import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect as connectTcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RULES, DEFAULT_STATS, deriveStats, DT, TICK_RATE } from '@tanks/shared/engine';
import {
  botRoomCode,
  FfaPhase,
  MessageType,
  PROTOCOL_VERSION,
  ErrorCode,
  TWIN_INFO,
  twinRoomCode,
  type FfaStateMessage,
  type RoundStartMessage,
  type SnapshotMessage,
} from '@tanks/shared/protocol';
import { createApp, type App } from '../src/app.js';
import { TestClient } from './client.js';
import { postInTwoParts, seededRandom, sleep, threadCpuMs } from './support.js';

const FAST_ROOM = { countdownTicks: 3, roundEndTicks: 3, maxInputsPerSecond: 90 };
const TICK_MS = 4;
// Характеристики двойника — самый частый билд игрока с телефона.
const TWIN_STATS = { armor: 0, engine: 3, gun: 4, reload: 3 };
// Двойник за полминуты боя успевает поехать и выстрелить, даже когда человек стоит.
const TWIN_WATCH_SNAPSHOTS = 30 * TICK_RATE;
const LOG_BODY_LIMIT_BYTES = 256 * 1024;

let app: App;
let port: number;
let staticRoot: string;
const clients: TestClient[] = [];

async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(port);
  clients.push(client);
  return client;
}

// Старт раунда последней пары — для проверок идентификатора дуэли.
let lastRoundStart: RoundStartMessage;

async function joinedPair(code = 'duel1'): Promise<[TestClient, TestClient]> {
  const a = await connect();
  const b = await connect();
  a.join(code, 'Алиса');
  await a.nextOfType(MessageType.Welcome);
  b.join(code, 'Боб');
  await b.nextOfType(MessageType.Welcome);
  lastRoundStart = await a.nextOfType(MessageType.RoundStart);
  await b.nextOfType(MessageType.RoundStart);
  return [a, b];
}

async function snapshotAfterCountdown(client: TestClient): Promise<SnapshotMessage> {
  let snapshot = await client.nextOfType(MessageType.Snapshot);
  while (snapshot.tick === 0) {
    snapshot = await client.nextOfType(MessageType.Snapshot);
  }
  return snapshot;
}

async function healthz(): Promise<{ build: string; rooms: number; connections: number; tick: number }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
  expect(response.status).toBe(200);
  return (await response.json()) as { build: string; rooms: number; connections: number; tick: number };
}

beforeEach(async () => {
  staticRoot = mkdtempSync(join(tmpdir(), 'tanks-static-'));
  writeFileSync(join(staticRoot, 'index.html'), '<html>tanks</html>');
  writeFileSync(join(staticRoot, 'app.js'), 'console.log(1)');
  writeFileSync(join(staticRoot, 'data.bin'), 'raw');
  app = createApp({ staticRoot, room: FAST_ROOM, random: seededRandom(42), tickMs: TICK_MS });
  port = await app.listen(0, '127.0.0.1');
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await app.close();
});

