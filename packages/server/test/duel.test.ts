import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STATS,
  DT,
  normalizeAngle,
  TANK_RADIUS,
  TURRET_RATE,
  type Action,
  type Stats,
} from '@tanks/shared/engine';
import {
  botRoomCode,
  EventFlag,
  twinRoomCode,
  MessageType,
  type RoundStartMessage,
  type ServerMessage,
  type SnapshotEvent,
  type SnapshotMessage,
  type TankSnapshot,
} from '@tanks/shared/protocol';
import { createApp, type App } from '../src/app.js';
import { TestClient } from './client.js';
import { seededRandom } from './support.js';

// Лимит ввода здесь не проверяется: при тике в 1 мс он мешал бы скриптам, которые шлют ввод на каждый снимок.
const FAST_ROOM = { countdownTicks: 2, roundEndTicks: 2, maxInputsPerSecond: 100000 };
const ARRIVE_DISTANCE = 50;
const AIM_TOLERANCE = 0.02;
const ROUND_TIMEOUT_MS = 40000;

const SHOOTER: Stats = { armor: 0, engine: 0, gun: 5, reload: 5 };
const RUNNER: Stats = { armor: 0, engine: 5, gun: 0, reload: 0 };
const WEAK_GUN: Stats = { armor: 3, engine: 3, gun: 0, reload: 2 };
const HUNTER: Stats = { armor: 0, engine: 3, gun: 4, reload: 3 };
// Курс скольжения — около 26° к верхнему краю.
const SLIDE_HEADING = -Math.PI / 7;
const SLIDE_HEADING_TOLERANCE = 0.05;
const SLIDE_TICKS = 30;
// Равновесие при 50 % под ≈ 26° к краю — около 115; без скольжения — около 21.
const SLIDE_PERCENT = 50;
const SLIDE_MIN_SPEED = 100;

let app: App;
let port: number;
const clients: TestClient[] = [];

beforeEach(async () => {
  app = createApp({ room: FAST_ROOM, tickMs: 1, random: seededRandom(42) });
  port = await app.listen(0, '127.0.0.1');
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await app.close();
});

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

interface Point {
  x: number;
  y: number;
}

const STILL: Action = { throttle: 0, turn: 0, turretTurn: 0, isFiring: false };

// Разворачивает корпус к точке и едет, у цели сбрасывает газ, чтобы не проскочить; на месте — стоит.
function steerTo(me: TankSnapshot, target: Point, arriveDistance = ARRIVE_DISTANCE): Pick<Action, 'throttle' | 'turn'> {
  const dx = target.x - me.x;
  const dy = target.y - me.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= arriveDistance) {
    return { throttle: 0, turn: 0 };
  }
  const diff = normalizeAngle(Math.atan2(dy, dx) - me.heading);
  const throttle = Math.abs(diff) < 0.3 ? clamp(distance / 200, 0.25, 1) : 0;
  return { turn: clamp(diff * 3, -1, 1), throttle };
}

function faceHeading(me: TankSnapshot, heading: number): Pick<Action, 'throttle' | 'turn'> {
  return { throttle: 0, turn: clamp(normalizeAngle(heading - me.heading) * 3, -1, 1) };
}

// Ведёт башню на цель и стреляет, когда наведена.
function aimAt(me: TankSnapshot, target: Point): Pick<Action, 'turretTurn' | 'isFiring'> {
  const diff = normalizeAngle(Math.atan2(target.y - me.y, target.x - me.x) - me.turret);
  return { turretTurn: clamp(diff / (TURRET_RATE * DT), -1, 1), isFiring: Math.abs(diff) < AIM_TOLERANCE };
}

// Маршрут по точкам: каждая следующая — после прибытия к предыдущей; у последней держится, подруливая.
function route(
  waypoints: { x: number; y: number; arrive?: number }[],
): (me: TankSnapshot) => Pick<Action, 'throttle' | 'turn'> {
  let index = 0;
  return (me) => {
    const waypoint = waypoints[Math.min(index, waypoints.length - 1)];
    if (waypoint === undefined) {
      return { throttle: 0, turn: 0 };
    }
    const arrive = waypoint.arrive ?? ARRIVE_DISTANCE;
    if (Math.hypot(waypoint.x - me.x, waypoint.y - me.y) <= arrive) {
      index = Math.min(index + 1, waypoints.length);
      return { throttle: 0, turn: 0 };
    }
    return steerTo(me, waypoint, arrive);
  };
}

