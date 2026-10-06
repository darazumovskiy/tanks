import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STATS,
  DT,
  normalizeAngle,
  TICK_RATE,
  TURRET_RATE,
  type Action,
  type FfaMap,
  type Stats,
} from '@tanks/shared/engine';
import {
  ErrorCode,
  EventFlag,
  FFA_JOURNAL,
  FfaInviteMiss,
  FfaPhase,
  MessageType,
  PROTOCOL_VERSION,
  replayFfaJournal,
  type FfaScoreMessage,
  type FfaSnapshotEvent,
  type FfaSnapshotMessage,
  type FfaTankSnapshot,
  type FfaWelcomeMessage,
  type ServerMessage,
} from '@tanks/shared/protocol';
import { createApp, type App, type AppOptions } from '../src/app.js';
import { DEFAULT_FFA_OPTIONS, type FfaOptions } from '../src/ffaGame.js';
import { TestClient } from './client.js';
import { sleep } from './support.js';

const TEST_MAP: FfaMap = {
  name: 'Проба',
  size: 10,
  seed: 1,
  width: 1600,
  height: 900,
  walls: [],
  kits: [{ x: 800, y: 450 }],
  spawnAreas: [
    { x: 200, y: 450, radius: 60 },
    { x: 1400, y: 450, radius: 60 },
    { x: 800, y: 150, radius: 60 },
    { x: 800, y: 750, radius: 60 },
    { x: 200, y: 150, radius: 60 },
    { x: 1400, y: 750, radius: 60 },
    { x: 200, y: 750, radius: 60 },
    { x: 1400, y: 150, radius: 60 },
  ],
};

// Финал — когда зона накрыла угловые места появления; углы замурованы стенами, поэтому все появляются в центре,
// куда зона не доходит: в финале никого не ранит зона, гибнут только от снарядов.
const HUDDLE_MAP: FfaMap = {
  ...TEST_MAP,
  name: 'Центр',
  walls: [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 1500, y: 0, w: 100, h: 100 },
    { x: 0, y: 800, w: 100, h: 100 },
    { x: 1500, y: 800, w: 100, h: 100 },
  ],
  kits: [],
  spawnAreas: [
    { x: 50, y: 50, radius: 20 },
    { x: 1550, y: 50, radius: 20 },
    { x: 50, y: 850, radius: 20 },
    { x: 1550, y: 850, radius: 20 },
    { x: 700, y: 450, radius: 40 },
    { x: 900, y: 450, radius: 40 },
    { x: 800, y: 350, radius: 40 },
    { x: 800, y: 550, radius: 40 },
  ],
};

// Лимит ввода не проверяется: при тике в 1 мс он мешал бы скриптам, которые шлют ввод на каждый снимок.
// Матч 600 с: при тике 1 мс финал наступает через ~10 с настоящего времени и не вмешивается в сценарии.
// Игру заполняют сами тесты: серверные боты — в ffaBots.test.ts.
const FAST: FfaOptions = {
  ...DEFAULT_FFA_OPTIONS,
  hasServerBots: false,
  countdownTicks: 3,
  resultsTicks: 5,
  lobbyWaitTicks: 5,
  reconnectTicks: 2000,
  idleWarnTicks: 1_000_000,
  idleKickTicks: 2_000_000,
  matchSeconds: 600,
  maxInputsPerSecond: 100_000,
  minimum: { 10: 2, 30: 2, 50: 2 },
  mapFor: () => TEST_MAP,
};
const SHOOTER: Stats = { armor: 0, engine: 0, gun: 5, reload: 5 };
const TARGET: Stats = { armor: 0, engine: 5, gun: 0, reload: 5 };
const AIM_TOLERANCE = 0.02;
const AWAY_TOLERANCE = 0.3;
const SCRIPT_TIMEOUT_MS = 20_000;
const STILL: Action = { throttle: 0, turn: 0, turretTurn: 0, isFiring: false };

let app: App | null = null;
let port = 0;
const clients: TestClient[] = [];

async function startApp(overrides: Partial<FfaOptions> = {}, appOptions: AppOptions = {}): Promise<App> {
  const started = createApp({ ffa: { ...FAST, ...overrides }, tickMs: 1, ...appOptions });
  app = started;
  port = await started.listen(0, '127.0.0.1');
  return started;
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await app?.close();
  app = null;
  unconfirmedTurns.clear();
});

interface Entered {
  client: TestClient;
  welcome: FfaWelcomeMessage;
}

interface EnterOptions {
  nickname?: string;
  stats?: Stats;
  token?: string;
  isBot?: boolean;
  gameId?: string;
}

async function enter(code = 'ffa10', options: EnterOptions = {}): Promise<Entered> {
  const client = await TestClient.connect(port);
  clients.push(client);
  client.join(
    code,
    options.nickname ?? 'Тест',
    options.stats ?? DEFAULT_STATS,
    PROTOCOL_VERSION,
    options.token ?? '',
    options.isBot ?? false,
    options.gameId ?? '',
  );
  return { client, welcome: await client.nextOfType(MessageType.FfaWelcome) };
}

async function waitFor<T extends ServerMessage['type']>(
  client: TestClient,
  type: T,
  predicate: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  timeoutMs = 5000,
): Promise<Extract<ServerMessage, { type: T }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await client.nextOfType(type, deadline - Date.now());
    if (predicate(message)) {
      return message;
    }
  }
  throw new Error(`не дождались нужного сообщения типа ${String(type)}`);
}

// Выбрасывает уже пришедшее: ожидание дальше видит только то, что сервер пришлёт после действия теста.
async function drain(...targets: TestClient[]): Promise<void> {
  await sleep(50);
  for (const client of targets) {
    client.takeQueued();
  }
}

function isSnapshot(message: ServerMessage): message is FfaSnapshotMessage {
  return message.type === MessageType.FfaSnapshot;
}

// Все снимки, накопившиеся с прошлого шага, — тест отстаёт от сервера на 1 мс/тик.
async function freshSnapshots(client: TestClient): Promise<FfaSnapshotMessage[]> {
  const first = await client.nextOfType(MessageType.FfaSnapshot);
  return [first, ...client.takeQueued().filter(isSnapshot)];
}

function tankOf(snapshot: FfaSnapshotMessage, id: number): FfaTankSnapshot | undefined {
  return snapshot.tanks.find((tank) => tank.id === id);
}

// Газ чередуется ±0,02: команда меняется каждый раз, и стрелок не попадает под бездействие.
let jitter = 1;

function fidget(): Action {
  jitter = -jitter;
  return { ...STILL, throttle: jitter * 0.02 };
}

