import { once } from 'node:events';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect, createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { DEFAULT_STATS, FFA, ffaMap, ffaViewCenter } from '@tanks/shared/engine';
import {
  FfaPhase,
  MessageType,
  PROTOCOL_VERSION,
  type FfaRosterEntry,
  type FfaScoreMessage,
  type ServerMessage,
} from '@tanks/shared/protocol';
import { createApp, type App, type AppOptions } from '../src/app.js';
import { DEFAULT_FFA_OPTIONS, type FfaOptions } from '../src/ffaGame.js';
import { formatReport, healthUrlOf, Swarm, type SwarmOptions, type SwarmReport } from '../src/swarm/swarm.js';
import { TestClient } from './client.js';
import { seededRandom, sleep } from './support.js';

// Тик 10 мс — игра втрое быстрее настоящей; боты успевают ответить на каждый снимок. Наблюдатель входит человеком,
// а игру заполняет только рой.
const TICK_MS = 10;
const QUICK: FfaOptions = {
  ...DEFAULT_FFA_OPTIONS,
  hasServerBots: false,
  countdownTicks: 3,
  resultsTicks: 5,
  lobbyQuietTicks: 5,
  matchSeconds: 20,
};
// Запас окна обзора вокруг точки обзора стрелка на задержку реакции: за 12 тиков танк проезжает меньше 80, а
// точка обзора на выстреле смещена к цели — башня на неё наведена.
const VIEW_MARGIN = 80;

const apps: App[] = [];
const swarms: Swarm[] = [];
const clients: TestClient[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const swarm of swarms.splice(0)) {
    await swarm.stop();
  }
  for (const client of clients.splice(0)) {
    client.close();
  }
  for (const close of closers.splice(0)) {
    await close();
  }
  for (const app of apps.splice(0)) {
    await app.close();
  }
});

async function startApp(ffa: Partial<FfaOptions> = {}, options: AppOptions = {}, port = 0): Promise<number> {
  const app = createApp({ ffa: { ...QUICK, ...ffa }, tickMs: TICK_MS, ...options });
  apps.push(app);
  return app.listen(port, '127.0.0.1');
}

function startSwarm(port: number, options: Partial<SwarmOptions> = {}): Swarm {
  const swarm = new Swarm({
    url: `ws://127.0.0.1:${String(port)}/ws`,
    size: 10,
    count: 8,
    random: seededRandom(7),
    mapFor: ffaMap,
    joinIntervalMs: 10,
    retryDelaysMs: [30],
    log: () => undefined,
    ...options,
  });
  swarms.push(swarm);
  swarm.start();
  return swarm;
}

async function observer(port: number, code = 'ffa10'): Promise<TestClient> {
  const client = await TestClient.connect(port);
  clients.push(client);
  client.join(code, 'Наблюдатель', DEFAULT_STATS, PROTOCOL_VERSION, '', false);
  return client;
}

async function until(isDone: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isDone()) {
      return;
    }
    await sleep(20);
  }
  throw new Error(`не дождались: ${what}`);
}

function namesOf(players: readonly FfaRosterEntry[]): string[] {
  return players
    .filter((player) => player.isBot)
    .map((player) => player.nickname)
    .sort();
}

// Прокси между роем и сервером: разрыв закрывает обе стороны, как пропавшая сеть; пока отказывает — новые
// соединения сразу закрываются.
class Proxy {
  isRefusing = false;
  private readonly sockets = new Set<Socket>();

  private constructor(private readonly server: Server) {}

