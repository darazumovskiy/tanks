import {
  clamp,
  isSegmentClear,
  isShotReturning,
  MUZZLE_OFFSET,
  normalizeAngle,
  REVERSE_FACTOR,
  TICK_RATE,
  type Action,
  type BattleMap,
  type Point,
} from '@tanks/shared/engine';
import type { CrowdProfile } from './profile.js';
import type { CrowdBullet, CrowdTank, CrowdView } from './view.js';

const CELL = 25;
// Радиус танка с запасом: клетка сетки и отрезок пути считаются свободными на таком удалении от стен.
const PAD = 26;
const NEAREST_FREE_RADIUS = 6;
const REPLAN_TICKS = 10;
const MIN_REPLAN_GAP_TICKS = 3;
const GOAL_SHIFT = 100;
const WAYPOINT_SKIP_PAD = 24;
const WAYPOINT_REACHED = 14;
const REVERSE_ANGLE = 2.2;
const STEER_GAIN = 3;
const CREEP_THROTTLE = 0.15;
const LEAD_ITERATIONS = 4;
const TURRET_GAIN = 8;
const SHOT_PAD = 6;
const THREAT_HORIZON_S = 0.9;
const THREAT_STEP_S = 0.1;
// Ехать как ехал — только с таким запасом до снарядов: модель кандидатов не знает разгона, а уход, едва
// ставший безопасным по инерции, иначе бросался бы, и танк возвращался под снаряд.
const SAFE_MISS = 60;
// Выбранный уход держится столько тиков: без этого бот метался бы между равными кандидатами.
const DODGE_HOLD_TICKS = 9;
const DODGE_DIRECTIONS = 8;
const DODGE_DISTANCE = 80;
// Куда кандидат уклонения успеет доехать — проверяется на свободу от стен.
const DODGE_PROBE_S = 0.5;
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

interface Grid {
  cols: number;
  rows: number;
  free: Uint8Array;
  freeCells: Point[];
  previous: Int32Array;
  queue: Int32Array;
}

type Drive = Pick<Action, 'throttle' | 'turn'>;
type Aim = Pick<Action, 'turretTurn' | 'isFiring'>;

