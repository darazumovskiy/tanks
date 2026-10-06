import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES,
  DEFAULT_STATS,
  IDLE_ACTION,
  normalizeAngle,
  TICK_RATE,
  type FfaMap,
} from '@tanks/shared/engine';
import { decode, FfaPhase, MessageType, type FfaSnapshotMessage, type SnapshotMessage } from '@tanks/shared/protocol';
import { createApp, type App } from '../src/app.js';
import { DEFAULT_FFA_OPTIONS, FfaGame, type FfaOptions } from '../src/ffaGame.js';
import { NO_LOG } from '../src/gameLog.js';
import { INPUT_BACKLOG_MIN, INPUT_BACKLOG_TICKS, INPUT_QUEUE_LIMIT, INPUT_SPARE_TICKS } from '../src/inputs.js';
import type { DropReason } from '../src/metrics.js';
import { Room, type Seat } from '../src/room.js';
import { TestClient } from './client.js';
import { seededRandom } from './support.js';

// Тик как на боевом сервере: команды, отправленные подряд, приходят в один тик.
const TICK_MS = 1000 / TICK_RATE;
const FAST_ROOM = { countdownTicks: 3, roundEndTicks: 3, maxInputsPerSecond: 90 };
// Поле без стен: снаряд, рождённый у стены, гибнет в тот же тик и в рождения не попадает.
const OPEN_MAP: FfaMap = {
  name: 'Проба',
  size: 10,
  seed: 1,
  width: 1600,
  height: 900,
  walls: [],
  kits: [],
  spawnAreas: [
    { x: 400, y: 450, radius: 60 },
    { x: 1200, y: 450, radius: 60 },
  ],
};
const FAST_FFA: FfaOptions = {
  ...DEFAULT_FFA_OPTIONS,
  countdownTicks: 3,
  lobbyWaitTicks: 3,
  minimum: { 10: 2, 30: 2, 50: 2 },
  mapFor: () => OPEN_MAP,
};
const HEADING_DIGITS = 9;
const SILENT_CONNECTION = { send: (): void => undefined };

let app: App;
let port: number;
const clients: TestClient[] = [];

beforeEach(async () => {
  app = createApp({ room: FAST_ROOM, ffa: FAST_FFA, tickMs: TICK_MS, random: seededRandom(42) });
  port = await app.listen(0, '127.0.0.1');
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await app.close();
});

async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(port);
  clients.push(client);
  return client;
}

// Снимки по порядку, пока сервер не подтвердит команду seq; последний — с подтверждением.
async function snapshotsUntilAck<S extends { ackSeq: number }>(next: () => Promise<S>, seq: number): Promise<S[]> {
  const snapshots: S[] = [];
  let snapshot: S;
  do {
    snapshot = await next();
    snapshots.push(snapshot);
  } while (snapshot.ackSeq < seq);
  return snapshots;
}

function ackedAt<S extends { ackSeq: number }>(snapshots: readonly S[], seq: number): S | undefined {
  return snapshots.find((snapshot) => snapshot.ackSeq === seq);
}

async function droppedInputs(reason: DropReason): Promise<number> {
  const text = await (await fetch(`http://127.0.0.1:${String(port)}/metrics`)).text();
  const line = text
    .split('\n')
    .find((candidate) => candidate.startsWith(`tanks_inputs_dropped_total{reason="${reason}"}`));
  return Number(line?.split(' ').at(-1));
}

// Свежий снимок боя дуэли: всё, что пришло до него, выброшено.
async function duelFight(code: string): Promise<{ client: TestClient; before: SnapshotMessage }> {
  const a = await connect();
  const b = await connect();
  a.join(code, 'Алиса');
  b.join(code, 'Боб');
  let snapshot = await a.nextOfType(MessageType.Snapshot);
  while (snapshot.tick === 0) {
    snapshot = await a.nextOfType(MessageType.Snapshot);
  }
  a.takeQueued();
  return { client: a, before: await a.nextOfType(MessageType.Snapshot) };
}

interface FfaFighter {
  client: TestClient;
  id: number;
  token: string;
}

async function ffaFight(): Promise<{ fighter: FfaFighter; before: FfaSnapshotMessage }> {
  const fighters: FfaFighter[] = [];
  for (const nickname of ['А', 'Б']) {
    const client = await connect();
    client.join('ffa10', nickname);
    const welcome = await client.nextOfType(MessageType.FfaWelcome);
    fighters.push({ client, id: welcome.playerId, token: welcome.token });
  }
  const [fighter] = fighters;
  if (fighter === undefined) {
    throw new Error('нет бойца');
  }
  let state = await fighter.client.nextOfType(MessageType.FfaState);
  while (state.phase !== FfaPhase.Fight) {
    state = await fighter.client.nextOfType(MessageType.FfaState);
  }
  fighter.client.takeQueued();
  return { fighter, before: await fighter.client.nextOfType(MessageType.FfaSnapshot) };
}

