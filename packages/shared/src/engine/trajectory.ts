import { BULLET_LIFETIME, BULLET_RADIUS, MUZZLE_OFFSET, TANK_RADIUS } from './constants.js';
import { boundsHit, circleRect, type Field, type Wall } from './geometry.js';
import type { Point } from './maps.js';
import { isCarried, shotFlight } from './shot.js';

export interface ShotSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// Путь снаряда по правилам движка: первый отрезок — от дула до первой преграды или до конца дальности,
// второй — после единственного отскока. Пусто, если дуло упёрлось в преграду и снаряд не вылетит.
// speed — скорость снаряда на пути, carry — снос от стрелка (`shotCarry`).
export interface ShotTrace {
  segments: ShotSegment[];
  speed: number;
  carry: Point;
}

interface RayHit {
  distance: number;
  nx: number;
  ny: number;
}

const NO_HIT: RayHit = { distance: Infinity, nx: 0, ny: 0 };
// Попадание ближе этого к началу луча — та же поверхность, от которой снаряд только что отскочил.
const MIN_HIT_DISTANCE = 1e-6;

function closer(a: RayHit, b: RayHit): RayHit {
  return b.distance < a.distance ? b : a;
}

// Расстояние вдоль луча до плоскости при движении в её сторону; Infinity — от неё или вдоль.
function planeDistance(origin: number, direction: number, plane: number): number {
  if (direction === 0) {
    return Infinity;
  }
  const distance = (plane - origin) / direction;
  return distance > MIN_HIT_DISTANCE ? distance : Infinity;
}

function circleEntry(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number): RayHit {
  const fx = ox - cx;
  const fy = oy - cy;
  const b = fx * dx + fy * dy;
  const c = fx * fx + fy * fy - BULLET_RADIUS * BULLET_RADIUS;
  const discriminant = b * b - c;
  if (discriminant < 0) {
    return NO_HIT;
  }
  const distance = -b - Math.sqrt(discriminant);
  if (distance <= MIN_HIT_DISTANCE) {
    return NO_HIT;
  }
  return { distance, nx: (ox + dx * distance - cx) / BULLET_RADIUS, ny: (oy + dy * distance - cy) / BULLET_RADIUS };
}

// Преграда для снаряда — прямоугольник стены, раздутый на радиус снаряда: плоские грани в пределах стены и
// четверти круга на углах, как у `circleRect`.
function wallHit(wall: Wall, ox: number, oy: number, dx: number, dy: number): RayHit {
  const left = wall.x;
  const right = wall.x + wall.w;
  const top = wall.y;
  const bottom = wall.y + wall.h;
  let best = NO_HIT;
  const toVerticalFace =
    dx > 0 ? planeDistance(ox, dx, left - BULLET_RADIUS) : planeDistance(ox, dx, right + BULLET_RADIUS);
  const yAtVerticalFace = oy + dy * toVerticalFace;
  if (yAtVerticalFace >= top && yAtVerticalFace <= bottom) {
    best = closer(best, { distance: toVerticalFace, nx: dx > 0 ? -1 : 1, ny: 0 });
  }
  const toHorizontalFace =
    dy > 0 ? planeDistance(oy, dy, top - BULLET_RADIUS) : planeDistance(oy, dy, bottom + BULLET_RADIUS);
  const xAtHorizontalFace = ox + dx * toHorizontalFace;
  if (xAtHorizontalFace >= left && xAtHorizontalFace <= right) {
    best = closer(best, { distance: toHorizontalFace, nx: 0, ny: dy > 0 ? -1 : 1 });
  }
  for (const cx of [left, right]) {
    for (const cy of [top, bottom]) {
      best = closer(best, circleEntry(ox, oy, dx, dy, cx, cy));
    }
  }
  return best;
}

// Ближайшая преграда по лучу: края поля, затем стены — в том же порядке, что проверяет `stepBullet`.
function nearestHit(field: Field, ox: number, oy: number, dx: number, dy: number): RayHit {
  let best = NO_HIT;
  if (dx < 0) {
    best = closer(best, { distance: planeDistance(ox, dx, BULLET_RADIUS), nx: 1, ny: 0 });
  }
  if (dx > 0) {
    best = closer(best, { distance: planeDistance(ox, dx, field.width - BULLET_RADIUS), nx: -1, ny: 0 });
  }
  if (dy < 0) {
    best = closer(best, { distance: planeDistance(oy, dy, BULLET_RADIUS), nx: 0, ny: 1 });
  }
  if (dy > 0) {
    best = closer(best, { distance: planeDistance(oy, dy, field.height - BULLET_RADIUS), nx: 0, ny: -1 });
  }
  for (const wall of field.walls) {
    best = closer(best, wallHit(wall, ox, oy, dx, dy));
  }
  return best;
}