type Script = (snapshot: SnapshotMessage) => Action | null;

interface PlayResult {
  last: SnapshotMessage;
  events: SnapshotEvent[];
}

// Старт первого раунда последней пары: идентификатор дуэли должен пережить смену раунда.
let firstRoundStart: RoundStartMessage;

async function connectPair(code: string, statsA: Stats, statsB: Stats): Promise<[TestClient, TestClient]> {
  const a = await TestClient.connect(port);
  const b = await TestClient.connect(port);
  clients.push(a, b);
  a.join(code, 'А', statsA);
  await a.nextOfType(MessageType.Welcome);
  b.join(code, 'Б', statsB);
  await b.nextOfType(MessageType.Welcome);
  firstRoundStart = await a.nextOfType(MessageType.RoundStart);
  await b.nextOfType(MessageType.RoundStart);
  return [a, b];
}

function isSnapshot(message: ServerMessage): message is SnapshotMessage {
  return message.type === MessageType.Snapshot;
}

interface Fresh {
  all: SnapshotMessage[];
  latest: SnapshotMessage;
}

// Снимки, накопившиеся с прошлого шага: тест отстаёт от сервера на 1 мс/тик, скрипт должен видеть свежее состояние.
async function freshSnapshots(client: TestClient): Promise<Fresh> {
  const first = await client.nextOfType(MessageType.Snapshot);
  const queued = client.takeQueued().filter(isSnapshot);
  return { all: [first, ...queued], latest: queued[queued.length - 1] ?? first };
}

// Гонит бой по снимкам: каждому игроку — его скрипт, пока не выполнится условие или не кончится раунд.
async function play(
  pair: [TestClient, TestClient],
  scripts: [Script, Script],
  isDone: (snapshot: SnapshotMessage, events: SnapshotEvent[]) => boolean,
): Promise<PlayResult> {
  const events: SnapshotEvent[] = [];
  const deadline = Date.now() + ROUND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const fresh = await freshSnapshots(pair[0]);
    await freshSnapshots(pair[1]);
    for (const snapshot of fresh.all) {
      events.push(...snapshot.events);
      if (isDone(snapshot, events) || snapshot.isOver) {
        return { last: snapshot, events };
      }
    }
    for (const side of [0, 1] as const) {
      const action = scripts[side](fresh.latest);
      if (action !== null) {
        pair[side].input(action);
      }
    }
  }
  throw new Error('бой не дошёл до условия за отведённое время');
}

const untilOver = (snapshot: SnapshotMessage): boolean => snapshot.isOver;
const idle: Script = () => null;

function hasEvent(events: SnapshotEvent[], kind: SnapshotEvent['kind'], flags = 0): boolean {
  return events.some((event) => event.kind === kind && (event.flags & flags) === flags);
}

