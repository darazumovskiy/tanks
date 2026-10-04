import { TANK_HIT_RADIUS, traceShot, type Point, type ShotSegment, type Wall } from '@tanks/shared/engine';
import { enemyLeadPoint, type AimLineEnemy } from './aimLine.js';

// Дальше попадания по журналам почти не случаются — выстрел вдаль не считается выстрелом по цели.
export const ZONE_FIRE_MAX_RANGE = 650;

export interface ZoneFireInput {
  walls: readonly Wall[];
  shooter: Point & { turret: number };
  bulletSpeed: number;
  // Живой противник в кадре; `null` — цели нет, зоны нет.
  enemy: AimLineEnemy | null;
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

// Зона — капсула от корпуса противника до точки упреждения радиусом в корпус; у стоящего она вырождается в круг.
// Первый отрезок пути кончается на преграде, поэтому за стеной до капсулы он не дотянется — прямая видимость
// проверяется той же геометрией.
export function isShotInZone(input: ZoneFireInput): boolean {
  const { walls, shooter, bulletSpeed, enemy } = input;
  if (enemy === null) {
    return false;
  }
  if (Math.hypot(enemy.x - shooter.x, enemy.y - shooter.y) > ZONE_FIRE_MAX_RANGE) {
    return false;
  }
  const first = traceShot(walls, shooter, shooter.turret, bulletSpeed).segments[0];
  if (first === undefined) {
    return false;
  }
  const lead = enemyLeadPoint(shooter, enemy, bulletSpeed) ?? enemy;
  const corridor: ShotSegment = { x1: enemy.x, y1: enemy.y, x2: lead.x, y2: lead.y };
  return segmentDistance(first, corridor) < TANK_HIT_RADIUS;
}