function aimAt(me: FfaTankSnapshot, target: { x: number; y: number }): Action {
  const diff = normalizeAngle(Math.atan2(target.y - me.y, target.x - me.x) - me.turret);
  const turretTurn = Math.max(-1, Math.min(1, diff / (TURRET_RATE * DT)));
  return { ...fidget(), turretTurn, isFiring: Math.abs(diff) < AIM_TOLERANCE };
}

const unconfirmedTurns = new Map<TestClient, { seq: number; turretTurn: number }[]>();

// Стрелок наводится на живую цель; цели нет — ёрзает, чтобы его не выкинуло за бездействие. Башню он доворачивает
// от места, куда её приведут уже отправленные, но ещё не применённые команды, — как настоящий клиент: иначе команда,
// ждущая в очереди сервера, проворачивает башню мимо цели.
function hunt(shooter: TestClient, snapshot: FfaSnapshotMessage, shooterId: number, targetId: number): void {
  const me = tankOf(snapshot, shooterId);
  const enemy = tankOf(snapshot, targetId);
  if (me === undefined) {
    return;
  }
  const unconfirmed = (unconfirmedTurns.get(shooter) ?? []).filter((entry) => entry.seq > snapshot.ackSeq);
  const turret = unconfirmed.reduce(
    (angle, entry) => normalizeAngle(angle + entry.turretTurn * TURRET_RATE * DT),
    me.turret,
  );
  const action = enemy?.isAlive === true ? aimAt({ ...me, turret }, enemy) : fidget();
  const seq = shooter.input(action);
  unconfirmedTurns.set(shooter, [...unconfirmed, { seq, turretTurn: action.turretTurn }]);
}

// Снимки у теста отстают от сервера, а команда действует до следующей: башня, повёрнутая по снимку, проскочит цель.
// Поэтому башня поворачивается шагами и каждый раз останавливается; направление проверяется по снимку после остановки.
// Снаряд от соперника (угол больше прямого) долетает до края поля, а не гибнет на чужом танке.
async function turnAway(shooter: Entered, enemyId: number): Promise<void> {
  const deadline = Date.now() + SCRIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const stopSeq = shooter.client.input(STILL);
    const stopped = await waitFor(shooter.client, MessageType.FfaSnapshot, (message) => message.ackSeq >= stopSeq);
    const me = tankOf(stopped, shooter.welcome.playerId);
    const enemy = tankOf(stopped, enemyId);
    if (me === undefined || enemy === undefined) {
      throw new Error('нет танков в снимке');
    }
    const toEnemy = Math.atan2(enemy.y - me.y, enemy.x - me.x);
    if (Math.abs(normalizeAngle(me.turret - toEnemy)) > Math.PI / 2) {
      return;
    }
    const turnSeq = shooter.client.input({ ...STILL, turretTurn: 1 });
    await waitFor(shooter.client, MessageType.FfaSnapshot, (message) => message.ackSeq >= turnSeq);
  }
  throw new Error('башня не отвернулась от соперника');
}

async function fightPair(statsA: Stats = DEFAULT_STATS, statsB: Stats = DEFAULT_STATS): Promise<[Entered, Entered]> {
  const a = await enter('ffa10', { nickname: 'А', stats: statsA });
  const b = await enter('ffa10', { nickname: 'Б', stats: statsB });
  await waitFor(a.client, MessageType.FfaState, (state) => state.phase === FfaPhase.Fight);
  await waitFor(b.client, MessageType.FfaState, (state) => state.phase === FfaPhase.Fight);
  return [a, b];
}

describe('вход в общую игру', () => {
  it('ffa10: приветствие, состав, лобби 1 из 10', async () => {
    await startApp();
    const { client, welcome } = await enter('ffa10', { nickname: 'Дима' });
    expect(welcome).toMatchObject({ playerId: 1, size: 10, rules: { wallSlidePercent: 0 } });
    expect(welcome.gameId).toMatch(/^[2-9A-Z]{4}$/);
    expect(welcome.token.length).toBeGreaterThanOrEqual(16);
    const roster = await client.nextOfType(MessageType.FfaRoster);
    expect(roster.players).toEqual([{ id: 1, nickname: 'Дима', stats: DEFAULT_STATS, isBot: false }]);
    const state = await client.nextOfType(MessageType.FfaState);
    expect(state).toMatchObject({
      phase: FfaPhase.Lobby,
      ticksLeft: null,
      players: 1,
      capacity: 10,
      minimum: 2,
      matchIndex: 0,
    });
  });

  it.each(['ffa11', 'ffa'])('код %s — ошибка и разрыв', async (code) => {
    await startApp();
    const client = await TestClient.connect(port);
    clients.push(client);
    client.join(code);
    const error = await client.nextOfType(MessageType.Error);
    expect(error.code).toBe(ErrorCode.BadMessage);
    expect(await client.closed()).toBe(true);
  });

  it('код ffaxyz — комната дуэли', async () => {
    await startApp();
    const client = await TestClient.connect(port);
    clients.push(client);
    client.join('ffaxyz');
    const welcome = await client.nextOfType(MessageType.Welcome);
    expect(welcome.roomCode).toBe('ffaxyz');
  });

  it('бот виден в составе у всех', async () => {
    await startApp();
    const human = await enter('ffa10', { nickname: 'Человек' });
    await enter('ffa10', { nickname: 'Робот', isBot: true });
    const roster = await waitFor(human.client, MessageType.FfaRoster, (message) => message.players.length === 2);
    expect(roster.players.map((player) => [player.nickname, player.isBot])).toEqual([
      ['Человек', false],
      ['Робот', true],
    ]);
  });

  it('Ping в игре — Pong', async () => {
    await startApp();
    const { client } = await enter();
    client.send({ type: MessageType.Ping, clientTime: 12.5 });
    const pong = await client.nextOfType(MessageType.Pong);
    expect(pong.clientTime).toBe(12.5);
  });
});

