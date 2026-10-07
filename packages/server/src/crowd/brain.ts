import {
  clamp,
  isSegmentClear,
  isShotReturning,
  MUZZLE_OFFSET,
  normalizeAngle,
  REVERSE_FACTOR,
  TANK_HIT_RADIUS,
  TANK_RADIUS,
  TICK_RATE,
  type Action,
  type BattleMap,
  type Point,
} from '@tanks/shared/engine';
import type { CrowdProfile } from './profile.js';
import type { CrowdBullet, CrowdTank, CrowdView, CrowdZone } from './view.js';

const CELL = 25;
// Клетка сетки и отрезок пути считаются свободными на таком удалении от стен.
const PAD = TANK_RADIUS + 2;
const NEAREST_FREE_RADIUS = 6;
const REPLAN_TICKS = 10;
const MIN_REPLAN_GAP_TICKS = 3;
const GOAL_SHIFT = 100;
const WAYPOINT_SKIP_PAD = TANK_RADIUS;
const WAYPOINT_REACHED = 14;
const REVERSE_ANGLE = 2.2;
const STEER_GAIN = 3;
const CREEP_THROTTLE = 0.15;
// Отклонение меньше 60°: ехать полным газом, не дожидаясь конца разворота.
const FULL_THROTTLE_COS = 0.5;
// Шаги времени складываются с ошибкой округления: без запаса последний шаг горизонта терялся бы.
const TIME_EPSILON = 1e-9;
const LEAD_ITERATIONS = 4;
const TURRET_GAIN = 8;
const SHOT_PAD = 6;
const THREAT_HORIZON_S = 0.9;
const THREAT_STEP_S = 0.1;
// Ехать как ехал — только с таким запасом до снарядов: модель кандидатов не знает разгона, а уход, едва
// ставший безопасным по инерции, иначе бросался бы, и танк возвращался под снаряд.
const SAFE_MISS = TANK_HIT_RADIUS + 31;
// Выбранный уход держится столько тиков: без этого бот метался бы между равными кандидатами.
const DODGE_HOLD_TICKS = 9;
const DODGE_DIRECTIONS = 8;
const SIDESTEP_DISTANCE = 80;
// Куда кандидат уклонения успеет доехать — проверяется на свободу от стен.
const DODGE_PROBE_S = 0.5;
const ZONE_MARGIN = 80;
// Возврат от края длится, пока бот не уйдёт вглубь на столько: без запаса он дёргался бы туда-обратно на границе
// каждый тик и стоял на месте.
const ZONE_RETURN_DEPTH = 70;
// Точки, к которым бот едет сам, — не ближе этого к краю зоны: дальше начинается возврат.
const ZONE_GOAL_MARGIN = 130;
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
const STUCK_TICKS = TICK_RATE;
const STUCK_MOVE = 10;
const STUCK_THROTTLE = 0.5;
const UNSTICK_TICKS = TICK_RATE / 2;
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

// Шаг поиска к соседу сдвигом номера клетки; по диагонали — ещё две смежные клетки, которые обе должны быть свободны.
interface PathStep {
  offset: number;
  isDiagonal: boolean;
  sideColumn: number;
  sideRow: number;
}

// Расстояния от свободных клеток до центра зоны — в порядке freeCells; центр зоны общий для всех ботов карты.
interface ZoneDistances {
  x: number;
  y: number;
  values: Float64Array;
}

interface Grid {
  cols: number;
  rows: number;
  free: Uint8Array;
  freeCells: Point[];
  previous: Int32Array;
  queue: Int32Array;
  steps: PathStep[];
  zoneDistances: ZoneDistances | null;
}

// Разрешение на поиск пути на этом ходу: take() — забрать одно, false — разрешений не осталось.
export interface PathAllowance {
  take(): boolean;
}

export const UNLIMITED_PATHS: PathAllowance = {
  take: () => true,
};

// Поиск пути — самая дорогая разовая работа мозга: на весь процесс не больше стольких за проход, сверх первого —
// пока бюджет не вышел. Первый разрешён всегда: иначе на медленной машине пути не обновлялись бы вовсе.
const PATH_SEARCHES_PER_TURN = 2;

