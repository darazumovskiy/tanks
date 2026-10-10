import {
  ARENA,
  BULLET_LIFETIME,
  BULLET_RADIUS,
  isCarried,
  shotFlight,
  TANK_RADIUS,
  type Point,
  type Wall,
} from '@tanks/shared/engine';

// Обратная пуля считается опасной, если второй отрезок проходит ближе этого к центру танка.
const RETURN_MARGIN = TANK_RADIUS + BULLET_RADIUS + 15;
// Прямой отрезок считается прицельным, если проходит ближе этого к центру цели; такой выстрел не подавляется.
const ON_TARGET_MARGIN = TANK_RADIUS + BULLET_RADIUS + 20;

interface RayHit {
  x: number;
  y: number;
  distance: number;
  normalX: number;
  normalY: number;
}

// Отрезок пересекает прямоугольник, раздутый на pad (отсечение Лианга — Барски).
function segmentHitsRect(x1: number, y1: number, x2: number, y2: number, rect: Wall, pad: number): boolean {
  const minX = rect.x - pad;
  const maxX = rect.x + rect.w + pad;
  const minY = rect.y - pad;
  const maxY = rect.y + rect.h + pad;
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) {
      return q >= 0;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) {
        return false;
      }
      t0 = Math.max(t0, t);
      return true;
    }
    if (t < t0) {
      return false;
    }
    t1 = Math.min(t1, t);
    return true;
  };
  return clip(-dx, x1 - minX) && clip(dx, maxX - x1) && clip(-dy, y1 - minY) && clip(dy, maxY - y1);
}

export function isClear(walls: Wall[], x1: number, y1: number, x2: number, y2: number, pad: number): boolean {
  return !walls.some((wall) => segmentHitsRect(x1, y1, x2, y2, wall, pad));
}

function distanceToSegment(point: Point, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((point.x - x1) * dx + (point.y - y1) * dy) / lengthSquared));
  return Math.hypot(point.x - (x1 + dx * t), point.y - (y1 + dy * t));
}

// Расстояние вдоль луча до плоскости x = planeX (или y = planeY) при движении в её сторону; Infinity — от неё.
function planeDistance(origin: number, direction: number, plane: number): number {
  const distance = (plane - origin) / direction;
  return direction !== 0 && distance > 0 ? distance : Infinity;
}

// Луч из точки по направлению до первой преграды: стена, раздутая на радиус пули, или край поля. Край есть всегда,
// поэтому попадание найдётся.
function castRay(walls: Wall[], x: number, y: number, dirX: number, dirY: number): RayHit {
  let best: RayHit = { x, y, distance: Infinity, normalX: 0, normalY: 0 };
  const consider = (distance: number, normalX: number, normalY: number): void => {
    if (distance < best.distance) {
      best = { x: x + dirX * distance, y: y + dirY * distance, distance, normalX, normalY };
    }
  };
  consider(planeDistance(x, dirX, BULLET_RADIUS), 1, 0);
  consider(planeDistance(x, dirX, ARENA.width - BULLET_RADIUS), -1, 0);
  consider(planeDistance(y, dirY, BULLET_RADIUS), 0, 1);
  consider(planeDistance(y, dirY, ARENA.height - BULLET_RADIUS), 0, -1);
  for (const wall of walls) {
    const minX = wall.x - BULLET_RADIUS;
    const maxX = wall.x + wall.w + BULLET_RADIUS;
    const minY = wall.y - BULLET_RADIUS;
    const maxY = wall.y + wall.h + BULLET_RADIUS;
    const toVerticalFace = dirX > 0 ? planeDistance(x, dirX, minX) : planeDistance(x, dirX, maxX);
    const toHorizontalFace = dirY > 0 ? planeDistance(y, dirY, minY) : planeDistance(y, dirY, maxY);
    const yAtVerticalFace = y + dirY * toVerticalFace;
    const xAtHorizontalFace = x + dirX * toHorizontalFace;
    if (yAtVerticalFace >= minY && yAtVerticalFace <= maxY) {
      consider(toVerticalFace, dirX > 0 ? -1 : 1, 0);
    }
    if (xAtHorizontalFace >= minX && xAtHorizontalFace <= maxX) {
      consider(toHorizontalFace, 0, dirY > 0 ? -1 : 1);
    }
  }
  return best;
}

// Выстрел, который явно пройдёт мимо цели, а после одного отскока вернётся в стрелка. Прицельные выстрелы не
// подавляются: пуля, идущая в цель, до стены обычно не долетает. Пуля со сносом carry летит по стволу со сносом
// и возвращается туда, куда стрелок доедет со скоростью сноса: обратный путь сдвигается на −carry · t.
export function isReturningShot(
  walls: Wall[],
  shooter: Point,
  muzzle: Point,
  turret: number,
  bulletSpeed: number,
  carry: Readonly<Point>,
  target: Point,
): boolean {
  const { dirX, dirY, speed } = shotFlight(turret, bulletSpeed, carry);
  const first = castRay(walls, muzzle.x, muzzle.y, dirX, dirY);
  if (distanceToSegment(target, muzzle.x, muzzle.y, first.x, first.y) < ON_TARGET_MARGIN) {
    return false;
  }
  const dot = dirX * first.normalX + dirY * first.normalY;
  const backX = dirX - 2 * dot * first.normalX;
  const backY = dirY - 2 * dot * first.normalY;
  const remaining = Math.max(0, BULLET_LIFETIME * speed - first.distance);
  const second = castRay(walls, first.x, first.y, backX, backY);
  const length = Math.min(remaining, second.distance);
  const endX = first.x + backX * length;
  const endY = first.y + backY * length;
  if (!isCarried(carry)) {
    return distanceToSegment(shooter, first.x, first.y, endX, endY) < RETURN_MARGIN;
  }
  const bounceTime = first.distance / speed;
  const endTime = bounceTime + length / speed;
  return (
    distanceToSegment(
      shooter,
      first.x - carry.x * bounceTime,
      first.y - carry.y * bounceTime,
      endX - carry.x * endTime,
      endY - carry.y * endTime,
    ) < RETURN_MARGIN
  );
}
