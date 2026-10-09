import { ReactionDelay, type BotBrain } from '@tanks/bots';
import {
  botView,
  BULLET_BOUNCES,
  BULLET_RADIUS,
  createRandom,
  createRound,
  DEFAULT_STATS,
  DT,
  flyBullets,
  IDLE_ACTION,
  nextRandom,
  normalizeAngle,
  stepRound,
  stepWorld,
  TANK_RADIUS,
  TICK_RATE,
  type Action,
  type Bullet,
  type DuelEvent,
  type Random,
  type Round,
  type RoundEvent,
  type Side,
  type Tank,
  type World,
  type WorldEvent,
} from '@tanks/shared/engine';
import { BOT_LEVEL_INFO, toSnapshotEvent, type BotLevel, type SnapshotEvent } from '@tanks/shared/protocol';
import { EventSchedule, eventPlace, type PictureClock } from '../pictureTime.js';
import type { InterpolatedTank, WorldView } from '../prediction.js';
import {
  DrawnBullets,
  type BulletFrames,
  type BulletPicture,
  type BulletTouch,
  type LagBullet,
  type TimedTank,
} from './lagBullets.js';

// Стенд задержки: мир лаборатории — судья. Танк цели входит в судью с опозданием на C тиков (очередь команд), поэтому
// снаряды стрелка проверяются против цели C тиков назад — компенсация задержки стрелка с пределом.

export const LAG_MODES = ['victim', 'shooter'] as const;
export type LagMode = (typeof LAG_MODES)[number];
export const LAG_RTT_MS = [0, 50, 100, 150, 200, 300] as const;
export const LAG_CAP_MS = [0, 80, 120, 160, 200] as const;
export const LAG_BOT_LEVELS = [4, 5, 6, 7, 8, 9] as const satisfies readonly BotLevel[];

export interface LagKnobs {
  mode: LagMode;
  rttMs: number;
  capMs: number;
  botLevel: BotLevel;
}

export const DEFAULT_LAG_KNOBS: Readonly<LagKnobs> = { mode: 'victim', rttMs: 200, capMs: 120, botLevel: 6 };

// Каньон: прямая между точками появления свободна от стен — уворот от лобового выстрела виден без помех.
export const LAG_MAP_INDEX = 3;
export const ROUND_RESTART_TICKS = TICK_RATE;
const MY_NAME = 'Ты';

const MY_SIDE: Side = 0;
const BOT_SIDE: Side = 1;
// Сверх половины задержки до стрелка и половины на дорогу выстрела: два тика интерполяции снимков у стрелка.
const INTERPOLATION_TICKS = 2;
const MS_PER_S = 1000;
const MS_PER_TICK = DT * MS_PER_S;
const HIT_DISTANCE = TANK_RADIUS + BULLET_RADIUS;
// Попал бы снаряд судьи в нарисованный танк — сверяются пути на C тиков и ещё столько в обе стороны от попадания:
// догоняющий снаряд касается нарисованного танка позже, встречный — раньше, чем танка судьи.
const ON_SCREEN_EXTRA_TICKS = 4;
const ON_SCREEN_SAMPLES_PER_TICK = 4;
// Свои снаряды жертвы рождаются в копии раньше, чем в судье, и номера у них там другие: на картинке им — свои номера
// по тику рождения.
const OWN_BULLET_ID_BASE = 1_000_000;
// Судья засчитывает касание своего танка через C тиков; сверх этого — запас на дробный тик касания.
const TOUCH_CONFIRM_SLACK_TICKS = 2;

export type LagBrainFactory = (level: BotLevel, random: () => number) => BotBrain;

export interface TankPose {
  x: number;
  y: number;
  heading: number;
  turret: number;
}

interface Point {
  x: number;
  y: number;
}

// Где свой танк жертвы для стрелка: shooterView — куда он целится (нарисованный танк V тиков назад),
// serverView — что проверяет сервер (танк судьи, C тиков назад).
export interface VictimCircles {
  shooterView: TankPose;
  serverView: TankPose;
}

// Что рисуется после тика судьи. circles — только у жертвы.
export interface LagPicture {
  round: Round;
  tanks: [InterpolatedTank, InterpolatedTank];
  bullets: LagBullet[];
  circles: VictimCircles | null;
}

// Попадание судьи по своему танку, которого на своём экране не было: drawn — нарисованный танк, point — снаряд.
export interface CompensatedHit {
  drawn: Point;
  serverView: TankPose;
  point: Point;
  distance: number;
}

export interface LagStep {
  events: SnapshotEvent[];
  compensatedHit: CompensatedHit | null;
  isNewRound: boolean;
}

