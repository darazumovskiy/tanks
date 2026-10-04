import { ARENA, BULLET_RADIUS, boundsHit, clamp, type Point, type Wall } from '@tanks/shared/engine';

const LEAD_ITERATIONS = 4;
const PARALLEL_EPSILON = 1e-12;
const CONTACT_EPSILON = 1e-9;
// Точка рикошета пишется уже после отскока — чуть дальше радиуса снаряда от края поля.
const BOUNDS_CONTACT_PAD = 0.6;

export interface Normal {
  nx: number;
  ny: number;
}

export interface RayHit extends Normal {
  distance: number;
}

// Пересечение отрезка с прямоугольником, раздутым на pad (алгоритм Лианга — Барски).
function segmentHitsRect(x1: number, y1: number, x2: number, y2: number, wall: Wall, pad: number): boolean {
  const minX = wall.x - pad;
  const maxX = wall.x + wall.w + pad;
  const minY = wall.y - pad;
  const maxY = wall.y + wall.h + pad;
  const dx = x2 - x1;
  const dy = y2 - y1;
  let tEnter = 0;
  let tExit = 1;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < PARALLEL_EPSILON) {
      return q >= 0;
    }
    const r = q / p;
    if (p < 0) {
      if (r > tExit) {
        return false;
      }
      tEnter = Math.max(tEnter, r);
      return true;
    }
    if (r < tEnter) {
      return false;
    }
    tExit = Math.min(tExit, r);
    return true;
  };
  return clip(-dx, x1 - minX) && clip(dx, maxX - x1) && clip(-dy, y1 - minY) && clip(dy, maxY - y1);
}

// Прямая видимость для снаряда: отрезок не задевает стен, раздутых на его радиус.
export function isClear(walls: readonly Wall[], x1: number, y1: number, x2: number, y2: number): boolean {
  return !walls.some((wall) => segmentHitsRect(x1, y1, x2, y2, wall, BULLET_RADIUS));
}

// Нормаль преграды, от которой отскочил снаряд в точке (x, y): край поля или ближайшая стена.
export function wallNormalAt(walls: readonly Wall[], x: number, y: number): Normal {
  const contact = boundsHit(x, y, BULLET_RADIUS + BOUNDS_CONTACT_PAD, ARENA);
  if (contact !== null) {
    return { nx: contact.nx, ny: contact.ny };
  }
  let best: Normal = { nx: 1, ny: 0 };
  let bestDistance = Infinity;
  for (const wall of walls) {
    const px = clamp(x, wall.x, wall.x + wall.w);
    const py = clamp(y, wall.y, wall.y + wall.h);
    const distance = Math.hypot(x - px, y - py);
    if (distance >= bestDistance) {
      continue;
    }
    bestDistance = distance;
    best = distance > CONTACT_EPSILON ? { nx: (x - px) / distance, ny: (y - py) / distance } : { nx: 1, ny: 0 };
  }
  return best;
}

function planeDistance(origin: number, direction: number, plane: number): number {
  if (direction === 0) {
    return Infinity;
  }
  const distance = (plane - origin) / direction;
  return distance > 0 ? distance : Infinity;
}

// Расстояние по лучу до первой преграды (стена, раздутая на радиус снаряда, или край поля) и её нормаль.
export function castRay(walls: readonly Wall[], x: number, y: number, dx: number, dy: number): RayHit {
  let best: RayHit = { distance: Infinity, nx: 0, ny: 0 };
  const consider = (distance: number, nx: number, ny: number): void => {
    if (distance < best.distance) {
      best = { distance, nx, ny };
    }
  };
  consider(planeDistance(x, dx, BULLET_RADIUS), 1, 0);
  consider(planeDistance(x, dx, ARENA.width - BULLET_RADIUS), -1, 0);
  consider(planeDistance(y, dy, BULLET_RADIUS), 0, 1);
  consider(planeDistance(y, dy, ARENA.height - BULLET_RADIUS), 0, -1);
  for (const wall of walls) {
    const minX = wall.x - BULLET_RADIUS;
    const maxX = wall.x + wall.w + BULLET_RADIUS;
    const minY = wall.y - BULLET_RADIUS;
    const maxY = wall.y + wall.h + BULLET_RADIUS;
    const toVertical = dx > 0 ? planeDistance(x, dx, minX) : planeDistance(x, dx, maxX);
    const toHorizontal = dy > 0 ? planeDistance(y, dy, minY) : planeDistance(y, dy, maxY);
    if (toVertical < Infinity) {
      const hitY = y + dy * toVertical;
      if (minY <= hitY && hitY <= maxY) {
        consider(toVertical, dx > 0 ? -1 : 1, 0);
      }
    }
    if (toHorizontal < Infinity) {
      const hitX = x + dx * toHorizontal;
      if (minX <= hitX && hitX <= maxX) {
        consider(toHorizontal, 0, dy > 0 ? -1 : 1);
      }
    }
  }
  return best;
}

export function wallClearance(walls: readonly Wall[], x: number, y: number): number {
  let best = Math.min(x, ARENA.width - x, y, ARENA.height - y);
  for (const wall of walls) {
    const px = clamp(x, wall.x, wall.x + wall.w);
    const py = clamp(y, wall.y, wall.y + wall.h);
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  return best;
}

// Точка перехвата при полном учёте скорости цели — так целятся боты.
export function leadPoint(me: Point, enemy: Point, velocity: Point, bulletSpeed: number): Point {
  let x = enemy.x;
  let y = enemy.y;
  for (let i = 0; i < LEAD_ITERATIONS; i++) {
    const flight = Math.hypot(x - me.x, y - me.y) / bulletSpeed;
    x = enemy.x + velocity.x * flight;
    y = enemy.y + velocity.y * flight;
  }
  return { x, y };
}