describe('HTTP', () => {
  it('отдаёт состояние на /healthz', async () => {
    const body = await healthz();
    expect(body.build).toBe('dev');
    expect(body.rooms).toBe(0);
    expect(body.connections).toBe(0);
  });

  it('раздаёт файлы клиента и index.html на маршрутах приложения', async () => {
    const base = `http://127.0.0.1:${String(port)}`;
    expect(await (await fetch(`${base}/app.js`)).text()).toBe('console.log(1)');
    expect(await (await fetch(`${base}/`)).text()).toBe('<html>tanks</html>');
    expect(await (await fetch(`${base}/d/abc123`)).text()).toBe('<html>tanks</html>');
    expect((await fetch(`${base}/nope.js`)).status).toBe(404);

    const binary = await fetch(`${base}/data.bin`);
    expect(binary.headers.get('content-type')).toBe('application/octet-stream');
    expect(await binary.text()).toBe('raw');

    const secretName = `tanks-outside-${randomBytes(6).toString('hex')}.txt`;
    const outside = join(staticRoot, '..', secretName);
    writeFileSync(outside, 'secret');
    try {
      expect((await fetch(`${base}/%2e%2e/${secretName}`)).status).toBe(404);
    } finally {
      rmSync(outside);
    }
  });

  it('кэш на год — только файлам сборки из /assets/; остальное браузер сверяет по дате и получает 304', async () => {
    const base = `http://127.0.0.1:${String(port)}`;
    mkdirSync(join(staticRoot, 'assets'));
    mkdirSync(join(staticRoot, 'fonts'));
    writeFileSync(join(staticRoot, 'assets', 'index-abc123.js'), 'build');
    writeFileSync(join(staticRoot, 'fonts', 'inter-latin.woff2'), 'font');
    writeFileSync(join(staticRoot, 'favicon.svg'), '<svg/>');

    const hashed = await fetch(`${base}/assets/index-abc123.js`);
    expect(hashed.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await hashed.text()).toBe('build');

    for (const path of ['/', '/ffa', '/favicon.svg', '/fonts/inter-latin.woff2', '/assets/%2e%2e/favicon.svg']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('cache-control'), path).toBe('no-cache');
      const lastModified = response.headers.get('last-modified') ?? '';
      expect(Date.parse(lastModified), path).not.toBeNaN();

      const unchanged = await fetch(`${base}${path}`, { headers: { 'If-Modified-Since': lastModified } });
      expect(unchanged.status, path).toBe(304);
      expect(await unchanged.text(), path).toBe('');
    }

    const stale = await fetch(`${base}/favicon.svg`, { headers: { 'If-Modified-Since': new Date(0).toUTCString() } });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe('<svg/>');
  });

  it('отдаёт index.html на маршрутах общего боя и приглашения, кроме размеров не из списка и кривых номеров', async () => {
    const base = `http://127.0.0.1:${String(port)}`;
    for (const route of ['/ffa', '/ffa/10', '/ffa/30', '/ffa/50', '/ffa/10/K7MF', '/ffa/30/x']) {
      expect(await (await fetch(`${base}${route}`)).text()).toBe('<html>tanks</html>');
    }
    const longId = 'A'.repeat(17);
    for (const route of [
      '/ffa/11',
      '/ffa/',
      '/ffa/11/K7MF',
      '/ffa/10/',
      '/ffa/10/K7MF/x',
      `/ffa/10/${longId}`,
      '/ffax',
    ]) {
      expect((await fetch(`${base}${route}`)).status).toBe(404);
    }
  });

  it('отдаёт index.html на странице боя ботов и только на ней', async () => {
    const base = `http://127.0.0.1:${String(port)}`;
    expect(await (await fetch(`${base}/watch`)).text()).toBe('<html>tanks</html>');
    for (const route of ['/watch/', '/watch/x', '/watchx']) {
      expect((await fetch(`${base}${route}`)).status, route).toBe(404);
    }
  });

  it('не принимает WebSocket на чужом пути', async () => {
    await expect(TestClient.connect(port, '/other')).rejects.toThrow();
  });

  it('битый кадр WebSocket закрывает соединение, сервер живёт дальше', async () => {
    const socket = connectTcp(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${String(port)}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
    );
    const [handshake] = (await once(socket, 'data')) as [Buffer];
    expect(handshake.toString()).toContain('101');
    expect((await healthz()).connections).toBe(1);

    // Кадр от клиента обязан быть замаскирован; без маски ws отвечает кадром закрытия.
    socket.write(Buffer.from([0x82, 0x01, 0x00]));
    await once(socket, 'data');
    socket.end();
    await once(socket, 'close');
    await sleep(20);
    expect((await healthz()).connections).toBe(0);
  });

  it('отдаёт APK приложения по /app/tanks.apk, пока файл есть', async () => {
    await app.close();
    const apkPath = join(staticRoot, 'tanks.apk');
    writeFileSync(apkPath, 'PK-apk');
    app = createApp({ staticRoot, apkPath, room: FAST_ROOM });
    port = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${String(port)}`;

    const response = await fetch(`${base}/app/tanks.apk`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/vnd.android.package-archive');
    expect(response.headers.get('content-disposition')).toContain('tanks.apk');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toBe('PK-apk');

    const head = await fetch(`${base}/app/tanks.apk`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('6');

    rmSync(apkPath);
    expect((await fetch(`${base}/app/tanks.apk`)).status).toBe(404);
  });

  it('без настроенного APK маршрут /app/tanks.apk отвечает 404', async () => {
    expect((await fetch(`http://127.0.0.1:${String(port)}/app/tanks.apk`)).status).toBe(404);
  });

  it('без папки журнала POST /log отвечает 404', async () => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/log?key=K7MF&src=C1`, {
      method: 'POST',
      body: 'x',
    });
    expect(response.status).toBe(404);
  });
});

describe('процесс', () => {
  it('createApp() без параметров работает с умолчаниями, close() без listen() не падает', async () => {
    await createApp().close();
    const plain = createApp();
    const plainPort = await plain.listen(0, '127.0.0.1');
    try {
      const response = await fetch(`http://127.0.0.1:${String(plainPort)}/healthz`);
      expect(response.status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${String(plainPort)}/`)).status).toBe(404);
    } finally {
      await plain.close();
    }
  });

  it('после остановки процесса дольше пяти тиков расписание сбрасывается, тики не навёрстываются пачкой', async () => {
    await sleep(50);
    const before = (await healthz()).tick;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * TICK_MS);
    await sleep(10 * TICK_MS);
    const after = (await healthz()).tick;
    expect(after - before).toBeGreaterThanOrEqual(5);
    expect(after - before).toBeLessThan(25);
  });
});

describe('переключатели общей игры из окружения', () => {
  const WAIT_MS = 10_000;
  const BOT_PASS_WINDOW_MS = 500;
  // Шесть ботов без замедления проходят за доли миллисекунды, с замедлением 30 — за несколько миллисекунд.
  const SLOW_BOT_PASS_MS = 2;
  // С бюджетом 1 мс за проход решает один бот из шести, остальные пропускают; с бюджетом 33 мс — почти никто.
  const TIGHT_SKIP_LEAD = 2;

  async function restart(env: Record<string, string>): Promise<void> {
    await app.close();
    app = createApp({ env, tickMs: TICK_MS, botClock: threadCpuMs });
    port = await app.listen(0, '127.0.0.1');
  }

  async function stateOf(client: TestClient, phase: number): Promise<FfaStateMessage> {
    let state = await client.nextOfType(MessageType.FfaState, WAIT_MS);
    while (state.phase !== phase) {
      state = await client.nextOfType(MessageType.FfaState, WAIT_MS);
    }
    return state;
  }

  it('минимум 1 — матч стартует с одним игроком; длительности лобби, матча и итогов — из переменных', async () => {
    await restart({
      FFA_MINIMUM: '1',
      FFA_LOBBY_WAIT_SECONDS: '1',
      FFA_MATCH_SECONDS: '2',
      FFA_RESULTS_SECONDS: '1',
    });
    const client = await connect();
    client.join('ffa10');
    const lobby = await stateOf(client, FfaPhase.Lobby);
    expect(lobby).toMatchObject({ players: 1, capacity: 10, minimum: 1, ticksLeft: TICK_RATE });
    await stateOf(client, FfaPhase.Countdown);
    expect((await client.nextOfType(MessageType.FfaMatchStart, WAIT_MS)).durationSeconds).toBe(2);
    expect((await stateOf(client, FfaPhase.Fight)).ticksLeft).toBe(2 * TICK_RATE);
    expect((await stateOf(client, FfaPhase.Results)).ticksLeft).toBe(TICK_RATE);
  });

  it('бездействие: предупреждение и выкидывание — из переменных', async () => {
    await restart({
      FFA_MINIMUM: '1',
      FFA_LOBBY_WAIT_SECONDS: '1',
      FFA_IDLE_WARN_SECONDS: '1',
      FFA_IDLE_KICK_SECONDS: '2',
    });
    const client = await connect();
    client.join('ffa10');
    let snapshot = await client.nextOfType(MessageType.FfaSnapshot, WAIT_MS);
    while (snapshot.self.idleTicksLeft === null) {
      snapshot = await client.nextOfType(MessageType.FfaSnapshot, WAIT_MS);
    }
    expect(snapshot.self.idleTicksLeft).toBe(TICK_RATE);
    expect((await client.nextOfType(MessageType.Error, WAIT_MS)).code).toBe(ErrorCode.Idle);
  });

  it('пустая переменная — умолчание: минимум 7, лобби добрано серверными ботами', async () => {
    await restart({ FFA_MINIMUM: '', FFA_MATCH_SECONDS: '', FFA_SERVER_BOTS: '' });
    const client = await connect();
    client.join('ffa10');
    expect(await stateOf(client, FfaPhase.Lobby)).toMatchObject({ minimum: 7, players: 7, ticksLeft: 5 * TICK_RATE });
  });

  it('FFA_SERVER_BOTS=0 — игру ботами не добирает', async () => {
    await restart({ FFA_SERVER_BOTS: '0' });
    const client = await connect();
    client.join('ffa10');
    expect(await stateOf(client, FfaPhase.Lobby)).toMatchObject({ minimum: 7, players: 1, ticksLeft: null });
  });

  function metricOf(text: string, pattern: RegExp): number {
    return Number(pattern.exec(text)?.[1] ?? NaN);
  }

  // Медиана прохода хода ботов и пропуски решений на тик за полсекунды боя ffa10 с шестью ботами. Проход меряется
  // процессорным временем потока, пропуски — от бюджета, поэтому посторонняя нагрузка машины на них не влияет.
  async function botPass(env: Record<string, string>): Promise<{ medianMs: number; skipsPerTick: number }> {
    await restart({ FFA_LOBBY_WAIT_SECONDS: '1', ...env });
    const client = await connect();
    client.join('ffa10');
    await stateOf(client, FfaPhase.Fight);
    const metricsUrl = `http://127.0.0.1:${String(port)}/metrics`;
    const before = await (await fetch(metricsUrl)).text();
    await sleep(BOT_PASS_WINDOW_MS);
    const after = await (await fetch(metricsUrl)).text();
    const skipped = /^tanks_bot_skipped_total (\S+)$/m;
    const ticks = /^tanks_ticks_total (\S+)$/m;
    return {
      medianMs: metricOf(after, /^tanks_bot_think_ms\{quantile="0\.5"\} (\S+)$/m),
      skipsPerTick:
        (metricOf(after, skipped) - metricOf(before, skipped)) / (metricOf(after, ticks) - metricOf(before, ticks)),
    };
  }

  it(
    'FFA_BOT_SLOWDOWN и FFA_BOT_BUDGET_MS — замедление удлиняет проход ботов, узкий бюджет обрезает его пропусками',
    async () => {
      const roomy = await botPass({ FFA_BOT_BUDGET_MS: '33', FFA_BOT_SLOWDOWN: '30' });
      const tight = await botPass({ FFA_BOT_BUDGET_MS: '1', FFA_BOT_SLOWDOWN: '30' });
      expect(roomy.medianMs).toBeGreaterThan(SLOW_BOT_PASS_MS);
      expect(tight.skipsPerTick).toBeGreaterThan(roomy.skipsPerTick + TIGHT_SKIP_LEAD);
    },
    4 * WAIT_MS,
  );

  it.each([
    ['FFA_MINIMUM', 'много'],
    ['FFA_MINIMUM', '0'],
    ['FFA_MINIMUM', '2.5'],
    ['FFA_MINIMUM', '11'],
    ['FFA_MATCH_SECONDS', '2185'],
    ['FFA_LOBBY_WAIT_SECONDS', '-1'],
    ['FFA_RESULTS_SECONDS', '1e9'],
    ['FFA_IDLE_WARN_SECONDS', 'x'],
    ['FFA_IDLE_KICK_SECONDS', '3000'],
    ['FFA_SERVER_BOTS', 'да'],
    ['FFA_BOT_BUDGET_MS', '0'],
    ['FFA_BOT_BUDGET_MS', '2.5'],
    ['FFA_BOT_BUDGET_MS', '34'],
    ['FFA_BOT_SLOWDOWN', 'быстро'],
    ['FFA_BOT_SLOWDOWN', '101'],
  ])('%s=«%s» — createApp бросает ошибку с именем переменной', (name, value) => {
    expect(() => createApp({ env: { [name]: value } })).toThrow(name);
  });

  it.each([
    [{ FFA_IDLE_WARN_SECONDS: '25' }],
    [{ FFA_IDLE_KICK_SECONDS: '10' }],
    [{ FFA_IDLE_WARN_SECONDS: '3', FFA_IDLE_KICK_SECONDS: '3' }],
  ])('предупреждение не раньше выкидывания (%o) — ошибка с именами переменных', (env) => {
    expect(() => createApp({ env })).toThrow(/FFA_IDLE_WARN_SECONDS.*FFA_IDLE_KICK_SECONDS/);
  });

  it('граничные значения принимаются: минимум 10, длительность 2184 с, бюджет ботов 33 мс, замедление 100', async () => {
    await createApp({
      env: { FFA_MINIMUM: '10', FFA_MATCH_SECONDS: '2184', FFA_BOT_BUDGET_MS: '33', FFA_BOT_SLOWDOWN: '100' },
    }).close();
  });
});

