import { describe, expect, it } from 'vitest';
import { BULLET_LIFETIME, BULLET_RADIUS, DT, MUZZLE_OFFSET, TANK_RADIUS } from './constants.js';
import type { Wall } from './geometry.js';
import { MAPS, type Point } from './maps.js';
import { createRound, IDLE_ACTION, stepRound, type RoundEvent } from './round.js';
import { isSegmentWithin, isShotReturning, isTraceReturning, traceShot, type ShotSegment } from './trajectory.js';

const POLYGON = 0;
const LABYRINTH = 1;
const DEFAULT_SPEED = 550;
const SELF_HIT_RADIUS = TANK_RADIUS + BULLET_RADIUS;
const deg = (value: number): number => (value * Math.PI) / 180;

function polygonWalls(): Wall[] {
  return MAPS[POLYGON]?.walls ?? [];
}

function length(segment: ShotSegment): number {
  return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
}

describe('traceShot', () => {
  it('выстрел перпендикулярно в ближний край поля возвращается в стрелка', () => {
    const shooter = { x: 140, y: 450 };
    const { segments } = traceShot(polygonWalls(), shooter, Math.PI, DEFAULT_SPEED);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ x1: 140 - MUZZLE_OFFSET, y1: 450, x2: BULLET_RADIUS, y2: 450 });
    expect(segments[1]?.x1).toBe(BULLET_RADIUS);
    expect(segments[1]?.x2).toBeGreaterThan(shooter.x);
    expect(segments[1]?.y2).toBeCloseTo(450, 6);
    expect(isShotReturning(polygonWalls(), shooter, Math.PI, DEFAULT_SPEED, null)).toBe(true);
  });

  it('под 30° к краю снаряд уходит мимо корпуса', () => {
    const shooter = { x: 140, y: 450 };
    const turret = -deg(150);
    const { segments } = traceShot(polygonWalls(), shooter, turret, DEFAULT_SPEED);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.x2).toBe(BULLET_RADIUS);
    expect(segments[1]?.x2).toBeGreaterThan(segments[1]?.x1 ?? 0);
    expect(segments[1]?.y2).toBeLessThan(segments[1]?.y1 ?? 0);
    expect(isShotReturning(polygonWalls(), shooter, turret, DEFAULT_SPEED, null)).toBe(false);
  });

  it('выстрел в упор в стену «Полигона» возвращается', () => {
    const shooter = { x: 260, y: 260 };
    const { segments } = traceShot(polygonWalls(), shooter, 0, DEFAULT_SPEED);
    expect(segments[0]?.x2).toBe(330 - BULLET_RADIUS);
    expect(isShotReturning(polygonWalls(), shooter, 0, DEFAULT_SPEED, null)).toBe(true);
  });

  it('дуло внутри стены — снаряда нет, опасности нет', () => {
    const shooter = { x: 300, y: 260 };
    expect(traceShot(polygonWalls(), shooter, 0, DEFAULT_SPEED).segments).toHaveLength(0);
    expect(isShotReturning(polygonWalls(), shooter, 0, DEFAULT_SPEED, null)).toBe(false);
  });

  it('дуло за краем поля — снаряда нет', () => {
    expect(traceShot([], { x: 20, y: 450 }, Math.PI, DEFAULT_SPEED).segments).toHaveLength(0);
  });

  it('дальность полёта обрывает второй отрезок до возврата', () => {
    const shooter = { x: 700, y: 450 };
    const slow = traceShot(polygonWalls(), shooter, Math.PI, 300);
    expect(slow.segments).toHaveLength(2);
    const total =
      length(slow.segments[0] ?? { x1: 0, y1: 0, x2: 0, y2: 0 }) +
      length(slow.segments[1] ?? { x1: 0, y1: 0, x2: 0, y2: 0 });
    expect(total).toBeCloseTo(300 * BULLET_LIFETIME, 6);
    expect(isShotReturning(polygonWalls(), shooter, Math.PI, 300, null)).toBe(false);
    expect(isShotReturning(polygonWalls(), shooter, Math.PI, DEFAULT_SPEED, null)).toBe(true);
  });

  it('дальность кончается раньше первой преграды — один отрезок', () => {
    const { segments } = traceShot(polygonWalls(), { x: 140, y: 450 }, Math.PI, 5);
    expect(segments).toHaveLength(1);
    expect(length(segments[0] ?? { x1: 0, y1: 0, x2: 0, y2: 0 })).toBeCloseTo(5 * BULLET_LIFETIME, 6);
    expect(isShotReturning(polygonWalls(), { x: 140, y: 450 }, Math.PI, 5, null)).toBe(false);
  });

  it('угол стены скруглён на радиус снаряда: нормаль радиальная', () => {
    const wall: Wall = { x: 300, y: 300, w: 100, h: 100 };
    const missing = traceShot([wall], { x: 200, y: 290 }, 0, DEFAULT_SPEED);
    expect(missing.segments[0]?.x2).toBeGreaterThan(400);
    const grazing = traceShot([wall], { x: 200, y: 297 }, 0, DEFAULT_SPEED);
    expect(grazing.segments[0]?.x2).toBeCloseTo(296, 6);
    const back = grazing.segments[1] ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
    const backLength = length(back);
    expect((back.x2 - back.x1) / backLength).toBeCloseTo(-0.28, 6);
    expect((back.y2 - back.y1) / backLength).toBeCloseTo(-0.96, 6);
  });

  it('грань стены по направлению луча: отскок от верхней грани', () => {
    const wall: Wall = { x: 300, y: 300, w: 100, h: 100 };
    const { segments } = traceShot([wall], { x: 350, y: 200 }, Math.PI / 2, DEFAULT_SPEED);
    expect(segments[0]?.y2).toBeCloseTo(300 - BULLET_RADIUS, 6);
    expect(segments[1]?.y2).toBeLessThan(200);
  });
});

