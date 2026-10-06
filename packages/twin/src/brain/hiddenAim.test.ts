import { exitPointOf, ricochetAngleOf, type HiddenAimTarget } from '@tanks/analysis';
import { createRandom, mapByIndex } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { calibrationWith, craftView, profileWith, type ViewSpec } from '../fixture.js';
import { TwinBrain } from './brain.js';
import { HiddenAim } from './hiddenAim.js';

// Полигон: центральный блок стен закрывает противника B от танка; на месте A противник виден.
const POLYGON = mapByIndex(0);
const ME = { x: 200, y: 450 };
const SEEN = { x: 1000, y: 800 };
const HIDDEN = { x: 1100, y: 450 };
const HIDDEN_VIEW: ViewSpec = { me: { ...ME, turret: 0 }, enemy: HIDDEN };
const SEEN_VIEW: ViewSpec = { me: { ...ME, turret: 0 }, enemy: SEEN };
const NO_SHARES: Record<HiddenAimTarget, number> = { bearing: 0, exit: 0, ricochet: 0, lastSeen: 0 };
const PICKS = 20000;
const REPLAN_TICKS = 10;

function aimWith(shares: Partial<Record<HiddenAimTarget, number>>, seed = 1): HiddenAim {
  return new HiddenAim({ ...NO_SHARES, ...shares }, createRandom(seed));
}

function shares(aim: HiddenAim): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let pick = 0; pick < PICKS; pick++) {
    aim.pick();
    counts[aim.current] = (counts[aim.current] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).map(([target, count]) => [target, count / PICKS]));
}

function brainWith(shares: Partial<Record<HiddenAimTarget, number>>, decisionMeanS = 0.5): TwinBrain {
  const profile = profileWith({
    calibration: calibrationWith({ hiddenAim: { ...NO_SHARES, ...shares }, decisionMeanS }),
  });
  const brain = new TwinBrain(profile);
  brain.init({ level: 8, roundIndex: 0, lossStreak: 0, mapIndex: 0, hasRicochetGuard: false, seed: 3 });
  return brain;
}