// Разрешение одного прохода хода серверных ботов, общее для всех.
export class PathQuota implements PathAllowance {
  used = 0;

  constructor(private readonly isOverBudget: () => boolean) {}

  take(): boolean {
    const isSpent = this.used >= PATH_SEARCHES_PER_TURN || (this.used > 0 && this.isOverBudget());
    if (isSpent) {
      return false;
    }
    this.used++;
    return true;
  }
}

type Drive = Pick<Action, 'throttle' | 'turn'>;
type Aim = Pick<Action, 'turretTurn' | 'isFiring'>;

// Кандидат уклонения: направление, скорость и время на разворот к нему; isCurrent — ехать как ехал.
interface Move {
  dirX: number;
  dirY: number;
  speed: number;
  delay: number;
  isForward: boolean;
  isCurrent: boolean;
}

const HOLD: Drive = { throttle: 0, turn: 0 };

function cellCenter(grid: Grid, index: number): Point {
  return { x: (index % grid.cols) * CELL + CELL / 2, y: Math.floor(index / grid.cols) * CELL + CELL / 2 };
}

function buildGrid(map: BattleMap): Grid {
  const cols = Math.ceil(map.width / CELL);
  const rows = Math.ceil(map.height / CELL);
  const grid: Grid = {
    cols,
    rows,
    free: new Uint8Array(cols * rows),
    freeCells: [],
    previous: new Int32Array(cols * rows),
    queue: new Int32Array(cols * rows),
    steps: NEIGHBOURS.map(([dr, dc]) => ({
      offset: dr * cols + dc,
      isDiagonal: dr !== 0 && dc !== 0,
      sideColumn: dc,
      sideRow: dr * cols,
    })),
    zoneDistances: null,
  };
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * CELL + CELL / 2;
      const y = row * CELL + CELL / 2;
      const isInBounds = x > PAD && x < map.width - PAD && y > PAD && y < map.height - PAD;
      const isInWall = map.walls.some(
        (wall) => x > wall.x - PAD && x < wall.x + wall.w + PAD && y > wall.y - PAD && y < wall.y + wall.h + PAD,
      );
      if (isInBounds && !isInWall) {
        grid.free[row * cols + col] = 1;
        grid.freeCells.push(cellCenter(grid, row * cols + col));
      }
    }
  }
  return grid;
}

// Сетка одна на карту на весь процесс: боты роя делят её и рабочие массивы поиска пути — ходят по очереди.
const GRIDS = new WeakMap<BattleMap, Grid>();

function gridFor(map: BattleMap): Grid {
  const known = GRIDS.get(map);
  if (known !== undefined) {
    return known;
  }
  const grid = buildGrid(map);
  GRIDS.set(map, grid);
  return grid;
}

// Сетка пути карты строится заранее, чтобы первый тик боя её не строил.
export function prepareCrowdMap(map: BattleMap): void {
  gridFor(map);
}

function isFree(grid: Grid, row: number, col: number): boolean {
  return grid.free[row * grid.cols + col] === 1;
}