describe('isShotReturning с противником', () => {
  const shooter = { x: 260, y: 260 };

  it('противник между дулом и стеной принимает снаряд — выстрел безопасен', () => {
    expect(isShotReturning(polygonWalls(), shooter, 0, DEFAULT_SPEED, { x: 300, y: 260 })).toBe(false);
    expect(isShotReturning(polygonWalls(), shooter, 0, DEFAULT_SPEED, null)).toBe(true);
  });

  it('противник в стороне от первого отрезка опасности не снимает', () => {
    expect(isShotReturning(polygonWalls(), shooter, 0, DEFAULT_SPEED, { x: 260, y: 400 })).toBe(true);
  });

  it('противник на втором отрезке не учитывается', () => {
    // Почти перпендикулярно в край: обратный путь задевает корпус и уходит дальше, не совпадая с первым отрезком.
    const edgeShooter = { x: 140, y: 450 };
    const turret = Math.PI - 0.02;
    const { segments } = traceShot(polygonWalls(), edgeShooter, turret, DEFAULT_SPEED);
    const [first, returning] = segments;
    const back = returning ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
    const along = Math.atan2(back.y2 - back.y1, back.x2 - back.x1);
    const onReturnPath = { x: back.x1 + Math.cos(along) * 500, y: back.y1 + Math.sin(along) * 500 };
    expect(isSegmentWithin(back, onReturnPath, 1)).toBe(true);
    expect(isSegmentWithin(first ?? back, onReturnPath, SELF_HIT_RADIUS)).toBe(false);
    expect(isShotReturning(polygonWalls(), edgeShooter, turret, DEFAULT_SPEED, null)).toBe(true);
    expect(isShotReturning(polygonWalls(), edgeShooter, turret, DEFAULT_SPEED, onReturnPath)).toBe(true);
  });

  it('пустой путь и один отрезок — не возвращается', () => {
    expect(isTraceReturning([], shooter, null)).toBe(false);
    expect(isTraceReturning([{ x1: 0, y1: 0, x2: 10, y2: 0 }], shooter, null)).toBe(false);
  });
});

describe('isSegmentWithin', () => {
  const segment: ShotSegment = { x1: 0, y1: 0, x2: 100, y2: 0 };

  it('точка у середины, у конца и за концом; радиус строгий', () => {
    expect(isSegmentWithin(segment, { x: 50, y: 10 }, 11)).toBe(true);
    expect(isSegmentWithin(segment, { x: 50, y: 10 }, 10)).toBe(false);
    expect(isSegmentWithin(segment, { x: 120, y: 0 }, 25)).toBe(true);
    expect(isSegmentWithin(segment, { x: -30, y: 0 }, 20)).toBe(false);
  });

  it('вырожденный отрезок — точка', () => {
    expect(isSegmentWithin({ x1: 5, y1: 5, x2: 5, y2: 5 }, { x: 5, y: 8 }, 4)).toBe(true);
    expect(isSegmentWithin({ x1: 5, y1: 5, x2: 5, y2: 5 }, { x: 5, y: 8 }, 3)).toBe(false);
  });
});

