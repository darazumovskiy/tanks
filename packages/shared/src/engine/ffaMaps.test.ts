import { describe, expect, it } from 'vitest';
import { TANK_RADIUS } from './constants.js';
import { buildFfaMap, FFA_SIZES, ffaMap, type FfaMap, type FfaSize } from './ffaMaps.js';
import { circleRect } from './geometry.js';
import type { Point } from './maps.js';

const EXPECTED: Readonly<Record<FfaSize, { width: number; height: number; areas: number; kits: number }>> = {
  10: { width: 2300, height: 1300, areas: 5, kits: 4 },
  30: { width: 4000, height: 2250, areas: 15, kits: 12 },
  50: { width: 5200, height: 2900, areas: 25, kits: 21 },
};
const GRID_STEP = 10;
const MIN_AREA_SPACING = 400;
// Отпечатки карт, одинаковые на V8 и JavaScriptCore (проверено jsc из macOS): клиент строит карту сам,
// поэтому смена раскладки должна быть заметна.
const MAP_DIGESTS: Readonly<Record<FfaSize, string>> = { 10: '9cbe8c29', 30: '60cd8e09', 50: '4781d08e' };

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// Заливка сетки центров танка: клетка свободна, если круг танка не задевает стен и краёв поля.
function reachableGrid(map: FfaMap, start: Point): { isReachable: (point: Point) => boolean } {
  const cols = Math.floor(map.width / GRID_STEP);
  const rows = Math.floor(map.height / GRID_STEP);
  const isFree = (col: number, row: number): boolean => {
    const x = col * GRID_STEP;
    const y = row * GRID_STEP;
    const isInside =
      x >= TANK_RADIUS && x <= map.width - TANK_RADIUS && y >= TANK_RADIUS && y <= map.height - TANK_RADIUS;
    return isInside && map.walls.every((wall) => circleRect(x, y, TANK_RADIUS, wall) === null);
  };
  const seen = new Uint8Array(cols * rows);
  const queue: number[] = [];
  const startCol = Math.round(start.x / GRID_STEP);
  const startRow = Math.round(start.y / GRID_STEP);
  seen[startRow * cols + startCol] = 1;
  queue.push(startRow * cols + startCol);
  while (queue.length > 0) {
    const index = queue.pop() ?? 0;
    const col = index % cols;
    const row = Math.floor(index / cols);
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nc = col + dc;
      const nr = row + dr;
      const next = nr * cols + nc;
      const isOnGrid = nc >= 0 && nc < cols && nr >= 0 && nr < rows;
      if (isOnGrid && seen[next] === 0 && isFree(nc, nr)) {
        seen[next] = 1;
        queue.push(next);
      }
    }
  }
  return {
    isReachable: (point) => seen[Math.round(point.y / GRID_STEP) * cols + Math.round(point.x / GRID_STEP)] === 1,
  };
}

describe.each(FFA_SIZES.map((size) => [size] as const))('карта на %i мест', (size) => {
  const map = ffaMap(size);
  const expected = EXPECTED[size];

  it('размеры, число точек возрождения и аптечек', () => {
    expect(map.size).toBe(size);
    expect(map.width).toBe(expected.width);
    expect(map.height).toBe(expected.height);
    expect(map.spawnAreas).toHaveLength(expected.areas);
    expect(map.kits).toHaveLength(expected.kits);
  });

  it('области возрождения внутри поля и свободны от стен', () => {
    for (const area of map.spawnAreas) {
      const reach = area.radius + TANK_RADIUS;
      expect(area.x - reach).toBeGreaterThanOrEqual(0);
      expect(area.y - reach).toBeGreaterThanOrEqual(0);
      expect(area.x + reach).toBeLessThanOrEqual(map.width);
      expect(area.y + reach).toBeLessThanOrEqual(map.height);
      for (const wall of map.walls) {
        expect(circleRect(area.x, area.y, reach, wall)).toBeNull();
      }
    }
  });

  it('каждая область и аптечка достижимы танком из любой области', () => {
    const [first] = map.spawnAreas;
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    const grid = reachableGrid(map, first);
    for (const point of [...map.spawnAreas, ...map.kits]) {
      expect(grid.isReachable(point), `(${String(point.x)}, ${String(point.y)})`).toBe(true);
    }
  });

  it('точки возрождения разнесены', () => {
    for (const [i, a] of map.spawnAreas.entries()) {
      for (const b of map.spawnAreas.slice(i + 1)) {
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(MIN_AREA_SPACING);
      }
    }
  });

  it('повторная сборка даёт ту же карту', () => {
    expect(buildFfaMap(size)).toEqual(map);
  });

  it('отпечаток совпадает с эталоном', () => {
    expect(fnv1a(JSON.stringify(map))).toBe(MAP_DIGESTS[size]);
  });
});