function isFreePoint(grid: Grid, x: number, y: number): boolean {
  const col = Math.floor(x / CELL);
  const row = Math.floor(y / CELL);
  const isInside = row >= 0 && row < grid.rows && col >= 0 && col < grid.cols;
  return isInside && isFree(grid, row, col);
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
// сетки всегда заняты (отступ PAD), поэтому соседи раскрытой клетки не выходят за сетку и сдвиг номера не
// переносит на соседнюю строку.
function findPath(grid: Grid, from: number, to: number): Point[] {
  const { free, previous, queue, steps } = grid;
  previous.fill(-1);
  let tail = 0;
  queue[tail++] = from;
  previous[from] = from;
  for (let head = 0; head < tail; head++) {
    const current = queue[head];
    if (current === undefined || current === to) {
      break;
    }
    for (const step of steps) {
      const next = current + step.offset;
      if (free[next] !== 1 || previous[next] !== -1) {
        continue;
      }
      if (step.isDiagonal && (free[current + step.sideColumn] !== 1 || free[current + step.sideRow] !== 1)) {
        continue;
      }
      previous[next] = current;
      queue[tail++] = next;
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

function zoneDistancesOf(grid: Grid, zone: Point): Float64Array {
  const known = grid.zoneDistances;
  if (known !== null && known.x === zone.x && known.y === zone.y) {
    return known.values;
  }
  const values = Float64Array.from(grid.freeCells, (cell) => Math.hypot(cell.x - zone.x, cell.y - zone.y));
  grid.zoneDistances = { x: zone.x, y: zone.y, values };
  return values;
}

// Свободная клетка ближе limit к центру зоны с номером floor(random × число таких) в порядке freeCells; null — таких
// нет. Без массива кандидатов: выбор идёт по всей сетке.
function pickZoneCell(grid: Grid, zone: Point, limit: number, random: number): Point | null {
  const distances = zoneDistancesOf(grid, zone);
  let count = 0;
  for (const distance of distances) {
    if (distance < limit) {
      count++;
    }
  }
  const pick = Math.floor(random * count);
  let seen = 0;
  const index = distances.findIndex((distance) => {
    if (distance >= limit) {
      return false;
    }
    seen++;
    return seen > pick;
  });
  // Таких клеток нет — index равен -1, клетки под ним нет.
  return grid.freeCells[index] ?? null;
}

function driveForward(me: CrowdTank, angle: number): Drive {
  const diff = normalizeAngle(angle - me.heading);
  const throttle = Math.cos(diff) > FULL_THROTTLE_COS ? 1 : CREEP_THROTTLE;
  return { throttle, turn: clamp(diff * STEER_GAIN, -1, 1) };
}

// Кормой к направлению angle. Поворот корпуса от газа не зависит: корма идёт за ним в ту же сторону.
function driveBackward(me: CrowdTank, angle: number): Drive {
  const back = normalizeAngle(angle + Math.PI - me.heading);
  const throttle = Math.cos(back) > FULL_THROTTLE_COS ? -1 : -CREEP_THROTTLE;
  return { throttle, turn: clamp(back * STEER_GAIN, -1, 1) };
}

// Задним ходом развернуться часто быстрее, чем крутиться на месте.
function driveTo(me: CrowdTank, x: number, y: number): Drive {
  const wanted = Math.atan2(y - me.y, x - me.x);
  if (Math.abs(normalizeAngle(wanted - me.heading)) > REVERSE_ANGLE) {
    return driveBackward(me, wanted);
  }
  return driveForward(me, wanted);
}

// Уход исполняется тем же ходом, что посчитала модель кандидатов: передом или задом.
function driveAlong(me: CrowdTank, move: Move): Drive {
  const angle = Math.atan2(move.dirY, move.dirX);
  return move.isForward ? driveForward(me, angle) : driveBackward(me, angle);
}

// quality — учитываемая доля скорости цели: 0 даёт текущее положение, 1 — полное упреждение.
function leadPoint(me: CrowdTank, target: CrowdTank, quality: number): Point {
  let x = target.x;
  let y = target.y;
  for (let i = 0; i < LEAD_ITERATIONS; i++) {
    const flight = Math.hypot(x - me.x, y - me.y) / me.stats.bulletSpeed;
    x = target.x + target.vx * quality * flight;
    y = target.y + target.vy * quality * flight;
  }
  return { x, y };
}

function sidestepPoint(me: CrowdTank, alongX: number, alongY: number, side: number): Point {
  const perpendicular = Math.atan2(alongY, alongX) + Math.PI / 2;
  return {
    x: me.x + Math.cos(perpendicular) * SIDESTEP_DISTANCE * side,
    y: me.y + Math.sin(perpendicular) * SIDESTEP_DISTANCE * side,
  };
}

function goalRadius(zone: CrowdZone): number {
  return Math.max(0, zone.radius - ZONE_GOAL_MARGIN);
}

function isGoalInZone(zone: CrowdZone, point: Point): boolean {
  return Math.hypot(point.x - zone.x, point.y - zone.y) <= goalRadius(zone);
}

// Точка дальше от края, чем ZONE_GOAL_MARGIN, — как есть; ближе или снаружи — на окружность этой глубины к ней.
function goalInZone(zone: CrowdZone, point: Point): Point {
  if (isGoalInZone(zone, point)) {
    return point;
  }
  const limit = goalRadius(zone);
  const distance = Math.hypot(point.x - zone.x, point.y - zone.y);
  return { x: zone.x + ((point.x - zone.x) / distance) * limit, y: zone.y + ((point.y - zone.y) / distance) * limit };
}

function positionAt(me: CrowdTank, move: Move, time: number): Point {
  const travel = move.speed * Math.max(0, time - move.delay);
  return { x: me.x + move.dirX * travel, y: me.y + move.dirY * travel };
}

// Наименьшее расстояние от танка, едущего по кандидату, до снарядов на горизонте уклонения.
function clearance(me: CrowdTank, move: Move, bullets: readonly CrowdBullet[]): number {
  let closest = Infinity;
  for (let time = 0; time <= THREAT_HORIZON_S + TIME_EPSILON; time += THREAT_STEP_S) {
    const place = positionAt(me, move, time);
    for (const bullet of bullets) {
      const gap = Math.hypot(bullet.x + bullet.vx * time - place.x, bullet.y + bullet.vy * time - place.y);
      closest = Math.min(closest, gap);
    }
  }
  return closest;
}

// Восемь направлений и «ехать как ехал». Разворот к направлению — меньшим углом: передом или задом.
function candidateMoves(me: CrowdTank): Move[] {
  const current: Move = {
    dirX: Math.cos(me.heading) * Math.sign(me.speed),
    dirY: Math.sin(me.heading) * Math.sign(me.speed),
    speed: Math.abs(me.speed),
    delay: 0,
    isForward: me.speed >= 0,
    isCurrent: true,
  };
  const turns: Move[] = [];
  for (let k = 0; k < DODGE_DIRECTIONS; k++) {
    const angle = (k * 2 * Math.PI) / DODGE_DIRECTIONS;
    const diff = Math.abs(normalizeAngle(angle - me.heading));
    const isForward = diff <= Math.PI / 2;
    const turnAngle = isForward ? diff : Math.PI - diff;
    turns.push({
      dirX: Math.cos(angle),
      dirY: Math.sin(angle),
      speed: isForward ? me.stats.maxSpeed : me.stats.maxSpeed * REVERSE_FACTOR,
      delay: turnAngle / me.stats.turnRate,
      isForward,
      isCurrent: false,
    });
  }
  turns.sort((a, b) => a.delay - b.delay);
  return [current, ...turns];
}

// Мозг бота толпы: путь по сетке, упреждение, аптечки, зона, уклонение от всех замеченных снарядов сразу, выезд
// из застревания в танках. Цель выбирает не мозг. Уровни отличаются только значениями ручек профиля.
export class CrowdBrain {
  private readonly phase: number;
  private path: Point[] = [];
  private pathTick = -Infinity;
  private pathGoal: Point | null = null;
  private isPathPending = false;
  // Тик прошлого хода в этой жизни: тик расписания между ходами засчитывается.
  private thoughtTick: number | null = null;
  // Тиков с прошлого хода в этой жизни: таймеры мозга считают тики, а не ходы.
  private elapsedTicks = 1;
  private aimNoise = 0;
  private aimNoiseTicksLeft = 0;
  private isLeadingShot = false;
  private isCarelessShot = false;
  private hasBeenReloading = false;
  private fireRetryTicksLeft = 0;
  private patrolTarget: Point | null = null;
  private patrolTick = -Infinity;
  private pauseTicksLeft = 0;
  private sincePauseTicks = 0;
  private noticed = new Map<number, boolean>();
  private dodgeMove: Move | null = null;
  private dodgeTicksLeft = 0;
  private isReturningToZone = false;
  private lastThrottle = 0;
  private anchor: Point | null = null;
  private pushTicks = 0;
  private unstickTicksLeft = 0;
  private unstickDrive: Drive = HOLD;
  private unstickSide = 1;

  // phase разносит пересчёт пути ботов роя по разным тикам.
  constructor(
    private readonly profile: CrowdProfile,
    private readonly random: () => number,
    phase: number,
  ) {
    this.phase = phase % REPLAN_TICKS;
  }

  // Новая жизнь: танк появился в новом месте.
  init(): void {
    this.path = [];
    this.pathTick = -Infinity;
    this.pathGoal = null;
    this.isPathPending = false;
    this.thoughtTick = null;
    this.aimNoiseTicksLeft = 0;
    this.isLeadingShot = this.random() < this.profile.leadChance;
    this.isCarelessShot = this.random() < this.profile.carelessness;
    this.hasBeenReloading = false;
    this.fireRetryTicksLeft = 0;
    this.patrolTarget = null;
    this.patrolTick = -Infinity;
    this.pauseTicksLeft = 0;
    this.sincePauseTicks = 0;
    this.noticed = new Map();
    this.dodgeMove = null;
    this.dodgeTicksLeft = 0;
    this.isReturningToZone = false;
    this.lastThrottle = 0;
    this.anchor = null;
    this.pushTicks = 0;
    this.unstickTicksLeft = 0;
  }

  tick(view: CrowdView, target: CrowdTank | null, paths: PathAllowance = UNLIMITED_PATHS): Action {
    this.elapsedTicks = this.thoughtTick === null ? 1 : Math.max(1, view.tick - this.thoughtTick);
    const grid = gridFor(view.map);
    const aim = target === null ? this.lookAhead(view.me) : this.aim(view, target);
    const drive = this.drive(view, grid, target, paths);
    const cap = this.profile.throttleCap;
    const throttle = clamp(drive.throttle, -cap, cap);
    this.lastThrottle = throttle;
    this.thoughtTick = view.tick;
    return { throttle, turn: drive.turn, ...aim };
  }

  private lookAhead(me: CrowdTank): Aim {
    return { turretTurn: clamp(normalizeAngle(me.heading - me.turret) * TURRET_GAIN, -1, 1), isFiring: false };
  }

  private aim(view: CrowdView, target: CrowdTank): Aim {
    const { me, map } = view;
    if (this.aimNoiseTicksLeft <= 0) {
      this.aimNoise = (this.random() * 2 - 1) * this.profile.aimNoiseRad;
      this.aimNoiseTicksLeft = AIM_NOISE_PERIOD_TICKS;
    }
    this.aimNoiseTicksLeft -= this.elapsedTicks;
    // Монетки упреждения и беспечности бросаются на каждый новый выстрел — в момент, когда перезарядка закончилась.
    const isReady = me.reloadLeft <= 0;
    if (isReady && this.hasBeenReloading) {
      this.isLeadingShot = this.random() < this.profile.leadChance;
      this.isCarelessShot = this.random() < this.profile.carelessness;
    }
    this.hasBeenReloading = !isReady;

    const point = leadPoint(me, target, this.isLeadingShot ? this.profile.leadQuality : 0);
    const wanted = Math.atan2(point.y - me.y, point.x - me.x) + this.aimNoise;
    const turretDiff = normalizeAngle(wanted - me.turret);
    const turretTurn = clamp(turretDiff * TURRET_GAIN, -1, 1);
    const muzzleX = me.x + Math.cos(me.turret) * MUZZLE_OFFSET;
    const muzzleY = me.y + Math.sin(me.turret) * MUZZLE_OFFSET;
    const isAimed = Math.abs(turretDiff) < this.profile.fireWindowRad;
    const isLineClear = isSegmentClear(map.walls, muzzleX, muzzleY, point.x, point.y, SHOT_PAD);
    const isSafe = this.isCarelessShot || !isShotReturning(map, me, me.turret, me.stats.bulletSpeed, target);
    if (!isReady || !isAimed || !isLineClear || !isSafe) {
      return { turretTurn, isFiring: false };
    }
    if (this.fireRetryTicksLeft > 0) {
      this.fireRetryTicksLeft -= this.elapsedTicks;
      return { turretTurn, isFiring: false };
    }
    if (this.random() < this.profile.fireChance) {
      return { turretTurn, isFiring: true };
    }
    this.fireRetryTicksLeft = FIRE_RETRY_TICKS;
    return { turretTurn, isFiring: false };
  }

  // Приоритеты корпуса: пауза > выезд из застревания > уклонение > зона > аптечка > движение уровня.
  private drive(view: CrowdView, grid: Grid, target: CrowdTank | null, paths: PathAllowance): Drive {
    const { me } = view;
    if (this.isPausing()) {
      return HOLD;
    }
    const unstick = this.unstick(me);
    if (unstick !== null) {
      return unstick;
    }
    const dodge = this.dodge(view, grid);
    if (dodge !== null) {
      return dodge;
    }
    if (this.isZoneReturnDue(view)) {
      return this.followPath(view, grid, view.zone, paths);
    }
    const kit = view.kits
      .filter((candidate) => candidate.isActive && isGoalInZone(view.zone, candidate))
      .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
    if (this.profile.hasKits && kit !== undefined && me.hp < me.maxHp * KIT_HP_FRACTION) {
      return this.followPath(view, grid, kit, paths);
    }
    if (target === null || this.profile.movement === 'patrol') {
      return this.patrol(view, grid, paths);
    }
    return this.hunt(view, grid, target, paths);
  }

  private isZoneReturnDue(view: CrowdView): boolean {
    const { me, zone } = view;
    const depth = zone.radius - Math.hypot(me.x - zone.x, me.y - zone.y);
    if (depth < ZONE_MARGIN) {
      this.isReturningToZone = true;
    }
    if (depth > ZONE_MARGIN + ZONE_RETURN_DEPTH) {
      this.isReturningToZone = false;
    }
    return this.isReturningToZone;
  }

  private isPausing(): boolean {
    const period = this.profile.pauseEverySec;
    if (period === null) {
      return false;
    }
    if (this.pauseTicksLeft > 0) {
      this.pauseTicksLeft -= this.elapsedTicks;
      return true;
    }
    this.sincePauseTicks += this.elapsedTicks;
    if (this.sincePauseTicks >= period * TICK_RATE) {
      this.sincePauseTicks = 0;
      this.pauseTicksLeft = PAUSE_TICKS;
    }
    return false;
  }

  // Газ держится секунду, а танк почти не сдвинулся — упёрся в танк или угол стены, которых путь не знает:
  // полсекунды задним ходом с поворотом, стороны поворота чередуются, путь — заново.
  private unstick(me: CrowdTank): Drive | null {
    if (this.unstickTicksLeft > 0) {
      this.unstickTicksLeft -= this.elapsedTicks;
      return this.unstickDrive;
    }
    const anchor = this.anchor ?? me;
    const isPushing = Math.abs(this.lastThrottle) >= STUCK_THROTTLE;
    if (!isPushing || Math.hypot(me.x - anchor.x, me.y - anchor.y) >= STUCK_MOVE) {
      this.anchor = { x: me.x, y: me.y };
      this.pushTicks = 0;
      return null;
    }
    this.pushTicks += this.elapsedTicks;
    if (this.pushTicks < STUCK_TICKS) {
      return null;
    }
    this.pushTicks = 0;
    this.unstickTicksLeft = UNSTICK_TICKS - 1;
    this.unstickDrive = { throttle: this.lastThrottle > 0 ? -1 : 1, turn: this.unstickSide };
    this.unstickSide = -this.unstickSide;
    this.path = [];
    return this.unstickDrive;
  }

  // Заметил ли бот опасный снаряд — монетка один раз на снаряд, пока тот в виду: свой вернувшийся замечает
  // небеспечный, чужой — с вероятностью уровня.
  private noticedThreats(view: CrowdView): CrowdBullet[] {
    const { me } = view;
    const next = new Map<number, boolean>();
    const noticed: CrowdBullet[] = [];
    for (const bullet of view.bullets) {
      const isMine = bullet.owner === me.id;
      if (isMine && !bullet.hasBounced) {
        continue;
      }
      const chance = isMine ? 1 - this.profile.carelessness : this.profile.dodgeChance;
      const isNoticed = this.noticed.get(bullet.id) ?? (chance > 0 && this.random() < chance);
      next.set(bullet.id, isNoticed);
      if (isNoticed) {
        noticed.push(bullet);
      }
    }
    this.noticed = next;
    return noticed;
  }

  // Ехать как ехал опасно — выбирается кандидат с наибольшим запасом до всех замеченных снарядов сразу; при
  // равенстве — тот, к которому быстрее развернуться. Шаг вбок от одного снаряда не уводит под второй.
  private dodge(view: CrowdView, grid: Grid): Drive | null {
    const { me } = view;
    const threats = this.noticedThreats(view);
    if (threats.length === 0) {
      this.dodgeTicksLeft = 0;
      return null;
    }
    if (this.dodgeTicksLeft > 0 && this.dodgeMove !== null) {
      this.dodgeTicksLeft -= this.elapsedTicks;
      return driveAlong(me, this.dodgeMove);
    }
    let best: Move | null = null;
    let bestClearance = -Infinity;
    for (const move of candidateMoves(me)) {
      const probe = positionAt(me, move, DODGE_PROBE_S);
      if (!move.isCurrent && !isFreePoint(grid, probe.x, probe.y)) {
        continue;
      }
      const gap = clearance(me, move, threats);
      if (move.isCurrent && gap >= SAFE_MISS) {
        return null;
      }
      if (gap > bestClearance) {
        best = move;
        bestClearance = gap;
      }
    }
    if (best === null || best.isCurrent) {
      return null;
    }
    this.dodgeMove = best;
    this.dodgeTicksLeft = DODGE_HOLD_TICKS - 1;
    return driveAlong(me, best);
  }

  // Случайная свободная точка внутри зоны; новая — когда доехал или по таймеру. Зона сжалась — доехать значит
  // добраться до точки, прижатой внутрь зоны.
  private patrol(view: CrowdView, grid: Grid, paths: PathAllowance): Drive {
    const { me } = view;
    const goal = this.patrolTarget === null ? null : goalInZone(view.zone, this.patrolTarget);
    const isReached = goal !== null && Math.hypot(goal.x - me.x, goal.y - me.y) < PATROL_REACHED;
    if (this.patrolTarget === null || isReached || view.tick - this.patrolTick > PATROL_REPLAN_TICKS) {
      const cell = pickZoneCell(grid, view.zone, goalRadius(view.zone), this.random());
      if (cell !== null) {
        this.patrolTarget = cell;
      }
      this.patrolTick = view.tick;
    }
    return this.followPath(view, grid, this.patrolTarget ?? view.zone, paths);
  }

  // Сближение держит дистанцию без кружения; круг в перестрелке ходит вокруг цели. Точки движения — внутри зоны.
  private hunt(view: CrowdView, grid: Grid, target: CrowdTank, paths: PathAllowance): Drive {
    const { me, map, zone } = view;
    const distance = Math.hypot(target.x - me.x, target.y - me.y);
    const hasLineOfSight = isSegmentClear(map.walls, me.x, me.y, target.x, target.y, SHOT_PAD);
    if (!hasLineOfSight || distance >= FIGHT_DISTANCE) {
      return this.followPath(view, grid, target, paths);
    }
    if (this.profile.movement === 'approach') {
      const away = Math.atan2(me.y - target.y, me.x - target.x);
      const retreat = { x: target.x + Math.cos(away) * HOLD_DISTANCE, y: target.y + Math.sin(away) * HOLD_DISTANCE };
      // Отход, упёршийся в край зоны, сменяется смещением поперёк: иначе бот стоял бы у края.
      if (distance < RETREAT_DISTANCE && isGoalInZone(zone, retreat)) {
        return driveTo(me, retreat.x, retreat.y);
      }
      if (distance < HOLD_DISTANCE) {
        // На дистанции не стоять столбом: медленно смещаться поперёк линии огня, меняя сторону.
        const side = this.cycleTick(view.tick, DRIFT_PERIOD_TICKS) < DRIFT_PERIOD_TICKS / 2 ? 1 : -1;
        const step = goalInZone(zone, sidestepPoint(me, me.x - target.x, me.y - target.y, side));
        const drift = driveTo(me, step.x, step.y);
        return { throttle: drift.throttle * DRIFT_THROTTLE, turn: drift.turn };
      }
      const closer = goalInZone(zone, target);
      return driveTo(me, closer.x, closer.y);
    }
    const sway =
      this.cycleTick(view.tick, STRAFE_PERIOD_TICKS) < STRAFE_PERIOD_TICKS / 2 ? STRAFE_ANGLE : -STRAFE_ANGLE;
    const around = Math.atan2(me.y - target.y, me.x - target.x) + sway;
    const radius = distance < STRAFE_NEAR ? STRAFE_RADIUS_NEAR : STRAFE_RADIUS_FAR;
    const circle = goalInZone(zone, {
      x: target.x + Math.cos(around) * radius,
      y: target.y + Math.sin(around) * radius,
    });
    return driveTo(me, circle.x, circle.y);
  }

  // Место тика в цикле смены стороны, сдвинутое номером бота: боты рядом не меняют сторону разом и не идут по кругу
  // друг за другом впритык.
  private cycleTick(tick: number, period: number): number {
    return (tick + (this.phase * period) / REPLAN_TICKS) % period;
  }

  // Тик расписания с прошлого хода: бот, пропустивший ход, не теряет пересчёт. Ход на том же тике или первый в
  // жизни — только сам тик.
  private isReplanDue(tick: number): boolean {
    const sinceDue = (tick + this.phase) % REPLAN_TICKS;
    const thought = this.thoughtTick;
    if (thought === null || thought >= tick) {
      return sinceDue === 0;
    }
    return sinceDue < tick - thought;
  }

  // Путь пересчитывается по расписанию (свой тик у каждого бота), когда цель пути заметно сдвинулась или путь
  // кончился — но не чаще раза в MIN_REPLAN_GAP_TICKS: недостижимая цель не гоняет поиск каждый тик. Первый путь —
  // только по расписанию: на старте боя боты ищут его не все в одном тике. Поиск без разрешения откладывается до
  // следующего хода. Цель пути прижимается внутрь зоны.
  private followPath(view: CrowdView, grid: Grid, wanted: Point, paths: PathAllowance): Drive {
    const { me, map } = view;
    const goal = goalInZone(view.zone, wanted);
    const isDue = this.isPathPending || this.isReplanDue(view.tick);
    const isFirst = this.pathGoal === null;
    const isStale =
      this.pathGoal === null ||
      this.path.length === 0 ||
      Math.hypot(goal.x - this.pathGoal.x, goal.y - this.pathGoal.y) > GOAL_SHIFT;
    const isReplanWanted = isFirst ? isDue : isStale || isDue;
    if (isReplanWanted && view.tick - this.pathTick >= MIN_REPLAN_GAP_TICKS) {
      this.replan(grid, me, goal, view.tick, paths);
    }
    while (this.path.length > 1) {
      const next = this.path[1];
      if (next === undefined || !isSegmentClear(map.walls, me.x, me.y, next.x, next.y, WAYPOINT_SKIP_PAD)) {
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

  private replan(grid: Grid, me: CrowdTank, goal: Point, tick: number, paths: PathAllowance): void {
    this.isPathPending = !paths.take();
    if (this.isPathPending) {
      return;
    }
    this.path = findPath(grid, nearestFree(grid, me.x, me.y), nearestFree(grid, goal.x, goal.y));
    this.pathTick = tick;
    this.pathGoal = { x: goal.x, y: goal.y };
  }
}