describe('полный раунд', () => {
  it('стрелок едет на полосу и расстреливает мишень: счёт растёт, начинается следующий раунд', async () => {
    const pair = await connectPair('duel', SHOOTER, RUNNER);
    const laneY = 100;
    const shooterPost = { x: 140, y: laneY };
    const runnerPost = { x: 1460, y: laneY };
    const shooter: Script = ({ tanks }) => {
      const [me, target] = tanks;
      const isTargetInLane =
        Math.abs(target.y - laneY) < ARRIVE_DISTANCE && Math.abs(target.x - runnerPost.x) < ARRIVE_DISTANCE;
      const isPosted = Math.hypot(shooterPost.x - me.x, shooterPost.y - me.y) <= ARRIVE_DISTANCE;
      if (!isPosted) {
        return { ...steerTo(me, shooterPost), turretTurn: 0, isFiring: false };
      }
      const turret = isTargetInLane ? aimAt(me, target) : { turretTurn: 0, isFiring: false };
      return { ...faceHeading(me, 0), ...turret };
    };
    const runner: Script = ({ tanks }) => {
      const me = tanks[1];
      const isPosted = Math.hypot(runnerPost.x - me.x, runnerPost.y - me.y) <= ARRIVE_DISTANCE;
      const drive = isPosted ? faceHeading(me, Math.PI) : steerTo(me, runnerPost);
      return { ...drive, turretTurn: 0, isFiring: false };
    };

    const { last, events } = await play(pair, [shooter, runner], untilOver);
    expect(last.endReason).toBe('kill');
    expect(last.winner).toBe(0);
    expect(last.tanks[1].isAlive).toBe(false);
    expect(events.filter((event) => event.kind === 'shot').length).toBeGreaterThanOrEqual(3);
    for (const kind of ['shot', 'hit', 'death', 'roundOver'] as const) {
      expect(hasEvent(events, kind)).toBe(true);
    }

    const next = await pair[0].nextOfType(MessageType.RoundStart, 3000);
    expect(next.roundIndex).toBe(1);
    expect(next.mapIndex).toBe(1);
    expect(next.score).toEqual([1, 0]);
    expect(next.gameId).toBe(firstRoundStart.gameId);
    const nextSnapshot = await pair[0].nextOfType(MessageType.Snapshot);
    expect(nextSnapshot.tick).toBe(0);
    expect(nextSnapshot.gameTick).toBeGreaterThan(last.gameTick);
  }, 60000);

  it('выстрел в центральную стенку возвращается рикошетом в стрелка', async () => {
    const pair = await connectPair('self', SHOOTER, RUNNER);
    let hasFired = false;
    const fireOnce: Script = () => {
      if (hasFired) {
        return null;
      }
      hasFired = true;
      return { ...STILL, isFiring: true };
    };
    const { events } = await play(pair, [fireOnce, idle], (_, seen) => hasEvent(seen, 'hit'));
    const hit = events.find((event) => event.kind === 'hit');
    expect(hit?.side).toBe(0);
    expect(hasEvent(events, 'hit', EventFlag.Self | EventFlag.Ricochet)).toBe(true);
    expect(hasEvent(events, 'ricochet')).toBe(true);
  }, 20000);

  it('разгон в стену даёт удар; слабый снаряд вдоль стены гаснет, не долетев до второго касания', async () => {
    const pair = await connectPair('fizzle', WEAK_GUN, RUNNER);
    let hasBumped = false;
    let hasFired = false;
    const driver: Script = ({ tanks, events }) => {
      hasBumped = hasBumped || events.some((event) => event.kind === 'bump');
      if (!hasBumped) {
        const diff = normalizeAngle(-Math.PI / 2 - tanks[0].heading);
        const isAligned = Math.abs(diff) < 0.3;
        return { turn: clamp(diff * 3, -1, 1), throttle: isAligned ? 1 : 0, turretTurn: 0, isFiring: false };
      }
      if (hasFired) {
        return null;
      }
      hasFired = true;
      return { ...STILL, isFiring: true };
    };
    const { events } = await play(pair, [driver, idle], (_, seen) => hasEvent(seen, 'fizzle'));
    expect(hasEvent(events, 'bump')).toBe(true);
    expect(hasEvent(events, 'fizzle')).toBe(true);
    expect(hasEvent(events, 'impact')).toBe(false);
  }, 20000);

  it('оба стоят на месте — зона добивает обоих в один тик, ничья, счёт не растёт', async () => {
    const pair = await connectPair('draw', RUNNER, RUNNER);
    const { last, events } = await play(pair, [idle, idle], untilOver);
    expect(last.endReason).toBe('kill');
    expect(last.winner).toBeNull();
    expect(last.tanks[0].isAlive).toBe(false);
    expect(last.tanks[1].isAlive).toBe(false);
    expect(hasEvent(events, 'zoneStart')).toBe(true);
    expect(hasEvent(events, 'hit', EventFlag.Zone)).toBe(true);
    expect(events.filter((event) => event.kind === 'death').length).toBe(2);

    const next = await pair[0].nextOfType(MessageType.RoundStart, 3000);
    expect(next.score).toEqual([0, 0]);
  }, 60000);

  it('раунд по времени: аптечка подобрана, опоздавший в зону теряет здоровье и проигрывает по очкам', async () => {
    const pair = await connectPair('timed', RUNNER, RUNNER);
    const kit = { x: 800, y: 130 };
    const toKit = route([
      { x: 560, y: 450 },
      { x: 560, y: 130 },
      { ...kit, arrive: 20 },
    ]);
    const toCenter = route([
      { x: 560, y: 130 },
      { x: 560, y: 450 },
      { x: 700, y: 450 },
    ]);
    let hasPickedUp = false;
    const collector: Script = ({ tanks, events }) => {
      hasPickedUp = hasPickedUp || events.some((event) => event.kind === 'pickup' && event.side === 0);
      const drive = hasPickedUp ? toCenter(tanks[0]) : toKit(tanks[0]);
      return { ...drive, turretTurn: 0, isFiring: false };
    };
    const lateMoveTick = 60 * 30;
    const shelterTick = 100 * 30;
    const outskirts = route([{ x: 1000, y: 450 }]);
    const shelter = route([{ x: 920, y: 450 }]);
    const latecomer: Script = ({ tick, tanks }) => {
      if (tick < lateMoveTick) {
        return null;
      }
      const drive = tick < shelterTick ? outskirts(tanks[1]) : shelter(tanks[1]);
      return { ...drive, turretTurn: 0, isFiring: false };
    };

    const { last, events } = await play(pair, [collector, latecomer], untilOver);
    expect(last.endReason).toBe('time');
    expect(last.winner).toBe(0);
    expect(last.tanks[0].hp).toBeGreaterThan(last.tanks[1].hp);
    expect(hasEvent(events, 'kitSpawn')).toBe(true);
    expect(hasEvent(events, 'pickup')).toBe(true);
    expect(hasEvent(events, 'zoneStart')).toBe(true);
    expect(hasEvent(events, 'roundOver', EventFlag.ByTime)).toBe(true);
  }, 60000);
});