describe('вход в комнату', () => {
  it('два игрока получают стороны 0 и 1, состояние комнаты и старт раунда', async () => {
    const a = await connect();
    a.join('room1', 'Алиса');
    const welcomeA = await a.nextOfType(MessageType.Welcome);
    expect(welcomeA.side).toBe(0);
    expect(welcomeA.roomCode).toBe('room1');
    const stateA = await a.nextOfType(MessageType.RoomState);
    expect(stateA.slots[0]).toEqual({ isTaken: true, nickname: 'Алиса' });
    expect(stateA.slots[1].isTaken).toBe(false);

    const b = await connect();
    b.join('room1', '  Боб  ');
    const welcomeB = await b.nextOfType(MessageType.Welcome);
    expect(welcomeB.side).toBe(1);
    const start = await b.nextOfType(MessageType.RoundStart);
    expect(start.tanks[0].nickname).toBe('Алиса');
    expect(start.tanks[1].nickname).toBe('Боб');
    expect(start.score).toEqual([0, 0]);
    expect(start.countdownTicks).toBe(FAST_ROOM.countdownTicks);
    expect(start.rules).toEqual({ wallSlidePercent: 0, shotLeadTicks: 0, shotInheritPercent: 0 });
    expect(app.stats().rooms).toBe(1);
  });

  it('повторный Join из комнаты игнорируется', async () => {
    const [a] = await joinedPair('again');
    a.join('other', 'Алиса-2');
    await expect(a.nextOfType(MessageType.Welcome, 200)).rejects.toThrow();
    expect(await a.closed(100)).toBe(false);
    expect(app.stats().rooms).toBe(1);
  });

  // Бот на месте 0 за 400 снимков успевает поехать или развернуться.
  async function hasBotMoved(human: TestClient): Promise<boolean> {
    let lastHeading: number | null = null;
    for (let i = 0; i < 400; i++) {
      const snapshot = await human.nextOfType(MessageType.Snapshot);
      const bot = snapshot.tanks[0];
      if (lastHeading !== null && (Math.abs(bot.speed) > 1 || bot.heading !== lastHeading)) {
        return true;
      }
      lastHeading = bot.heading;
    }
    return false;
  }

  it('код bot01… — дуэль против манекена: он уже сидит первым, раунд стартует сразу', async () => {
    const code = botRoomCode(1, 'xyz1');
    const human = await connect();
    human.join(code, 'Дима');
    const welcome = await human.nextOfType(MessageType.Welcome);
    expect(welcome.side).toBe(1);
    const start = await human.nextOfType(MessageType.RoundStart);
    expect(start.tanks[0].nickname).toBe('Манекен');
    expect(start.tanks[1].nickname).toBe('Дима');
    expect(await hasBotMoved(human)).toBe(true);

    const stranger = await connect();
    stranger.join(code, 'Третий');
    expect((await stranger.nextOfType(MessageType.Error)).code).toBe(ErrorCode.RoomFull);

    human.close();
    await sleep(100);
    expect(app.stats().rooms).toBe(0);
  });

  it.each([
    [3, 'Новобранец', { armor: 3, engine: 3, gun: 1, reload: 2 }],
    [8, 'Охотник', { armor: 3, engine: 3, gun: 2, reload: 2 }],
    [9, 'Охотник-ас', { armor: 0, engine: 0, gun: 5, reload: 5 }],
    [10, 'ПАРАЛЛАКС-ASTRA', { armor: 2, engine: 1, gun: 2, reload: 5 }],
  ] as const)('уровень %i — бот «%s» со своими характеристиками, двигается', async (level, name, stats) => {
    const human = await connect();
    human.join(botRoomCode(level, 'xyz1'), 'Дима');
    const start = await human.nextOfType(MessageType.RoundStart);
    expect(start.tanks[0]).toEqual({ nickname: name, stats });
    // Стоящий за стеной человек не цель: в стену боты не стреляют, проверяется только движение.
    expect(await hasBotMoved(human)).toBe(true);
  });

  it('код twin… — дуэль против двойника: он сидит первым со своими характеристиками, едет и стреляет', async () => {
    const code = twinRoomCode('xyz1');
    const human = await connect();
    human.join(code, 'Дима');
    expect((await human.nextOfType(MessageType.Welcome)).side).toBe(1);
    const start = await human.nextOfType(MessageType.RoundStart);
    expect(start.tanks[0]).toEqual({ nickname: TWIN_INFO.name, stats: TWIN_STATS });
    expect(start.tanks[1].nickname).toBe('Дима');
    let hasMoved = false;
    let hasShot = false;
    for (let i = 0; i < TWIN_WATCH_SNAPSHOTS && !(hasMoved && hasShot); i++) {
      const snapshot = await human.nextOfType(MessageType.Snapshot);
      hasMoved ||= Math.abs(snapshot.tanks[0].speed) > 1;
      hasShot ||= snapshot.bullets.some((bullet) => bullet.owner === 0);
    }
    expect(hasMoved).toBe(true);
    expect(hasShot).toBe(true);

    const stranger = await connect();
    stranger.join(code, 'Третий');
    expect((await stranger.nextOfType(MessageType.Error)).code).toBe(ErrorCode.RoomFull);

    human.close();
    await sleep(100);
    expect(app.stats().rooms).toBe(0);
  }, 30000);

  it('код bot без заполненного уровня — неверный код комнаты, комната не создаётся', async () => {
    for (const code of ['botabc', 'bot1abc', 'bot00abc', 'bot11abc']) {
      const client = await connect();
      client.join(code, 'Дима');
      expect((await client.nextOfType(MessageType.Error)).code).toBe(ErrorCode.BadMessage);
      expect(await client.closed()).toBe(true);
    }
    expect(app.stats().rooms).toBe(0);
  });

  it('клиент замолчал — его танк останавливается, а не едет по последней команде вечно', async () => {
    const [a] = await joinedPair('silent');
    await snapshotAfterCountdown(a);
    a.input({ throttle: 1 });
    let fastest = 0;
    let latest = 0;
    for (let i = 0; i < 90; i++) {
      const snapshot = await a.nextOfType(MessageType.Snapshot);
      latest = snapshot.tanks[0].speed;
      fastest = Math.max(fastest, latest);
    }
    expect(fastest).toBeGreaterThan(50);
    expect(latest).toBeLessThan(1);
  });

  it('третьему отказывает: комната полна', async () => {
    await joinedPair('full');
    const c = await connect();
    c.join('full');
    const error = await c.nextOfType(MessageType.Error);
    expect(error.code).toBe(ErrorCode.RoomFull);
    expect(await c.closed()).toBe(true);
  });

  it('отвергает чужую версию протокола, неверный код и мусор', async () => {
    const a = await connect();
    a.join('room1', 'x', undefined, PROTOCOL_VERSION + 1);
    expect((await a.nextOfType(MessageType.Error)).code).toBe(ErrorCode.BadProtocolVersion);

    const b = await connect();
    b.join('НЕ КОД');
    expect((await b.nextOfType(MessageType.Error)).code).toBe(ErrorCode.BadMessage);

    const c = await connect();
    c.sendRaw(new Uint8Array([250, 1, 2]));
    expect((await c.nextOfType(MessageType.Error)).code).toBe(ErrorCode.BadMessage);

    const d = await connect();
    d.sendRaw(new Uint8Array([MessageType.Welcome, 0, 0, 0]));
    expect((await d.nextOfType(MessageType.Error)).code).toBe(ErrorCode.BadMessage);
  });

  it('пустой ник и неверные характеристики заменяются допустимыми', async () => {
    const a = await connect();
    a.join('room2', '   ', { armor: 9, engine: 9, gun: 9, reload: 9 });
    await a.nextOfType(MessageType.Welcome);
    const state = await a.nextOfType(MessageType.RoomState);
    expect(state.slots[0].nickname).toBe('Игрок');
    const b = await connect();
    b.join('room2', 'Боб');
    const start = await b.nextOfType(MessageType.RoundStart);
    expect(start.tanks[0].stats).toEqual({ armor: 3, engine: 3, gun: 2, reload: 2 });
  });

  it('Leave в дуэли — уход, как закрытие: место соперника свободно, снимки прекращаются', async () => {
    const [a, b] = await joinedPair('quit');
    await snapshotAfterCountdown(a);
    b.send({ type: MessageType.Leave });
    let state = await a.next();
    while (state.type !== MessageType.RoomState) {
      state = await a.next();
    }
    expect(state.slots[1].isTaken).toBe(false);
    await expect(a.nextOfType(MessageType.Snapshot, 300)).rejects.toThrow();
    b.close();
  });

  it('после ухода игрока комната ждёт, снимки прекращаются, пустая комната удаляется', async () => {
    const [a, b] = await joinedPair('leave');
    await snapshotAfterCountdown(a);
    b.close();
    let state = await a.next();
    while (state.type !== MessageType.RoomState) {
      state = await a.next();
    }
    expect(state.slots[1].isTaken).toBe(false);
    await expect(a.nextOfType(MessageType.Snapshot, 300)).rejects.toThrow();
    a.close();
    await a.closed();
    await sleep(50);
    expect(app.stats().rooms).toBe(0);
  });
});

