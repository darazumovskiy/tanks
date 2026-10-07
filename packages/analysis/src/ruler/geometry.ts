import { ARENA, BULLET_RADIUS, clamp, type Wall } from '@tanks/shared/engine';

const PARALLEL_EPSILON = 1e-12;

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

export function wallClearance(walls: readonly Wall[], x: number, y: number): number {
  let best = Math.min(x, ARENA.width - x, y, ARENA.height - y);
  for (const wall of walls) {
    const px = clamp(x, wall.x, wall.x + wall.w);
    const py = clamp(y, wall.y, wall.y + wall.h);
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  return best;
}