export interface LagCounters {
  hitsTaken: number;
  compensatedHits: number;
  averageMissPx: number | null;
  shots: number;
  hits: number;
  accuracy: number | null;
}

interface TankDebug {
  x: number;
  y: number;
  heading: number;
  hp: number;
  isAlive: boolean;
}

// Попадания по своему танку жертвы, сыгранные по касанию на картинке: сколько подтвердил судья, сколько отменено.
interface TouchHitsDebug {
  played: number;
  confirmed: number;
  cancelled: number;
}

export interface LagDebugState {
  mode: LagMode;
  rttMs: number;
  capMs: number;
  botLevel: BotLevel;
  viewLagTicks: number;
  compensationTicks: number;
  judgeTick: number;
  roundIndex: number;
  me: { judge: TankDebug; picture: TankDebug };
  bot: { judge: TankDebug; picture: TankDebug };
  bullets: LagBullet[];
  counters: LagCounters;
  touchHits: TouchHitsDebug;
  shooterView: TankPose | null;
  serverView: TankPose | null;
}

interface Tally {
  hitsTaken: number;
  compensatedHits: number;
  missSumPx: number;
  shots: number;
  hits: number;
  touchHits: number;
  confirmedTouchHits: number;
  cancelledTouchHits: number;
}

// Попадание по касанию, которое судья ещё не засчитал; tick — шаг стенда, в котором снаряд коснулся брони.
interface PendingTouch {
  damage: number;
  tick: number;
}

// Отставание взгляда стрелка V в тиках: половина задержки до него, интерполяция, половина на дорогу выстрела.
export function viewLagTicks(rttMs: number): number {
  return Math.round((rttMs * TICK_RATE) / MS_PER_S) + INTERPOLATION_TICKS;
}

// Компенсация C в тиках: отставание взгляда, но не больше предела.
export function compensationTicks(rttMs: number, capMs: number): number {
  return Math.min(viewLagTicks(rttMs), Math.round((capMs * TICK_RATE) / MS_PER_S));
}

function emptyTally(): Tally {
  return {
    hitsTaken: 0,
    compensatedHits: 0,
    missSumPx: 0,
    shots: 0,
    hits: 0,
    touchHits: 0,
    confirmedTouchHits: 0,
    cancelledTouchHits: 0,
  };
}

function poseOf(tank: TankPose): TankPose {
  return { x: tank.x, y: tank.y, heading: tank.heading, turret: tank.turret };
}

function pictureTank(tank: Tank): InterpolatedTank {
  return { ...poseOf(tank), speed: tank.speed, hp: tank.hp, maxHp: tank.stats.maxHp, isAlive: tank.isAlive };
}

function debugOf(tank: InterpolatedTank | Tank): TankDebug {
  return { x: tank.x, y: tank.y, heading: tank.heading, hp: tank.hp, isAlive: tank.isAlive };
}

function ownBulletId(round: Round, bullet: Bullet): number {
  return OWN_BULLET_ID_BASE + Math.round(round.tick - bullet.age / DT);
}

// Танк с нулём здоровья на картинке снаряды пролетают насквозь, как подбитый.
function timedTank(tank: InterpolatedTank, offset: number, isHitOnTouch: boolean): TimedTank {
  return { x: tank.x, y: tank.y, isAlive: tank.isAlive && tank.hp > 0, offset, isHitOnTouch };
}

// Попадание по касанию в событиях движка: в точке касания, урон уже ограничен здоровьем на картинке.
function touchHit(touch: BulletTouch, damage: number): Extract<DuelEvent, { type: 'hit' }> {
  const { bullet, point } = touch;
  const speed = Math.hypot(bullet.vx, bullet.vy);
  return {
    type: 'hit',
    tank: touch.side,
    ...point,
    damage,
    cause: bullet.owner === touch.side ? 'self' : 'bullet',
    by: bullet.owner,
    isRicochet: bullet.hasBounced,
    bulletX: point.x,
    bulletY: point.y,
    dirX: bullet.vx / speed,
    dirY: bullet.vy / speed,
  };
}

// Номер на картинке снаряда, попавшего в танк судьи: снаряд стрелка, который был до шага, исчез после шага и ближе
// всех к точке попадания.
function hitBulletId(
  hit: Extract<DuelEvent, { type: 'hit' }>,
  before: ReadonlyMap<number, Bullet>,
  after: ReadonlyMap<number, Bullet>,
): number | null {
  const { bulletX, bulletY } = hit;
  if (bulletX === undefined || bulletY === undefined) {
    return null;
  }
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const [id, bullet] of before) {
    if (bullet.owner !== hit.by || after.has(id)) {
      continue;
    }
    const away = Math.hypot(bullet.x - bulletX, bullet.y - bulletY);
    if (away < bestDistance) {
      best = id;
      bestDistance = away;
    }
  }
  return best;
}

