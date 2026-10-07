import type { TwinDecision, TwinSituation, TwinView } from '@tanks/bots/twin';
import { profileWith } from '@tanks/bots/twinFixture';
import type { TwinProfile } from '@tanks/bots/twin';
import type { GameLog } from '@tanks/server/gameLog';
import { Room, type Connection, type Seat } from '@tanks/server/room';
import { DEFAULT_STATS, deriveStats, IDLE_ACTION, type Action, type Side } from '@tanks/shared/engine';
import {
  encode,
  MessageType,
  type RoundStartMessage,
  type SnapshotMessage,
  type TankSnapshot,
} from '@tanks/shared/protocol';
import { describe, expect, it } from 'vitest';
import { TwinPlayer, type Brain } from './player.js';

const FAST_ROOM = { countdownTicks: 2, roundEndTicks: 2, maxInputsPerSecond: 90 };
const TURNING: Action = { throttle: 0, turn: 1, turretTurn: 1, isFiring: false };
const TURN_PER_TICK = deriveStats(DEFAULT_STATS).turnRate / 30;

class RecordingBrain implements Brain {
  readonly views: TwinView[] = [];
  readonly situations: TwinSituation[] = [];

  constructor(
    private readonly decide: (view: TwinView) => TwinDecision = () => ({ action: TURNING, isGuardHolding: false }),
  ) {}

  init(situation: TwinSituation): void {
    this.situations.push(situation);
  }

  tick(view: TwinView): TwinDecision {
    this.views.push(view);
    return this.decide(view);
  }
}

interface LogLine {
  key: string;
  source: string;
  text: string;
}

class RecordingLog implements GameLog {
  readonly lines: LogLine[] = [];

  write(key: string, source: string, text: string): void {
    this.lines.push({ key, source, text });
  }

  bodies(): string[] {
    return this.lines.map((line) => line.text.replace(/^gt=\d+ tc=\S+ now=\S+ /, ''));
  }
}

function channel(uplinkTicks: number, downlinkTicks: number, interpolationTicks: number): TwinProfile {
  return profileWith({ channel: { uplinkTicks, downlinkTicks, interpolationTicks } });
}

function playerWith(profile: TwinProfile, brain: Brain, log: GameLog = new RecordingLog()): TwinPlayer {
  return new TwinPlayer({
    profile,
    brain,
    level: 8,
    hasRicochetGuard: true,
    roundSeeds: [11, 12],
    roomCode: 'bot08test',
    log,
  });
}

const IDLE_CONNECTION: Connection = { send: () => undefined };

function roomWith(twin: TwinPlayer, log: GameLog, onInput: (seq: number, action: Action) => void): Room {
  const room = new Room('bot08test', FAST_ROOM, log, undefined, { wallSlidePercent: 30 });
  room.join(0, IDLE_CONNECTION, 'Охотник', DEFAULT_STATS);
  const seat = room.join(1, twin, 'Двойник', DEFAULT_STATS);
  twin.attach({
    ...seat,
    input: (seq, action) => {
      onInput(seq, action);
      seat.input(seq, action);
    },
  });
  return room;
}

function tank(x: number, heading = 0): TankSnapshot {
  return { x, y: 450, heading, turret: heading, speed: 0, hp: 100, reloadLeft: 0, isAlive: true };
}

function roundStart(roundIndex: number, wallSlidePercent = 0, score: [number, number] = [0, 0]): RoundStartMessage {
  return {
    type: MessageType.RoundStart,
    gameId: 'GAME',
    roundIndex,
    mapIndex: roundIndex,
    countdownTicks: 2,
    score,
    rules: { wallSlidePercent },
    tanks: [
      { nickname: 'Охотник', stats: DEFAULT_STATS },
      { nickname: 'Двойник', stats: DEFAULT_STATS },
    ],
  };
}

function snapshot(tick: number, enemyX: number, extra: Partial<SnapshotMessage> = {}): SnapshotMessage {
  return {
    type: MessageType.Snapshot,
    tick,
    gameTick: tick + 2,
    ackSeq: 0,
    hasSpareInput: false,
    isOver: false,
    winner: null,
    endReason: null,
    zoneRadius: 900,
    tanks: [tank(enemyX, Math.PI), tank(300)],
    bullets: [],
    kits: [],
    events: [],
    ...extra,
  };
}

function welcome(side: Side): Uint8Array {
  return encode({ type: MessageType.Welcome, side, roomCode: 'bot08test' });
}

