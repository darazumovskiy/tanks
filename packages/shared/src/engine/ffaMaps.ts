import type { Wall } from './geometry.js';
import type { BattleMap, Point } from './maps.js';
import { createRandom, nextRandom, type Random } from './random.js';

export type FfaSize = 10 | 30 | 50;

export const FFA_SIZES: readonly FfaSize[] = [10, 30, 50];

// Точка возрождения: центр и радиус области, внутри которой выбирается место появления.
export interface SpawnArea extends Point {
  radius: number;
}

export interface FfaMap extends BattleMap {
  size: FfaSize;
  spawnAreas: SpawnArea[];
}

interface Layout {
  width: number;
  height: number;
  cols: number;
  rows: number;
  spawnAreas: number;
  kits: number;
  seed: number;
}

const LAYOUTS: Readonly<Record<FfaSize, Layout>> = {
  10: { width: 2300, height: 1300, cols: 5, rows: 3, spawnAreas: 5, kits: 4, seed: 0x5a10 },
  30: { width: 4000, height: 2250, cols: 9, rows: 5, spawnAreas: 15, kits: 12, seed: 0x5a30 },
  50: { width: 5200, height: 2900, cols: 11, rows: 6, spawnAreas: 25, kits: 21, seed: 0x5a50 },
};

const SPAWN_AREA_RADIUS = 90;
const WALL_THICKNESS = 40;
const PILLAR_SIZE = 80;
// Препятствие держится дальше этого от краёв клетки: между клетками остаётся проход шире танка.
const CELL_MARGIN = 70;

type ShapeKind = 'barAcross' | 'barAlong' | 'corner' | 'pair' | 'pillar' | 'empty';

const SHAPE_WEIGHTS: readonly (readonly [ShapeKind, number])[] = [
  ['barAcross', 2],
  ['barAlong', 2],
  ['corner', 2],
  ['pair', 1],
  ['pillar', 2],
  ['empty', 1],
];

interface Cell {
  col: number;
  row: number;
  center: Point;
}

interface Inner {
  x: number;
  y: number;
  w: number;
  h: number;
}

function pickShape(random: Random): ShapeKind {
  const total = SHAPE_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = nextRandom(random) * total;
  for (const [kind, weight] of SHAPE_WEIGHTS) {
    roll -= weight;
    if (roll < 0) {
      return kind;
    }
  }
  return 'empty';
}

function between(random: Random, low: number, high: number): number {
  return low + nextRandom(random) * (high - low);
}