describe('башня без видимости', () => {
  const me = craftView(HIDDEN_VIEW).me;

  it('доля 1 — своя цель: точка выхода, рикошет на дистанции противника, место, где видел, пеленг', () => {
    const exit = aimWith({ exit: 1 });
    const ricochet = aimWith({ ricochet: 1 });
    const lastSeen = aimWith({ lastSeen: 1 });
    const bearing = aimWith({ bearing: 1 });
    for (const aim of [exit, ricochet, lastSeen, bearing]) {
      aim.see(SEEN);
      aim.pick();
    }
    const angle = ricochetAngleOf(POLYGON, me, HIDDEN, me.stats.bulletSpeed, me.turret) ?? 0;
    const distance = Math.hypot(HIDDEN.x - ME.x, HIDDEN.y - ME.y);
    const ricochetPoint = ricochet.point(POLYGON, me, HIDDEN, 0);

    expect(exit.point(POLYGON, me, HIDDEN, 0)).toEqual(exitPointOf(POLYGON, me, HIDDEN));
    expect(ricochetPoint?.x).toBeCloseTo(ME.x + Math.cos(angle) * distance, 6);
    expect(ricochetPoint?.y).toBeCloseTo(ME.y + Math.sin(angle) * distance, 6);
    expect(lastSeen.point(POLYGON, me, HIDDEN, 0)).toEqual(SEEN);
    expect(bearing.current).toBe('bearing');
    expect(bearing.point(POLYGON, me, HIDDEN, 0)).toBeNull();
  });

  it('все доли 0 — башню не ведут', () => {
    const aim = aimWith({});
    aim.pick();

    expect(aim.current).toBe('hold');
  });

  it('рикошет — ближайший к нынешней башне', () => {
    const field = { ...POLYGON, walls: [{ x: 700, y: 350, w: 40, h: 200 }] };
    const spec: ViewSpec = { me: { x: 400, y: 450, turret: -1 }, enemy: { x: 1000, y: 450 } };
    const tank = craftView(spec).me;
    const aim = aimWith({ ricochet: 1 });
    aim.pick();
    const point = aim.point(field, tank, spec.enemy, 0);

    expect(Math.atan2((point?.y ?? 0) - 450, (point?.x ?? 0) - 400)).toBeLessThan(0);
  });

  it('цели нет — пеленг: противник ещё не был виден; после сброса места нет', () => {
    const lastSeen = aimWith({ lastSeen: 1 });
    lastSeen.pick();
    expect(lastSeen.point(POLYGON, me, HIDDEN, 0)).toBeNull();

    lastSeen.see(SEEN);
    lastSeen.reset();
    lastSeen.pick();
    expect(lastSeen.point(POLYGON, me, HIDDEN, 0)).toBeNull();
  });

  it('выбор — по своей доле у каждой цели, остаток — башню не ведут; при сумме больше 1 последним меньше', () => {
    const partial = shares(aimWith({ bearing: 0.1, exit: 0.2, ricochet: 0.3 }));
    const over = shares(aimWith({ bearing: 0.5, exit: 0.4, lastSeen: 0.8 }));

    expect(partial.bearing).toBeCloseTo(0.1, 1);
    expect(partial.exit).toBeCloseTo(0.2, 1);
    expect(partial.ricochet).toBeCloseTo(0.3, 1);
    expect(partial.hold).toBeCloseTo(0.4, 1);
    expect(over.hold).toBeUndefined();
    expect(over.exit).toBeCloseTo(0.4, 1);
    expect(over.lastSeen).toBeCloseTo(0.1, 1);
  });

  it('точка выхода пересчитывается раз в 10 тиков и при новом выборе', () => {
    const aim = aimWith({ exit: 1 });
    aim.pick();
    const first = aim.point(POLYGON, me, HIDDEN, 0);
    const moved = { x: HIDDEN.x, y: 300 };

    expect(aim.point(POLYGON, me, moved, REPLAN_TICKS - 1)).toEqual(first);
    expect(aim.point(POLYGON, me, moved, REPLAN_TICKS)).toEqual(exitPointOf(POLYGON, me, moved));
    aim.pick();
    expect(aim.point(POLYGON, me, HIDDEN, REPLAN_TICKS + 1)).toEqual(first);
  });

  describe('в мозге', () => {
    function turretTurns(shares: Partial<Record<HiddenAimTarget, number>>, decisionMeanS: number): Set<number> {
      const brain = brainWith(shares, decisionMeanS);
      const turns = new Set<number>();
      for (let tick = 0; tick < 100; tick++) {
        turns.add(brain.tick(craftView({ ...HIDDEN_VIEW, tick: tick + 1 })).action.turretTurn);
      }
      return turns;
    }

    it('противник скрылся — башня сразу на выбранную цель; снова виден — на противника', () => {
      const brain = brainWith({ exit: 1 });
      const seenTurn = brain.tick(craftView({ ...SEEN_VIEW, tick: 1 })).action.turretTurn;
      const hiddenTurn = brain.tick(craftView({ ...HIDDEN_VIEW, tick: 2 })).action.turretTurn;

      expect(seenTurn).toBeGreaterThan(0);
      expect(hiddenTurn).toBeLessThan(0);
    });

    it('башню не ведут — она стоит, даже когда огонь зажат и пеленг в стороне', () => {
      const brain = brainWith({});
      const turret = Math.PI / 2;
      const turns = new Set<number>();
      for (let tick = 0; tick < 30; tick++) {
        turns.add(brain.tick(craftView({ ...HIDDEN_VIEW, me: { ...ME, turret }, tick: tick + 1 })).action.turretTurn);
      }

      expect(turns).toEqual(new Set([0]));
    });

    it('противник скрылся, пока танк едет к центру зоны и решений манёвра нет, — цель выбирается всё равно', () => {
      const brain = brainWith({ exit: 1 });
      const zoneRadius = 300;
      brain.tick(craftView({ ...SEEN_VIEW, tick: 1, zoneRadius }));
      const hiddenTurn = brain.tick(craftView({ ...HIDDEN_VIEW, tick: 2, zoneRadius })).action.turretTurn;

      expect(hiddenTurn).toBeLessThan(0);
    });

    it('место, где противник был виден последний раз, — по виду, пока он был на виду', () => {
      const brain = brainWith({ lastSeen: 1 });
      const turret = Math.atan2(SEEN.y - ME.y, SEEN.x - ME.x);
      brain.tick(craftView({ ...SEEN_VIEW, me: { ...ME, turret }, tick: 1 }));
      const hiddenTurn = brain.tick(craftView({ ...HIDDEN_VIEW, me: { ...ME, turret }, tick: 2 })).action.turretTurn;

      expect(hiddenTurn).toBe(0);
    });

    it('цель выбирается заново на каждом решении манёвра, между решениями держится', () => {
      expect(turretTurns({ exit: 0.5 }, 0.001).size).toBe(2);
      expect(turretTurns({ exit: 0.5 }, 1000).size).toBe(1);
    });
  });
});
