import { TICK_RATE } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import {
  action,
  BOT,
  countdownFrames,
  fightFrame,
  HUMAN,
  IDLE,
  pose,
  profileRoundsOf,
  roundOver,
  startDuel,
  type EventSpec,
  type LogAction,
  type Pose,
} from '../logFixture.js';
import { profileMetrics } from './index.js';
import type { KitMetrics } from './metrics.js';

// Аптечки Полигона: (800, 130) у верхнего края, (800, 770) у нижнего; полосы y = 130 и y = 770 без стен.
const TOP_KIT = { x: 800, y: 130 };
const BOTTOM_KIT = { x: 800, y: 770 };
const SPEED_PER_TICK = 4;
const HEALED = 30;
const PICKUP_TICK = 70;
const SECOND_SPAWN_TICK = 100;
const TICKS = 160;
const KIT_STRIDE = 5;
const DRIVE = action(1);
const REVERSE = action(-1);
const START_X = 400;
const BOT_POSE = pose(1000, BOTTOM_KIT.y, Math.PI);

interface KitTick {
  human: Pose;
  humanAction: LogAction;
  bot: Pose;
  events: EventSpec[];
}

function kitLog(ticks: number, tickAt: (tick: number) => KitTick): string {
  const first = tickAt(0);
  const builder = startDuel()
    .roundStart(0, 0)
    .frames(countdownFrames([first.bot, first.human]));
  for (let tick = 0; tick < ticks; tick++) {
    const spec = tickAt(tick);
    builder.frame(
      fightFrame([spec.bot, spec.human], {
        actions: [IDLE, spec.humanAction],
        events: tick === ticks - 1 ? [...spec.events, roundOver(HUMAN)] : spec.events,
      }),
    );
  }
  return builder.text();
}

function kitsOf(log: string): KitMetrics {
  return profileMetrics(profileRoundsOf({ 'KITS.log': log })).kits;
}

function spawn(kit: { x: number; y: number }): EventSpec {
  return { kind: 'kitSpawn', side: null, ...kit };
}

// Человек едет вправо к верхней аптечке и подбирает её; затем у нижней аптечки ближе бот, а человек едет
// от неё влево.
function towardLog(): string {
  return kitLog(TICKS, (tick) => {
    const isFirstLeg = tick < SECOND_SPAWN_TICK;
    const x = isFirstLeg ? START_X + SPEED_PER_TICK * tick : 800 - SPEED_PER_TICK * (tick - SECOND_SPAWN_TICK);
    const events: EventSpec[] = [];
    if (tick === 0) {
      events.push(spawn(TOP_KIT));
    }
    if (tick === PICKUP_TICK) {
      events.push({ kind: 'pickup', side: HUMAN, ...TOP_KIT, v: HEALED });
    }
    if (tick === SECOND_SPAWN_TICK) {
      events.push(spawn(BOTTOM_KIT));
    }
    return { human: pose(x, TOP_KIT.y, isFirstLeg ? 0 : Math.PI), humanAction: DRIVE, bot: BOT_POSE, events };
  });
}

// Ход по полосе верхней аптечки: на каждом тике — газ и курс; танк сдвигается на SPEED_PER_TICK по курсу, пока
// газ есть. Аптечка появляется на первом тике, botPickupTick — тик, когда её подбирает бот.
type Leg = 'toward' | 'away' | 'pause';

function tripLog(legAt: (tick: number) => Leg, ticks: number, botPickupTick: number | null = null): string {
  let x = START_X;
  return kitLog(ticks, (tick) => {
    const leg = legAt(tick);
    const events: EventSpec[] = tick === 0 ? [spawn(TOP_KIT)] : [];
    if (tick === botPickupTick) {
      events.push({ kind: 'pickup', side: BOT, ...TOP_KIT, v: 0 });
    }
    const heading = leg === 'away' ? Math.PI : 0;
    const human = pose(x, TOP_KIT.y, heading);
    x += leg === 'pause' ? 0 : Math.cos(heading) * SPEED_PER_TICK;
    return { human, humanAction: leg === 'pause' ? IDLE : DRIVE, bot: BOT_POSE, events };
  });
}

function legsUntil(towardTicks: number, rest: Leg): (tick: number) => Leg {
  return (tick) => (tick < towardTicks ? 'toward' : rest);
}

function pauseAt(from: number, ticks: number): (tick: number) => Leg {
  return (tick) => (tick >= from && tick < from + ticks ? 'pause' : 'toward');
}

