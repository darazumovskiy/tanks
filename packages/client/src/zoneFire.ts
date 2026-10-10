import { TANK_HIT_RADIUS, traceShot, type Field, type Point, type ShotSegment } from '@tanks/shared/engine';
import { enemyLeadPoint, type AimLineEnemy } from './aimLine.js';

// Дальше попадания по журналам почти не случаются — выстрел вдаль не считается выстрелом по цели.
export const ZONE_FIRE_MAX_RANGE = 650;

export interface ZonePathInput {
  shooter: Point;
  bulletSpeed: number;
  // Снос своего снаряда скоростью своего танка (`shotCarry` по правилам боя).
  carry: Point;
  // Живые чужие танки в кадре; пусто — целей нет, зоны нет.
  targets: readonly AimLineEnemy[];
}

export interface ZoneFireInput extends ZonePathInput {
  field: Field;
  shooter: Point & { turret: number };
}

function pointToSegmentDistance(point: Point, segment: ShotSegment): number {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - segment.x1, point.y - segment.y1);
  }
  const projection = ((point.x - segment.x1) * dx + (point.y - segment.y1) * dy) / lengthSquared;
  const t = Math.max(0, Math.min(1, projection));
  return Math.hypot(point.x - (segment.x1 + dx * t), point.y - (segment.y1 + dy * t));
}

function orientation(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
}

function areSegmentsCrossing(a: ShotSegment, b: ShotSegment): boolean {
  const abToB1 = orientation(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const abToB2 = orientation(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const baToA1 = orientation(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const baToA2 = orientation(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  const isStraddlingA = abToB1 * abToB2 < 0;
  const isStraddlingB = baToA1 * baToA2 < 0;
  return isStraddlingA && isStraddlingB;
}

// Расстояние между отрезками: ноль при пересечении, иначе ближайший конец одного к другому.
function segmentDistance(a: ShotSegment, b: ShotSegment): number {
  if (areSegmentsCrossing(a, b)) {
    return 0;
  }
  return Math.min(
    pointToSegmentDistance({ x: a.x1, y: a.y1 }, b),
    pointToSegmentDistance({ x: a.x2, y: a.y2 }, b),
    pointToSegmentDistance({ x: b.x1, y: b.y1 }, a),
    pointToSegmentDistance({ x: b.x2, y: b.y2 }, a),
  );
}

function isInRange(enemy: Point, shooter: Point): boolean {
  return Math.hypot(enemy.x - shooter.x, enemy.y - shooter.y) <= ZONE_FIRE_MAX_RANGE;
}

export function isShotInZone(input: ZoneFireInput): boolean {
  const { field, shooter, bulletSpeed, carry } = input;
  if (!input.targets.some((enemy) => isInRange(enemy, shooter))) {
    return false;
  }
  return isPathInZone(traceShot(field, shooter, shooter.turret, bulletSpeed, carry).segments, input);
}

// Зона — капсула от корпуса противника до точки упреждения радиусом в корпус; у стоящего она вырождается в круг.
// Первый отрезок пути кончается на преграде, поэтому за стеной до капсулы он не дотянется — прямая видимость
// проверяется той же геометрией. Выстрел открыт, если путь заходит в зону любой цели.
export function isPathInZone(path: readonly ShotSegment[], input: ZonePathInput): boolean {
  const { shooter, bulletSpeed, carry } = input;
  const first = path[0];
  if (first === undefined) {
    return false;
  }
  const inRange = input.targets.filter((enemy) => isInRange(enemy, shooter));
  return inRange.some((enemy) => {
    const lead = enemyLeadPoint(shooter, enemy, bulletSpeed, carry) ?? enemy;
    const corridor: ShotSegment = { x1: enemy.x, y1: enemy.y, x2: lead.x, y2: lead.y };
    return segmentDistance(first, corridor) < TANK_HIT_RADIUS;
  });
}
