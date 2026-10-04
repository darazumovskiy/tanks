import {
  clamp,
  normalizeAngle,
  type Action,
  type BotView,
  type BulletView,
  type Point,
  type Stats,
  type TankView,
} from '@tanks/shared/engine';
import type { BotBrain } from './arenaBot.js';
import { isClear } from './sight.js';

const CELL = 25;
// Радиус танка с запасом: клетка сетки и отрезок пути считаются свободными на таком удалении от стен.
const PAD = 26;
const NEAREST_FREE_RADIUS = 6;
const REPLAN_TICKS = 10;
const WAYPOINT_SKIP_PAD = 24;
const WAYPOINT_REACHED = 14;
const REVERSE_ANGLE = 2.2;
const STEER_GAIN = 3;
const CREEP_THROTTLE = 0.15;
const LEAD_ITERATIONS = 4;
const TURRET_GAIN = 8;
const FIRE_WINDOW_RAD = 0.07;
const SHOT_PAD = 6;
const MUZZLE = 34;
const THREAT_HORIZON_S = 0.9;
const THREAT_MISS = 40;
const DODGE_DISTANCE = 80;
const ZONE_MARGIN = 80;
const KIT_HP_FRACTION = 0.6;
const FIGHT_DISTANCE = 420;
const STRAFE_PERIOD_TICKS = 180;
const STRAFE_ANGLE = 0.6;
const STRAFE_NEAR = 250;
const STRAFE_RADIUS_NEAR = 330;
const STRAFE_RADIUS_FAR = 300;
const NEIGHBOURS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

interface Grid {
  cols: number;
  rows: number;
  free: Uint8Array;
}

interface Threat {
  bullet: BulletView;
  closestX: number;
  closestY: number;
}

type Drive = Pick<Action, 'throttle' | 'turn'>;

function buildGrid(arena: BotView['arena']): Grid {
  const cols = Math.ceil(arena.width / CELL);
  const rows = Math.ceil(arena.height / CELL);
  const free = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * CELL + CELL / 2;
      const y = row * CELL + CELL / 2;
      const isInBounds = x > PAD && x < arena.width - PAD && y > PAD && y < arena.height - PAD;
      const isInWall = arena.walls.some(
        (wall) => x > wall.x - PAD && x < wall.x + wall.w + PAD && y > wall.y - PAD && y < wall.y + wall.h + PAD,
      );
      free[row * cols + col] = isInBounds && !isInWall ? 1 : 0;
    }
  }
  return { cols, rows, free };
}

function isFree(grid: Grid, row: number, col: number): boolean {
  return grid.free[row * grid.cols + col] === 1;
}

