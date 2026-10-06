import { clamp, TANK_RADIUS, type BattleMap, type Point, type Wall } from '@tanks/shared/engine';
import { isClear } from '../geometry.js';

// Укрытие рядом — свободная клетка сетки в пределах пути 300, из которой стена закрывает противника.
// Сетка — как у Охотника: клетка 25, отступ от стен и краёв на радиус танка с запасом.
const COVER_PATH_LENGTH = 300;
const CELL = 25;
const PAD = TANK_RADIUS + 2;
const DIAGONAL_STEP = Math.SQRT2;
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

interface Grid {
  cols: number;
  rows: number;
  free: Uint8Array;
  walls: readonly Wall[];
}

const grids = new WeakMap<readonly Wall[], Grid>();

function gridOf(map: BattleMap): Grid {
  const cached = grids.get(map.walls);
  if (cached !== undefined) {
    return cached;
  }
  const cols = Math.ceil(map.width / CELL);
  const rows = Math.ceil(map.height / CELL);
  const free = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * CELL + CELL / 2;
      const y = row * CELL + CELL / 2;
      const isInBounds = x > PAD && x < map.width - PAD && y > PAD && y < map.height - PAD;
      const isInWall = map.walls.some(
        (wall) => x > wall.x - PAD && x < wall.x + wall.w + PAD && y > wall.y - PAD && y < wall.y + wall.h + PAD,
      );
      if (isInBounds && !isInWall) {
        free[row * cols + col] = 1;
      }
    }
  }
  const grid: Grid = { cols, rows, free, walls: map.walls };
  grids.set(map.walls, grid);
  return grid;
}

function cellCenter(grid: Grid, index: number): Point {
  return { x: (index % grid.cols) * CELL + CELL / 2, y: Math.floor(index / grid.cols) * CELL + CELL / 2 };
}

function isFree(grid: Grid, row: number, col: number): boolean {
  const isInside = row >= 0 && row < grid.rows && col >= 0 && col < grid.cols;
  return isInside && grid.free[row * grid.cols + col] === 1;
}

// Путь — в шагах клетки: прямой шаг 1, по диагонали √2 и только если обе смежные клетки свободны.
export function hasCoverWithin(map: BattleMap, me: Point, enemy: Point): boolean {
  const grid = gridOf(map);
  const startCol = clamp(Math.floor(me.x / CELL), 0, grid.cols - 1);
  const startRow = clamp(Math.floor(me.y / CELL), 0, grid.rows - 1);
  const start = startRow * grid.cols + startCol;
  const maxSteps = COVER_PATH_LENGTH / CELL;
  const steps = new Map<number, number>([[start, 0]]);
  // Очередь с повторной постановкой при укорочении пути: ответу «есть / нет» порядок обхода не важен,
  // важно только, что каждая клетка в пределах пути раскрыта.
  const queue: number[] = [start];
  for (const current of queue) {
    const center = cellCenter(grid, current);
    if (!isClear(grid.walls, center.x, center.y, enemy.x, enemy.y)) {
      return true;
    }
    const row = Math.floor(current / grid.cols);
    const col = current % grid.cols;
    const base = steps.get(current) ?? 0;
    for (const [dr, dc] of NEIGHBOURS) {
      const isDiagonal = dr !== 0 && dc !== 0;
      if (!isFree(grid, row + dr, col + dc)) {
        continue;
      }
      if (isDiagonal && (!isFree(grid, row, col + dc) || !isFree(grid, row + dr, col))) {
        continue;
      }
      const next = (row + dr) * grid.cols + col + dc;
      const cost = base + (isDiagonal ? DIAGONAL_STEP : 1);
      const known = steps.get(next);
      if (cost > maxSteps || (known !== undefined && known <= cost)) {
        continue;
      }
      steps.set(next, cost);
      queue.push(next);
    }
  }
  return false;
}
