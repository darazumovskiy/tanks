import {
  clamp,
  MUZZLE_OFFSET,
  normalizeAngle,
  TANK_HIT_RADIUS,
  TANK_RADIUS,
  TICK_RATE,
  type Action,
  type BotView,
  type BulletView,
  type Point,
  type Stats,
  type TankView,
} from '@tanks/shared/engine';
import type { BotBrain } from './brain.js';
import type { BotProfile } from './profile.js';
import { isClear, isReturningShot } from './sight.js';

const CELL = 25;
// Клетка сетки и отрезок пути считаются свободными на таком удалении от стен.
const PAD = TANK_RADIUS + 2;
const NEAREST_FREE_RADIUS = 6;
const REPLAN_TICKS = 10;
const WAYPOINT_SKIP_PAD = TANK_RADIUS;
const WAYPOINT_REACHED = 14;
const REVERSE_ANGLE = 2.2;
const STEER_GAIN = 3;
const CREEP_THROTTLE = 0.15;
const LEAD_ITERATIONS = 4;
const TURRET_GAIN = 8;
const SHOT_PAD = 6;
const THREAT_HORIZON_S = 0.9;
const THREAT_MISS = TANK_HIT_RADIUS + 11;
const DODGE_DISTANCE = 80;
const ZONE_MARGIN = 80;
const KIT_HP_FRACTION = 0.6;
const FIGHT_DISTANCE = 420;
const STRAFE_PERIOD_TICKS = 180;
const STRAFE_ANGLE = 0.6;
const STRAFE_NEAR = 250;
const STRAFE_RADIUS_NEAR = 330;
const STRAFE_RADIUS_FAR = 300;
const HOLD_DISTANCE = 380;
const RETREAT_DISTANCE = 260;
const DRIFT_PERIOD_TICKS = 60;
const DRIFT_THROTTLE = 0.8;
const AIM_NOISE_PERIOD_TICKS = TICK_RATE / 2;
const FIRE_RETRY_TICKS = TICK_RATE / 2;
const PAUSE_TICKS = TICK_RATE / 2;
const PATROL_REACHED = 40;
const PATROL_REPLAN_TICKS = TICK_RATE * 6;
const PATROL_ZONE_MARGIN = 100;
const DODGE_MEMORY = 64;
const READY_POSE_DISTANCE = 500;
const READY_POSE_AIM_RAD = 0.12;
const READY_POSE_RELOAD_S = 0.15;
const READY_POSE_PERIOD_TICKS = 60;
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
  freeCells: Point[];
}

interface Threat {
  bullet: BulletView;
  closestX: number;
  closestY: number;
}

type Drive = Pick<Action, 'throttle' | 'turn'>;
type Aim = Pick<Action, 'turretTurn' | 'isFiring'>;

const HOLD: Drive = { throttle: 0, turn: 0 };

function cellCenter(grid: Grid, index: number): Point {
  return { x: (index % grid.cols) * CELL + CELL / 2, y: Math.floor(index / grid.cols) * CELL + CELL / 2 };
}

function buildGrid(arena: BotView['arena']): Grid {
  const cols = Math.ceil(arena.width / CELL);
  const rows = Math.ceil(arena.height / CELL);
  const free = new Uint8Array(cols * rows);
  const grid: Grid = { cols, rows, free, freeCells: [] };
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * CELL + CELL / 2;
      const y = row * CELL + CELL / 2;
      const isInBounds = x > PAD && x < arena.width - PAD && y > PAD && y < arena.height - PAD;
      const isInWall = arena.walls.some(
        (wall) => x > wall.x - PAD && x < wall.x + wall.w + PAD && y > wall.y - PAD && y < wall.y + wall.h + PAD,
      );
      if (isInBounds && !isInWall) {
        free[row * cols + col] = 1;
        grid.freeCells.push(cellCenter(grid, row * cols + col));
      }
    }
  }
  return grid;
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
    path.push(cellCenter(grid, node));
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