describe('лобби и подбор', () => {
  it('игра заполнилась — отсчёт сразу; у каждого свой снимок со всеми танками и своим ackSeq', async () => {
    await startApp({ minimum: { 10: 10, 30: 2, 50: 2 }, lobbyWaitTicks: 1_000_000 });
    const players: Entered[] = [];
    for (let i = 0; i < 10; i++) {
      players.push(await enter('ffa10', { nickname: `Игрок ${String(i)}` }));
    }
    const first = players[0];
    const last = players[9];
    if (first === undefined || last === undefined) {
      throw new Error('нет игроков');
    }
    const full = await waitFor(first.client, MessageType.FfaState, (state) => state.players === 10);
    expect(full).toMatchObject({ phase: FfaPhase.Lobby, ticksLeft: 0 });
    await waitFor(first.client, MessageType.FfaState, (state) => state.phase === FfaPhase.Countdown);
    const start = await first.client.nextOfType(MessageType.FfaMatchStart);
    expect(start.matchIndex).toBe(1);
    expect(start.durationSeconds).toBe(600);
    const snapshot = await first.client.nextOfType(MessageType.FfaSnapshot);
    expect(snapshot.tanks).toHaveLength(10);
    expect(snapshot.self.state).toBe('alive');

    const seq = last.client.input({ turretTurn: 1 });
    const acked = await waitFor(last.client, MessageType.FfaSnapshot, (message) => message.ackSeq === seq);
    expect(acked.ackSeq).toBe(seq);
    const other = await first.client.nextOfType(MessageType.FfaSnapshot);
    expect(other.ackSeq).toBe(0);
  });

  it('набран минимум — старт через ожидание; вход после минимума старт не отодвигает', async () => {
    const wait = 300;
    await startApp({ minimum: { 10: 3, 30: 2, 50: 2 }, lobbyWaitTicks: wait });
    const a = await enter();
    const below = await waitFor(a.client, MessageType.FfaState, (state) => state.players === 2 || state.players === 1);
    expect(below.ticksLeft).toBeNull();
    await enter();
    await enter();
    const atMinimum = await waitFor(a.client, MessageType.FfaState, (state) => state.players === 3);
    expect(atMinimum.ticksLeft).toBe(wait);
    await sleep(30);
    await enter();
    const later = await waitFor(a.client, MessageType.FfaState, (state) => state.players === 4);
    expect(later.ticksLeft).not.toBeNull();
    expect(later.ticksLeft ?? wait).toBeLessThan(wait);
    const countdown = await waitFor(a.client, MessageType.FfaState, (state) => state.phase === FfaPhase.Countdown);
    expect(countdown.players).toBe(4);
  });

  it('набран минимум, один ушёл и снова вошёл — ожидание с начала', async () => {
    const wait = 600;
    await startApp({ minimum: { 10: 2, 30: 2, 50: 2 }, lobbyWaitTicks: wait, reconnectTicks: 5 });
    const a = await enter();
    const b = await enter();
    await waitFor(a.client, MessageType.FfaState, (state) => state.players === 2);
    await sleep(50);
    b.client.close();
    const alone = await waitFor(a.client, MessageType.FfaState, (state) => state.players === 1);
    expect(alone.ticksLeft).toBeNull();
    await enter();
    const again = await waitFor(a.client, MessageType.FfaState, (state) => state.players === 2);
    expect(again.ticksLeft).toBe(wait);
  });

  it('мест нет — новая игра; вошедший — в ту из открытых, где больше игроков', async () => {
    const started = await startApp({ minimum: { 10: 10, 30: 2, 50: 2 }, reconnectTicks: 10 });
    const first: Entered[] = [];
    for (let i = 0; i < 10; i++) {
      first.push(await enter());
    }
    const gameA = first[0]?.welcome.gameId;
    const second: Entered[] = [];
    for (let i = 0; i < 5; i++) {
      second.push(await enter());
    }
    const gameB = second[0]?.welcome.gameId;
    expect(gameB).not.toBe(gameA);
    expect(second.every((entered) => entered.welcome.gameId === gameB)).toBe(true);
    expect(started.stats().rooms).toBe(2);

    const witness = first[0];
    if (witness === undefined) {
      throw new Error('нет игрока');
    }
    await drain(witness.client);
    first[9]?.client.close();
    await waitFor(witness.client, MessageType.FfaRoster, (roster) => roster.players.length === 9, 10_000);
    const toFuller = await enter();
    expect(toFuller.welcome.gameId).toBe(gameA);

    await drain(witness.client);
    for (const entered of first.slice(2, 9)) {
      entered.client.close();
    }
    toFuller.client.close();
    await waitFor(witness.client, MessageType.FfaRoster, (roster) => roster.players.length === 2, 10_000);
    const newcomer = await enter();
    expect(newcomer.welcome.gameId).toBe(gameB);
  }, 30_000);
});

describe('приглашение друга', () => {
  async function fillGame(count: number): Promise<Entered[]> {
    const entered: Entered[] = [];
    for (let i = 0; i < count; i++) {
      entered.push(await enter());
    }
    return entered;
  }

  it('в игре позвавшего есть место — друг в ней, хотя подбор выбрал бы другую; без номера — без промаха', async () => {
    await startApp({ minimum: { 10: 10, 30: 2, 50: 2 }, reconnectTicks: 10 });
    const full = await fillGame(10);
    const host = await enter();
    expect(host.welcome.inviteMiss).toBe(FfaInviteMiss.None);
    const witness = full[0];
    if (witness === undefined) {
      throw new Error('нет игрока');
    }
    await drain(witness.client);
    full[9]?.client.close();
    await waitFor(witness.client, MessageType.FfaRoster, (roster) => roster.players.length === 9, 10_000);

    const friend = await enter('ffa10', { gameId: host.welcome.gameId });
    expect(friend.welcome.gameId).toBe(host.welcome.gameId);
    expect(friend.welcome.inviteMiss).toBe(FfaInviteMiss.None);
  }, 30_000);

  it('игра позвавшего заполнена людьми — друг в другой игре, промах Full', async () => {
    await startApp({ minimum: { 10: 10, 30: 2, 50: 2 } });
    const full = await fillGame(10);
    const hostGame = full[0]?.welcome.gameId ?? '';
    const friend = await enter('ffa10', { gameId: hostGame });
    expect(friend.welcome.gameId).not.toBe(hostGame);
    expect(friend.welcome.inviteMiss).toBe(FfaInviteMiss.Full);
  }, 30_000);

  it('игры позвавшего уже нет — друг в новой игре, промах Gone', async () => {
    const started = await startApp({ reconnectTicks: 20 });
    const host = await enter();
    host.client.close();
    const deadline = Date.now() + 5000;
    while (started.stats().rooms > 0 && Date.now() < deadline) {
      await sleep(10);
    }
    expect(started.stats().rooms).toBe(0);
    const friend = await enter('ffa10', { gameId: host.welcome.gameId });
    expect(friend.welcome.gameId).not.toBe(host.welcome.gameId);
    expect(friend.welcome.inviteMiss).toBe(FfaInviteMiss.Gone);
  });

  it('мусорный номер и номер игры другого размера — обычный подбор, промах Gone', async () => {
    await startApp();
    const host = await enter('ffa30');
    const lobby = await enter();
    const junk = await enter('ffa10', { gameId: 'не-номер!' });
    expect(junk.welcome.gameId).toBe(lobby.welcome.gameId);
    expect(junk.welcome.inviteMiss).toBe(FfaInviteMiss.Gone);
    const otherSize = await enter('ffa10', { gameId: host.welcome.gameId });
    expect(otherSize.welcome.gameId).toBe(lobby.welcome.gameId);
    expect(otherSize.welcome.inviteMiss).toBe(FfaInviteMiss.Gone);
  });

  it('пропуск главнее номера: игрок возвращается на своё место в своей игре', async () => {
    await startApp({ minimum: { 10: 10, 30: 2, 50: 2 } });
    const full = await fillGame(10);
    const own = full[0];
    const other = await enter();
    if (own === undefined) {
      throw new Error('нет игрока');
    }
    const back = await enter('ffa10', { token: own.welcome.token, gameId: other.welcome.gameId });
    expect(back.welcome.gameId).toBe(own.welcome.gameId);
    expect(back.welcome.playerId).toBe(own.welcome.playerId);
    expect(back.welcome.inviteMiss).toBe(FfaInviteMiss.None);
  }, 30_000);
});