// Снаряд копии после тика рождения — снова у ствола, в миг выстрела: шаг поля проведёт его тиком рождения и сверит со
// встречными снарядами, как судья.
function atMuzzle(bullet: Bullet): Bullet {
  return { ...bullet, x: bullet.x - bullet.vx * DT, y: bullet.y - bullet.vy * DT, age: bullet.age - DT };
}

function keepLast(list: unknown[], count: number): void {
  list.splice(0, Math.max(0, list.length - count));
}

type OwnBulletEvent = Extract<DuelEvent, { type: 'shot' | 'impact' | 'fizzle' | 'ricochet' }>;

// Свой выстрел и судьба своего снаряда: у жертвы они берутся из копии — там, где их видит игрок.
function isOwnBulletEvent(event: RoundEvent): event is OwnBulletEvent {
  if (event.type === 'shot') {
    return event.tank === MY_SIDE;
  }
  const isBulletFate = event.type === 'impact' || event.type === 'fizzle' || event.type === 'ricochet';
  return isBulletFate && event.owner === MY_SIDE;
}

// Событие о своём танке жертвы, которое играется на его нарисованном месте.
function isTankPlaceEvent(event: SnapshotEvent, side: Side): boolean {
  const isPlaceKind = event.kind === 'hit' || event.kind === 'death' || event.kind === 'bump';
  return isPlaceKind && event.side === side;
}

// Путь снаряда, попавшего в танк судьи, по тикам от -ticks до ticks: назад — по прямой, вперёд — полётом поля без
// танков, со стенами и отскоком, если он ещё не потрачен; null — снаряд уже погиб.
function bulletPath(
  field: Round,
  hit: Extract<DuelEvent, { type: 'hit' }>,
  speed: number,
  ticks: number,
): (Point | null)[] {
  const point = { x: hit.bulletX ?? hit.x, y: hit.bulletY ?? hit.y };
  const vx = (hit.dirX ?? 0) * speed;
  const vy = (hit.dirY ?? 0) * speed;
  const path: (Point | null)[] = [];
  for (let k = ticks; k > 0; k--) {
    path.push({ x: point.x - vx * k * DT, y: point.y - vy * k * DT });
  }
  path.push(point);
  const bullet: Bullet = {
    id: 0,
    owner: BOT_SIDE,
    ...point,
    vx,
    vy,
    damage: 0,
    bouncesLeft: hit.isRicochet === true ? 0 : BULLET_BOUNCES,
    hasBounced: hit.isRicochet === true,
    age: 0,
    isDead: false,
  };
  const flight: World = { ...field, tanks: [], bullets: [bullet] };
  for (let k = 1; k <= ticks; k++) {
    flyBullets(flight);
    path.push(bullet.isDead ? null : { x: bullet.x, y: bullet.y });
  }
  return path;
}

// Путь нарисованного танка по тикам от -ticks до ticks: назад — по его следу, вперёд — с текущей скоростью и курсом.
function drawnPath(trail: readonly Point[], drawn: Tank, ticks: number): (Point | null)[] {
  const path: (Point | null)[] = [];
  for (let k = ticks; k > 0; k--) {
    path.push(trail[trail.length - 1 - k] ?? null);
  }
  const vx = Math.cos(drawn.heading) * drawn.speed;
  const vy = Math.sin(drawn.heading) * drawn.speed;
  for (let k = 0; k <= ticks; k++) {
    path.push({ x: drawn.x + vx * k * DT, y: drawn.y + vy * k * DT });
  }
  return path;
}

function isKnown(point: Point | null | undefined): point is Point {
  return point !== null && point !== undefined;
}

function isPathTouching(bullet: readonly (Point | null)[], tank: readonly (Point | null)[]): boolean {
  for (let k = 1; k < bullet.length; k++) {
    const [b0, b1, t0, t1] = [bullet[k - 1], bullet[k], tank[k - 1], tank[k]];
    if (!isKnown(b0) || !isKnown(b1)) {
      continue;
    }
    if (!isKnown(t0) || !isKnown(t1)) {
      continue;
    }
    for (let s = 0; s <= ON_SCREEN_SAMPLES_PER_TICK; s++) {
      const t = s / ON_SCREEN_SAMPLES_PER_TICK;
      const dx = lerp(b0.x, b1.x, t) - lerp(t0.x, t1.x, t);
      const dy = lerp(b0.y, b1.y, t) - lerp(t0.y, t1.y, t);
      if (Math.hypot(dx, dy) < HIT_DISTANCE) {
        return true;
      }
    }
  }
  return false;
}