// quality — учитываемая доля скорости цели: 0 даёт текущее положение, 1 — полное упреждение.
function leadPoint(me: TankView, enemy: TankView, quality: number): Point {
  const bulletSpeed = me.stats.bulletSpeed;
  let x = enemy.x;
  let y = enemy.y;
  for (let i = 0; i < LEAD_ITERATIONS; i++) {
    const flight = Math.hypot(x - me.x, y - me.y) / bulletSpeed;
    x = enemy.x + enemy.vx * quality * flight;
    y = enemy.y + enemy.vy * quality * flight;
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

// Шаг вбок от направления, по которому летит или полетит снаряд; side — в какую из двух сторон.
function sidestep(me: TankView, alongX: number, alongY: number, side: number): Drive {
  const perpendicular = Math.atan2(alongY, alongX) + Math.PI / 2;
  return driveTo(
    me,
    me.x + Math.cos(perpendicular) * DODGE_DISTANCE * side,
    me.y + Math.sin(perpendicular) * DODGE_DISTANCE * side,
  );
}

// Один элемент по случайному индексу как список из нуля или одного: пустой список даёт пустой результат.
function pickOne<T>(list: readonly T[], random: number): T[] {
  const index = Math.floor(random * list.length);
  return list.slice(index, index + 1);
}

// Тело спарринг-бота «Охотник» из tank-arena — путь по сетке, упреждение, уход от пуль, аптечки, зона —
// с ручками профиля: уровни 1–9 отличаются только значениями ручек.
export class HunterBrain implements BotBrain {
  readonly stats: Stats;
  readonly reactionTicks: number;
  private grid: Grid | null = null;
  private gridMapName = '';
  private path: Point[] = [];
  private pathTick = -Infinity;
  private aimNoise = 0;
  private aimNoiseTicksLeft = 0;
  private isLeadingShot = false;
  private isCarelessShot = false;
  private wasReloading = false;
  private fireRetryTicksLeft = 0;
  private patrolTarget: Point | null = null;
  private patrolTick = -Infinity;
  private pauseTicksLeft = 0;
  private sincePauseTicks = 0;
  private dodgeDecisions = new Map<number, boolean>();

  constructor(
    private readonly profile: BotProfile,
    private readonly random: () => number,
  ) {
    this.stats = { ...profile.stats };
    this.reactionTicks = profile.reactionTicks;
  }

  init(): void {
    this.grid = null;
    this.path = [];
    this.pathTick = -Infinity;
    this.aimNoiseTicksLeft = 0;
    this.isLeadingShot = this.random() < this.profile.leadChance;
    this.isCarelessShot = this.random() < this.profile.carelessness;
    this.wasReloading = false;
    this.fireRetryTicksLeft = 0;
    this.patrolTarget = null;
    this.patrolTick = -Infinity;
    this.pauseTicksLeft = 0;
    this.sincePauseTicks = 0;
    this.dodgeDecisions = new Map();
  }

  tick(view: BotView): Action {
    const grid = this.gridFor(view.arena);
    const aim = this.aim(view);
    const drive = this.drive(view, grid);
    const cap = this.profile.throttleCap;
    return { throttle: clamp(drive.throttle, -cap, cap), turn: drive.turn, ...aim };
  }

  private gridFor(arena: BotView['arena']): Grid {
    if (this.grid === null || this.gridMapName !== arena.mapName) {
      this.grid = buildGrid(arena);
      this.gridMapName = arena.mapName;
    }
    return this.grid;
  }

  private aim(view: BotView): Aim {
    const { me, enemy, arena } = view;
    if (this.aimNoiseTicksLeft <= 0) {
      this.aimNoise = (this.random() * 2 - 1) * this.profile.aimNoiseRad;
      this.aimNoiseTicksLeft = AIM_NOISE_PERIOD_TICKS;
    }
    this.aimNoiseTicksLeft--;
    // Монетки упреждения и беспечности бросаются на каждый новый выстрел — в момент, когда перезарядка закончилась.
    const isReady = me.reloadLeft <= 0;
    if (isReady && this.wasReloading) {
      this.isLeadingShot = this.random() < this.profile.leadChance;
      this.isCarelessShot = this.random() < this.profile.carelessness;
    }
    this.wasReloading = !isReady;

    const target = leadPoint(me, enemy, this.isLeadingShot ? this.profile.leadQuality : 0);
    const wanted = Math.atan2(target.y - me.y, target.x - me.x) + this.aimNoise;
    const turretDiff = normalizeAngle(wanted - me.turret);
    const turretTurn = clamp(turretDiff * TURRET_GAIN, -1, 1);
    const muzzleX = me.x + Math.cos(me.turret) * MUZZLE_OFFSET;
    const muzzleY = me.y + Math.sin(me.turret) * MUZZLE_OFFSET;
    const isAimed = Math.abs(turretDiff) < this.profile.fireWindowRad;
    const muzzle = { x: muzzleX, y: muzzleY };
    const isLineClear = isClear(arena.walls, muzzleX, muzzleY, target.x, target.y, SHOT_PAD);
    const isSafe =
      this.isCarelessShot || !isReturningShot(arena.walls, me, muzzle, me.turret, me.stats.bulletSpeed, enemy);
    if (!isReady || !isAimed || !isLineClear || !isSafe) {
      return { turretTurn, isFiring: false };
    }
    if (this.fireRetryTicksLeft > 0) {
      this.fireRetryTicksLeft--;
      return { turretTurn, isFiring: false };
    }
    if (this.random() < this.profile.fireChance) {
      return { turretTurn, isFiring: true };
    }
    this.fireRetryTicksLeft = FIRE_RETRY_TICKS;
    return { turretTurn, isFiring: false };
  }

  // Приоритеты корпуса: пауза > уход от пули > поза готовности > зона > аптечка > режим движения.
  private drive(view: BotView, grid: Grid): Drive {
    const { me, enemy } = view;
    if (this.isPausing()) {
      return HOLD;
    }
    // От своей вернувшейся пули уходит любой уровень, кроме беспечного; от чужой — только режим dodge.
    const threat = nearestThreat(me, view.bullets);
    if (threat !== null) {
      const chance = threat.bullet.isMine ? 1 - this.profile.carelessness : this.profile.dodgeChance;
      if (this.shouldDodge(threat.bullet.id, chance)) {
        return sidestep(me, threat.bullet.vx, threat.bullet.vy, this.offsetSide(threat));
      }
    }
    if (this.profile.hasReadyPose && this.isEnemyAboutToFire(view)) {
      const side = view.tick % READY_POSE_PERIOD_TICKS < READY_POSE_PERIOD_TICKS / 2 ? 1 : -1;
      return sidestep(me, me.x - enemy.x, me.y - enemy.y, side);
    }

    const zoneDistance = Math.hypot(me.x - view.zone.x, me.y - view.zone.y);
    if (zoneDistance > view.zone.radius - ZONE_MARGIN) {
      return this.followPath(view, grid, view.zone);
    }
    const kit = view.repairKits
      .filter((candidate) => candidate.isActive)
      .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
    if (this.profile.hasKits && kit !== undefined && me.hp < me.maxHp * KIT_HP_FRACTION) {
      return this.followPath(view, grid, kit);
    }
    if (this.profile.movement === 'patrol') {
      return this.patrol(view, grid);
    }
    return this.hunt(view, grid);
  }

  private isPausing(): boolean {
    const period = this.profile.pauseEverySec;
    if (period === null) {
      return false;
    }
    if (this.pauseTicksLeft > 0) {
      this.pauseTicksLeft--;
      return true;
    }
    this.sincePauseTicks++;
    if (this.sincePauseTicks >= period * TICK_RATE) {
      this.sincePauseTicks = 0;
      this.pauseTicksLeft = PAUSE_TICKS;
    }
    return false;
  }

  // Решение по каждой пуле принимается один раз: иначе монетка бросалась бы каждый тик и уход был бы почти всегда.
  private shouldDodge(bulletId: number, chance: number): boolean {
    const isKnownDodge = this.dodgeDecisions.get(bulletId);
    if (isKnownDodge !== undefined) {
      return isKnownDodge;
    }
    if (this.dodgeDecisions.size >= DODGE_MEMORY) {
      this.dodgeDecisions.clear();
    }
    const shouldDodge = this.random() < chance;
    this.dodgeDecisions.set(bulletId, shouldDodge);
    return shouldDodge;
  }

  private offsetSide(threat: Threat): number {
    const perpendicular = Math.atan2(threat.bullet.vy, threat.bullet.vx) + Math.PI / 2;
    const offset = threat.closestX * Math.cos(perpendicular) + threat.closestY * Math.sin(perpendicular);
    return offset > 0 ? -1 : 1;
  }

  private isEnemyAboutToFire(view: BotView): boolean {
    const { me, enemy } = view;
    const distance = Math.hypot(me.x - enemy.x, me.y - enemy.y);
    const aimError = Math.abs(normalizeAngle(Math.atan2(me.y - enemy.y, me.x - enemy.x) - enemy.turret));
    const isAimedAtMe = aimError < READY_POSE_AIM_RAD;
    return distance < READY_POSE_DISTANCE && isAimedAtMe && enemy.reloadLeft < READY_POSE_RELOAD_S;
  }

  // Случайная свободная точка внутри зоны; новая — когда доехал или по таймеру.
  private patrol(view: BotView, grid: Grid): Drive {
    const { me } = view;
    const isReached =
      this.patrolTarget !== null && Math.hypot(this.patrolTarget.x - me.x, this.patrolTarget.y - me.y) < PATROL_REACHED;
    if (this.patrolTarget === null || isReached || view.tick - this.patrolTick > PATROL_REPLAN_TICKS) {
      const limit = view.zone.radius - PATROL_ZONE_MARGIN;
      const candidates = grid.freeCells.filter(
        (cell) => Math.hypot(cell.x - view.zone.x, cell.y - view.zone.y) < limit,
      );
      for (const cell of pickOne(candidates, this.random())) {
        this.patrolTarget = cell;
      }
      this.patrolTick = view.tick;
    }
    return this.followPath(view, grid, this.patrolTarget ?? view.zone);
  }

  // Сближение держит дистанцию без кружения; круг и уклонение в перестрелке ходят вокруг цели.
  private hunt(view: BotView, grid: Grid): Drive {
    const { me, enemy, arena } = view;
    const distance = Math.hypot(enemy.x - me.x, enemy.y - me.y);
    const hasLineOfSight = isClear(arena.walls, me.x, me.y, enemy.x, enemy.y, SHOT_PAD);
    if (!hasLineOfSight || distance >= FIGHT_DISTANCE) {
      return this.followPath(view, grid, enemy);
    }
    if (this.profile.movement === 'approach') {
      if (distance < RETREAT_DISTANCE) {
        const away = Math.atan2(me.y - enemy.y, me.x - enemy.x);
        return driveTo(me, enemy.x + Math.cos(away) * HOLD_DISTANCE, enemy.y + Math.sin(away) * HOLD_DISTANCE);
      }
      if (distance < HOLD_DISTANCE) {
        // На дистанции не стоять столбом: медленно смещаться поперёк линии огня, меняя сторону.
        const side = view.tick % DRIFT_PERIOD_TICKS < DRIFT_PERIOD_TICKS / 2 ? 1 : -1;
        const drift = sidestep(me, me.x - enemy.x, me.y - enemy.y, side);
        return { throttle: drift.throttle * DRIFT_THROTTLE, turn: drift.turn };
      }
      return driveTo(me, enemy.x, enemy.y);
    }
    const sway = view.tick % STRAFE_PERIOD_TICKS < STRAFE_PERIOD_TICKS / 2 ? STRAFE_ANGLE : -STRAFE_ANGLE;
    const around = Math.atan2(me.y - enemy.y, me.x - enemy.x) + sway;
    const radius = distance < STRAFE_NEAR ? STRAFE_RADIUS_NEAR : STRAFE_RADIUS_FAR;
    return driveTo(me, enemy.x + Math.cos(around) * radius, enemy.y + Math.sin(around) * radius);
  }

  private followPath(view: BotView, grid: Grid, goal: Point): Drive {
    const { me, arena } = view;
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