function headingOf(snapshot: FfaSnapshotMessage | undefined, id: number): number {
  return snapshot?.tanks.find((tank) => tank.id === id)?.heading ?? NaN;
}

describe('очередь команд: дуэль', () => {
  it('две команды одной пачкой применяются по одной на соседних тиках', async () => {
    const { client, before } = await duelFight('qtwo');
    client.input({ turn: 1 });
    const last = client.input({ turn: 1 });
    const snapshots = await snapshotsUntilAck(() => client.nextOfType(MessageType.Snapshot), last);
    const first = ackedAt(snapshots, last - 1);
    const second = ackedAt(snapshots, last);
    expect(second?.tick).toBe((first?.tick ?? NaN) + 1);
    const step = normalizeAngle((first?.tanks[0].heading ?? NaN) - before.tanks[0].heading);
    expect(step).toBeGreaterThan(0);
    expect(normalizeAngle((second?.tanks[0].heading ?? NaN) - (first?.tanks[0].heading ?? NaN))).toBeCloseTo(
      step,
      HEADING_DIGITS,
    );
  });

  it('короткий выстрел в первой из двух команд пачки — снаряд родился', async () => {
    const { client } = await duelFight('qfire');
    client.input({ isFiring: true });
    const last = client.input({});
    const snapshots = await snapshotsUntilAck(() => client.nextOfType(MessageType.Snapshot), last);
    const fired = ackedAt(snapshots, last - 1);
    expect(fired?.events.some((event) => event.kind === 'shot' && event.side === 0)).toBe(true);
  });

  it('переполнение: задержка не больше предела, самые старые выброшены, их выстрел не потерян', async () => {
    const { client } = await duelFight('qover');
    client.input({ isFiring: true });
    let last = 0;
    for (let i = 1; i < INPUT_QUEUE_LIMIT + 2; i++) {
      last = client.input({});
    }
    const snapshots = await snapshotsUntilAck(() => client.nextOfType(MessageType.Snapshot), last);
    const applied = snapshots.filter((snapshot) => snapshot.ackSeq > 0);
    const firstApplied = applied[0]?.tick ?? NaN;
    expect((applied.at(-1)?.tick ?? NaN) - firstApplied).toBeLessThanOrEqual(INPUT_QUEUE_LIMIT - 1);
    const acked = new Set(applied.map((snapshot) => snapshot.ackSeq));
    let skipped = 0;
    for (let seq = 1; seq <= last; seq++) {
      skipped += acked.has(seq) ? 0 : 1;
    }
    expect(skipped).toBeGreaterThan(0);
    expect(await droppedInputs('overflow')).toBe(skipped);
    const shots = applied.flatMap((snapshot) => snapshot.events).filter((event) => event.kind === 'shot');
    expect(shots).toHaveLength(1);
  });
});

// Комната без сокета: тик крутит тест, команды приходят ровно между тиками — слив не зависит от скорости ответа.
class ManualDuel {
  readonly drops: DropReason[] = [];
  readonly acked = new Set<number>();
  readonly spareFlags: boolean[] = [];
  private lastSeq = 0;
  private ackSeq = 0;
  private readonly room = new Room('manual', FAST_ROOM, NO_LOG, {
    countDroppedInput: (reason) => {
      this.drops.push(reason);
    },
  });
  private readonly seat: Seat;

  constructor() {
    this.seat = this.room.join(
      0,
      {
        send: (bytes) => {
          const message = decode(bytes);
          if (message.type === MessageType.Snapshot) {
            this.ackSeq = message.ackSeq;
            this.acked.add(message.ackSeq);
            this.spareFlags.push(message.hasSpareInput);
          }
        },
      },
      'А',
      DEFAULT_STATS,
    );
    this.room.join(1, SILENT_CONNECTION, 'Б', DEFAULT_STATS);
  }

  sendIdle(count: number): void {
    for (let i = 0; i < count; i++) {
      this.lastSeq++;
      this.seat.input(this.lastSeq, IDLE_ACTION);
    }
  }

  get sent(): number {
    return this.lastSeq;
  }

  // Каждый тик: шаг, задержка подтверждения в командах, затем perTick новых команд.
  run(ticks: number, perTick: number): number[] {
    const lags: number[] = [];
    for (let i = 0; i < ticks; i++) {
      this.room.step();
      lags.push(this.lastSeq - this.ackSeq);
      this.sendIdle(perTick);
    }
    return lags;
  }
}

