import { clamp, isSegmentClear, TANK_RADIUS, type BattleMap, type Point, type Wall } from '@tanks/shared/engine';

// Сетка и путь — как у Охотника: клетка 25, клетка и отрезок пути свободны на удалении от стен.
const CELL = 25;
const PAD = TANK_RADIUS + 2;
const NEAREST_FREE_RADIUS = 6;
const REPLAN_TICKS = 10;
const WAYPOINT_SKIP_PAD = TANK_RADIUS;
export const WAYPOINT_REACHED = 14;
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export interface Grid {
  cols: number;
  rows: number;
  free: Uint8Array;
  walls: readonly Wall[];
}

const grids = new WeakMap<BattleMap, Grid>();

function cellCenter(grid: Grid, index: number): Point {
  return { x: (index % grid.cols) * CELL + CELL / 2, y: Math.floor(index / grid.cols) * CELL + CELL / 2 };
}

export function gridOf(map: BattleMap): Grid {
  const cached = grids.get(map);
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
  grids.set(map, grid);
  return grid;
}

function isFree(grid: Grid, row: number, col: number): boolean {
  return grid.free[row * grid.cols + col] === 1;
}

export function isFreeAt(grid: Grid, point: Point): boolean {
  const col = Math.floor(point.x / CELL);
  const row = Math.floor(point.y / CELL);
  const isInside = row >= 0 && row < grid.rows && col >= 0 && col < grid.cols;
  return isInside && isFree(grid, row, col);
}

export function nearestFree(grid: Grid, point: Point): number {
  const col = clamp(Math.floor(point.x / CELL), 0, grid.cols - 1);
  const row = clamp(Math.floor(point.y / CELL), 0, grid.rows - 1);
  if (isFree(grid, row, col)) {
    return row * grid.cols + col;
  }
  for (let radius = 1; radius < NEAREST_FREE_RADIUS; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const r = row + dr;
        const c = col + dc;
        const isInside = r >= 0 && r < grid.rows && c >= 0 && c < grid.cols;
        if (isInside && isFree(grid, r, c)) {
          return r * grid.cols + c;
        }
      }
    }
  }
  return row * grid.cols + col;
}

// Поиск в ширину по восьми соседям; по диагонали — только если обе смежные клетки свободны. Крайние клетки
// сетки всегда заняты (отступ PAD), поэтому соседи раскрытой клетки не выходят за сетку. Обход
// останавливается на первой клетке, где isGoal истинно; goal −1 — такой клетки нет.
function breadthFirst(
  grid: Grid,
  from: number,
  isGoal: (cell: number) => boolean,
): { goal: number; previous: Int32Array } {
  const previous = new Int32Array(grid.cols * grid.rows).fill(-1);
  const queue = [from];
  previous[from] = from;
  for (const current of queue) {
    if (isGoal(current)) {
      return { goal: current, previous };
    }
    const row = Math.floor(current / grid.cols);
    const col = current % grid.cols;
    for (const [dr, dc] of NEIGHBOURS) {
      const r = row + dr;
      const c = col + dc;
      const next = r * grid.cols + c;
      if (!isFree(grid, r, c) || previous[next] !== -1) {
        continue;
      }
      const isDiagonal = dr !== 0 && dc !== 0;
      if (isDiagonal && (!isFree(grid, row, c) || !isFree(grid, r, col))) {
        continue;
      }
      previous[next] = current;
      queue.push(next);
    }
  }
  return { goal: -1, previous };
}

function pathTo(grid: Grid, from: number, goal: number, previous: Int32Array): Point[] {
  const path: Point[] = [];
  let node: number | undefined = goal;
  while (node !== undefined && node !== from) {
    path.push(cellCenter(grid, node));
    node = previous[node];
  }
  return path.reverse();
}

// Путь клетками от from до to без стартовой клетки; пусто, если to недостижима или совпадает с from.
export function findPath(grid: Grid, from: number, to: number): Point[] {
  const { goal, previous } = breadthFirst(grid, from, (cell) => cell === to);
  return goal === -1 ? [] : pathTo(grid, from, goal, previous);
}

// Ближайшая по пути свободная клетка, где выполнено условие; null — такой нет.
export function nearestCell(grid: Grid, from: number, isWanted: (center: Point) => boolean): Point | null {
  const { goal } = breadthFirst(grid, from, (cell) => isWanted(cellCenter(grid, cell)));
  return goal === -1 ? null : cellCenter(grid, goal);
}

// Ведёт по пути к цели: путь пересчитывается раз в REPLAN_TICKS, видимые напрямую точки пути пропускаются.
export class PathFollower {
  private path: Point[] = [];
  private pathTick = -Infinity;

  reset(): void {
    this.path = [];
    this.pathTick = -Infinity;
  }

  waypoint(grid: Grid, me: Point, goal: Point, tick: number): Point {
    if (tick - this.pathTick > REPLAN_TICKS || this.path.length === 0) {
      this.path = findPath(grid, nearestFree(grid, me), nearestFree(grid, goal));
      this.pathTick = tick;
    }
    while (this.path.length > 1) {
      const next = this.path[1];
      if (next === undefined || !isSegmentClear(grid.walls, me.x, me.y, next.x, next.y, WAYPOINT_SKIP_PAD)) {
        break;
      }
      this.path.shift();
    }
    const waypoint = this.path[0] ?? goal;
    if (Math.hypot(waypoint.x - me.x, waypoint.y - me.y) < WAYPOINT_REACHED) {
      this.path.shift();
    }
    return waypoint;
  }
}