// Точки стрелка свободны от стен; противник ставится в угол поля, которого путь не касается.
const SHOOTER_SPOTS: { mapIndex: number; spot: Point }[] = [
  { mapIndex: POLYGON, spot: { x: 140, y: 450 } },
  { mapIndex: POLYGON, spot: { x: 260, y: 260 } },
  { mapIndex: POLYGON, spot: { x: 700, y: 450 } },
  { mapIndex: POLYGON, spot: { x: 1000, y: 200 } },
  { mapIndex: LABYRINTH, spot: { x: 140, y: 450 } },
  { mapIndex: LABYRINTH, spot: { x: 600, y: 450 } },
];
const ENEMY_SPOTS: Point[] = [
  { x: 1500, y: 100 },
  { x: 1500, y: 800 },
  { x: 100, y: 800 },
  { x: 100, y: 100 },
];
const GUN_STATS = [
  { armor: 3, engine: 3, gun: 0, reload: 4 },
  { armor: 0, engine: 0, gun: 5, reload: 5 },
];
const ANGLE_STEP_DEG = 15;
const ENEMY_CLEARANCE = 80;
// Снаряд движка летит шагами до 6 единиц: отскок и проверка попадания дискретные, поэтому пути, проходящие
// у самой границы корпуса, с непрерывным расчётом могут разойтись.
const BORDERLINE_MARGIN = 10;
const MAX_FLIGHT_TICKS = Math.ceil(BULLET_LIFETIME / DT) + 2;
const MIN_COMPARISONS = 10;

function clearEnemySpot(segments: ShotSegment[]): Point | null {
  for (const candidate of ENEMY_SPOTS) {
    const isClear = segments.every((segment) => !isSegmentWithin(segment, candidate, ENEMY_CLEARANCE));
    if (isClear) {
      return candidate;
    }
  }
  return null;
}

function isBorderline(segments: ShotSegment[], shooter: Point): boolean {
  const returning = segments[1];
  if (returning === undefined) {
    return false;
  }
  const end = { x: returning.x2, y: returning.y2 };
  const isEndNearHull =
    Math.abs(Math.hypot(end.x - shooter.x, end.y - shooter.y) - SELF_HIT_RADIUS) < BORDERLINE_MARGIN;
  const isPassNearHull =
    isSegmentWithin(returning, shooter, SELF_HIT_RADIUS + BORDERLINE_MARGIN) &&
    !isSegmentWithin(returning, shooter, SELF_HIT_RADIUS - BORDERLINE_MARGIN);
  return isEndNearHull || isPassNearHull;
}

function simulateSelfHit(
  mapIndex: number,
  stats: (typeof GUN_STATS)[number],
  shooter: Point,
  turret: number,
  enemy: Point,
): boolean {
  const round = createRound(mapIndex, [
    { name: 'A', stats },
    { name: 'B', stats },
  ]);
  Object.assign(round.tanks[0], { x: shooter.x, y: shooter.y, turret });
  Object.assign(round.tanks[1], { x: enemy.x, y: enemy.y });
  const isSelfHit = (event: RoundEvent): boolean => event.type === 'hit' && event.cause === 'self' && event.side === 0;
  for (let tick = 0; tick < MAX_FLIGHT_TICKS; tick++) {
    const events = stepRound(round, [{ ...IDLE_ACTION, isFiring: tick === 0 }, IDLE_ACTION]);
    if (events.some(isSelfHit)) {
      return true;
    }
    if (tick > 0 && round.bullets.length === 0) {
      return false;
    }
  }
  return false;
}

describe('согласованность с движком', () => {
  it('«опасно» ⇔ движок даёт самопопадание при неподвижном танке', () => {
    let dangerous = 0;
    let safe = 0;
    let borderline = 0;
    for (const { mapIndex, spot } of SHOOTER_SPOTS) {
      const walls = MAPS[mapIndex]?.walls ?? [];
      for (const stats of GUN_STATS) {
        const bulletSpeed = 450 + 50 * stats.gun;
        for (let angle = 0; angle < 360; angle += ANGLE_STEP_DEG) {
          const turret = deg(angle);
          const { segments } = traceShot(walls, spot, turret, bulletSpeed);
          const enemy = clearEnemySpot(segments);
          if (enemy === null) {
            continue;
          }
          if (isBorderline(segments, spot)) {
            borderline++;
            continue;
          }
          const isExpectedReturning = isShotReturning(walls, spot, turret, bulletSpeed, null);
          const isSelfHitInEngine = simulateSelfHit(mapIndex, stats, spot, turret, enemy);
          expect(
            isSelfHitInEngine,
            `карта ${String(mapIndex)}, точка (${String(spot.x)}, ${String(spot.y)}), угол ${String(angle)}°`,
          ).toBe(isExpectedReturning);
          if (isExpectedReturning) {
            dangerous++;
          } else {
            safe++;
          }
        }
      }
    }
    expect(dangerous).toBeGreaterThanOrEqual(MIN_COMPARISONS);
    expect(safe).toBeGreaterThanOrEqual(MIN_COMPARISONS);
    expect(borderline).toBeLessThan(dangerous + safe);
  });
});