describe('очередь команд: слив на ручном тике', () => {
  it('одна лишняя команда в очереди — запас против дрожания, не сливается', () => {
    const duel = new ManualDuel();
    duel.sendIdle(2);
    expect(duel.run(3 * INPUT_BACKLOG_TICKS, 1)).toEqual(Array<number>(3 * INPUT_BACKLOG_TICKS).fill(1));
    expect(duel.drops).toEqual([]);
  });

  it('стойкий запас из двух сливается до одной; провал до одной начинает окно заново', () => {
    const duel = new ManualDuel();
    duel.sendIdle(INPUT_BACKLOG_MIN + 1);
    const halfWindow = INPUT_BACKLOG_TICKS / 2;
    expect(duel.run(halfWindow, 1)).toEqual(Array<number>(halfWindow).fill(INPUT_BACKLOG_MIN));
    duel.run(1, 0);
    expect(duel.run(1, 2)).toEqual([1]);
    const afterDip = duel.run(2 * INPUT_BACKLOG_TICKS, 1);
    expect(afterDip).toEqual([
      ...Array<number>(INPUT_BACKLOG_TICKS + 1).fill(INPUT_BACKLOG_MIN),
      ...Array<number>(INPUT_BACKLOG_TICKS - 1).fill(1),
    ]);
    expect(duel.drops).toEqual(['backlog']);
  });

  it('запас, который секунду не понадобился, помечается в снимке; пропуск шага клиентом убирает его без потери команд', () => {
    const duel = new ManualDuel();
    duel.sendIdle(2);
    duel.run(INPUT_SPARE_TICKS + 5, 1);
    expect(duel.spareFlags).toEqual([
      ...Array<boolean>(INPUT_SPARE_TICKS - 1).fill(false),
      ...Array<boolean>(6).fill(true),
    ]);
    duel.run(1, 0);
    const flagsBefore = duel.spareFlags.length;
    expect(duel.run(INPUT_SPARE_TICKS - 1, 1)).toEqual(Array<number>(INPUT_SPARE_TICKS - 1).fill(0));
    expect(duel.spareFlags.slice(flagsBefore)).toEqual(Array<boolean>(INPUT_SPARE_TICKS - 1).fill(false));
    expect(duel.drops).toEqual([]);
    for (let seq = 1; seq <= duel.sent - 1; seq++) {
      expect(duel.acked.has(seq)).toBe(true);
    }
  });

  it('тик без команды посреди окна начинает окно запаса заново', () => {
    const duel = new ManualDuel();
    duel.sendIdle(2);
    duel.run(INPUT_SPARE_TICKS / 2, 1);
    duel.run(1, 0);
    duel.run(1, 2);
    const flagsBefore = duel.spareFlags.length;
    duel.run(INPUT_SPARE_TICKS, 1);
    // Окно считается с тика, на котором запас кончился: этот тик прошёл до отрезка.
    expect(duel.spareFlags.slice(flagsBefore).indexOf(true)).toBe(INPUT_SPARE_TICKS - 1);
    expect(duel.spareFlags.slice(0, flagsBefore).some((flag) => flag)).toBe(false);
  });

  it('общий бой: начало матча очищает очередь и отметку слива, пачка отсчёта применяется целиком', () => {
    const drops: DropReason[] = [];
    const options: FfaOptions = { ...FAST_FFA, lobbyWaitTicks: 2 * INPUT_BACKLOG_TICKS };
    const dropCounter = {
      countDroppedInput: (reason: DropReason): void => {
        drops.push(reason);
      },
    };
    const game = new FfaGame(10, options, NO_LOG, dropCounter, DEFAULT_RULES);
    const seen: { phase: FfaPhase; ackSeq: number } = { phase: FfaPhase.Lobby, ackSeq: NaN };
    const connection = {
      send: (bytes: Uint8Array): void => {
        const message = decode(bytes);
        if (message.type === MessageType.FfaState) {
          seen.phase = message.phase;
        }
        if (message.type === MessageType.FfaSnapshot) {
          seen.ackSeq = message.ackSeq;
        }
      },
      close: (): void => undefined,
    };
    const seat = game.join(connection, 'А', DEFAULT_STATS, false);
    game.join({ ...SILENT_CONNECTION, close: () => undefined }, 'Б', DEFAULT_STATS, false);
    for (let seq = 1; seq <= INPUT_QUEUE_LIMIT; seq++) {
      seat.input(seq, IDLE_ACTION);
    }
    while (seen.phase === FfaPhase.Lobby) {
      game.step();
    }
    const batchStart = INPUT_QUEUE_LIMIT + 1;
    for (let seq = batchStart; seq < batchStart + INPUT_QUEUE_LIMIT; seq++) {
      seat.input(seq, IDLE_ACTION);
    }
    const acks: number[] = [];
    for (let i = 0; i < INPUT_QUEUE_LIMIT; i++) {
      game.step();
      acks.push(seen.ackSeq);
    }
    expect(acks).toEqual([batchStart, batchStart + 1, batchStart + 2]);
    expect(drops).toEqual([]);
  });
});