describe('бой', () => {
  it('команда двигает свой танк; устаревший номер команды отброшен', async () => {
    await startApp();
    const [a] = await fightPair();
    const before = await a.client.nextOfType(MessageType.FfaSnapshot);
    const startX = tankOf(before, a.welcome.playerId)?.x ?? NaN;
    const startY = tankOf(before, a.welcome.playerId)?.y ?? NaN;
    let seq = 0;
    for (let i = 0; i < 5; i++) {
      seq = a.client.input({ throttle: 1 });
    }
    a.client.send({ type: MessageType.Input, seq: 1, action: STILL });
    const moved = await waitFor(a.client, MessageType.FfaSnapshot, (snapshot) => {
      const me = tankOf(snapshot, a.welcome.playerId);
      return me !== undefined && Math.hypot(me.x - startX, me.y - startY) > 20;
    });
    expect(moved.ackSeq).toBe(seq);
  });

  it('выстрел: рождение у всех, отскок от края со скоростью после отскока, гибель', async () => {
    await startApp();
    const [a, b] = await fightPair();
    await turnAway(a, b.welcome.playerId);
    a.client.input({ ...STILL, isFiring: true });
    const born = await waitFor(b.client, MessageType.FfaSnapshot, (snapshot) => snapshot.births.length > 0);
    a.client.input(STILL);
    const birth = born.births[0];
    expect(birth?.owner).toBe(a.welcome.playerId);
    expect(birth?.bouncesLeft).toBe(1);
    const bounced = await waitFor(
      b.client,
      MessageType.FfaSnapshot,
      (snapshot) => snapshot.bounces.some((bounce) => bounce.id === birth?.id),
      8000,
    );
    const bounce = bounced.bounces.find((entry) => entry.id === birth?.id);
    expect(Math.hypot(bounce?.vx ?? 0, bounce?.vy ?? 0)).toBeCloseTo(Math.hypot(birth?.vx ?? 0, birth?.vy ?? 0), 6);
    await waitFor(b.client, MessageType.FfaSnapshot, (snapshot) => snapshot.deaths.includes(birth?.id ?? -1), 8000);
  }, 30_000);

  it('убийство: смерть с убийцей у всех, счёт, убитый подбит → ждёт → снова на поле', async () => {
    await startApp();
    const [shooter, target] = await fightPair(SHOOTER, TARGET);
    const shooterId = shooter.welcome.playerId;
    const targetId = target.welcome.playerId;
    const events: FfaSnapshotEvent[] = [];
    const deadline = Date.now() + SCRIPT_TIMEOUT_MS;
    while (!events.some((event) => event.kind === 'death') && Date.now() < deadline) {
      const fresh = await freshSnapshots(shooter.client);
      events.push(...fresh.flatMap((snapshot) => snapshot.events));
      const latest = fresh[fresh.length - 1];
      if (latest !== undefined) {
        hunt(shooter.client, latest, shooterId, targetId);
      }
    }
    expect(events.find((event) => event.kind === 'death')).toMatchObject({ tank: targetId, by: shooterId });
    expect(events.some((event) => event.kind === 'shield' && event.tank === targetId)).toBe(true);
    const score = await waitFor(target.client, MessageType.FfaScore, (message) =>
      message.rows.some((row) => row.id === targetId && row.deaths === 1),
    );
    expect(score.rows.find((row) => row.id === shooterId)?.kills).toBe(1);
    await waitFor(target.client, MessageType.FfaSnapshot, (snapshot) => snapshot.self.state === 'wreck');
    const waiting = await waitFor(
      target.client,
      MessageType.FfaSnapshot,
      (snapshot) => snapshot.self.state === 'waiting',
    );
    expect(waiting.self.killerId).toBe(shooterId);
    const reborn = await waitFor(target.client, MessageType.FfaSnapshot, (snapshot) =>
      snapshot.events.some((event) => event.kind === 'spawn' && event.tank === targetId),
    );
    expect(reborn.self.state).toBe('alive');
  });

  it('конец матча: итоги без снимков, потом отсчёт нового матча с обнулённым счётом', async () => {
    await startApp({ matchSeconds: 2, resultsTicks: 50 });
    const [a] = await fightPair();
    const over = await waitFor(a.client, MessageType.FfaSnapshot, (snapshot) =>
      snapshot.events.some((event) => event.kind === 'matchOver'),
    );
    expect(over.events.some((event) => event.kind === 'matchOver')).toBe(true);
    const results = await waitFor(a.client, MessageType.FfaState, (state) => state.phase === FfaPhase.Results);
    expect(results.matchIndex).toBe(1);
    const duringResults: ServerMessage[] = [];
    for (;;) {
      const message = await a.client.next();
      if (message.type === MessageType.FfaState && message.phase === FfaPhase.Countdown) {
        expect(message.matchIndex).toBe(2);
        break;
      }
      duringResults.push(message);
    }
    expect(duringResults.filter(isSnapshot)).toHaveLength(0);
    const start = await a.client.nextOfType(MessageType.FfaMatchStart);
    expect(start.matchIndex).toBe(2);
    const score = await a.client.nextOfType(MessageType.FfaScore);
    expect(score.rows.every((row) => row.kills === 0 && row.deaths === 0 && row.damageTaken === 0)).toBe(true);
  });

  it('после итогов игроков меньше минимума — лобби', async () => {
    await startApp({ matchSeconds: 1, resultsTicks: 400, reconnectTicks: 10 });
    const [a, b] = await fightPair();
    await waitFor(a.client, MessageType.FfaState, (state) => state.phase === FfaPhase.Results, 8000);
    b.client.close();
    const lobby = await waitFor(a.client, MessageType.FfaState, (state) => state.phase === FfaPhase.Lobby, 8000);
    expect(lobby.players).toBe(1);
  });

  it('финал: человек, бот 1, бот 2 — бот 1 подбил человека, за него взорвался бот, бот 1 ушёл, пока человек в обломках: матч ждёт человека и кончается, когда он вернулся', async () => {
    await startApp({ matchSeconds: 200, reconnectTicks: 5, mapFor: () => HUDDLE_MAP }, { tickMs: 2 });
    const human = await enter('ffa10', { nickname: 'Мишень', stats: TARGET });
    const bot1 = await enter('ffa10', { nickname: 'Бот 1', stats: SHOOTER, isBot: true });
    const bot2 = await enter('ffa10', { nickname: 'Бот 2', isBot: true });
    const humanId = human.welcome.playerId;
    const bot1Id = bot1.welcome.playerId;
    await waitFor(
      human.client,
      MessageType.FfaSnapshot,
      (snapshot) => snapshot.events.some((event) => event.kind === 'suddenDeath'),
      SCRIPT_TIMEOUT_MS,
    );
    await drain(bot1.client);
    const events: FfaSnapshotEvent[] = [];
    const deadline = Date.now() + SCRIPT_TIMEOUT_MS;
    while (!events.some((event) => event.kind === 'death' && event.tank === humanId) && Date.now() < deadline) {
      const fresh = await freshSnapshots(bot1.client);
      events.push(...fresh.flatMap((snapshot) => snapshot.events));
      const latest = fresh[fresh.length - 1];
      if (latest !== undefined) {
        hunt(bot1.client, latest, bot1Id, humanId);
      }
    }
    bot1.client.close();
    // Шальной снаряд бота 1 мог подбить бота 2 раньше человека — тогда за человека взрывается сам бот 1.
    const humanDeathAt = events.findIndex((event) => event.kind === 'death' && event.tank === humanId);
    const isBot2DownFirst = events
      .slice(0, humanDeathAt)
      .some((event) => event.kind === 'death' && event.tank === bot2.welcome.playerId);
    const outTanks = events
      .filter((event) => event.kind === 'death' && (event.flags & EventFlag.Out) !== 0)
      .map((event) => event.tank);
    expect(outTanks).toEqual([isBot2DownFirst ? bot1Id : bot2.welcome.playerId]);

    const seen = { isDown: false, isBack: false, bot1LeftWhileDown: false, endedWhileDown: false };
    for (;;) {
      const message = await human.client.next(SCRIPT_TIMEOUT_MS);
      if (message.type === MessageType.FfaSnapshot) {
        seen.isBack ||= seen.isDown && message.self.state === 'alive';
        seen.isDown ||= message.self.state !== 'alive';
      }
      if (message.type === MessageType.FfaRoster && !message.players.some((player) => player.id === bot1Id)) {
        seen.bot1LeftWhileDown ||= seen.isDown && !seen.isBack;
      }
      if (message.type === MessageType.FfaState && message.phase === FfaPhase.Results) {
        seen.endedWhileDown = !seen.isBack;
        break;
      }
    }
    expect(seen).toEqual({ isDown: true, isBack: true, bot1LeftWhileDown: true, endedWhileDown: false });
  }, 30_000);
});

