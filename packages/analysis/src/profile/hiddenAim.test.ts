import {
  BULLET_RADIUS,
  isSegmentClear,
  isSegmentWithin,
  mapByIndex,
  normalizeAngle,
  TANK_HIT_RADIUS,
  traceShot,
  type Point,
} from '@tanks/shared/engine';
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
  shotEvent,
  startDuel,
  type Pose,
} from '../logFixture.js';
import {
  exitPointOf,
  hiddenAimDirections,
  HIDDEN_AIM_WINDOW,
  ricochetAngleOf,
  ricochetAnglesOf,
  soleChance,
  soleHiddenAim,
  type HiddenAimDirections,
  type HiddenAimTarget,
} from '../ruler/hiddenAim.js';
import { profileMetrics } from './index.js';

// Полигон: центральный блок стен закрывает противника B от танка; на месте A противник был виден.
const POLYGON = mapByIndex(0);
const ME = { x: 200, y: 450 };
const SEEN = { x: 1000, y: 800 };
const HIDDEN = { x: 1100, y: 450 };
const BULLET_SPEED = 550;
const SEEN_TICKS = 10;
const SEGMENT_TICKS = 10;
const DEGREE = Math.PI / 180;
const TARGET_ORDER = ['bearing', 'exit', 'ricochet', 'lastSeen'] as const;

function bearing(to: { x: number; y: number }): number {
  return Math.atan2(to.y - ME.y, to.x - ME.x);
}

function gap(a: number, b: number): number {
  return Math.abs(normalizeAngle(a - b));
}

interface Scene {
  me: Point;
  seen: Point;
  hidden: Point;
}

const SCENE: Scene = { me: ME, seen: SEEN, hidden: HIDDEN };
// Все цели врозь: пеленг 0°, точка выхода 28°, рикошеты около 55° и около −59°, место, где видел, — 90°.
const APART: Scene = { me: { x: 200, y: 300 }, seen: { x: 200, y: 800 }, hidden: { x: 550, y: 300 } };

function bearingIn(scene: Scene, to: Point): number {
  return Math.atan2(to.y - scene.me.y, to.x - scene.me.x);
}

// Первые seenTicks тиков противник на виду, затем за стеной; башня по 10 тиков на каждом направлении по
// порядку — цели сверяются на каждом десятом тике боя.
function hiddenAimLog(turrets: readonly number[], seenTicks = SEEN_TICKS, scene: Scene = SCENE): string {
  const { me, seen, hidden } = scene;
  const first = pose(me.x, me.y, 0, 0);
  const start = seenTicks > 0 ? seen : hidden;
  const builder = startDuel()
    .roundStart(0, 0)
    .frames(countdownFrames([pose(start.x, start.y), first]));
  const ticks = seenTicks + turrets.length * SEGMENT_TICKS;
  for (let tick = 0; tick < ticks; tick++) {
    const enemy = tick < seenTicks ? seen : hidden;
    const segment = Math.floor((tick - seenTicks) / SEGMENT_TICKS);
    const human: Pose = pose(me.x, me.y, 0, tick < seenTicks ? 0 : (turrets[segment] ?? 0));
    const events = tick === 0 ? [shotEvent(HUMAN, human)] : [];
    builder.frame(
      fightFrame([pose(enemy.x, enemy.y), human], {
        actions: [IDLE, action(0)],
        events: tick === ticks - 1 ? [...events, roundOver(HUMAN)] : events,
      }),
    );
  }
  return builder.text();
}

function apartDirections(): HiddenAimDirections {
  return hiddenAimDirections(POLYGON, APART.me, APART.hidden, APART.seen, BULLET_SPEED);
}

// Направление, далёкое от всех целей, кроме допущенных: башня там на одной цели или ни на какой.
function soleDirection(
  directions: HiddenAimDirections,
  candidates: readonly number[],
  allowed: readonly HiddenAimTarget[] = ['ricochet'],
): number {
  const others = TARGET_ORDER.filter((target) => !allowed.includes(target)).flatMap((target) => directions[target]);
  const found = candidates.find((angle) => others.every((other) => gap(angle, other) > 2 * HIDDEN_AIM_WINDOW));
  if (found === undefined) {
    throw new Error('нет направления вдали от прочих целей');
  }
  return found;
}