describe('очередь команд: общий бой', () => {
  it('две команды одной пачкой применяются по одной на соседних тиках', async () => {
    const { fighter, before } = await ffaFight();
    fighter.client.input({ turn: 1 });
    const last = fighter.client.input({ turn: 1 });
    const snapshots = await snapshotsUntilAck(() => fighter.client.nextOfType(MessageType.FfaSnapshot), last);
    const first = ackedAt(snapshots, last - 1);
    const second = ackedAt(snapshots, last);
    expect(second?.gameTick).toBe((first?.gameTick ?? NaN) + 1);
    const step = normalizeAngle(headingOf(first, fighter.id) - headingOf(before, fighter.id));
    expect(step).toBeGreaterThan(0);
    expect(normalizeAngle(headingOf(second, fighter.id) - headingOf(first, fighter.id))).toBeCloseTo(
      step,
      HEADING_DIGITS,
    );
  });

  it('короткий выстрел в первой из двух команд пачки — снаряд родился', async () => {
    const { fighter } = await ffaFight();
    fighter.client.input({ isFiring: true });
    const last = fighter.client.input({});
    const snapshots = await snapshotsUntilAck(() => fighter.client.nextOfType(MessageType.FfaSnapshot), last);
    const fired = ackedAt(snapshots, last - 1);
    expect(fired?.births.some((birth) => birth.owner === fighter.id)).toBe(true);
  });

  it('возврат по пропуску сбрасывает очередь старого соединения', async () => {
    const { fighter } = await ffaFight();
    const twin = await connect();
    for (let i = 0; i < INPUT_QUEUE_LIMIT; i++) {
      fighter.client.input({ turn: 1 });
    }
    twin.join('ffa10', 'А', undefined, undefined, fighter.token);
    expect((await twin.nextOfType(MessageType.FfaWelcome)).playerId).toBe(fighter.id);
    const snapshots: FfaSnapshotMessage[] = [];
    for (let i = 0; i < INPUT_QUEUE_LIMIT + 2; i++) {
      snapshots.push(await twin.nextOfType(MessageType.FfaSnapshot));
    }
    expect(snapshots.map((snapshot) => snapshot.ackSeq)).toEqual(snapshots.map(() => 0));
    const headings = snapshots.map((snapshot) => headingOf(snapshot, fighter.id));
    expect(headings).toEqual(headings.map(() => headings[0]));
  });

  it('запас команд: флаг через секунду ровной сети; пропуск шага — флага нет, команда подтверждается на тик раньше', async () => {
    const { fighter } = await ffaFight();
    fighter.client.input({});
    let lastSent = fighter.client.input({});
    // Ответ на каждый снимок — одна команда; сколько снимков от отправки до подтверждения.
    const lagOf = (snapshot: FfaSnapshotMessage): number => lastSent - snapshot.ackSeq;
    let snapshot = await fighter.client.nextOfType(MessageType.FfaSnapshot);
    while (!snapshot.hasSpareInput) {
      lastSent = fighter.client.input({});
      snapshot = await fighter.client.nextOfType(MessageType.FfaSnapshot);
    }
    const lagWithSpare = lagOf(snapshot);
    snapshot = await fighter.client.nextOfType(MessageType.FfaSnapshot);
    const flags: boolean[] = [];
    const lags: number[] = [];
    for (let i = 0; i < TICK_RATE / 2; i++) {
      lastSent = fighter.client.input({});
      snapshot = await fighter.client.nextOfType(MessageType.FfaSnapshot);
      flags.push(snapshot.hasSpareInput);
      lags.push(lagOf(snapshot));
    }
    expect(flags.slice(2)).toEqual(flags.slice(2).map(() => false));
    expect(Math.max(...lags.slice(2))).toBe(lagWithSpare - 1);
  });

  it('пачка нового соединения сразу после возврата применяется целиком', async () => {
    const { fighter } = await ffaFight();
    let snapshot = await fighter.client.nextOfType(MessageType.FfaSnapshot);
    while (snapshot.gameTick <= 2 * INPUT_BACKLOG_TICKS) {
      snapshot = await fighter.client.nextOfType(MessageType.FfaSnapshot);
    }
    const twin = await connect();
    twin.join('ffa10', 'А', undefined, undefined, fighter.token);
    twin.input({ turn: 1 });
    const last = twin.input({ turn: 1 });
    const snapshots = await snapshotsUntilAck(() => twin.nextOfType(MessageType.FfaSnapshot), last);
    expect(ackedAt(snapshots, last - 1)).toBeDefined();
    expect(await droppedInputs('backlog')).toBe(0);
  });
});