describe('игрок-двойник', () => {
  it('задержка до сервера 2 тика: команда приходит в Seat.input через 2 тика комнаты, номера растут с единицы', () => {
    const log = new RecordingLog();
    const twin = playerWith(channel(2, 0, 0), new RecordingBrain(), log);
    const arrivals: { step: number; seq: number }[] = [];
    let step = 0;
    const room = roomWith(twin, log, (seq) => arrivals.push({ step, seq }));
    const sentAt = new Map<number, number>();
    for (step = 1; step <= 10; step++) {
      room.step();
      const before = log.lines.length;
      twin.step();
      for (const line of log.lines.slice(before)) {
        const seq = /in seq=(\d+)/.exec(line.text)?.[1];
        if (seq !== undefined) {
          sentAt.set(Number(seq), step);
        }
      }
    }

    expect(arrivals.map((arrival) => arrival.seq)).toEqual(arrivals.map((_, index) => index + 1));
    expect(arrivals.length).toBeGreaterThan(3);
    for (const arrival of arrivals) {
      expect(arrival.step - (sentAt.get(arrival.seq) ?? 0)).toBe(2);
    }
  });

  it('задержка до клиента 1 тик, интерполяция 2: противник — из снимка на 3 тика старше; пока истории мало — самый старый', () => {
    const brain = new RecordingBrain();
    const twin = playerWith(channel(0, 1, 2), brain);
    twin.send(welcome(1));
    twin.send(encode(roundStart(0)));
    twin.step();
    const enemyAt = (tick: number): number => 1000 + tick * 10;
    for (let tick = 1; tick <= 8; tick++) {
      twin.send(encode(snapshot(tick, enemyAt(tick))));
      twin.step();
    }
    const seen = brain.views.map((view) => view.enemy.x);

    expect(seen[0]).toBe(enemyAt(1));
    expect(seen.at(-1)).toBe(enemyAt(8 - 3));
  });

  it('свой танк — с предсказанием: неподтверждённые команды доворачивают курс, подтверждённые — сняты', () => {
    const brain = new RecordingBrain();
    const twin = playerWith(channel(2, 1, 0), brain);
    twin.send(welcome(1));
    twin.send(encode(roundStart(0)));
    twin.step();
    for (let tick = 1; tick <= 6; tick++) {
      twin.send(encode(snapshot(tick, 1000, { ackSeq: 0 })));
      twin.step();
    }
    const unacked = brain.views.at(-1)?.me.heading ?? 0;
    twin.send(encode(snapshot(7, 1000, { ackSeq: 100 })));
    twin.step();
    twin.step();
    const acked = brain.views.at(-1)?.me.heading ?? Infinity;

    expect(unacked).toBeGreaterThan(3 * TURN_PER_TICK);
    expect(acked).toBeCloseTo(0, 9);
  });

  it('журнал от стороны двойника: device, flags и settings на старте раунда, in seq=, guard hold, sec rtt=', () => {
    const log = new RecordingLog();
    let tick = 0;
    const brain = new RecordingBrain(() => {
      tick++;
      return { action: IDLE_ACTION, isGuardHolding: tick % 40 >= 10 && tick % 40 < 20 };
    });
    const twin = playerWith(channel(1, 1, 2), brain, log);
    const room = roomWith(twin, log, () => undefined);
    for (let step = 0; step < 100; step++) {
      room.step();
      twin.step();
    }
    const client = log.lines.filter((line) => line.source === 'C1');
    const bodies = client.map((line) => line.text.replace(/^gt=\d+ tc=\S+ now=\S+ /, ''));
    const commands = bodies.filter((body) => body.startsWith('in seq='));

    expect(client[0]?.key).toBe('room-bot08test');
    expect(bodies[0]).toBe('device ua=tanks-twin/phone screen=0x0 dpr=1 touch=1');
    expect(client.slice(1).every((line) => line.key !== 'room-bot08test')).toBe(true);
    expect(bodies).toContain('flags guard=1 aimline=1');
    expect(bodies).toContain('settings {"pivotThrottle":0.6,"hasRicochetGuard":true}');
    expect(commands.length).toBeGreaterThan(90);
    const holdStarts = brain.views.filter((_, index) => (index + 1) % 40 === 10).length;
    expect(holdStarts).toBeGreaterThanOrEqual(2);
    expect(bodies.filter((body) => body === 'guard hold')).toHaveLength(holdStarts);
    expect(bodies.filter((body) => body.startsWith('sec rtt=67 ')).length).toBe(3);
  });

  it('снимок с isOver и новый RoundStart: двойник молчит до нового раунда, зеркало — с правилами раунда', () => {
    const brain = new RecordingBrain();
    const log = new RecordingLog();
    const inputs: number[] = [];
    const twin = playerWith(channel(0, 0, 0), brain, log);
    const seat: Seat = { input: (seq) => inputs.push(seq), ping: () => undefined, leave: () => undefined };
    twin.attach(seat);
    twin.send(welcome(1));
    twin.send(encode(roundStart(0)));
    twin.step();
    twin.send(encode(snapshot(1, 1000)));
    twin.step();
    twin.send(encode(snapshot(2, 1000, { isOver: true, winner: 0 })));
    twin.step();
    const afterOver = inputs.length;
    twin.step();
    twin.step();

    expect(inputs.length).toBe(afterOver);
    expect(twin.finishedRounds).toBe(1);

    twin.send(encode(roundStart(1, 100, [1, 0])));
    twin.step();
    twin.send(encode(snapshot(1, 1000)));
    twin.step();

    expect(inputs.length).toBe(afterOver + 2);
    expect(
      brain.situations.map((situation) => [
        situation.roundIndex,
        situation.mapIndex,
        situation.lossStreak,
        situation.seed,
      ]),
    ).toEqual([
      [0, 0, 0, 11],
      [1, 1, 1, 12],
    ]);
    expect(brain.views.at(-1)?.arena.mapName).toBe('Лабиринт');
  });
});