function isMuzzleBlocked(field: Field, x: number, y: number): boolean {
  if (boundsHit(x, y, BULLET_RADIUS, field) !== null) {
    return true;
  }
  return field.walls.some((wall) => circleRect(x, y, BULLET_RADIUS, wall) !== null);
}

// Дуло — по стволу, полёт — по стволу со сносом: при сносе путь отклоняется от ствола по ходу стрелка.
export function traceShot(
  field: Field,
  shooter: Point,
  turret: number,
  bulletSpeed: number,
  carry: Readonly<Point>,
): ShotTrace {
  const muzzleX = shooter.x + Math.cos(turret) * MUZZLE_OFFSET;
  const muzzleY = shooter.y + Math.sin(turret) * MUZZLE_OFFSET;
  const { dirX: dx, dirY: dy, speed } = shotFlight(turret, bulletSpeed, carry);
  const trace = (segments: ShotSegment[]): ShotTrace => ({ segments, speed, carry: { x: carry.x, y: carry.y } });
  if (isMuzzleBlocked(field, muzzleX, muzzleY)) {
    return trace([]);
  }
  const range = speed * BULLET_LIFETIME;
  const first = nearestHit(field, muzzleX, muzzleY, dx, dy);
  if (first.distance >= range) {
    return trace([{ x1: muzzleX, y1: muzzleY, x2: muzzleX + dx * range, y2: muzzleY + dy * range }]);
  }
  const bounceX = muzzleX + dx * first.distance;
  const bounceY = muzzleY + dy * first.distance;
  const dot = dx * first.nx + dy * first.ny;
  const backX = dx - 2 * dot * first.nx;
  const backY = dy - 2 * dot * first.ny;
  const remaining = range - first.distance;
  const second = nearestHit(field, bounceX, bounceY, backX, backY);
  const length = Math.min(remaining, second.distance);
  return trace([
    { x1: muzzleX, y1: muzzleY, x2: bounceX, y2: bounceY },
    { x1: bounceX, y1: bounceY, x2: bounceX + backX * length, y2: bounceY + backY * length },
  ]);
}

export function isSegmentWithin(segment: ShotSegment, point: Point, radius: number): boolean {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - segment.x1, point.y - segment.y1) < radius;
  }
  const projection = ((point.x - segment.x1) * dx + (point.y - segment.y1) * dy) / lengthSquared;
  const t = Math.max(0, Math.min(1, projection));
  return Math.hypot(point.x - (segment.x1 + dx * t), point.y - (segment.y1 + dy * t)) < radius;
}

// Путь проходит ближе этого к центру танка — снаряд его задевает.
export const TANK_HIT_RADIUS = TANK_RADIUS + BULLET_RADIUS;

function segmentLength(segment: ShotSegment): number {
  return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
}

// Второй отрезок глазами стрелка, который едет со скоростью сноса: точка, куда снаряд долетает за время t,
// сдвигается на −carry · t. Отрезок остаётся отрезком — снаряд и стрелок движутся равномерно.
function returningAlongCarrier(trace: ShotTrace, first: ShotSegment, returning: ShotSegment): ShotSegment {
  const { speed, carry } = trace;
  const bounceTime = segmentLength(first) / speed;
  const endTime = bounceTime + segmentLength(returning) / speed;
  return {
    x1: returning.x1 - carry.x * bounceTime,
    y1: returning.y1 - carry.y * bounceTime,
    x2: returning.x2 - carry.x * endTime,
    y2: returning.y2 - carry.y * endTime,
  };
}

// Свой снаряд до отскока владельца не ранит — опасен только второй отрезок. Противник на первом отрезке
// принимает снаряд на себя — до отскока дело не дойдёт. Снаряд со сносом возвращается не в точку выстрела,
// а туда, куда стрелок доедет со скоростью сноса.
export function isTraceReturning(trace: ShotTrace, shooter: Point, target: Point | null): boolean {
  const [first, returning] = trace.segments;
  if (first === undefined || returning === undefined) {
    return false;
  }
  if (target !== null && isSegmentWithin(first, target, TANK_HIT_RADIUS)) {
    return false;
  }
  const danger = isCarried(trace.carry) ? returningAlongCarrier(trace, first, returning) : returning;
  return isSegmentWithin(danger, shooter, TANK_HIT_RADIUS);
}

export function isShotReturning(
  field: Field,
  shooter: Point,
  turret: number,
  bulletSpeed: number,
  carry: Readonly<Point>,
  target: Point | null,
): boolean {
  return isTraceReturning(traceShot(field, shooter, turret, bulletSpeed, carry), shooter, target);
}