describe('журнал игры', () => {
  let logDir: string;
  const GAME_ID = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;
  const LINE = /^\d{2}:\d{2}:\d{2}\.\d{3} (S|C\d) /;

  beforeEach(async () => {
    await app.close();
    logDir = mkdtempSync(join(tmpdir(), 'tanks-log-'));
    app = createApp({ staticRoot, logDir, room: FAST_ROOM, random: seededRandom(42), tickMs: TICK_MS });
    port = await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
    rmSync(logDir, { recursive: true, force: true });
  });

  function logLines(gameId: string): string[] {
    return readFileSync(join(logDir, `${gameId}.log`), 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  }

  it('дуэль получает идентификатор, таймкод растёт по тикам, новая дуэль — новый идентификатор', async () => {
    const [a, b] = await joinedPair('ids');
    const start = lastRoundStart;
    expect(start.gameId).toMatch(GAME_ID);
    const first = await a.nextOfType(MessageType.Snapshot);
    const second = await a.nextOfType(MessageType.Snapshot);
    expect(second.gameTick).toBe(first.gameTick + 1);

    b.close();
    await sleep(50);
    const c = await connect();
    c.join('ids', 'Вера');
    await c.nextOfType(MessageType.Welcome);
    const restart = await c.nextOfType(MessageType.RoundStart);
    expect(restart.gameId).toMatch(GAME_ID);
    expect(restart.gameId).not.toBe(start.gameId);
  });

  it('сервер пишет старт, тики, команды, события и уход в файл дуэли', async () => {
    const [a, b] = await joinedPair('srvlog');
    const start = lastRoundStart;
    await snapshotAfterCountdown(a);
    const seq = a.input({ throttle: 1, isFiring: true });
    let snapshot = await a.nextOfType(MessageType.Snapshot);
    while (snapshot.ackSeq < seq) {
      snapshot = await a.nextOfType(MessageType.Snapshot);
    }
    a.send({ type: MessageType.Input, seq, action: { throttle: 0, turn: 0, turretTurn: 0, isFiring: false } });
    for (let i = 0; i < FAST_ROOM.maxInputsPerSecond + 5; i++) {
      a.input({ throttle: 1 });
    }
    while (snapshot.events.every((event) => event.kind !== 'shot')) {
      snapshot = await a.nextOfType(MessageType.Snapshot);
    }
    await sleep(700);
    const flushed = logLines(start.gameId);
    expect(flushed.length).toBeGreaterThan(0);

    b.close();
    await sleep(50);
    await app.close();
    const lines = logLines(start.gameId);
    for (const line of lines) {
      expect(line).toMatch(LINE);
    }
    const text = lines.join('\n');
    expect(text).toMatch(
      /S gt=0 tc=00:00 game start room=srvlog p0=Алиса p1=Боб rules=0 lead=0 inherit=0\n\S+ S gt=0 tc=00:00 build server=dev\n/,
    );
    expect(text).toContain('round start idx=0 map=0 score=0:0');
    expect(text).toMatch(/tick rt=\d+ ph=c late=\d+\.\d a0=0\.00,0\.00,0\.00,0 ack0=0 in0=0 sil0=\d p0=140\.0,450\.0/);
    expect(text).toMatch(/tick rt=\d+ ph=f .*a0=1\.00,0\.00,0\.00,1 ack0=1 in0=1 /);
    expect(text).toContain(`input stale side=0 seq=${String(seq)} last=${String(seq)}`);
    expect(text).toMatch(/input limit side=0 seq=\d+/);
    expect(text).toMatch(/input overflow side=0 seq=\d+\n/);
    expect(text).toMatch(/ev kind=shot side=0 x=\d+\.\d y=450\.0 v=/);
    expect(text).toContain('leave side=1 nick=Боб');
  });

  it('принимает строки клиента на POST /log и пишет их в файл ключа с источником', async () => {
    const base = `http://127.0.0.1:${String(port)}`;
    const posted = await fetch(`${base}/log?key=K7MF&src=C1`, { method: 'POST', body: 'gt=1 snap a\n\ngt=2 in b\n' });
    expect(posted.status).toBe(204);
    const again = await fetch(`${base}/log?key=K7MF&src=C1`, { method: 'POST', body: 'gt=3 sec c' });
    expect(again.status).toBe(204);
    expect((await fetch(`${base}/log?key=K7MF&src=C1`, { method: 'POST', body: '' })).status).toBe(204);
    await app.close();
    const lines = logLines('K7MF');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} C1 gt=1 snap a$/);
    expect(lines[1]).toMatch(/ C1 gt=2 in b$/);
    expect(lines[2]).toMatch(/ C1 gt=3 sec c$/);
  });

  it('принимает источник с наибольшим номером игрока боя толпы', async () => {
    const base = `http://127.0.0.1:${String(port)}`;
    expect((await fetch(`${base}/log?key=K7QX&src=C65534`, { method: 'POST', body: 'gt=1 sec a' })).status).toBe(204);
    await app.close();
    expect(logLines('K7QX')[0]).toMatch(/ C65534 gt=1 sec a$/);
  });

  it('правила процесса уходят в RoundStart и в строку game start', async () => {
    await app.close();
    app = createApp({ logDir, rules: { ...DEFAULT_RULES, wallSlidePercent: 50 }, room: FAST_ROOM, tickMs: TICK_MS });
    port = await app.listen(0, '127.0.0.1');
    const [a] = await joinedPair('rules');
    expect(lastRoundStart.rules).toEqual({ wallSlidePercent: 50, shotLeadTicks: 0, shotInheritPercent: 0 });
    await snapshotAfterCountdown(a);
    await app.close();
    expect(logLines(lastRoundStart.gameId).join('\n')).toContain(
      'game start room=rules p0=Алиса p1=Боб rules=50 lead=0 inherit=0',
    );
  });

  it('SHOT_LEAD_TICKS ставит догон поверх правил процесса, TANKS_BUILD — версию: RoundStart, game start, /healthz', async () => {
    await app.close();
    app = createApp({
      logDir,
      rules: { ...DEFAULT_RULES, wallSlidePercent: 50 },
      env: { SHOT_LEAD_TICKS: '2', TANKS_BUILD: 'abc1234' },
      room: FAST_ROOM,
      tickMs: TICK_MS,
    });
    port = await app.listen(0, '127.0.0.1');
    expect((await healthz()).build).toBe('abc1234');
    const [a] = await joinedPair('leadrules');
    expect(lastRoundStart.rules).toEqual({ wallSlidePercent: 50, shotLeadTicks: 2, shotInheritPercent: 0 });
    await snapshotAfterCountdown(a);
    await app.close();
    expect(logLines(lastRoundStart.gameId).join('\n')).toContain(
      'game start room=leadrules p0=Алиса p1=Боб rules=50 lead=2 inherit=0\n',
    );
    expect(logLines(lastRoundStart.gameId)[1]).toMatch(/ S gt=0 tc=00:00 build server=abc1234$/);
  });

  it('отвергает недопустимый ключ или источник, слишком большое тело и не-POST', async () => {
    const base = `http://127.0.0.1:${String(port)}`;
    expect((await fetch(`${base}/log?key=../etc&src=C1`, { method: 'POST', body: 'x' })).status).toBe(400);
    expect((await fetch(`${base}/log?key=K7MF&src=client-0`, { method: 'POST', body: 'x' })).status).toBe(400);
    expect((await fetch(`${base}/log?key=K7MF&src=C123456`, { method: 'POST', body: 'x' })).status).toBe(400);
    expect((await fetch(`${base}/log?src=C1`, { method: 'POST', body: 'x' })).status).toBe(400);
    expect((await fetch(`${base}/log?key=K7MF`, { method: 'POST', body: 'x' })).status).toBe(400);
    const overLimit = 'y'.repeat(LOG_BODY_LIMIT_BYTES + 1);
    expect(await postInTwoParts(`${base}/log?key=K7MF&src=C1`, overLimit, 'z'.repeat(1024))).toBe(413);
    expect((await fetch(`${base}/log?key=K7MF&src=C1`)).status).toBe(404);
    await app.close();
    expect(existsSync(join(logDir, 'K7MF.log'))).toBe(false);
  });
});