function takeDue(queue: Action[], delayTicks: number): Action {
  if (queue.length <= delayTicks) {
    return IDLE_ACTION;
  }
  return queue.shift() ?? IDLE_ACTION;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function lerpAngle(from: number, to: number, t: number): number {
  return normalizeAngle(from + normalizeAngle(to - from) * t);
}

function lerpPose<T extends TankPose>(from: TankPose, to: T, t: number): T {
  return {
    ...to,
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
    heading: lerpAngle(from.heading, to.heading, t),
    turret: lerpAngle(from.turret, to.turret, t),
  };
}

// Кадр между двумя тиками судьи: t — доля пути от прошлой картинки к текущей. Новый снаряд — сразу на своём месте.
export function lagViewAt(
  from: LagPicture | null,
  to: LagPicture,
  t: number,
): { view: WorldView; circles: VictimCircles | null } {
  if (from === null) {
    return { view: { round: to.round, tanks: to.tanks, bullets: to.bullets }, circles: to.circles };
  }
  const starts = new Map(from.bullets.map((bullet) => [bullet.id, bullet]));
  const bullets = to.bullets.map((bullet) => {
    const start = starts.get(bullet.id);
    if (start === undefined) {
      return bullet;
    }
    return { ...bullet, x: lerp(start.x, bullet.x, t), y: lerp(start.y, bullet.y, t) };
  });
  const tanks: [InterpolatedTank, InterpolatedTank] = [
    lerpPose(from.tanks[0], to.tanks[0], t),
    lerpPose(from.tanks[1], to.tanks[1], t),
  ];
  const circles =
    from.circles === null || to.circles === null
      ? to.circles
      : {
          shooterView: lerpPose(from.circles.shooterView, to.circles.shooterView, t),
          serverView: lerpPose(from.circles.serverView, to.circles.serverView, t),
        };
  return { view: { round: to.round, tanks, bullets }, circles };
}

// Бой своего танка с ботом через судью. Жертва: свои команды ждут в очереди C тиков, бот видит судью с задержкой
// реакции на V − C больше, свой танк на картинке — копия судьи, прошагавшая очередь вперёд. Стрелок: команды бота
// ждут C тиков, нарисованный бот — бот судьи V − C тиков назад. Снаряды и события о них — во времени ближайшего
// нарисованного танка. Шаг — один тик судьи; раунд кончился — через секунду новый.
export class LagStand {
  private chosen: LagKnobs;
  private readonly random: Random;
  private brain: BotBrain;
  private delay: ReactionDelay;
  private judge: Round;
  private drawnMe: Tank;
  private drawnTrail: Point[] = [];
  // Жертва: позы нарисованного своего танка за V тиков, первая — где он для стрелка.
  private drawnPoses: TankPose[] = [];
  private queue: Action[] = [];
  private botHistory: InterpolatedTank[];
  private bulletHistory: Map<number, Bullet>[];
  private frames: BulletFrames;
  private readonly drawnBullets = new DrawnBullets();
  private readonly schedule = new EventSchedule<SnapshotEvent>();
  // Касания, которых судья ещё не засчитал, по номеру снаряда на картинке.
  private readonly pendingTouches = new Map<number, PendingTouch>();
  private current: LagPicture;
  private ticks = 0;
  private ticksOver = 0;
  private roundNumber = 0;
  private wins: [number, number] = [0, 0];
  private tally: Tally = emptyTally();

  constructor(
    knobs: Readonly<LagKnobs>,
    private readonly brainFactory: LagBrainFactory,
    seed: number,
  ) {
    this.chosen = { ...knobs };
    this.random = createRandom(seed);
    this.brain = this.freshBrain();
    this.judge = this.openRound();
    this.drawnMe = this.judge.tanks[MY_SIDE];
    this.drawnPoses = [poseOf(this.drawnMe)];
    this.botHistory = [pictureTank(this.judge.tanks[BOT_SIDE])];
    this.bulletHistory = [this.bulletFrame(this.judge)];
    this.frames = { first: 0, frames: this.bulletHistory };
    this.delay = this.freshDelay();
    this.current = this.pictureNow();
  }

  get knobs(): Readonly<LagKnobs> {
    return this.chosen;
  }

  get viewLag(): number {
    return viewLagTicks(this.chosen.rttMs);
  }

  get compensation(): number {
    return compensationTicks(this.chosen.rttMs, this.chosen.capMs);
  }

  get picture(): LagPicture {
    return this.current;
  }

  get round(): Round {
    return this.judge;
  }

  get roundIndex(): number {
    return this.roundNumber;
  }

  get score(): [number, number] {
    return [this.wins[0], this.wins[1]];
  }

  get names(): [string, string] {
    return [MY_NAME, BOT_LEVEL_INFO[this.chosen.botLevel].name];
  }

  // Танк, которым игрок управляет на своём экране: у жертвы — из копии, у стрелка — из судьи.
  get controlledTank(): Tank {
    return this.drawnMe;
  }

  get counters(): LagCounters {
    const { tally } = this;
    return {
      hitsTaken: tally.hitsTaken,
      compensatedHits: tally.compensatedHits,
      averageMissPx: tally.compensatedHits === 0 ? null : tally.missSumPx / tally.compensatedHits,
      shots: tally.shots,
      hits: tally.hits,
      accuracy: tally.shots === 0 ? null : tally.hits / tally.shots,
    };
  }

  // Любая ручка — бой заново: новый мозг, раунды и счётчики с нуля.
  setKnobs(knobs: Readonly<LagKnobs>): void {
    this.chosen = { ...knobs };
    this.brain = this.freshBrain();
    this.wins = [0, 0];
    this.tally = emptyTally();
    this.roundNumber = 0;
    this.restartRound();
  }

  step(input: Readonly<Action>): LagStep {
    this.ticks++;
    if (this.judge.isOver) {
      return this.waitStep();
    }
    const result = this.chosen.mode === 'victim' ? this.victimStep(input) : this.shooterStep(input);
    this.countWin();
    return result;
  }

  debugState(): LagDebugState {
    const { chosen, judge, current } = this;
    return {
      mode: chosen.mode,
      rttMs: chosen.rttMs,
      capMs: chosen.capMs,
      botLevel: chosen.botLevel,
      viewLagTicks: this.viewLag,
      compensationTicks: this.compensation,
      judgeTick: judge.tick,
      roundIndex: this.roundNumber,
      me: { judge: debugOf(judge.tanks[MY_SIDE]), picture: debugOf(current.tanks[MY_SIDE]) },
      bot: { judge: debugOf(judge.tanks[BOT_SIDE]), picture: debugOf(current.tanks[BOT_SIDE]) },
      bullets: current.bullets.map((bullet) => ({ ...bullet })),
      counters: this.counters,
      touchHits: {
        played: this.tally.touchHits,
        confirmed: this.tally.confirmedTouchHits,
        cancelled: this.tally.cancelledTouchHits,
      },
      shooterView: current.circles === null ? null : { ...current.circles.shooterView },
      serverView: current.circles === null ? null : { ...current.circles.serverView },
    };
  }

  private countWin(): void {
    const { isOver, winner } = this.judge;
    if (!isOver || winner === null) {
      return;
    }
    this.wins[winner]++;
  }

  private freshBrain(): BotBrain {
    return this.brainFactory(this.chosen.botLevel, () => nextRandom(this.random));
  }

  // Жертва: бот вместе с отставанием своего танка в судье видит его на V тиков в прошлом.
  private freshDelay(): ReactionDelay {
    const extraTicks = this.chosen.mode === 'victim' ? this.viewLag - this.compensation : 0;
    return new ReactionDelay(this.brain.reactionTicks + extraTicks);
  }

  private openRound(): Round {
    const round = createRound(LAG_MAP_INDEX, [
      { name: MY_NAME, stats: { ...DEFAULT_STATS } },
      { name: BOT_LEVEL_INFO[this.chosen.botLevel].name, stats: this.brain.stats },
    ]);
    this.brain.init?.(botView(round, BOT_SIDE), {
      roundIndex: this.roundNumber,
      mapIndex: round.mapIndex,
      score: [this.wins[0], this.wins[1]],
    });
    return round;
  }

  private restartRound(): void {
    this.judge = this.openRound();
    this.drawnMe = this.judge.tanks[MY_SIDE];
    this.drawnTrail = [];
    this.drawnPoses = [poseOf(this.drawnMe)];
    this.delay = this.freshDelay();
    this.queue = [];
    this.botHistory = [pictureTank(this.judge.tanks[BOT_SIDE])];
    this.bulletHistory = [this.bulletFrame(this.judge)];
    this.frames = { first: 0, frames: this.bulletHistory };
    this.drawnBullets.clear();
    this.schedule.clear();
    this.pendingTouches.clear();
    this.ticksOver = 0;
    this.current = this.pictureNow();
  }

  private waitStep(): LagStep {
    this.ticksOver++;
    if (this.ticksOver >= ROUND_RESTART_TICKS) {
      this.roundNumber++;
      this.restartRound();
      return { events: [], compensatedHit: null, isNewRound: true };
    }
    if (this.chosen.mode === 'victim') {
      this.expireTouches();
      this.current = this.victimPicture(this.current.bullets);
      return { events: [], compensatedHit: null, isNewRound: false };
    }
    // Нарисованный бот и снаряды догоняют судью, отложенные события доигрываются.
    this.recordHistory();
    this.current = this.pictureNow();
    return { events: this.releaseDue(), compensatedHit: null, isNewRound: false };
  }

  private botAction(): Action {
    return this.brain.tick(this.delay.perceive(botView(this.judge, BOT_SIDE)));
  }

  private victimStep(input: Readonly<Action>): LagStep {
    this.queue.push({ ...input });
    const applied = takeDue(this.queue, this.compensation);
    const botAction = this.botAction();
    const beforeStep = structuredClone(this.judge);
    const framesBefore = this.bulletFrame(beforeStep);
    const judgeEvents = stepRound(this.judge, [applied, botAction]);
    const framesAfter = this.bulletFrame(this.judge);
    const own = this.forwardMe(beforeStep, [applied, ...this.queue], botAction);
    this.frames = this.victimFrames(framesBefore, framesAfter, own.shots);
    this.drawnTrail.push({ x: this.drawnMe.x, y: this.drawnMe.y });
    this.drawnTrail.splice(0, this.drawnTrail.length - this.onScreenTicks - 1);
    this.drawnPoses.push(poseOf(this.drawnMe));
    keepLast(this.drawnPoses, this.viewLag + 1);
    const judgeMe = this.judge.tanks[MY_SIDE];
    const shift = { x: this.drawnMe.x - judgeMe.x, y: this.drawnMe.y - judgeMe.y };
    const events: SnapshotEvent[] = [];
    let compensatedHit: CompensatedHit | null = null;
    for (const event of judgeEvents) {
      if (isOwnBulletEvent(event)) {
        continue;
      }
      if (event.type === 'hit' && event.tank === MY_SIDE && event.cause === 'bullet') {
        this.tally.hitsTaken++;
        compensatedHit = this.compensatedHitOf(event, judgeMe) ?? compensatedHit;
      }
      if (event.type === 'hit' && this.confirmTouch(event, framesBefore, framesAfter)) {
        continue;
      }
      events.push(this.onDrawnMe(toSnapshotEvent(event), shift));
    }
    // Свой выстрел — сразу у ствола нарисованного танка; судьба своих снарядов — когда до её места дойдёт картинка.
    const ownTick = this.ticks + this.queue.length;
    for (const event of own.events) {
      const snapshot = toSnapshotEvent(event);
      if (event.type === 'shot') {
        events.push(snapshot);
        continue;
      }
      this.schedule.add(snapshot, ownTick, { kind: 'point' }, this.nowMs);
    }
    const { bullets, touches } = this.drawBullets(this.victimTanks());
    events.push(...this.playTouches(touches));
    this.expireTouches();
    this.current = this.victimPicture(bullets);
    events.push(...this.releaseDue());
    return { events, compensatedHit, isNewRound: false };
  }

  // Попадание судьи по своему танку, уже сыгранное по касанию, подтверждается и повторно не играется (true).
  private confirmTouch(
    hit: Extract<DuelEvent, { type: 'hit' }>,
    before: ReadonlyMap<number, Bullet>,
    after: ReadonlyMap<number, Bullet>,
  ): boolean {
    if (hit.tank !== MY_SIDE) {
      return false;
    }
    const id = hitBulletId(hit, before, after);
    if (id === null) {
      return false;
    }
    if (!this.pendingTouches.delete(id)) {
      return false;
    }
    this.tally.confirmedTouchHits++;
    return true;
  }

  // Касание своего танка — попадание сразу: урон снаряда, но не больше здоровья на картинке.
  private playTouches(touches: readonly BulletTouch[]): SnapshotEvent[] {
    const events: SnapshotEvent[] = [];
    for (const touch of touches) {
      const hp = this.shownMyHp;
      if (hp <= 0) {
        continue;
      }
      const damage = Math.min(hp, touch.bullet.damage);
      this.pendingTouches.set(touch.id, { damage, tick: this.ticks });
      this.tally.touchHits++;
      events.push(toSnapshotEvent(touchHit(touch, damage)));
    }
    return events;
  }

  // Касание, которое судья не засчитал за C тиков с запасом, тихо отменяется: здоровье на картинке снова из судьи.
  private expireTouches(): void {
    for (const [id, touch] of this.pendingTouches) {
      if (this.ticks - touch.tick <= this.compensation + TOUCH_CONFIRM_SLACK_TICKS) {
        continue;
      }
      this.pendingTouches.delete(id);
      this.tally.cancelledTouchHits++;
    }
  }

  private get shownMyHp(): number {
    let pending = 0;
    for (const touch of this.pendingTouches.values()) {
      pending += touch.damage;
    }
    return Math.max(0, this.judge.tanks[MY_SIDE].hp - pending);
  }

  // Копия судьи до шага без снарядов бота проходит команду этого тика и очередь вперёд физикой поля без конца раунда:
  // свой танк в ней не подбит и не остановлен победой — он там, где его видит игрок. Бот повторяет свою команду без
  // выстрела. События своих снарядов — из последнего шага копии, единственного нового с прошлого тика; shots[k] —
  // свои снаряды, родившиеся в копии к тику судьи + k + 1: судья их ещё не выпустил.
  private forwardMe(
    beforeStep: Round,
    actions: readonly Action[],
    botAction: Action,
  ): { events: OwnBulletEvent[]; shots: Bullet[][] } {
    beforeStep.bullets = beforeStep.bullets.filter((bullet) => bullet.owner === MY_SIDE);
    const botRepeat: Action = { ...botAction, isFiring: false };
    let lastEvents: WorldEvent[] = [];
    const shots: Bullet[][] = [];
    for (const [index, action] of actions.entries()) {
      lastEvents = stepWorld(beforeStep, [action, botRepeat]);
      if (index === 0) {
        continue;
      }
      const born = beforeStep.bullets.filter((bullet) => bullet.age <= DT);
      shots.push(born.map((bullet) => ({ ...bullet, id: ownBulletId(beforeStep, bullet) })));
    }
    this.drawnMe = beforeStep.tanks[MY_SIDE];
    return { events: lastEvents.filter(isOwnBulletEvent), shots };
  }

  // Кадры жертвы: судья до шага и после, дальше — снаряды судьи шагом поля без танков до времени своего танка, со
  // стенами и встречными снарядами, с выстрелами копии в их тиках.
  private victimFrames(
    framesBefore: Map<number, Bullet>,
    now: Map<number, Bullet>,
    shots: readonly Bullet[][],
  ): BulletFrames {
    const frames = [framesBefore, now];
    const flight: World = {
      ...this.judge,
      tanks: [],
      bullets: [...now.values()].map((bullet) => ({ ...bullet })),
      kits: [],
      zone: { ...this.judge.zone },
    };
    for (const born of shots) {
      flight.bullets.push(...born.map(atMuzzle));
      stepWorld(flight, []);
      frames.push(new Map(flight.bullets.map((bullet) => [bullet.id, { ...bullet }])));
    }
    return { first: -1, frames };
  }

  // Снаряды тика под номерами картинки.
  private bulletFrame(round: Round): Map<number, Bullet> {
    const isVictim = this.chosen.mode === 'victim';
    return new Map(
      round.bullets.map((bullet) => {
        const id = isVictim && bullet.owner === MY_SIDE ? ownBulletId(round, bullet) : bullet.id;
        return [id, { ...bullet, id }];
      }),
    );
  }

  private get nowMs(): number {
    return this.ticks * MS_PER_TICK;
  }

  private get onScreenTicks(): number {
    return this.compensation + ON_SCREEN_EXTRA_TICKS;
  }

  // Попадание компенсацией — только если и без компенсации снаряд не коснулся бы танка там, где его видит игрок:
  // ни раньше, ни позже попадания в танк судьи.
  private compensatedHitOf(event: Extract<DuelEvent, { type: 'hit' }>, judgeMe: Tank): CompensatedHit | null {
    const point = { x: event.bulletX ?? event.x, y: event.bulletY ?? event.y };
    const speed = this.judge.tanks[BOT_SIDE].stats.bulletSpeed;
    const ticks = this.onScreenTicks;
    const bullet = bulletPath(this.judge, event, speed, ticks);
    if (isPathTouching(bullet, drawnPath(this.drawnTrail, this.drawnMe, ticks))) {
      return null;
    }
    const distance = Math.hypot(point.x - this.drawnMe.x, point.y - this.drawnMe.y);
    this.tally.compensatedHits++;
    this.tally.missSumPx += distance;
    return { drawn: { x: this.drawnMe.x, y: this.drawnMe.y }, serverView: poseOf(judgeMe), point, distance };
  }

  private onDrawnMe(event: SnapshotEvent, shift: Point): SnapshotEvent {
    if (!isTankPlaceEvent(event, MY_SIDE)) {
      return event;
    }
    return { ...event, x: event.x + shift.x, y: event.y + shift.y };
  }

  private shooterStep(input: Readonly<Action>): LagStep {
    this.queue.push(this.botAction());
    const botApplied = takeDue(this.queue, this.compensation);
    const judgeEvents = stepRound(this.judge, [{ ...input }, botApplied]);
    for (const event of judgeEvents) {
      if (event.type === 'shot' && event.tank === MY_SIDE) {
        this.tally.shots++;
      }
      if (event.type === 'hit' && event.tank === BOT_SIDE && event.cause === 'bullet') {
        this.tally.hits++;
      }
      this.scheduleJudgeEvent(toSnapshotEvent(event));
    }
    this.recordHistory();
    this.current = this.pictureNow();
    return { events: this.releaseDue(), compensatedHit: null, isNewRound: false };
  }

  // Событие о танке ждёт, пока до тика события дойдёт нарисованный танк, событие в точке — картинка в этой точке.
  private scheduleJudgeEvent(event: SnapshotEvent): void {
    const tank = event.side === null ? null : { id: event.side, ...poseOf(this.judge.tanks[event.side]) };
    this.schedule.add(event, this.ticks, eventPlace(event.kind, tank, MY_SIDE), this.nowMs);
  }

  // История стрелка: позы бота на V − C тиков назад, снаряды — на тик дольше, чтобы было видно место гибели.
  private recordHistory(): void {
    const drawLag = this.viewLag - this.compensation;
    this.botHistory.push(pictureTank(this.judge.tanks[BOT_SIDE]));
    this.bulletHistory.push(this.bulletFrame(this.judge));
    keepLast(this.botHistory, drawLag + 1);
    keepLast(this.bulletHistory, drawLag + 2);
    this.frames = { first: 1 - this.bulletHistory.length, frames: this.bulletHistory };
  }

  // Время своего нарисованного танка и нарисованного бота в тиках от тика судьи.
  private get tankOffsets(): [number, number] {
    if (this.chosen.mode === 'victim') {
      return [this.frames.first + this.frames.frames.length - 1, 0];
    }
    return [0, 1 - this.botHistory.length];
  }

  private releaseDue(): SnapshotEvent[] {
    const [me, bot] = this.current.tanks;
    const [myOffset, botOffset] = this.tankOffsets;
    const clock: PictureClock = {
      myTick: this.ticks + myOffset,
      othersTick: this.ticks + botOffset,
      me: me.isAlive ? poseOf(me) : null,
      others: bot.isAlive ? [poseOf(bot)] : [],
    };
    const drawnTank = (id: number): InterpolatedTank => (id === BOT_SIDE ? bot : me);
    return this.schedule.release(clock, drawnTank, this.nowMs).map((due) => due.event);
  }

  // Картинка начала раунда и стрелка: у жертвы в начале раунда снарядов нет, касаний тоже.
  private pictureNow(): LagPicture {
    if (this.chosen.mode === 'victim') {
      return this.victimPicture(this.drawBullets(this.victimTanks()).bullets);
    }
    return this.shooterPicture();
  }

  // Свой танк — из копии, жизнь своего танка — из судьи, здоровье — судьи за вычетом касаний, которых судья ещё не
  // засчитал; бот — из судьи.
  private victimTanks(): [InterpolatedTank, InterpolatedTank] {
    const judgeMe = this.judge.tanks[MY_SIDE];
    const me: InterpolatedTank = { ...pictureTank(this.drawnMe), hp: this.shownMyHp, isAlive: judgeMe.isAlive };
    return [me, pictureTank(this.judge.tanks[BOT_SIDE])];
  }

  private victimPicture(bullets: LagBullet[]): LagPicture {
    const circles = {
      shooterView: this.drawnPoses[0] ?? poseOf(this.drawnMe),
      serverView: poseOf(this.judge.tanks[MY_SIDE]),
    };
    return { round: this.judge, tanks: this.victimTanks(), bullets, circles };
  }

  private shooterPicture(): LagPicture {
    const drawnBot = this.botHistory[0] ?? pictureTank(this.judge.tanks[BOT_SIDE]);
    const tanks: [InterpolatedTank, InterpolatedTank] = [pictureTank(this.judge.tanks[MY_SIDE]), drawnBot];
    return { round: this.judge, tanks, bullets: this.drawBullets(tanks).bullets, circles: null };
  }

  // Попадание по касанию — только по своему танку жертвы: он на картинке впереди судьи.
  private drawBullets(tanks: [InterpolatedTank, InterpolatedTank]): BulletPicture {
    const [myOffset, botOffset] = this.tankOffsets;
    const isVictim = this.chosen.mode === 'victim';
    return this.drawnBullets.frame({
      tick: this.ticks,
      frames: this.frames,
      tanks: [timedTank(tanks[0], myOffset, isVictim), timedTank(tanks[1], botOffset, false)],
      field: this.judge,
    });
  }
}