describe('аптечки', () => {
  it('ход к аптечке — по тому, кому она ближе по пути; подборы, доля моих и лечение — по событиям', () => {
    const kits = kitsOf(towardLog());
    // Тики 0, 5 … 65 — к верхней аптечке; с 100-го — от нижней, к которой ближе бот.
    const towardTicks = Math.floor((PICKUP_TICK - 1) / KIT_STRIDE) + 1;
    const awayTicks = Math.floor((TICKS - 1 - SECOND_SPAWN_TICK) / KIT_STRIDE) + 1;

    expect(kits.toward.closer).toMatchObject({ part: towardTicks, total: towardTicks });
    expect(kits.toward.farther).toMatchObject({ part: 0, total: awayTicks });
    expect(kits.followed).toMatchObject({ part: 1, total: 1 });
    expect(kits.picked).toMatchObject({ part: 1, total: 2 });
    expect(kits.mine).toMatchObject({ part: 1, total: 1 });
    expect(kits.healPerMinute).toBeCloseTo((HEALED * 60 * TICK_RATE) / TICKS, 6);
  });

  it('без газа тик не в знаменателе хода к аптечке; аптечку подобрал бот — она не моя', () => {
    const events = new Map<number, EventSpec[]>([
      [0, [spawn(TOP_KIT)]],
      [PICKUP_TICK, [{ kind: 'pickup', side: BOT, ...TOP_KIT, v: 0 }]],
    ]);
    const log = kitLog(TICKS, (tick) => ({
      human: pose(START_X, TOP_KIT.y),
      humanAction: IDLE,
      bot: pose(1000, TOP_KIT.y, Math.PI),
      events: events.get(tick) ?? [],
    }));
    const kits = kitsOf(log);

    expect(kits.toward.closer.total + kits.toward.farther.total).toBe(0);
    expect(kits.followed.total).toBe(0);
    expect(kits.mine).toMatchObject({ part: 0, total: 1 });
    expect(kits.healPerMinute).toBe(0);
  });

  it('курс — по корпусу и газу: задним ходом кормой к аптечке — к ней; газ в стену носом к аптечке — к ней', () => {
    const reverse = kitLog(PICKUP_TICK, (tick) => ({
      human: pose(START_X + SPEED_PER_TICK * tick, TOP_KIT.y, Math.PI),
      humanAction: REVERSE,
      bot: BOT_POSE,
      events: tick === 0 ? [spawn(TOP_KIT)] : [],
    }));
    const pushing = kitLog(PICKUP_TICK, (tick) => ({
      human: pose(START_X, TOP_KIT.y),
      humanAction: DRIVE,
      bot: BOT_POSE,
      events: tick === 0 ? [spawn(TOP_KIT)] : [],
    }));
    const samples = Math.floor((PICKUP_TICK - 1) / KIT_STRIDE) + 1;

    expect(kitsOf(reverse).toward.closer).toMatchObject({ part: samples, total: samples });
    expect(kitsOf(pushing).toward.closer).toMatchObject({ part: samples, total: samples });
  });

  describe('поездка к аптечке', () => {
    it('бот подобрал аптечку посреди поездки — поездка доведена', () => {
      expect(kitsOf(tripLog(() => 'toward', 80, 50)).followed).toMatchObject({ part: 1, total: 1 });
    });

    it('отвернул, пока аптечка лежит, — поездка брошена', () => {
      expect(kitsOf(tripLog(legsUntil(40, 'away'), 80)).followed).toMatchObject({ part: 0, total: 1 });
    });

    it('перерыв в ходе к аптечке до 0,5 с поездку не рвёт, дольше — рвёт', () => {
      // Перерыв 15 тиков — три отсчёта без хода; 20 тиков — четыре. После разрыва новая поездка до подбора
      // ботом сокращает путь меньше чем на 100 и в счёт не идёт.
      const short = kitsOf(tripLog(pauseAt(40, 15), 100, 80));
      const long = kitsOf(tripLog(pauseAt(40, 20), 100, 75));

      expect(short.followed).toMatchObject({ part: 1, total: 1 });
      expect(long.followed).toMatchObject({ part: 0, total: 1 });
    });

    it('поездка, сократившая путь меньше чем на 100, и поездка, оборванная концом раунда, — не в счёт', () => {
      expect(kitsOf(tripLog(legsUntil(20, 'away'), 60)).followed.total).toBe(0);
      expect(kitsOf(tripLog(() => 'toward', 50)).followed.total).toBe(0);
    });
  });
});
