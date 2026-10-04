import type { Wall } from '@tanks/shared/engine';

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