describe('бой', () => {
  it('снимки идут каждый тик, в отсчёте танки стоят, после — ввод двигает танк и подтверждается', async () => {
    const [a] = await joinedPair('fight');
    const idle = await a.nextOfType(MessageType.Snapshot);
    expect(idle.tick).toBe(0);
    expect(idle.tanks[0].x).toBe(140);

    const first = await snapshotAfterCountdown(a);
    const seq = a.input({ throttle: 1 });
    let moved = await a.nextOfType(MessageType.Snapshot);
    while (moved.ackSeq < seq) {
      moved = await a.nextOfType(MessageType.Snapshot);
    }
    expect(moved.tick).toBeGreaterThan(first.tick);
    expect(moved.tanks[0].x).toBeGreaterThan(140);
    expect(moved.tanks[0].speed).toBeGreaterThan(0);
    expect(moved.tanks[1].x).toBe(1460);
  });

  it('выстрел порождает снаряд и событие', async () => {
    const [a] = await joinedPair('shoot');
    await snapshotAfterCountdown(a);
    a.input({ isFiring: true });
    let snapshot = await a.nextOfType(MessageType.Snapshot);
    while (snapshot.events.every((event) => event.kind !== 'shot')) {
      snapshot = await a.nextOfType(MessageType.Snapshot);
    }
    expect(snapshot.bullets.length).toBe(1);
    expect(snapshot.bullets[0]?.owner).toBe(0);
    expect(snapshot.tanks[0].reloadLeft).toBeGreaterThan(0);
  });

  it('снаряд о стену даёт рикошет, затем удар', async () => {
    const [a] = await joinedPair('wall');
    await snapshotAfterCountdown(a);
    a.input({ isFiring: true });
    const seen = new Set<string>();
    const deadline = Date.now() + 5000;
    const isDone = (): boolean => seen.has('ricochet') && (seen.has('impact') || seen.has('clash'));
    while (!isDone() && Date.now() < deadline) {
      const snapshot = await a.nextOfType(MessageType.Snapshot);
      a.input({ isFiring: true });
      for (const event of snapshot.events) {
        seen.add(event.kind);
      }
    }
    expect(seen.has('shot')).toBe(true);
    expect(isDone()).toBe(true);
  }, 10000);

  it('устаревший и слишком частый ввод отбрасывается, через секунду лимит сбрасывается', async () => {
    const [a] = await joinedPair('spam');
    await snapshotAfterCountdown(a);
    for (let i = 0; i < 200; i++) {
      a.input({ throttle: 1 });
    }
    a.send({ type: MessageType.Input, seq: 1, action: { throttle: -1, turn: 0, turretTurn: 0, isFiring: false } });
    let snapshot = await a.nextOfType(MessageType.Snapshot);
    while (snapshot.ackSeq === 0) {
      snapshot = await a.nextOfType(MessageType.Snapshot);
    }
    expect(snapshot.ackSeq).toBeLessThanOrEqual(FAST_ROOM.maxInputsPerSecond);
    expect(snapshot.tanks[0].speed).toBeGreaterThan(0);

    await sleep(40 * TICK_MS);
    const lateSeq = a.input({ throttle: 1 });
    const deadline = Date.now() + 2000;
    let acked = await a.nextOfType(MessageType.Snapshot);
    while (acked.ackSeq < lateSeq && Date.now() < deadline) {
      acked = await a.nextOfType(MessageType.Snapshot);
    }
    expect(acked.ackSeq).toBe(lateSeq);
  });

  it('отвечает на ping текущим тиком', async () => {
    const [a] = await joinedPair('ping');
    a.send({ type: MessageType.Ping, clientTime: 42.5 });
    const pong = await a.nextOfType(MessageType.Pong);
    expect(pong.clientTime).toBe(42.5);
    expect(pong.serverTick).toBeGreaterThanOrEqual(0);
  });

  it('ввод до входа в комнату игнорируется', async () => {
    const a = await connect();
    a.input({ throttle: 1 });
    a.send({ type: MessageType.Ping, clientTime: 1 });
    await expect(a.next(200)).rejects.toThrow();
  });
});