  static async start(targetPort: number): Promise<{ proxy: Proxy; port: number }> {
    const server = createServer();
    const proxy = new Proxy(server);
    server.on('connection', (client) => {
      proxy.pipe(client, targetPort);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => proxy.close());
    return { proxy, port: (server.address() as AddressInfo).port };
  }

  cut(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
  }

  // Сеть пропала без закрытия: открытые соединения перестают доставлять данные, новые работают.
  freeze(): void {
    for (const socket of this.sockets) {
      socket.unpipe();
      socket.pause();
    }
  }

  close(): Promise<void> {
    this.cut();
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private pipe(client: Socket, targetPort: number): void {
    if (this.isRefusing) {
      client.destroy();
      return;
    }
    const upstream = connect(targetPort, '127.0.0.1');
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      this.sockets.add(from);
      from.pipe(to);
      from.on('error', () => to.destroy());
      from.on('close', () => to.destroy());
    }
  }
}

describe('рой ботов через сокет', () => {
  it('8 ботов в ffa10: пирамида уровней, бой с попаданиями и убийствами, стреляют только по видимым, следующий матч', async () => {
    const port = await startApp();
    const watcher = await observer(port);
    const swarm = new Swarm({
      url: `ws://127.0.0.1:${String(port)}/ws`,
      size: 10,
      count: 8,
      random: seededRandom(3),
      mapFor: ffaMap,
      joinIntervalMs: 10,
    });
    swarms.push(swarm);
    swarm.start();

    let roster: FfaRosterEntry[] = [];
    let phase: FfaPhase | null = null;
    let matchIndex = 0;
    let lastScore: FfaScoreMessage | null = null;
    let finalScore: FfaScoreMessage | null = null;
    const blindShots: string[] = [];
    let botShots = 0;
    const firstSeen = new Map<string, { x: number; y: number }>();
    const moved = new Set<string>();
    function absorb(messages: readonly ServerMessage[]): void {
      for (const message of messages) {
        if (message.type === MessageType.FfaRoster) {
          roster = message.players;
        }
        if (message.type === MessageType.FfaMatchStart) {
          matchIndex = message.matchIndex;
        }
        if (message.type === MessageType.FfaScore) {
          lastScore = message;
        }
        if (message.type === MessageType.FfaState) {
          if (message.phase === FfaPhase.Results && phase !== FfaPhase.Results) {
            finalScore ??= lastScore;
          }
          phase = message.phase;
        }
        if (message.type !== MessageType.FfaSnapshot || phase !== FfaPhase.Fight) {
          continue;
        }
        const bots = new Set(roster.filter((player) => player.isBot).map((player) => player.id));
        for (const tank of message.tanks.filter((candidate) => bots.has(candidate.id) && candidate.isAlive)) {
          const key = `${String(matchIndex)}:${String(tank.id)}`;
          const start = firstSeen.get(key) ?? { x: tank.x, y: tank.y };
          firstSeen.set(key, start);
          if (Math.hypot(tank.x - start.x, tank.y - start.y) > 50) {
            moved.add(key);
          }
        }
        for (const birth of message.births.filter((candidate) => bots.has(candidate.owner))) {
          botShots++;
          const shooter = message.tanks.find((tank) => tank.id === birth.owner);
          const center = shooter === undefined ? null : ffaViewCenter(shooter);
          const isSeen = message.tanks.some(
            (tank) =>
              tank.id !== birth.owner &&
              tank.isAlive &&
              center !== null &&
              Math.abs(tank.x - center.x) <= FFA.viewWidth / 2 + VIEW_MARGIN &&
              Math.abs(tank.y - center.y) <= FFA.viewHeight / 2 + VIEW_MARGIN,
          );
          if (!isSeen) {
            blindShots.push(`${String(birth.owner)} на тике ${String(message.tick)}`);
          }
        }
      }
    }
    const poll = (isDone: () => boolean): (() => boolean) => {
      return () => {
        absorb(watcher.takeQueued());
        return isDone();
      };
    };

    await until(
      poll(
        () =>
          roster.filter((player) => player.isBot).length === 8 && swarm.bots().every((bot) => bot.playerId !== null),
      ),
      'восемь ботов в составе, у каждого свой номер',
    );
    expect(namesOf(roster)).toEqual(
      [
        'Ветеран [5]',
        'Манекен [1]',
        'Манекен [1]',
        'Новобранец [3]',
        'Призрак [7]',
        'Прогульщик [2]',
        'Прогульщик [2]',
        'Сержант [4]',
      ].sort(),
    );
    const ids = swarm.bots().map((bot) => bot.playerId);

    await until(
      poll(() => matchIndex === 2 && phase === FfaPhase.Fight),
      'второй матч',
      30_000,
    );
    expect(finalScore).not.toBeNull();
    const rows = (finalScore as FfaScoreMessage | null)?.rows ?? [];
    expect(rows.reduce((sum, row) => sum + row.damageDealt, 0)).toBeGreaterThan(0);
    expect(botShots).toBeGreaterThan(0);
    expect(blindShots).toEqual([]);
    expect([...moved].filter((key) => key.startsWith('1:')).length).toBeGreaterThanOrEqual(6);
    expect(swarm.bots().map((bot) => bot.playerId)).toEqual(ids);
    await until(
      poll(() => [...moved].filter((key) => key.startsWith('2:')).length >= 6),
      'боты едут во втором матче',
    );

    const report = swarm.report();
    expect(report).toMatchObject({ online: 8, total: 8, phase: FfaPhase.Fight, gaps: 0 });
    expect(report.bytesPerSecond.average).toBeGreaterThan(0);
    expect(report.snapshotsPerSecond).toBeGreaterThan(0);
    expect(report.pingMs.median).not.toBeNull();
    expect(report.brainMs.median).not.toBeNull();
    expect(report.serverTickMaxMs).not.toBeNull();
    expect(report.visibleBullets.average).not.toBeNull();
    expect(report.games).toHaveLength(1);
    const game = report.games[0];
    expect(game?.id).toMatch(/^[A-Z0-9]{4}$/);
    expect(game?.gameTick).toBeGreaterThan(0);
    expect(formatReport(report)).toContain(`8/8 в игре · ${game?.id ?? ''} `);
  }, 60_000);

  it('28 ботов в ffa30 — одна игра, уровни пирамидой; в лобби тишина дольше порога соединения не рвёт', async () => {
    const port = await startApp({ minimum: { 10: 10, 30: 30, 50: 50 } }, { silenceTimeoutMs: 200 });
    const swarm = startSwarm(port, { size: 30, count: 28, joinIntervalMs: 5, pingIntervalMs: 50 });
    await until(() => swarm.bots().every((bot) => bot.isOnline), 'все 28 в игре');
    await sleep(600);
    expect(swarm.bots().every((bot) => bot.isOnline)).toBe(true);
    const lobby = swarm.report();
    expect(lobby.games).toHaveLength(1);
    expect(lobby.games[0]?.gameTick).toBeNull();
    expect(formatReport(lobby)).toContain(`28/28 в игре · ${lobby.games[0]?.id ?? ''} · лобби`);
    const watcher = await observer(port, 'ffa30');
    const roster = await watcher.nextOfType(MessageType.FfaRoster);
    const counts = new Map<string, number>();
    for (const name of namesOf(roster.players)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      'Манекен [1]': 7,
      'Прогульщик [2]': 6,
      'Новобранец [3]': 5,
      'Сержант [4]': 4,
      'Ветеран [5]': 3,
      'Снайпер [6]': 2,
      'Призрак [7]': 1,
    });
  }, 30_000);

  it('обрыв сети: короткий — тот же игрок по пропуску, дольше окна возврата — новый игрок', async () => {
    const serverPort = await startApp({ reconnectTicks: 30, minimum: { 10: 2, 30: 2, 50: 2 } });
    const { proxy, port } = await Proxy.start(serverPort);
    const swarm = startSwarm(port, { count: 3 });
    await until(() => swarm.bots().every((bot) => bot.isOnline), 'трое в игре');
    const ids = swarm.bots().map((bot) => bot.playerId);
    const tokens = swarm.bots().map((bot) => bot.token);

    proxy.cut();
    await until(() => swarm.bots().some((bot) => !bot.isOnline), 'обрыв замечен');
    await until(() => swarm.bots().every((bot) => bot.isOnline), 'вернулись');
    expect(swarm.bots().map((bot) => bot.playerId)).toEqual(ids);

    proxy.isRefusing = true;
    proxy.cut();
    await sleep(700);
    proxy.isRefusing = false;
    await until(() => swarm.bots().every((bot) => bot.isOnline), 'вошли заново');
    const fresh = swarm.bots().map((bot) => bot.playerId);
    expect(swarm.bots().some((bot) => tokens.includes(bot.token))).toBe(false);
    const watcher = await observer(serverPort);
    const roster = await watcher.nextOfType(MessageType.FfaRoster);
    expect(
      roster.players
        .filter((player) => player.isBot)
        .map((player) => player.id)
        .sort(),
    ).toEqual([...fresh].sort());
  }, 30_000);

  it('тихий обрыв: сервер замолчал, а закрытие не пришло — бот сам рвёт соединение и возвращается с пропуском', async () => {
    const serverPort = await startApp({ minimum: { 10: 2, 30: 2, 50: 2 } });
    const { proxy, port } = await Proxy.start(serverPort);
    const swarm = startSwarm(port, { count: 2, pingIntervalMs: 50, silenceTimeoutMs: 300 });
    await until(() => swarm.bots().every((bot) => bot.isOnline), 'двое в игре');
    const ids = swarm.bots().map((bot) => bot.playerId);
    proxy.freeze();
    await until(() => swarm.bots().some((bot) => !bot.isOnline), 'молчание замечено', 5000);
    await until(() => swarm.bots().every((bot) => bot.isOnline), 'вернулись');
    expect(swarm.bots().map((bot) => bot.playerId)).toEqual(ids);
  }, 20_000);

  it('чужое соединение с пропуском бота занимает место — бот остановлен и больше не входит', async () => {
    const port = await startApp();
    const lines: string[] = [];
    const swarm = new Swarm({
      url: `ws://127.0.0.1:${String(port)}/ws`,
      size: 10,
      count: 1,
      random: seededRandom(1),
      mapFor: ffaMap,
      retryDelaysMs: [30],
      log: (line) => lines.push(line),
    });
    swarms.push(swarm);
    swarm.start();
    await until(() => swarm.bots()[0]?.isOnline === true, 'бот в игре');
    const [bot] = swarm.bots();
    const thief = await TestClient.connect(port);
    clients.push(thief);
    thief.join('ffa10', 'Вор', DEFAULT_STATS, PROTOCOL_VERSION, bot?.token ?? '', false);
    const welcome = await thief.nextOfType(MessageType.FfaWelcome);
    expect(welcome.playerId).toBe(bot?.playerId);
    await until(() => swarm.isDone, 'бот остановлен');
    await sleep(200);
    expect(swarm.bots()[0]).toMatchObject({ isStopped: true, isOnline: false });
    expect(lines.join('\n')).toContain('Манекен [1] остановлен');
  }, 20_000);

  it('выкинутый за бездействие бот входит заново новым игроком', async () => {
    const port = await startApp({ idleWarnTicks: 1, idleKickTicks: 3, minimum: { 10: 2, 30: 2, 50: 2 } });
    const lines: string[] = [];
    const swarm = startSwarm(port, { count: 2, log: (line) => lines.push(line) });
    await until(() => swarm.bots().every((bot) => bot.isOnline), 'двое в игре');
    const ids = swarm.bots().map((bot) => bot.playerId);
    await until(() => lines.some((line) => line.includes('выкинуло за бездействие')), 'выкинуло', 20_000);
    await until(() => swarm.bots().some((bot) => bot.isOnline && !ids.includes(bot.playerId)), 'вошёл новым игроком');
  }, 30_000);

  it('рой запущен раньше сервера: пока сервера нет — пустой отчёт, сервер поднялся — боты входят', async () => {
    const probe = createApp();
    const port = await probe.listen(0, '127.0.0.1');
    await probe.close();
    const swarm = startSwarm(port, { count: 2 });
    const empty = swarm.report();
    expect(empty).toMatchObject({ online: 0, games: [], phase: null, serverTickMaxMs: null, offscreenShare: null });
    expect(empty.pingMs.median).toBeNull();
    expect(formatReport(empty)).toContain('нет игры');
    await sleep(150);
    await startApp({}, {}, port);
    await until(() => swarm.bots().every((bot) => bot.isOnline), 'боты вошли');
  }, 20_000);

  it('чужой сервер: текст пропускается, сообщение не по протоколу останавливает бота, рой не падает', async () => {
    const stranger = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    closers.push(
      () =>
        new Promise((resolve) => {
          stranger.close(() => {
            resolve();
          });
        }),
    );
    stranger.on('connection', (socket) => {
      socket.send('{"hello":"world"}');
      socket.send(new Uint8Array([123, 1, 2]));
    });
    await once(stranger, 'listening');
    const lines: string[] = [];
    const swarm = startSwarm((stranger.address() as AddressInfo).port, { count: 1, log: (line) => lines.push(line) });
    await until(() => swarm.isDone, 'бот остановлен');
    expect(lines.join('\n')).toContain('не по протоколу игры');
  }, 20_000);

  it('бот, вошедший в идущий матч, едет', async () => {
    const port = await startApp({ minimum: { 10: 2, 30: 2, 50: 2 } });
    const watcher = await observer(port);
    startSwarm(port, { count: 2 });
    await watcher.nextOfType(MessageType.FfaMatchStart, 5000);
    const late = startSwarm(port, { count: 1, random: seededRandom(11) });
    await until(() => late.bots()[0]?.isOnline === true, 'опоздавший в игре');
    const lateId = late.bots()[0]?.playerId;
    let start: { x: number; y: number } | null = null;
    let distance = 0;
    await until(() => {
      for (const message of watcher.takeQueued()) {
        if (message.type !== MessageType.FfaSnapshot) {
          continue;
        }
        const tank = message.tanks.find((candidate) => candidate.id === lateId && candidate.isAlive);
        if (tank === undefined) {
          continue;
        }
        start ??= { x: tank.x, y: tank.y };
        distance = Math.max(distance, Math.hypot(tank.x - start.x, tank.y - start.y));
      }
      return distance > 30;
    }, 'опоздавший едет');
  }, 20_000);
});