function nearestFree(grid: Grid, x: number, y: number): number {
  const col = clamp(Math.floor(x / CELL), 0, grid.cols - 1);
  const row = clamp(Math.floor(y / CELL), 0, grid.rows - 1);
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
// сетки всегда заняты (отступ PAD), поэтому соседи раскрытой клетки не выходят за сетку.
function findPath(grid: Grid, from: number, to: number): Point[] {
  const previous = new Int32Array(grid.cols * grid.rows).fill(-1);
  const queue = [from];
  previous[from] = from;
  // Итератор массива видит элементы, добавленные во время обхода, — очередь без указателя головы.
  for (const current of queue) {
    if (current === to) {
      break;
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
  if (previous[to] === -1) {
    return [];
  }
  const path: Point[] = [];
  let node: number | undefined = to;
  while (node !== undefined && node !== from) {
    path.push({ x: (node % grid.cols) * CELL + CELL / 2, y: Math.floor(node / grid.cols) * CELL + CELL / 2 });
    node = previous[node];
  }
  return path.reverse();
}

// Задним ходом развернуться часто быстрее, чем крутиться на месте.
function driveTo(me: TankView, x: number, y: number): Drive {
  const wanted = Math.atan2(y - me.y, x - me.x);
  const diff = normalizeAngle(wanted - me.heading);
  if (Math.abs(diff) > REVERSE_ANGLE) {
    const back = normalizeAngle(diff + Math.PI);
    return { throttle: -1, turn: clamp(-back * STEER_GAIN, -1, 1) };
  }
  return { throttle: Math.cos(diff) > 0.5 ? 1 : CREEP_THROTTLE, turn: clamp(diff * STEER_GAIN, -1, 1) };
}

function leadPoint(me: TankView, enemy: TankView): Point {
  const bulletSpeed = me.stats.bulletSpeed;
  let x = enemy.x;
  let y = enemy.y;
  for (let i = 0; i < LEAD_ITERATIONS; i++) {
    const flight = Math.hypot(x - me.x, y - me.y) / bulletSpeed;
    x = enemy.x + enemy.vx * flight;
    y = enemy.y + enemy.vy * flight;
  }
  return { x, y };
}

// Ближайший по времени снаряд, который пройдёт меньше THREAT_MISS от центра в ближайшие THREAT_HORIZON_S.
function nearestThreat(me: TankView, bullets: BulletView[]): Threat | null {
  let worst: (Threat & { time: number }) | null = null;
  for (const bullet of bullets) {
    if (bullet.isMine && !bullet.canHitOwner) {
      continue;
    }
    const rx = me.x - bullet.x;
    const ry = me.y - bullet.y;
    const speedSquared = bullet.vx * bullet.vx + bullet.vy * bullet.vy;
    const time = (rx * bullet.vx + ry * bullet.vy) / speedSquared;
    if (time < 0 || time > THREAT_HORIZON_S) {
      continue;
    }
    const closestX = bullet.x + bullet.vx * time - me.x;
    const closestY = bullet.y + bullet.vy * time - me.y;
    const isCloser = worst === null || time < worst.time;
    if (Math.hypot(closestX, closestY) < THREAT_MISS && isCloser) {
      worst = { bullet, time, closestX, closestY };
    }
  }
  return worst;
}

// Уровень 3 — спарринг-бот «Охотник» из tank-arena: путь по сетке, упреждение, уход от пуль, аптечки, зона.
export class HunterBrain implements BotBrain {
  readonly stats: Stats = { armor: 3, engine: 3, gun: 2, reload: 2 };
  private grid: Grid | null = null;
  private gridMapName = '';
  private path: Point[] = [];
  private pathTick = -Infinity;

  init(): void {
    this.grid = null;
    this.path = [];
    this.pathTick = -Infinity;
  }

  tick(view: BotView): Action {
    const { me, enemy, arena } = view;
    const grid = this.gridFor(arena);

    const aim = leadPoint(me, enemy);
    const turretDiff = normalizeAngle(Math.atan2(aim.y - me.y, aim.x - me.x) - me.turret);
    const muzzleX = me.x + Math.cos(me.turret) * MUZZLE;
    const muzzleY = me.y + Math.sin(me.turret) * MUZZLE;
    const isAimed = Math.abs(turretDiff) < FIRE_WINDOW_RAD;
    const isFiring = enemy.isAlive && isAimed && isClear(arena.walls, muzzleX, muzzleY, aim.x, aim.y, SHOT_PAD);

    const drive = this.drive(view, grid);
    return { ...drive, turretTurn: clamp(turretDiff * TURRET_GAIN, -1, 1), isFiring };
  }

  private gridFor(arena: BotView['arena']): Grid {
    if (this.grid === null || this.gridMapName !== arena.mapName) {
      this.grid = buildGrid(arena);
      this.gridMapName = arena.mapName;
    }
    return this.grid;
  }

  // Приоритеты корпуса: уход от пули > зона > аптечка > охота.
  private drive(view: BotView, grid: Grid): Drive {
    const { me, enemy, arena } = view;
    const threat = nearestThreat(me, view.bullets);
    if (threat !== null) {
      const perpendicular = Math.atan2(threat.bullet.vy, threat.bullet.vx) + Math.PI / 2;
      const offset = threat.closestX * Math.cos(perpendicular) + threat.closestY * Math.sin(perpendicular);
      const side = offset > 0 ? -1 : 1;
      return driveTo(
        me,
        me.x + Math.cos(perpendicular) * DODGE_DISTANCE * side,
        me.y + Math.sin(perpendicular) * DODGE_DISTANCE * side,
      );
    }

    let goal: Point = { x: enemy.x, y: enemy.y };
    let isHunting = true;
    const zoneDistance = Math.hypot(me.x - view.zone.x, me.y - view.zone.y);
    const kit = view.repairKits
      .filter((candidate) => candidate.isActive)
      .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
    if (zoneDistance > view.zone.radius - ZONE_MARGIN) {
      goal = { x: view.zone.x, y: view.zone.y };
      isHunting = false;
    } else if (kit !== undefined && me.hp < me.maxHp * KIT_HP_FRACTION) {
      goal = { x: kit.x, y: kit.y };
      isHunting = false;
    }

    const distance = Math.hypot(enemy.x - me.x, enemy.y - me.y);
    const hasLineOfSight = isClear(arena.walls, me.x, me.y, enemy.x, enemy.y, SHOT_PAD);
    if (isHunting && hasLineOfSight && distance < FIGHT_DISTANCE) {
      // В перестрелке кружить вокруг цели, а не лезть в упор.
      const sway = view.tick % STRAFE_PERIOD_TICKS < STRAFE_PERIOD_TICKS / 2 ? STRAFE_ANGLE : -STRAFE_ANGLE;
      const around = Math.atan2(me.y - enemy.y, me.x - enemy.x) + sway;
      const radius = distance < STRAFE_NEAR ? STRAFE_RADIUS_NEAR : STRAFE_RADIUS_FAR;
      return driveTo(me, enemy.x + Math.cos(around) * radius, enemy.y + Math.sin(around) * radius);
    }

    if (view.tick - this.pathTick > REPLAN_TICKS || this.path.length === 0) {
      this.path = findPath(grid, nearestFree(grid, me.x, me.y), nearestFree(grid, goal.x, goal.y));
      this.pathTick = view.tick;
    }
    while (this.path.length > 1) {
      const next = this.path[1];
      if (next === undefined || !isClear(arena.walls, me.x, me.y, next.x, next.y, WAYPOINT_SKIP_PAD)) {
        break;
      }
      this.path.shift();
    }
    const waypoint = this.path[0] ?? goal;
    if (Math.hypot(waypoint.x - me.x, waypoint.y - me.y) < WAYPOINT_REACHED) {
      this.path.shift();
    }
    return driveTo(me, waypoint.x, waypoint.y);
  }
}