function wall(x: number, y: number, w: number, h: number): Wall {
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function horizontalBar(inner: Inner, y: number, length: number, isFromEnd: boolean): Wall {
  const x = isFromEnd ? inner.x + inner.w - length : inner.x;
  return wall(x, y, length, WALL_THICKNESS);
}

function verticalBar(inner: Inner, x: number, length: number, isFromEnd: boolean): Wall {
  const y = isFromEnd ? inner.y + inner.h - length : inner.y;
  return wall(x, y, WALL_THICKNESS, length);
}

function shapeWalls(kind: ShapeKind, inner: Inner, random: Random): Wall[] {
  const middleY = inner.y + (inner.h - WALL_THICKNESS) / 2;
  const middleX = inner.x + (inner.w - WALL_THICKNESS) / 2;
  const isFromEnd = nextRandom(random) < 0.5;
  switch (kind) {
    case 'barAcross':
      return [horizontalBar(inner, middleY, inner.w * between(random, 0.6, 1), isFromEnd)];
    case 'barAlong':
      return [verticalBar(inner, middleX, inner.h * between(random, 0.6, 1), isFromEnd)];
    case 'corner': {
      const isBottom = nextRandom(random) < 0.5;
      const barY = isBottom ? inner.y + inner.h - WALL_THICKNESS : inner.y;
      const barX = isFromEnd ? inner.x + inner.w - WALL_THICKNESS : inner.x;
      return [
        horizontalBar(inner, barY, inner.w * between(random, 0.5, 0.8), isFromEnd),
        verticalBar(inner, barX, inner.h * between(random, 0.5, 0.8), isBottom),
      ];
    }
    case 'pair': {
      if (nextRandom(random) < 0.5) {
        const length = inner.w * between(random, 0.5, 0.8);
        return [
          horizontalBar(inner, inner.y, length, isFromEnd),
          horizontalBar(inner, inner.y + inner.h - WALL_THICKNESS, length, !isFromEnd),
        ];
      }
      const length = inner.h * between(random, 0.5, 0.8);
      return [
        verticalBar(inner, inner.x, length, isFromEnd),
        verticalBar(inner, inner.x + inner.w - WALL_THICKNESS, length, !isFromEnd),
      ];
    }
    case 'pillar':
      return [
        wall(inner.x + (inner.w - PILLAR_SIZE) / 2, inner.y + (inner.h - PILLAR_SIZE) / 2, PILLAR_SIZE, PILLAR_SIZE),
      ];
    case 'empty':
      return [];
  }
}

// Каждая следующая клетка — самая дальняя от уже выбранных; при равенстве — первая по порядку обхода.
function spreadCells(cells: readonly Cell[], taken: readonly Cell[], count: number): Cell[] {
  const chosen: Cell[] = [];
  const all = [...taken];
  for (let i = 0; i < count; i++) {
    let best: Cell | null = null;
    let bestDistance = -1;
    for (const cell of cells) {
      if (all.includes(cell)) {
        continue;
      }
      const distance =
        all.length === 0
          ? 0
          : Math.min(...all.map((other) => Math.hypot(cell.center.x - other.center.x, cell.center.y - other.center.y)));
      if (distance > bestDistance) {
        best = cell;
        bestDistance = distance;
      }
    }
    if (best === null) {
      break;
    }
    chosen.push(best);
    all.push(best);
  }
  return chosen;
}

// Карта строится из сида размера: каждый вызов даёт ту же карту.
export function buildFfaMap(size: FfaSize): FfaMap {
  const layout = LAYOUTS[size];
  const random = createRandom(layout.seed);
  const cellW = layout.width / layout.cols;
  const cellH = layout.height / layout.rows;
  const cells: Cell[] = [];
  for (let row = 0; row < layout.rows; row++) {
    for (let col = 0; col < layout.cols; col++) {
      cells.push({ col, row, center: { x: (col + 0.5) * cellW, y: (row + 0.5) * cellH } });
    }
  }
  const spawnCells = spreadCells(cells, [], layout.spawnAreas);
  const kitCells = spreadCells(cells, spawnCells, layout.kits);
  const walls: Wall[] = [];
  for (const cell of cells) {
    if (spawnCells.includes(cell) || kitCells.includes(cell)) {
      continue;
    }
    const inner: Inner = {
      x: cell.col * cellW + CELL_MARGIN,
      y: cell.row * cellH + CELL_MARGIN,
      w: cellW - 2 * CELL_MARGIN,
      h: cellH - 2 * CELL_MARGIN,
    };
    walls.push(...shapeWalls(pickShape(random), inner, random));
  }
  return {
    name: `Арена на ${String(size)}`,
    size,
    width: layout.width,
    height: layout.height,
    walls,
    kits: kitCells.map((cell) => ({ x: Math.round(cell.center.x), y: Math.round(cell.center.y) })),
    spawnAreas: spawnCells.map((cell) => ({
      x: Math.round(cell.center.x),
      y: Math.round(cell.center.y),
      radius: SPAWN_AREA_RADIUS,
    })),
  };
}

const FFA_MAPS: Readonly<Record<FfaSize, FfaMap>> = { 10: buildFfaMap(10), 30: buildFfaMap(30), 50: buildFfaMap(50) };

export function ffaMap(size: FfaSize): FfaMap {
  return FFA_MAPS[size];
}
