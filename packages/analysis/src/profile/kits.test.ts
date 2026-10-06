import { TICK_RATE } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import {
  action,
  countdownFrames,
  fightFrame,
  HUMAN,
  IDLE,
  pose,
  profileRoundsOf,
  roundOver,
  startDuel,
  type EventSpec,
  type Pose,
} from '../logFixture.js';
import { profileMetrics } from './index.js';

// Аптечки Полигона: (800, 130) у верхнего края, (800, 770) у нижнего; полосы y = 130 и y = 770 без стен.
const TOP_KIT = { x: 800, y: 130 };
const BOTTOM_KIT = { x: 800, y: 770 };
const SPEED_PER_TICK = 4;
const HEALED = 30;
const PICKUP_TICK = 70;
const SECOND_SPAWN_TICK = 100;
const TICKS = 160;

interface KitTick {
  human: Pose;
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
        actions: [IDLE, action(1)],
        events: tick === ticks - 1 ? [...spec.events, roundOver(HUMAN)] : spec.events,
      }),
    );
  }
  return builder.text();
}

function spawn(kit: { x: number; y: number }): EventSpec {
  return { kind: 'kitSpawn', side: null, ...kit };
}

// Человек едет вправо к верхней аптечке и подбирает её; затем у нижней аптечки ближе бот, а человек едет
// от неё влево.
function towardLog(): string {
  return kitLog(TICKS, (tick) => {
    const isFirstLeg = tick < SECOND_SPAWN_TICK;
    const x = isFirstLeg ? 400 + SPEED_PER_TICK * tick : 800 - SPEED_PER_TICK * (tick - SECOND_SPAWN_TICK);
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
    return { human: pose(x, TOP_KIT.y, isFirstLeg ? 0 : Math.PI), bot: pose(1000, BOTTOM_KIT.y, Math.PI), events };
  });
}

describe('аптечки', () => {
  it('ход к аптечке — по тому, кому она ближе по пути; подборы, доля моих и лечение — по событиям', () => {
    const kits = profileMetrics(profileRoundsOf({ 'KITS.log': towardLog() })).kits;
    // Тики 5, 10 … 65 — к верхней аптечке; с 100-го — от нижней, к которой ближе бот.
    const towardTicks = Math.floor((PICKUP_TICK - 1) / 5);
    const awayTicks = Math.floor((TICKS - 1 - SECOND_SPAWN_TICK) / 5) + 1;

    expect(kits.toward.closer).toMatchObject({ part: towardTicks, total: towardTicks });
    expect(kits.toward.farther).toMatchObject({ part: 0, total: awayTicks });
    expect(kits.picked).toMatchObject({ part: 1, total: 2 });
    expect(kits.mine).toMatchObject({ part: 1, total: 1 });
    expect(kits.healPerMinute).toBeCloseTo((HEALED * 60 * TICK_RATE) / TICKS, 6);
  });

  it('стоит — не ход к аптечке; аптечку подобрал бот — она не моя', () => {
    const events = new Map<number, EventSpec[]>([
      [0, [spawn(TOP_KIT)]],
      [PICKUP_TICK, [{ kind: 'pickup', side: 0, ...TOP_KIT, v: 0 }]],
    ]);
    const log = kitLog(TICKS, (tick) => ({
      human: pose(400, TOP_KIT.y),
      bot: pose(1000, TOP_KIT.y, Math.PI),
      events: events.get(tick) ?? [],
    }));
    const kits = profileMetrics(profileRoundsOf({ 'STAND.log': log })).kits;

    expect(kits.toward.closer.total + kits.toward.farther.total).toBeGreaterThan(0);
    expect(kits.toward.closer.part + kits.toward.farther.part).toBe(0);
    expect(kits.mine).toMatchObject({ part: 0, total: 1 });
    expect(kits.healPerMinute).toBe(0);
  });
});