describe('догон снаряда', () => {
  const WAIT_MS = 10_000;
  const LEAD_TICKS = 2;
  // Снимок после тика выстрела: обычный снаряд прошёл один шаг, догнанный — ещё LEAD_TICKS.
  const PLAIN_AGE = DT;
  const LEAD_AGE = (LEAD_TICKS + 1) * DT;
  let logDir: string;

  beforeEach(async () => {
    await app.close();
    logDir = mkdtempSync(join(tmpdir(), 'tanks-lead-'));
  });

  afterEach(async () => {
    await app.close();
    rmSync(logDir, { recursive: true, force: true });
  });

  async function start(env: Record<string, string>): Promise<void> {
    app = createApp({ logDir, env, room: FAST_ROOM, random: seededRandom(42), tickMs: TICK_MS });
    port = await app.listen(0, '127.0.0.1');
  }

  function gameLog(gameId: string): string {
    return readFileSync(join(logDir, `${gameId}.log`), 'utf8');
  }

  it.each([['-1'], ['7'], ['1.5'], ['два']])(
    'SHOT_LEAD_TICKS=«%s» — createApp бросает ошибку с именем переменной',
    (value) => {
      expect(() => createApp({ env: { SHOT_LEAD_TICKS: value } })).toThrow('SHOT_LEAD_TICKS');
    },
  );

  it.each([
    ['', 0],
    ['0', 0],
    ['6', 6],
  ])('SHOT_LEAD_TICKS=«%s» — догон %i в RoundStart', async (value, expected) => {
    await start({ SHOT_LEAD_TICKS: value });
    const human = await connect();
    human.join(botRoomCode(1, 'lead'), 'Дима');
    expect((await human.nextOfType(MessageType.RoundStart)).rules.shotLeadTicks).toBe(expected);
  });

  it('дуэль с двойником при догоне 2: снаряд человека рождается на два тика дальше, снаряд двойника — нет', async () => {
    await start({ SHOT_LEAD_TICKS: String(LEAD_TICKS) });
    const human = await connect();
    human.join(twinRoomCode('lead'), 'Дима');
    const roundStart = await human.nextOfType(MessageType.RoundStart);
    expect(roundStart.rules).toEqual({ wallSlidePercent: 0, shotLeadTicks: LEAD_TICKS, shotInheritPercent: 0 });
    const firstAge = new Map<number, number>();
    const seen = new Set<number>();
    for (let i = 0; i < TWIN_WATCH_SNAPSHOTS && firstAge.size < 2; i++) {
      const snapshot = await human.nextOfType(MessageType.Snapshot);
      human.input({ isFiring: true });
      for (const bullet of snapshot.bullets) {
        if (!seen.has(bullet.id) && !firstAge.has(bullet.owner)) {
          firstAge.set(bullet.owner, bullet.age);
        }
        seen.add(bullet.id);
      }
    }
    expect(firstAge.get(1)).toBeCloseTo(LEAD_AGE, 9);
    expect(firstAge.get(0)).toBeCloseTo(PLAIN_AGE, 9);
    await app.close();
    expect(gameLog(roundStart.gameId)).toContain(`p1=Дима rules=0 lead=${String(LEAD_TICKS)} inherit=0`);
  });

  it('бой толпы при догоне 2: правило в FfaWelcome и game start; снаряд человека дальше, снаряд бота — нет', async () => {
    await start({
      SHOT_LEAD_TICKS: String(LEAD_TICKS),
      TANKS_BUILD: 'abc1234',
      FFA_SERVER_BOTS: '0',
      FFA_MINIMUM: '2',
      FFA_LOBBY_WAIT_SECONDS: '1',
    });
    const human = await connect();
    human.join('ffa10', 'Дима');
    const welcome = await human.nextOfType(MessageType.FfaWelcome);
    expect(welcome.rules).toEqual({ wallSlidePercent: 0, shotLeadTicks: LEAD_TICKS, shotInheritPercent: 0 });
    const bot = await connect();
    bot.join('ffa10', 'Бот', undefined, undefined, '', true);
    const botId = (await bot.nextOfType(MessageType.FfaWelcome)).playerId;
    const firstAge = new Map<number, number>();
    const deadline = Date.now() + WAIT_MS;
    while (firstAge.size < 2 && Date.now() < deadline) {
      const snapshot = await human.nextOfType(MessageType.FfaSnapshot, WAIT_MS);
      human.input({ isFiring: true });
      for (const message of bot.takeQueued()) {
        if (message.type === MessageType.FfaSnapshot) {
          bot.input({ isFiring: true });
        }
      }
      for (const birth of snapshot.births) {
        if (!firstAge.has(birth.owner)) {
          firstAge.set(birth.owner, birth.age);
        }
      }
    }
    expect(firstAge.get(welcome.playerId)).toBeCloseTo(LEAD_AGE, 9);
    expect(firstAge.get(botId)).toBeCloseTo(PLAIN_AGE, 9);
    await app.close();
    expect(gameLog(welcome.gameId)).toContain(
      `game start mode=ffa size=10 rules=0 lead=${String(LEAD_TICKS)} inherit=0`,
    );
    expect(gameLog(welcome.gameId)).toMatch(/inherit=0\n\S+ S gt=0 tc=00:00 build server=abc1234\n/);
  });
});