describe('вход посреди матча', () => {
  it('во время боя: расписание, летящий снаряд в полном списке, счёт со своей строкой; появляется на поле', async () => {
    // Тик 10 мс: снаряд живёт 4 с игры — 1,2 с настоящего времени, вход успевает застать его в полёте.
    await startApp({}, { tickMs: 10 });
    const [a, b] = await fightPair();
    const born = await waitFor(b.client, MessageType.FfaSnapshot, (snapshot) => {
      const me = tankOf(snapshot, a.welcome.playerId);
      const enemy = tankOf(snapshot, b.welcome.playerId);
      if (me !== undefined && enemy !== undefined) {
        // Под нагрузкой башня по запаздывающим снимкам качается вокруг точной наводки: стреляет, как только смотрит
        // примерно от соперника, — снаряду нужно только лететь, а не попасть.
        const away = normalizeAngle(Math.atan2(me.y - enemy.y, me.x - enemy.x) - me.turret);
        const aim = aimAt(me, { x: 2 * me.x - enemy.x, y: 2 * me.y - enemy.y });
        a.client.input({ ...aim, isFiring: Math.abs(away) < AWAY_TOLERANCE });
        a.client.takeQueued();
      }
      return snapshot.births.length > 0;
    });
    a.client.input(STILL);
    const late = await enter();
    const roster = await late.client.nextOfType(MessageType.FfaRoster);
    expect(roster.players).toHaveLength(3);
    const state = await late.client.nextOfType(MessageType.FfaState);
    expect(state.phase).toBe(FfaPhase.Fight);
    expect(state.ticksLeft).toBeGreaterThan(0);
    await late.client.nextOfType(MessageType.FfaMatchStart);
    const bullets = await late.client.nextOfType(MessageType.FfaBullets);
    expect(bullets.bullets.map((bullet) => bullet.id)).toContain(born.births[0]?.id);
    // На тике входа в матч снимок с появлением уходит раньше счёта.
    await waitFor(late.client, MessageType.FfaSnapshot, (snapshot) =>
      snapshot.events.some((event) => event.kind === 'spawn' && event.tank === late.welcome.playerId),
    );
    const score = await late.client.nextOfType(MessageType.FfaScore);
    expect(score.rows.some((row) => row.id === late.welcome.playerId)).toBe(true);
    await waitFor(a.client, MessageType.FfaRoster, (message) => message.players.length === 3);
  }, 30_000);

  it('во время отсчёта: в снимке «ждёт», с началом боя — на поле', async () => {
    await startApp({ countdownTicks: 400 });
    const a = await enter();
    await enter();
    await waitFor(a.client, MessageType.FfaState, (state) => state.phase === FfaPhase.Countdown);
    const late = await enter();
    const countdown = await waitFor(late.client, MessageType.FfaSnapshot, () => true);
    expect(countdown.self.state).toBe('waiting');
    expect(tankOf(countdown, late.welcome.playerId)).toBeUndefined();
    const fighting = await waitFor(late.client, MessageType.FfaSnapshot, (snapshot) => snapshot.self.state === 'alive');
    expect(tankOf(fighting, late.welcome.playerId)).toBeDefined();
  });

  it('в финале — зритель до конца матча, в счёт матча не входит', async () => {
    await startApp({ matchSeconds: 60 });
    const [a, b] = await fightPair();
    await waitFor(a.client, MessageType.FfaSnapshot, (snapshot) =>
      snapshot.events.some((event) => event.kind === 'suddenDeath'),
    );
    const late = await enter();
    const watching = await waitFor(
      late.client,
      MessageType.FfaSnapshot,
      (snapshot) => snapshot.self.state === 'spectator',
    );
    expect(tankOf(watching, late.welcome.playerId)).toBeUndefined();
    const score = await late.client.nextOfType(MessageType.FfaScore);
    expect(score.rows.map((row) => row.id).sort((x, y) => x - y)).toEqual(
      [a.welcome.playerId, b.welcome.playerId].sort((x, y) => x - y),
    );
  });
});