describe('башня без видимости', () => {
  it('точка выхода — видимая точка пути противника; рикошет — снаряд после отскока проходит через противника', () => {
    const exit = exitPointOf(POLYGON, ME, HIDDEN);
    const ricochets = ricochetAnglesOf(POLYGON, ME, HIDDEN, BULLET_SPEED);

    expect(isSegmentClear(POLYGON.walls, ME.x, ME.y, HIDDEN.x, HIDDEN.y, BULLET_RADIUS)).toBe(false);
    expect(isSegmentClear(POLYGON.walls, ME.x, ME.y, SEEN.x, SEEN.y, BULLET_RADIUS)).toBe(true);
    expect(exit).not.toBeNull();
    expect(isSegmentClear(POLYGON.walls, ME.x, ME.y, exit?.x ?? 0, exit?.y ?? 0, BULLET_RADIUS)).toBe(true);
    // Первая видимая точка пути от противника — у угла стены на его стороне, а не у стрелка.
    expect(Math.hypot((exit?.x ?? 0) - ME.x, (exit?.y ?? 0) - ME.y)).toBeGreaterThan(
      Math.hypot(ME.x - HIDDEN.x, ME.y - HIDDEN.y) / 2,
    );
    expect(ricochets.length).toBeGreaterThan(0);
    for (const angle of ricochets) {
      const [first, second] = traceShot(POLYGON, ME, angle, BULLET_SPEED).segments;
      expect(first !== undefined && isSegmentWithin(first, HIDDEN, TANK_HIT_RADIUS)).toBe(false);
      expect(second !== undefined && isSegmentWithin(second, HIDDEN, TANK_HIT_RADIUS)).toBe(true);
    }
  });

  it('рикошетов несколько — в списке все, ближайший к заданному направлению выбирается из них', () => {
    // Поле без стен, кроме перегородки между танками: рикошеты — от верхнего и нижнего края.
    const field = { ...POLYGON, walls: [{ x: 700, y: 350, w: 40, h: 200 }] };
    const me = { x: 400, y: 450 };
    const enemy = { x: 1000, y: 450 };
    const mirrored = Math.atan2(900, 600);
    const step = 2 * DEGREE;
    const angles = ricochetAnglesOf(field, me, enemy, BULLET_SPEED);

    expect(angles.some((angle) => gap(angle, mirrored) < step)).toBe(true);
    expect(angles.some((angle) => gap(angle, -mirrored) < step)).toBe(true);
    expect(gap(ricochetAngleOf(field, me, enemy, BULLET_SPEED, 1) ?? 0, mirrored)).toBeLessThan(step);
    expect(gap(ricochetAngleOf(field, me, enemy, BULLET_SPEED, -1) ?? 0, -mirrored)).toBeLessThan(step);
  });

  it('башня на цели — в окне одной этой цели; в общем окне двух целей и вне окон — ни на какой', () => {
    const directions: HiddenAimDirections = { bearing: [0], exit: [15 * DEGREE], ricochet: [Math.PI], lastSeen: [] };

    expect(soleHiddenAim(-5 * DEGREE, directions)).toBe('bearing');
    expect(soleHiddenAim(20 * DEGREE, directions)).toBe('exit');
    expect(soleHiddenAim(7 * DEGREE, directions)).toBeNull();
    expect(soleHiddenAim(Math.PI + 9 * DEGREE, directions)).toBe('ricochet');
    expect(soleHiddenAim(Math.PI / 2, directions)).toBeNull();
  });

  it('случайная башня: доля круга в окне одной цели; общая зона двух целей не в счёт ни одной', () => {
    const lone = soleChance({ bearing: [0.5 * DEGREE], exit: [], ricochet: [], lastSeen: [] });
    const overlapping = soleChance({ bearing: [0.5 * DEGREE], exit: [10.5 * DEGREE], ricochet: [], lastSeen: [] });

    expect(lone.bearing).toBeCloseTo(20 / 360, 9);
    expect(lone.exit).toBe(0);
    // Окна 0,5° ± 10° и 10,5° ± 10° пересекаются на 10°: у каждой цели остаётся по 10°.
    expect(overlapping.bearing).toBeCloseTo(10 / 360, 9);
    expect(overlapping.exit).toBeCloseTo(10 / 360, 9);
  });

  it('метрика: доля тиков на одной цели, доля случайной башни и превышение', () => {
    const directions = apartDirections();
    const toHidden = bearingIn(APART, APART.hidden);
    const turrets = [
      soleDirection(directions, [toHidden], ['bearing']),
      soleDirection(directions, directions.exit, ['exit']),
      soleDirection(directions, directions.ricochet),
      soleDirection(directions, [bearingIn(APART, APART.seen)], ['lastSeen']),
      soleDirection(directions, [toHidden + Math.PI], []),
    ];
    const hiddenAim = profileMetrics(profileRoundsOf({ 'HIDE.log': hiddenAimLog(turrets, SEEN_TICKS, APART) })).aim
      .hiddenAim;
    const chance = soleChance(directions);

    TARGET_ORDER.forEach((target, index) => {
      expect(soleHiddenAim(turrets[index] ?? 0, directions)).toBe(target);
      expect(hiddenAim[target].sole).toMatchObject({ part: 1, total: 5 });
      expect(hiddenAim[target].chancePct).toBeCloseTo(100 * chance[target], 6);
      expect(hiddenAim[target].excessPct).toBeCloseTo(20 - 100 * chance[target], 6);
    });
  });

  it('рикошетов несколько — на рикошете башня у любого из них, а не только у ближайшего к пеленгу или к башне', () => {
    const directions = apartDirections();
    const toHidden = bearingIn(APART, APART.hidden);
    const upper = soleDirection(
      directions,
      directions.ricochet.filter((angle) => angle > 0),
    );
    const lower = soleDirection(
      directions,
      directions.ricochet.filter((angle) => angle < 0),
    );
    const log = hiddenAimLog([toHidden, upper, toHidden, lower], SEEN_TICKS, APART);
    const hiddenAim = profileMetrics(profileRoundsOf({ 'MANY.log': log })).aim.hiddenAim;

    expect(gap(upper, lower)).toBeGreaterThan(Math.PI / 2);
    expect(hiddenAim.ricochet.sole).toMatchObject({ part: 2, total: 4 });
  });

  it('противник ещё не был виден — места, где его видели, среди целей нет', () => {
    const seen = profileMetrics(profileRoundsOf({ 'SEEN.log': hiddenAimLog([bearing(SEEN)]) })).aim.hiddenAim;
    const unseen = profileMetrics(profileRoundsOf({ 'NOSE.log': hiddenAimLog([bearing(SEEN)], 0) })).aim.hiddenAim;

    expect(seen.lastSeen.sole).toMatchObject({ part: 1, total: 1 });
    expect(unseen.lastSeen.sole).toMatchObject({ part: 0, total: 1 });
    expect(unseen.lastSeen.chancePct).toBe(0);
  });
});

