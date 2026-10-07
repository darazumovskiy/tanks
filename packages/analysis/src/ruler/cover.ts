import { clamp, TANK_RADIUS, type BattleMap, type Point, type Wall } from '@tanks/shared/engine';
import { isClear } from './geometry.js';

// Укрытие рядом — свободная клетка сетки в пределах пути 300, из которой стена закрывает противника.
// Сетка — как у Охотника: клетка 25, отступ от стен и краёв на радиус танка с запасом.
const COVER_PATH_LENGTH = 300;
const CELL = 25;
const PAD = TANK_RADIUS + 2;
const DIAGONAL_STEP = Math.SQRT2;
const NEAREST_FREE_RINGS = 6;
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

function cellOf(grid: Grid, point: Point): number {
  const col = clamp(Math.floor(point.x / CELL), 0, grid.cols - 1);
  const row = clamp(Math.floor(point.y / CELL), 0, grid.rows - 1);
  return row * grid.cols + col;
}

// Свободная клетка ближе всего к точке по кольцам вокруг её клетки; null — вокруг всё занято.
function nearestFreeCell(grid: Grid, point: Point): number | null {
  const start = cellOf(grid, point);
  const row = Math.floor(start / grid.cols);
  const col = start % grid.cols;
  for (let ring = 0; ring <= NEAREST_FREE_RINGS; ring++) {
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        const isOnRing = Math.max(Math.abs(dr), Math.abs(dc)) === ring;
        if (isOnRing && isFree(grid, row + dr, col + dc)) {
          return (row + dr) * grid.cols + col + dc;
        }
      }
    }
  }
  return null;
}

function neighboursOf(grid: Grid, index: number): number[] {
  const row = Math.floor(index / grid.cols);
  const col = index % grid.cols;
  const result: number[] = [];
  for (const [dr, dc] of NEIGHBOURS) {
    const isDiagonal = dr !== 0 && dc !== 0;
    if (!isFree(grid, row + dr, col + dc)) {
      continue;
    }
    if (isDiagonal && (!isFree(grid, row, col + dc) || !isFree(grid, row + dr, col))) {
      continue;
    }
    result.push((row + dr) * grid.cols + col + dc);
  }
  return result;
}

// Путь по сетке поиском в ширину — центры клеток от клетки начала до клетки цели; пусто — пути нет.
export function gridPath(map: BattleMap, from: Point, to: Point): Point[] {
  const grid = gridOf(map);
  const start = nearestFreeCell(grid, from);
  const goal = nearestFreeCell(grid, to);
  if (start === null || goal === null) {
    return [];
  }
  const previous = new Map<number, number>([[start, start]]);
  const queue: number[] = [start];
  for (const current of queue) {
    if (current === goal) {
      break;
    }
    for (const next of neighboursOf(grid, current)) {
      if (!previous.has(next)) {
        previous.set(next, current);
        queue.push(next);
      }
    }
  }
  if (!previous.has(goal)) {
    return [];
  }
  const cells = [goal];
  for (let cell = goal; cell !== start; cell = previous.get(cell) ?? start) {
    cells.push(previous.get(cell) ?? start);
  }
  return cells.reverse().map((cell) => cellCenter(grid, cell));
}

function stepLength(grid: Grid, from: number, to: number): number {
  const isDiagonal = to % grid.cols !== from % grid.cols && Math.abs(to - from) !== 1;
  return isDiagonal ? DIAGONAL_STEP : 1;
}

// Длина пути по сетке до точки от каждой клетки, в клетках; Infinity — клетка недостижима.
export interface PathField {
  grid: Grid;
  steps: Float64Array;
}

const fields = new WeakMap<readonly Wall[], Map<string, PathField>>();

export function pathFieldTo(map: BattleMap, goal: Point): PathField {
  const grid = gridOf(map);
  const byGoal = fields.get(map.walls) ?? new Map<string, PathField>();
  fields.set(map.walls, byGoal);
  const key = `${String(goal.x)}:${String(goal.y)}`;
  const cached = byGoal.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const steps = new Float64Array(grid.cols * grid.rows).fill(Infinity);
  const start = nearestFreeCell(grid, goal);
  const queue: number[] = start === null ? [] : [start];
  if (start !== null) {
    steps[start] = 0;
  }
  for (const current of queue) {
    const base = steps[current] ?? Infinity;
    for (const next of neighboursOf(grid, current)) {
      const cost = base + stepLength(grid, current, next);
      if (cost < (steps[next] ?? Infinity)) {
        steps[next] = cost;
        queue.push(next);
      }
    }
  }
  const field = { grid, steps };
  byGoal.set(key, field);
  return field;
}

export function pathLengthFrom(field: PathField, point: Point): number {
  const cell = nearestFreeCell(field.grid, point);
  return cell === null ? Infinity : (field.steps[cell] ?? Infinity) * CELL;
}

// Точка пути к цели не ближе reach от point — по убыванию длины пути; null — с этой точки пути нет.
export function pathPointFrom(field: PathField, point: Point, reach: number): Point | null {
  const { grid, steps } = field;
  const start = nearestFreeCell(grid, point);
  if (start === null || steps[start] === Infinity) {
    return null;
  }
  let cell: number = start;
  let center = cellCenter(grid, cell);
  while ((steps[cell] ?? 0) > 0 && Math.hypot(center.x - point.x, center.y - point.y) < reach) {
    let next: number = cell;
    for (const candidate of neighboursOf(grid, cell)) {
      if ((steps[candidate] ?? Infinity) < (steps[next] ?? Infinity)) {
        next = candidate;
      }
    }
    cell = next;
    center = cellCenter(grid, cell);
  }
  return center;
}

// Путь — в шагах клетки: прямой шаг 1, по диагонали √2 и только если обе смежные клетки свободны.
export function hasCoverWithin(map: BattleMap, me: Point, enemy: Point): boolean {
  const grid = gridOf(map);
  const start = cellOf(grid, me);
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
    const base = steps.get(current) ?? 0;
    for (const next of neighboursOf(grid, current)) {
      const cost = base + stepLength(grid, current, next);
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