describe('обрыв и возврат', () => {
  it('возврат в окне: ехал и оборвался — танк встал; вернулся — тот же танк и счёт, команды с единицы', async () => {
    await startApp();
    const [a, b] = await fightPair();
    const id = a.welcome.playerId;
    for (let i = 0; i < 20; i++) {
      a.client.input({ throttle: 1 });
    }
    await waitFor(b.client, MessageType.FfaSnapshot, (snapshot) => (tankOf(snapshot, id)?.speed ?? 0) > 50);
    a.client.close();
    const stopped = await waitFor(b.client, MessageType.FfaSnapshot, (snapshot) => tankOf(snapshot, id)?.speed === 0);
    const parked = tankOf(stopped, id);
    await drain(b.client);
    const later = await b.client.nextOfType(MessageType.FfaSnapshot);
    expect(tankOf(later, id)).toMatchObject({ x: parked?.x, y: parked?.y });

    const back = await enter('ffa10', { token: a.welcome.token });
    expect(back.welcome).toMatchObject({ playerId: id, gameId: a.welcome.gameId });
    await back.client.nextOfType(MessageType.FfaRoster);
    const state = await back.client.nextOfType(MessageType.FfaState);
    expect(state.phase).toBe(FfaPhase.Fight);
    await back.client.nextOfType(MessageType.FfaMatchStart);
    await back.client.nextOfType(MessageType.FfaBullets);
    const score = await back.client.nextOfType(MessageType.FfaScore);
    expect(score.rows.some((row) => row.id === id)).toBe(true);
    const resumed = await back.client.nextOfType(MessageType.FfaSnapshot);
    expect(resumed.self.state).toBe('alive');
    expect(tankOf(resumed, id)).toMatchObject({ x: parked?.x, y: parked?.y });

    const seq = back.client.input({ throttle: 1 });
    expect(seq).toBe(1);
    const moving = await waitFor(
      back.client,
      MessageType.FfaSnapshot,
      (snapshot) => snapshot.ackSeq === seq && (tankOf(snapshot, id)?.speed ?? 0) > 0,
    );
    expect(moving.events.some((event) => event.kind === 'spawn' && event.tank === id)).toBe(false);
  });

  it('возврат, пока старое соединение живо: старое получает Replaced и закрыто; новое с команды 1 играет', async () => {
    await startApp();
    const [a] = await fightPair();
    let seq = 0;
    for (let i = 0; i < 5; i++) {
      seq = a.client.input({ turretTurn: 1 });
    }
    await waitFor(a.client, MessageType.FfaSnapshot, (snapshot) => snapshot.ackSeq === seq);
    const twin = await enter('ffa10', { token: a.welcome.token });
    expect(twin.welcome.playerId).toBe(a.welcome.playerId);
    const error = await a.client.nextOfType(MessageType.Error);
    expect(error.code).toBe(ErrorCode.Replaced);
    expect(await a.client.closed()).toBe(true);
    const first = twin.client.input({ throttle: 1 });
    expect(first).toBe(1);
    await waitFor(twin.client, MessageType.FfaSnapshot, (snapshot) => snapshot.ackSeq === first);
  });

  it('молчание дольше порога — сервер закрывает соединение, игрок в окне возврата; Ping держит связь', async () => {
    await startApp({}, { silenceTimeoutMs: 200 });
    const [a, b] = await fightPair();
    const keepAlive = setInterval(() => {
      a.client.send({ type: MessageType.Ping, clientTime: 0 });
    }, 50);
    try {
      expect(await b.client.closed(3000)).toBe(true);
      expect(await a.client.closed(400)).toBe(false);
      await drain(a.client);
      const snapshot = await a.client.nextOfType(MessageType.FfaSnapshot);
      expect(tankOf(snapshot, b.welcome.playerId)).toBeDefined();
    } finally {
      clearInterval(keepAlive);
    }
  });

  it('выход кнопкой: танк стоит, команды после Leave не применяются; убран через окно выхода, а не обрыва', async () => {
    await startApp({ reconnectTicks: 1_000_000, quitTicks: 300 });
    const [a, b] = await fightPair();
    const id = a.welcome.playerId;
    for (let i = 0; i < 20; i++) {
      a.client.input({ throttle: 1 });
    }
    await waitFor(b.client, MessageType.FfaSnapshot, (snapshot) => (tankOf(snapshot, id)?.speed ?? 0) > 50);
    a.client.send({ type: MessageType.Leave });
    await sleep(30);
    await drain(b.client);
    const before = tankOf(await b.client.nextOfType(MessageType.FfaSnapshot), id);
    for (let i = 0; i < 40; i++) {
      a.client.input({ turn: 1, turretTurn: 1 });
      await sleep(2);
    }
    await drain(b.client);
    const after = tankOf(await b.client.nextOfType(MessageType.FfaSnapshot), id);
    expect(after).toMatchObject({ heading: before?.heading, turret: before?.turret });
    a.client.close();
    const roster = await waitFor(b.client, MessageType.FfaRoster, (message) => message.players.length === 1, 10_000);
    expect(roster.players[0]?.id).toBe(b.welcome.playerId);
  });

  it('выход кнопкой и возврат в окне — то же место; следующий обрыв держит место полное окно', async () => {
    await startApp({ reconnectTicks: 1_000_000, quitTicks: 400 });
    const [a, b] = await fightPair();
    a.client.send({ type: MessageType.Leave });
    a.client.close();
    const back = await enter('ffa10', { token: a.welcome.token });
    expect(back.welcome).toMatchObject({ playerId: a.welcome.playerId, gameId: a.welcome.gameId });
    await drain(b.client);
    back.client.close();
    await sleep(800);
    const snapshot = await b.client.nextOfType(MessageType.FfaSnapshot);
    expect(tankOf(snapshot, a.welcome.playerId)).toBeDefined();
  });

  it('выход кнопкой в лобби — место отпущено сразу: игрок не держит минимум, старт снят', async () => {
    await startApp({ minimum: { 10: 2, 30: 2, 50: 2 }, lobbyWaitTicks: 1_000_000, quitTicks: 1_000_000 });
    const a = await enter();
    const b = await enter();
    const ready = await waitFor(a.client, MessageType.FfaState, (state) => state.players === 2);
    expect(ready.ticksLeft).not.toBeNull();
    b.client.send({ type: MessageType.Leave });
    const alone = await waitFor(a.client, MessageType.FfaState, (state) => state.players === 1, 2000);
    expect(alone).toMatchObject({ phase: FfaPhase.Lobby, ticksLeft: null });
  });

  it('выход кнопкой на итогах — место отпущено сразу: следующий матч без ушедшего', async () => {
    await startApp({ matchSeconds: 1, resultsTicks: 300, quitTicks: 1_000_000 });
    const [a, b] = await fightPair();
    await waitFor(a.client, MessageType.FfaState, (state) => state.phase === FfaPhase.Results, 10_000);
    b.client.send({ type: MessageType.Leave });
    const roster = await waitFor(a.client, MessageType.FfaRoster, (message) => message.players.length === 1, 2000);
    expect(roster.players[0]?.id).toBe(a.welcome.playerId);
    const lobby = await waitFor(a.client, MessageType.FfaState, (state) => state.phase === FfaPhase.Lobby, 5000);
    expect(lobby.players).toBe(1);
  });

  it('Leave до входа и повторный Leave — без последствий', async () => {
    await startApp({ quitTicks: 1_000_000 });
    const stranger = await TestClient.connect(port);
    clients.push(stranger);
    stranger.send({ type: MessageType.Leave });
    expect(await stranger.closed(200)).toBe(false);
    const [a, b] = await fightPair();
    a.client.send({ type: MessageType.Leave });
    a.client.send({ type: MessageType.Leave });
    a.client.send({ type: MessageType.Ping, clientTime: 1 });
    await expect(a.client.nextOfType(MessageType.Pong, 300)).rejects.toThrow();
    await drain(b.client);
    const snapshot = await b.client.nextOfType(MessageType.FfaSnapshot);
    expect(tankOf(snapshot, a.welcome.playerId)).toBeDefined();
  });

  it('чужой пропуск — новый игрок', async () => {
    await startApp();
    const a = await enter();
    const stranger = await enter('ffa10', { token: 'не-тот-пропуск' });
    expect(stranger.welcome.playerId).not.toBe(a.welcome.playerId);
    expect(stranger.welcome.token).not.toBe('не-тот-пропуск');
  });

  it('обрыв дольше окна: в бою — убран из матча и состава; последний ушёл из лобби — игра удалена', async () => {
    const started = await startApp({ reconnectTicks: 20 });
    const [a, b] = await fightPair();
    await drain(a.client);
    b.client.close();
    const roster = await waitFor(a.client, MessageType.FfaRoster, (message) => message.players.length === 1);
    expect(roster.players[0]?.id).toBe(a.welcome.playerId);
    await waitFor(a.client, MessageType.FfaSnapshot, (snapshot) => tankOf(snapshot, b.welcome.playerId) === undefined);

    const lonely = await enter('ffa30');
    expect(started.stats().rooms).toBe(2);
    lonely.client.close();
    const deadline = Date.now() + 5000;
    while (started.stats().rooms > 1 && Date.now() < deadline) {
      await sleep(10);
    }
    expect(started.stats().rooms).toBe(1);
  });
});