// Противник за стеной hiddenTicks тиков, затем выходит в точку APPEAR; башня всё время смотрит под углом turret.
const APPEAR = { x: 1000, y: 800 };

function appearLog(hiddenTicks: number, turret: number): string {
  const human = pose(ME.x, ME.y, 0, turret);
  const builder = startDuel()
    .roundStart(0, 0)
    .frames(countdownFrames([pose(HIDDEN.x, HIDDEN.y), human]));
  const ticks = hiddenTicks + 20;
  for (let tick = 0; tick < ticks; tick++) {
    const enemy = tick < hiddenTicks ? HIDDEN : APPEAR;
    const events = tick === 0 ? [shotEvent(HUMAN, human)] : [];
    builder.frame(
      fightFrame([pose(enemy.x, enemy.y), human], {
        actions: [IDLE, action(0)],
        events: tick === ticks - 1 ? [...events, roundOver(HUMAN)] : events,
      }),
    );
  }
  return builder.text();
}

describe('башня перед появлением противника', () => {
  it('за 0,5 с до появления после секунды без видимости башня сверяется с точкой появления', () => {
    const onPoint = profileMetrics(profileRoundsOf({ 'ON.log': appearLog(40, bearing(APPEAR)) })).aim.preAppear;
    const nearPoint = profileMetrics(
      profileRoundsOf({ 'NEAR.log': appearLog(40, bearing(APPEAR) + HIDDEN_AIM_WINDOW * 0.9) }),
    ).aim.preAppear;
    const offPoint = profileMetrics(
      profileRoundsOf({ 'OFF.log': appearLog(40, bearing(APPEAR) + HIDDEN_AIM_WINDOW * 1.1) }),
    ).aim.preAppear;

    expect(onPoint).toMatchObject({ part: 1, total: 1 });
    expect(nearPoint).toMatchObject({ part: 1, total: 1 });
    expect(offPoint).toMatchObject({ part: 0, total: 1 });
  });

  it('без видимости меньше секунды — не появление', () => {
    const short = profileMetrics(profileRoundsOf({ 'SHORT.log': appearLog(29, bearing(APPEAR)) })).aim.preAppear;
    const enough = profileMetrics(profileRoundsOf({ 'ENOUGH.log': appearLog(30, bearing(APPEAR)) })).aim.preAppear;

    expect(short.total).toBe(0);
    expect(enough.total).toBe(1);
  });
});
