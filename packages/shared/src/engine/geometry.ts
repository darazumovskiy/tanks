export interface Wall {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Contact {
  nx: number;
  ny: number;
  depth: number;
}

export interface FieldSize {
  width: number;
  height: number;
}

export interface Field extends FieldSize {
  walls: readonly Wall[];
}

export function clamp(value: number, low: number, high: number): number {
  if (value < low) {
    return low;
  }
  if (value > high) {
    return high;
  }
  return value;
}

export function normalizeAngle(angle: number): number {
  let a = (angle + Math.PI) % (2 * Math.PI);
  if (a < 0) {
    a += 2 * Math.PI;
  }
  return a - Math.PI;
}

export function circleRect(cx: number, cy: number, r: number, wall: Wall): Contact | null {
  const px = clamp(cx, wall.x, wall.x + wall.w);
  const py = clamp(cy, wall.y, wall.y + wall.h);
  const dx = cx - px;
  const dy = cy - py;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) {
    return null;
  }
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    return { nx: dx / d, ny: dy / d, depth: r - d };
  }
  const left = cx - wall.x;
  const right = wall.x + wall.w - cx;
  const top = cy - wall.y;
  const bottom = wall.y + wall.h - cy;
  const m = Math.min(left, right, top, bottom);
  if (m === left) {
    return { nx: -1, ny: 0, depth: left + r };
  }
  if (m === right) {
    return { nx: 1, ny: 0, depth: right + r };
  }
  if (m === top) {
    return { nx: 0, ny: -1, depth: top + r };
  }
  return { nx: 0, ny: 1, depth: bottom + r };
}

export function boundsHit(x: number, y: number, r: number, field: FieldSize): Contact | null {
  if (x < r) {
    return { nx: 1, ny: 0, depth: r - x };
  }
  if (x > field.width - r) {
    return { nx: -1, ny: 0, depth: x - (field.width - r) };
  }
  if (y < r) {
    return { nx: 0, ny: 1, depth: r - y };
  }
  if (y > field.height - r) {
    return { nx: 0, ny: -1, depth: y - (field.height - r) };
  }
  return null;
}

// Отрезок не задевает ни одной стены, раздутой на pad: отсечение отрезка прямоугольником (Лян — Барски).
export function isSegmentClear(
  walls: readonly Wall[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  pad: number,
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return walls.every((wall) => {
    let enter = 0;
    let exit = 1;
    const edges: readonly [number, number][] = [
      [-dx, x1 - (wall.x - pad)],
      [dx, wall.x + wall.w + pad - x1],
      [-dy, y1 - (wall.y - pad)],
      [dy, wall.y + wall.h + pad - y1],
    ];
    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) {
          return true;
        }
        continue;
      }
      const t = q / p;
      if (p < 0) {
        enter = Math.max(enter, t);
      } else {
        exit = Math.min(exit, t);
      }
      if (enter > exit) {
        return true;
      }
    }
    return false;
  });
}