describe('скольжение вдоль стен', () => {
  beforeEach(async () => {
    await app.close();
    app = createApp({
      room: FAST_ROOM,
      tickMs: 1,
      random: seededRandom(42),
      rules: { wallSlidePercent: SLIDE_PERCENT },
    });
    port = await app.listen(0, '127.0.0.1');
  });

  it('танк под острым углом к краю поля держит скорость и не гремит ударами', async () => {
    const pair = await connectPair('slide', DEFAULT_STATS, DEFAULT_STATS);
    expect(firstRoundStart.rules).toEqual({ wallSlidePercent: SLIDE_PERCENT });
    const lanePost = { x: 140, y: 100 };
    let isPosted = false;
    let touchTick: number | null = null;
    const slider: Script = ({ tick, tanks }) => {
      const me = tanks[0];
      isPosted = isPosted || Math.hypot(lanePost.x - me.x, lanePost.y - me.y) <= ARRIVE_DISTANCE;
      if (!isPosted) {
        return { ...steerTo(me, lanePost), turretTurn: 0, isFiring: false };
      }
      const diff = normalizeAngle(SLIDE_HEADING - me.heading);
      if (Math.abs(diff) > SLIDE_HEADING_TOLERANCE) {
        return { ...faceHeading(me, SLIDE_HEADING), turretTurn: 0, isFiring: false };
      }
      if (touchTick === null && me.y <= TANK_RADIUS) {
        touchTick = tick;
      }
      return { ...STILL, throttle: 1 };
    };
    const isSliding = (snapshot: SnapshotMessage): boolean =>
      touchTick !== null && snapshot.tick >= touchTick + SLIDE_TICKS;
    const { last, events } = await play(pair, [slider, idle], isSliding);
    expect(last.tanks[0].y).toBe(TANK_RADIUS);
    expect(last.tanks[0].speed).toBeGreaterThanOrEqual(SLIDE_MIN_SPEED);
    expect(hasEvent(events, 'bump')).toBe(false);
  }, 20000);
});

describe('против бота', () => {
  it.each([
    ['Охотника', botRoomCode(8, 'duel')],
    ['двойника', twinRoomCode('duel')],
  ])(
    'скриптовый человек против %s: раунд доигрывается до конца, начинается следующий',
    async (_name, code) => {
      const human = await TestClient.connect(port);
      clients.push(human);
      human.join(code, 'Человек', HUNTER);
      await human.nextOfType(MessageType.Welcome);
      await human.nextOfType(MessageType.RoundStart);

      const deadline = Date.now() + ROUND_TIMEOUT_MS;
      let last: SnapshotMessage | null = null;
      while (Date.now() < deadline && last?.isOver !== true) {
        const fresh = await freshSnapshots(human);
        last = fresh.all.find((snapshot) => snapshot.isOver) ?? fresh.latest;
        const [bot, me] = last.tanks;
        human.input({ ...steerTo(me, bot, 120), ...aimAt(me, bot) });
      }
      expect(last?.isOver).toBe(true);

      const next = await human.nextOfType(MessageType.RoundStart, 3000);
      expect(next.roundIndex).toBe(1);
    },
    60000,
  );
});