describe('отчёт роя', () => {
  function reportOf(phase: FfaPhase | null, matchTick = 0, games: SwarmReport['games'] = []): SwarmReport {
    return {
      online: 3,
      total: 4,
      games,
      phase,
      matchTick,
      bytesPerSecond: { average: 81_920, max: 90_000 },
      snapshotsPerSecond: 30,
      gaps: 1,
      pingMs: { median: 62, high: 80 },
      brainMs: { median: 0.2, high: 1.1 },
      cpuShare: 0.35,
      serverTickMaxMs: 2.1,
      visibleBullets: { average: 14.2, max: 41 },
      offscreenShare: 0.22,
    };
  }

  it('строка на каждую фазу', () => {
    expect(formatReport(reportOf(FfaPhase.Fight, 72 * 30))).toBe(
      '3/4 в игре · бой 1:12 · вход на бота 80 КиБ/с (макс 88) · снимков 30/с, пропусков 1 · пинг 62/80 мс · ' +
        'мозг 0,20/1,10 мс · рой 35 % ядра · тик сервера макс 2,1 мс · снарядов в окне 14,2/41 · урон из-за экрана 22 %',
    );
    expect(formatReport(reportOf(FfaPhase.Lobby))).toContain('· лобби ·');
    expect(formatReport(reportOf(FfaPhase.Countdown))).toContain('· отсчёт ·');
    expect(formatReport(reportOf(FfaPhase.Results))).toContain('· итоги ·');
  });

  it('игра — номером и таймкодом, как внизу экрана игрока; до первого снимка — только номер; несколько игр — через запятую', () => {
    const fight = reportOf(FfaPhase.Fight, 72 * 30, [{ id: 'BNRS', gameTick: 99 * 30 + 12 }]);
    expect(formatReport(fight)).toMatch(/^3\/4 в игре · BNRS 01:39 · бой 1:12 · /);
    expect(formatReport(reportOf(FfaPhase.Lobby, 0, [{ id: 'BNRS', gameTick: null }]))).toMatch(
      /^3\/4 в игре · BNRS · лобби · /,
    );
    const two = [
      { id: 'BNRS', gameTick: 30 },
      { id: 'K7MF', gameTick: null },
    ];
    expect(formatReport(reportOf(FfaPhase.Fight, 30, two))).toMatch(/^3\/4 в игре · BNRS 00:01, K7MF · бой/);
  });

  it('адрес здоровья сервера — из адреса сокета; ответ без длительности тика — прочерк', async () => {
    expect(healthUrlOf('wss://example.org/ws')).toBe('https://example.org/healthz');
    expect(healthUrlOf('ws://127.0.0.1:8080/ws')).toBe('http://127.0.0.1:8080/healthz');
    const fake: HttpServer = createHttpServer((_request, response) => {
      response.end('{}');
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise((resolve) =>
          fake.close(() => {
            resolve();
          }),
        ),
    );
    const healthUrl = `http://127.0.0.1:${String((fake.address() as AddressInfo).port)}/healthz`;
    const swarm = new Swarm({
      url: 'ws://127.0.0.1:1/ws',
      size: 10,
      count: 1,
      random: seededRandom(1),
      mapFor: ffaMap,
      healthUrl,
      log: () => undefined,
    });
    swarms.push(swarm);
    swarm.start();
    expect(swarm.report().serverTickMaxMs).toBeNull();
    await sleep(100);
    expect(swarm.bots()[0]?.isOnline).toBe(false);
  });
});