describe('бездействие', () => {
  it('отсчёт в снимке; смена команды снимает; на пороге — выход с ошибкой Idle, состав обновлён', async () => {
    // Тик — миллисекунда: окно между предупреждением и выходом должно пережить задержку разбора очереди под нагрузкой.
    await startApp({ idleWarnTicks: 60, idleKickTicks: 2060 });
    const [idle, busy] = await fightPair();
    let turret = 1;
    const keepBusy = (): void => {
      turret = -turret;
      busy.client.input({ turretTurn: turret });
      busy.client.takeQueued();
    };
    const warned = await waitFor(idle.client, MessageType.FfaSnapshot, (snapshot) => {
      keepBusy();
      return snapshot.self.idleTicksLeft !== null;
    });
    expect(warned.self.idleTicksLeft).toBeLessThanOrEqual(2000);
    const seq = idle.client.input({ throttle: 0.5 });
    const cleared = await waitFor(
      idle.client,
      MessageType.FfaSnapshot,
      (snapshot) => {
        keepBusy();
        return snapshot.ackSeq === seq;
      },
      8000,
    );
    expect(cleared.self.idleTicksLeft).toBeNull();
    // Очередь второго больше не сбрасывается: состав без вышедшего приходит ему в тот же тик, что ошибка — первому.
    // Второй последний раз сменил команду позже первого — выйдет за бездействие позже, когда состав уже у него.
    const error = await waitFor(idle.client, MessageType.Error, () => true, 15_000);
    expect(error.code).toBe(ErrorCode.Idle);
    expect(await idle.client.closed()).toBe(true);
    const roster = await waitFor(busy.client, MessageType.FfaRoster, (message) => message.players.length === 1, 8000);
    expect(roster.players[0]?.id).toBe(busy.welcome.playerId);
  }, 30_000);

  it('в лобби и на отсчёте не копится', async () => {
    await startApp({ idleWarnTicks: 20, idleKickTicks: 40, countdownTicks: 150, minimum: { 10: 3, 30: 2, 50: 2 } });
    const a = await enter();
    await enter();
    await sleep(120);
    await enter();
    const fighting = await waitFor(a.client, MessageType.FfaState, (state) => state.phase === FfaPhase.Fight, 8000);
    expect(fighting.players).toBe(3);
    const first = await a.client.nextOfType(MessageType.FfaSnapshot);
    expect(first.self.idleTicksLeft).toBeNull();
  });

  it('пока танк подбит и ждёт возрождения — не копится', async () => {
    await startApp({ idleWarnTicks: 40, idleKickTicks: 80 });
    const [shooter, target] = await fightPair(SHOOTER, TARGET);
    const shooterId = shooter.welcome.playerId;
    const targetId = target.welcome.playerId;
    let turret = 1;
    let isDead = false;
    const deadline = Date.now() + SCRIPT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const message = await target.client.next(deadline - Date.now());
      expect(message.type).not.toBe(MessageType.Error);
      if (message.type !== MessageType.FfaSnapshot) {
        continue;
      }
      if (message.events.some((event) => event.kind === 'spawn' && event.tank === targetId)) {
        break;
      }
      isDead = isDead || message.self.state !== 'alive';
      if (!isDead) {
        turret = -turret;
        target.client.input({ turretTurn: turret });
      }
      const fresh = shooter.client.takeQueued().filter(isSnapshot);
      hunt(shooter.client, fresh[fresh.length - 1] ?? message, shooterId, targetId);
    }
    expect(isDead).toBe(true);
  }, 30_000);

  it('убитый с начатым отсчётом не видит его, пока не возродится', async () => {
    await startApp({ idleWarnTicks: 30, idleKickTicks: 1_000_000 });
    const [shooter, target] = await fightPair(SHOOTER, TARGET);
    const shooterId = shooter.welcome.playerId;
    const targetId = target.welcome.playerId;
    let isWarnedAlive = false;
    let deadSnapshots = 0;
    const deadline = Date.now() + SCRIPT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const message = await target.client.nextOfType(MessageType.FfaSnapshot, deadline - Date.now());
      if (message.events.some((event) => event.kind === 'spawn' && event.tank === targetId)) {
        break;
      }
      if (message.self.state === 'alive') {
        isWarnedAlive = isWarnedAlive || message.self.idleTicksLeft !== null;
      } else {
        deadSnapshots++;
        expect(message.self.idleTicksLeft).toBeNull();
      }
      const fresh = shooter.client.takeQueued().filter(isSnapshot);
      hunt(shooter.client, fresh[fresh.length - 1] ?? message, shooterId, targetId);
    }
    expect(isWarnedAlive).toBe(true);
    expect(deadSnapshots).toBeGreaterThan(0);
  }, 30_000);
});