// Кандидат уклонения: направление, скорость и время на разворот к нему; isCurrent — ехать как ехал.
interface Move {
  dirX: number;
  dirY: number;
  speed: number;
  delay: number;
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
// сетки всегда заняты (отступ PAD), поэтому соседи раскрытой клетки не выходят за сетку.
function findPath(grid: Grid, from: number, to: number): Point[] {
  const previous = grid.previous;
  previous.fill(-1);
  const queue = grid.queue;
  let tail = 0;
  queue[tail++] = from;
  previous[from] = from;
  for (let head = 0; head < tail; head++) {
    const current = queue[head];
    if (current === undefined || current === to) {
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

// Задним ходом развернуться часто быстрее, чем крутиться на месте.
function driveTo(me: CrowdTank, x: number, y: number): Drive {
  const wanted = Math.atan2(y - me.y, x - me.x);
  const diff = normalizeAngle(wanted - me.heading);
  if (Math.abs(diff) > REVERSE_ANGLE) {
    const back = normalizeAngle(diff + Math.PI);
    return { throttle: -1, turn: clamp(-back * STEER_GAIN, -1, 1) };
  }
  return { throttle: Math.cos(diff) > 0.5 ? 1 : CREEP_THROTTLE, turn: clamp(diff * STEER_GAIN, -1, 1) };
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

function sidestep(me: CrowdTank, alongX: number, alongY: number, side: number): Drive {
  const perpendicular = Math.atan2(alongY, alongX) + Math.PI / 2;
  return driveTo(
    me,
    me.x + Math.cos(perpendicular) * DODGE_DISTANCE * side,
    me.y + Math.sin(perpendicular) * DODGE_DISTANCE * side,
  );
}

function pickOne<T>(list: readonly T[], random: number): T[] {
  const index = Math.floor(random * list.length);
  return list.slice(index, index + 1);
}

function positionAt(me: CrowdTank, move: Move, time: number): Point {
  const travel = move.speed * Math.max(0, time - move.delay);
  return { x: me.x + move.dirX * travel, y: me.y + move.dirY * travel };
}

// Наименьшее расстояние от танка, едущего по кандидату, до снарядов на горизонте уклонения.
function clearance(me: CrowdTank, move: Move, bullets: readonly CrowdBullet[]): number {
  let closest = Infinity;
  for (let time = 0; time <= THREAT_HORIZON_S + 1e-9; time += THREAT_STEP_S) {
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
  private noticed = new Map<number, boolean>();
  private dodgeMove: Move | null = null;
  private dodgeTicksLeft = 0;
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
    this.aimNoiseTicksLeft = 0;
    this.isLeadingShot = this.random() < this.profile.leadChance;
    this.isCarelessShot = this.random() < this.profile.carelessness;
    this.wasReloading = false;
    this.fireRetryTicksLeft = 0;
    this.patrolTarget = null;
    this.patrolTick = -Infinity;
    this.pauseTicksLeft = 0;
    this.sincePauseTicks = 0;
    this.noticed = new Map();
    this.dodgeMove = null;
    this.dodgeTicksLeft = 0;
    this.lastThrottle = 0;
    this.anchor = null;
    this.pushTicks = 0;
    this.unstickTicksLeft = 0;
  }

  tick(view: CrowdView, target: CrowdTank | null): Action {
    const grid = gridFor(view.map);
    const aim = target === null ? this.lookAhead(view.me) : this.aim(view, target);
    const drive = this.drive(view, grid, target);
    const cap = this.profile.throttleCap;
    const throttle = clamp(drive.throttle, -cap, cap);
    this.lastThrottle = throttle;
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
    this.aimNoiseTicksLeft--;
    // Монетки упреждения и беспечности бросаются на каждый новый выстрел — в момент, когда перезарядка закончилась.
    const isReady = me.reloadLeft <= 0;
    if (isReady && this.wasReloading) {
      this.isLeadingShot = this.random() < this.profile.leadChance;
      this.isCarelessShot = this.random() < this.profile.carelessness;
    }
    this.wasReloading = !isReady;

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
      this.fireRetryTicksLeft--;
      return { turretTurn, isFiring: false };
    }
    if (this.random() < this.profile.fireChance) {
      return { turretTurn, isFiring: true };
    }
    this.fireRetryTicksLeft = FIRE_RETRY_TICKS;
    return { turretTurn, isFiring: false };
  }

  // Приоритеты корпуса: пауза > выезд из застревания > уклонение > зона > аптечка > движение уровня.
  private drive(view: CrowdView, grid: Grid, target: CrowdTank | null): Drive {
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
    const zoneDistance = Math.hypot(me.x - view.zone.x, me.y - view.zone.y);
    if (zoneDistance > view.zone.radius - ZONE_MARGIN) {
      return this.followPath(view, grid, view.zone);
    }
    const kit = view.kits
      .filter((candidate) => candidate.isActive)
      .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
    if (this.profile.hasKits && kit !== undefined && me.hp < me.maxHp * KIT_HP_FRACTION) {
      return this.followPath(view, grid, kit);
    }
    if (target === null || this.profile.movement === 'patrol') {
      return this.patrol(view, grid);
    }
    return this.hunt(view, grid, target);
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

  // Газ держится секунду, а танк почти не сдвинулся — упёрся в танк или угол стены, которых путь не знает:
  // полсекунды задним ходом с поворотом, стороны поворота чередуются, путь — заново.
  private unstick(me: CrowdTank): Drive | null {
    if (this.unstickTicksLeft > 0) {
      this.unstickTicksLeft--;
      return this.unstickDrive;
    }
    const anchor = this.anchor ?? me;
    const isPushing = Math.abs(this.lastThrottle) >= STUCK_THROTTLE;
    if (!isPushing || Math.hypot(me.x - anchor.x, me.y - anchor.y) >= STUCK_MOVE) {
      this.anchor = { x: me.x, y: me.y };
      this.pushTicks = 0;
      return null;
    }
    this.pushTicks++;
    if (this.pushTicks < STUCK_TICKS) {
      return null;
    }
    this.pushTicks = 0;
    this.unstickTicksLeft = UNSTICK_TICKS - 1;
    this.unstickDrive = { throttle: this.lastThrottle > 0 ? -1 : 1, turn: this.unstickSide };
    this.unstickSide = -this.unstickSide;
    this.path = [];
    this.pathGoal = null;
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
      this.dodgeTicksLeft--;
      return driveTo(me, me.x + this.dodgeMove.dirX * DODGE_DISTANCE, me.y + this.dodgeMove.dirY * DODGE_DISTANCE);
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
    return driveTo(me, me.x + best.dirX * DODGE_DISTANCE, me.y + best.dirY * DODGE_DISTANCE);
  }

  // Случайная свободная точка внутри зоны; новая — когда доехал или по таймеру.
  private patrol(view: CrowdView, grid: Grid): Drive {
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

  // Сближение держит дистанцию без кружения; круг в перестрелке ходит вокруг цели.
  private hunt(view: CrowdView, grid: Grid, target: CrowdTank): Drive {
    const { me, map } = view;
    const distance = Math.hypot(target.x - me.x, target.y - me.y);
    const hasLineOfSight = isSegmentClear(map.walls, me.x, me.y, target.x, target.y, SHOT_PAD);
    if (!hasLineOfSight || distance >= FIGHT_DISTANCE) {
      return this.followPath(view, grid, target);
    }
    if (this.profile.movement === 'approach') {
      if (distance < RETREAT_DISTANCE) {
        const away = Math.atan2(me.y - target.y, me.x - target.x);
        return driveTo(me, target.x + Math.cos(away) * HOLD_DISTANCE, target.y + Math.sin(away) * HOLD_DISTANCE);
      }
      if (distance < HOLD_DISTANCE) {
        // На дистанции не стоять столбом: медленно смещаться поперёк линии огня, меняя сторону.
        const side = view.tick % DRIFT_PERIOD_TICKS < DRIFT_PERIOD_TICKS / 2 ? 1 : -1;
        const drift = sidestep(me, me.x - target.x, me.y - target.y, side);
        return { throttle: drift.throttle * DRIFT_THROTTLE, turn: drift.turn };
      }
      return driveTo(me, target.x, target.y);
    }
    const sway = view.tick % STRAFE_PERIOD_TICKS < STRAFE_PERIOD_TICKS / 2 ? STRAFE_ANGLE : -STRAFE_ANGLE;
    const around = Math.atan2(me.y - target.y, me.x - target.x) + sway;
    const radius = distance < STRAFE_NEAR ? STRAFE_RADIUS_NEAR : STRAFE_RADIUS_FAR;
    return driveTo(me, target.x + Math.cos(around) * radius, target.y + Math.sin(around) * radius);
  }

  // Путь пересчитывается по расписанию (свой тик у каждого бота), когда цель пути заметно сдвинулась или путь
  // кончился — но не чаще раза в MIN_REPLAN_GAP_TICKS: недостижимая цель не гоняет поиск каждый тик.
  private followPath(view: CrowdView, grid: Grid, goal: Point): Drive {
    const { me, map } = view;
    const isStale =
      this.pathGoal === null ||
      this.path.length === 0 ||
      Math.hypot(goal.x - this.pathGoal.x, goal.y - this.pathGoal.y) > GOAL_SHIFT;
    const isDue = (view.tick + this.phase) % REPLAN_TICKS === 0;
    if ((isStale || isDue) && view.tick - this.pathTick >= MIN_REPLAN_GAP_TICKS) {
      this.path = findPath(grid, nearestFree(grid, me.x, me.y), nearestFree(grid, goal.x, goal.y));
      this.pathTick = view.tick;
      this.pathGoal = { x: goal.x, y: goal.y };
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
}