describe('снаряд со скоростью танка', () => {
  const INHERIT_PERCENT = 100;
  const BULLET_SPEED = deriveStats(DEFAULT_STATS).bulletSpeed;
  // Сколько снимков газовать до выстрела: танк успевает разогнаться.
  const GAS_SNAPSHOTS = 20;
  let logDir: string;

  beforeEach(async () => {
    await app.close();
    logDir = mkdtempSync(join(tmpdir(), 'tanks-inherit-'));
  });

  afterEach(async () => {
    await app.close();
    rmSync(logDir, { recursive: true, force: true });
  });

  async function start(env: Record<string, string>): Promise<void> {
    app = createApp({ logDir, env, room: FAST_ROOM, random: seededRandom(42), tickMs: TICK_MS });
    port = await app.listen(0, '127.0.0.1');
  }

  it.each([['-1'], ['101'], ['1.5'], ['сто']])(
    'SHOT_INHERIT_PERCENT=«%s» — createApp бросает ошибку с именем переменной',
    (value) => {
      expect(() => createApp({ env: { SHOT_INHERIT_PERCENT: value } })).toThrow('SHOT_INHERIT_PERCENT');
    },
  );

  it.each([
    ['', 0],
    ['0', 0],
    ['50', 50],
  ])('SHOT_INHERIT_PERCENT=«%s» — наследование %i в RoundStart', async (value, expected) => {
    await start({ SHOT_INHERIT_PERCENT: value });
    const human = await connect();
    human.join(botRoomCode(1, 'inhr'), 'Дима');
    expect((await human.nextOfType(MessageType.RoundStart)).rules.shotInheritPercent).toBe(expected);
  });

  it('при 100 снаряд едущего человека получает скорость танка; правило в RoundStart и game start', async () => {
    await start({ SHOT_INHERIT_PERCENT: String(INHERIT_PERCENT) });
    const human = await connect();
    human.join(botRoomCode(1, 'inhr'), 'Дима');
    const roundStart = await human.nextOfType(MessageType.RoundStart);
    expect(roundStart.rules).toEqual({ wallSlidePercent: 0, shotLeadTicks: 0, shotInheritPercent: INHERIT_PERCENT });
    const mySide = 1;
    let gasLeft = GAS_SNAPSHOTS;
    let carried: { vx: number; vy: number; expectedVx: number; expectedVy: number } | null = null;
    for (let i = 0; i < TWIN_WATCH_SNAPSHOTS && carried === null; i++) {
      const snapshot = await human.nextOfType(MessageType.Snapshot);
      const me = snapshot.tanks[mySide];
      const born = snapshot.bullets.find((bullet) => bullet.owner === mySide);
      if (born !== undefined) {
        carried = {
          vx: born.vx,
          vy: born.vy,
          expectedVx: Math.cos(me.turret) * BULLET_SPEED + Math.cos(me.heading) * me.speed,
          expectedVy: Math.sin(me.turret) * BULLET_SPEED + Math.sin(me.heading) * me.speed,
        };
      }
      const isMoving = snapshot.tick > roundStart.countdownTicks;
      gasLeft -= isMoving ? 1 : 0;
      human.input({ throttle: 1, turretTurn: 0.5, isFiring: gasLeft <= 0 });
    }
    expect(carried).not.toBeNull();
    expect(carried?.vx).toBeCloseTo(carried?.expectedVx ?? NaN, 6);
    expect(carried?.vy).toBeCloseTo(carried?.expectedVy ?? NaN, 6);
    expect(Math.hypot(carried?.vx ?? 0, carried?.vy ?? 0)).not.toBeCloseTo(BULLET_SPEED, 0);
    await app.close();
    expect(readFileSync(join(logDir, `${roundStart.gameId}.log`), 'utf8')).toContain(
      `p1=Дима rules=0 lead=0 inherit=${String(INHERIT_PERCENT)}`,
    );
  });
});

describe('сглаживание дёрганой сети', () => {
  beforeEach(async () => {
    await app.close();
  });

  async function start(env: Record<string, string>): Promise<void> {
    app = createApp({ env, room: FAST_ROOM, random: seededRandom(42), tickMs: TICK_MS });
    port = await app.listen(0, '127.0.0.1');
  }

  it.each([['2'], ['да'], ['on']])('NET_SMOOTHING=«%s» — createApp бросает ошибку с именем переменной', (value) => {
    expect(() => createApp({ env: { NET_SMOOTHING: value } })).toThrow('NET_SMOOTHING');
  });

  it.each([
    ['', false],
    ['0', false],
    ['1', true],
  ])('NET_SMOOTHING=«%s» — признак %s в Welcome дуэли и FfaWelcome', async (value, expected) => {
    await start({ NET_SMOOTHING: value });
    const duelist = await connect();
    duelist.join('smooth', 'Дима');
    expect((await duelist.nextOfType(MessageType.Welcome)).hasNetSmoothing).toBe(expected);
    const fighter = await connect();
    fighter.join('ffa10', 'Дима');
    expect((await fighter.nextOfType(MessageType.FfaWelcome)).hasNetSmoothing).toBe(expected);
  });
});