describe('журнал боя толпы', () => {
  let logDir = '';

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'tanks-ffa-log-'));
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  async function journalOf(gameId: string): Promise<string[]> {
    await app?.close();
    app = null;
    return readFileSync(join(logDir, `${gameId}.log`), 'utf8').split('\n');
  }

  function linesOf(journal: readonly string[], tag: string): string[] {
    return journal.filter((line) => line.includes(` ${tag} `) || line.endsWith(` ${tag}`));
  }

  it('стрельба, вход посреди боя, обрыв и возврат: прогон движком совпадает на всех сверках', async () => {
    await startApp({ matchSeconds: 20 }, { logDir });
    const [shooter, target] = await fightPair(SHOOTER, TARGET);
    const shooterId = shooter.welcome.playerId;
    const targetId = target.welcome.playerId;
    let late: Entered | null = null;
    let isTargetGone = false;
    let back: Entered | null = null;
    let finalScore: FfaScoreMessage | null = null;
    let isResults = false;
    const deadline = Date.now() + SCRIPT_TIMEOUT_MS;
    while (!isResults && Date.now() < deadline) {
      const messages = [await shooter.client.next(deadline - Date.now()), ...shooter.client.takeQueued()];
      for (const message of messages) {
        if (message.type === MessageType.FfaScore) {
          finalScore = message;
        }
        isResults = isResults || (message.type === MessageType.FfaState && message.phase === FfaPhase.Results);
      }
      const latest = messages.filter(isSnapshot).pop();
      if (latest === undefined || isResults) {
        continue;
      }
      hunt(shooter.client, latest, shooterId, targetId);
      if (late === null && latest.tick > 100) {
        late = await enter('ffa10', { nickname: 'Поздний' });
      }
      if (!isTargetGone && latest.tick > 200) {
        target.client.close();
        isTargetGone = true;
      }
      if (back === null && latest.tick > 300) {
        back = await enter('ffa10', { token: target.welcome.token });
      }
    }
    expect(isResults).toBe(true);
    expect(back).not.toBeNull();
    const journal = await journalOf(shooter.welcome.gameId);
    expect(linesOf(journal, FFA_JOURNAL.matchStart)[0]).toMatch(/ seed=\d+ dur=20 roster=\d+:0055,\d+:0505$/);
    expect(linesOf(journal, FFA_JOURNAL.fightStart)).toHaveLength(1);
    expect(linesOf(journal, FFA_JOURNAL.join)).toHaveLength(1);
    expect(journal.some((line) => line.includes(` ${String(targetId)}=-`))).toBe(true);
    expect(journal.some((line) => / ac .*=-?\d+,-?\d+,-?\d+,1/.test(line))).toBe(true);
    expect(linesOf(journal, FFA_JOURNAL.matchOver)).toHaveLength(1);

    const [replayed] = replayFfaJournal(journal, { mapFor: () => TEST_MAP }).matches;
    expect(replayed?.isComplete).toBe(true);
    expect(replayed?.mismatches).toEqual([]);
    expect(replayed?.sums).toBe(Math.ceil((replayed?.match.world.tick ?? 0) / TICK_RATE));
    expect(finalScore?.rows.some((row) => row.damageDealt > 0)).toBe(true);
    for (const row of finalScore?.rows ?? []) {
      const player = replayed?.match.players.find((candidate) => candidate.id === row.id);
      expect(player).toMatchObject({ kills: row.kills, deaths: row.deaths, damageDealt: row.damageDealt });
    }

    const actionLines = journal.filter((line) => line.includes(` ${FFA_JOURNAL.actions} `));
    const broken = journal.filter((line) => line !== actionLines[3]);
    const [brokenReplay] = replayFfaJournal(broken, { mapFor: () => TEST_MAP }).matches;
    expect(brokenReplay?.mismatches.length).toBeGreaterThan(0);
  }, 30_000);

  it('выход за бездействие, по обрыву дольше окна и кнопкой: прогон совпадает на всех сверках', async () => {
    await startApp(
      {
        matchSeconds: 10,
        idleWarnTicks: 20,
        idleKickTicks: 40,
        reconnectTicks: 30,
        quitTicks: 20,
        lobbyWaitTicks: 30,
      },
      { logDir, tickMs: 5 },
    );
    const busy = await enter('ffa10', { nickname: 'Занят' });
    const idle = await enter('ffa10', { nickname: 'Спит' });
    const gone = await enter('ffa10', { nickname: 'Ушёл' });
    const quitter = await enter('ffa10', { nickname: 'Вышел' });
    await waitFor(busy.client, MessageType.FfaState, (state) => state.phase === FfaPhase.Fight);
    gone.client.close();
    quitter.client.send({ type: MessageType.Leave });
    quitter.client.close();
    let isOver = false;
    const deadline = Date.now() + SCRIPT_TIMEOUT_MS;
    while (!isOver && Date.now() < deadline) {
      const fresh = await freshSnapshots(busy.client);
      isOver = fresh.some((snapshot) => snapshot.events.some((event) => event.kind === 'matchOver'));
      busy.client.input(fidget());
    }
    expect(isOver).toBe(true);
    const journal = await journalOf(busy.welcome.gameId);

    expect(journal.some((line) => line.endsWith(`leave id=${String(idle.welcome.playerId)} reason=idle`))).toBe(true);
    expect(journal.some((line) => line.endsWith(`leave id=${String(gone.welcome.playerId)} reason=offline`))).toBe(
      true,
    );
    const quitterId = String(quitter.welcome.playerId);
    expect(journal.some((line) => line.endsWith(` quit id=${quitterId}`))).toBe(true);
    expect(journal.some((line) => line.endsWith(` offline id=${quitterId}`))).toBe(false);
    expect(journal.some((line) => line.endsWith(`leave id=${quitterId} reason=offline`))).toBe(true);
    const [replayed] = replayFfaJournal(journal, { mapFor: () => TEST_MAP }).matches;
    expect(replayed?.isComplete).toBe(true);
    expect(replayed?.mismatches).toEqual([]);
    expect(replayed?.match.players.map((player) => player.id)).toEqual([busy.welcome.playerId]);
  }, 30_000);
});
