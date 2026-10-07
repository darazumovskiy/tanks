import {
  isSegmentClear,
  nextRandom,
  normalizeAngle,
  TANK_RADIUS,
  TICK_RATE,
  type Action,
  type BotView,
  type Point,
  type Random,
  type TankView,
} from '@tanks/shared/engine';
import type { SightKey } from '../profile.js';
import { COURSE_BANDS, type CourseBandLabel, type KitSide } from '@tanks/analysis';
import { findPath, isFreeAt, nearestFree, PathFollower, WAYPOINT_REACHED, type Grid } from './path.js';
import { chance, fromDeciles, sampleDeciles, sampleExponential } from './sampling.js';
import { IDLE_HULL, keysToward, steerHull, type HullSteering } from './steering.js';

export type CourseDeciles = Readonly<Record<SightKey, Readonly<Record<CourseBandLabel, readonly number[]>>>>;

export interface ManoeuvreSettings {
  control: 'sticks' | 'mouseKeys';
  pivotThrottle: number;
  decisionMeanS: number;
  courseReach: number;
  stickDeciles: readonly number[];
  courseDecilesDeg: CourseDeciles;
  reverseChance: number;
  kitShare: Readonly<Record<KitSide, number>>;
  kitFollowShare: number;
}

// course — ход под углом к линии на противника; chase — путём к противнику, когда вокруг танка ни одно
// направление не свободно; unstick — назад от препятствия; kit — путём к аптечке.
export type IntentKind = 'course' | 'chase' | 'unstick' | 'kit';

// angle — угол хода к линии на противника со знаком стороны: 0 — к нему, ±π — от него.
export interface ManoeuvreIntent {
  kind: IntentKind;
  goal: Point;
  angle: number;
  strength: number;
  isReverse: boolean;
}

export type Drive = Pick<Action, 'throttle' | 'turn'>;

const HOLD: Drive = { throttle: 0, turn: 0 };

// Упёрся — газ держится 1 с, а танк сдвинулся меньше чем на 10.
const STUCK_TICKS = TICK_RATE;
const STUCK_SHIFT = 10;
const STUCK_THROTTLE = 0.5;
const UNSTICK_DISTANCE = 80;
const ZONE_MARGIN = 80;
const DEGREES_TO_RADIANS = Math.PI / 180;
// Курс смотрит вперёд на courseReach; занятый стеной курс отклоняется шагами по 15° в обе стороны, вплоть до
// обратного.
const DEFLECT_STEP = 15 * DEGREES_TO_RADIANS;
const DEFLECT_STEPS = 12;
// Курс свободен, если корпус по нему не задевает стен: запас — радиус корпуса. Отрезок проверяется с удаления
// в радиус корпуса, иначе прижатый к стене танк не нашёл бы курса и от неё.
const COURSE_PAD = TANK_RADIUS;
const SIDE_LEFT_CHANCE = 0.5;
// Угол хода корзины относится к её середине, у последней корзины без верхней границы — к нижней.
const BAND_ANCHORS = COURSE_BANDS.map((band) => (Number.isFinite(band.high) ? (band.low + band.high) / 2 : band.low));

interface TrackPoint {
  x: number;
  y: number;
  isPushing: boolean;
}

function activeKits(view: BotView): Point[] {
  return view.repairKits.filter((kit) => kit.isActive).map((kit) => ({ x: kit.x, y: kit.y }));
}

function isSamePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function isKitActive(view: BotView, point: Point): boolean {
  return activeKits(view).some((kit) => isSamePoint(kit, point));
}

function pathCells(grid: Grid, from: Point, to: Point): number {
  const start = nearestFree(grid, from);
  const goal = nearestFree(grid, to);
  if (start === goal) {
    return 0;
  }
  const path = findPath(grid, start, goal);
  return path.length === 0 ? Infinity : path.length;
}

interface KitChoice {
  point: Point;
  side: KitSide;
}

// Ближайшая ко мне по пути аптечка на поле и кому она ближе; null — аптечек нет или до них не доехать.
export function nearestKit(view: BotView, grid: Grid): KitChoice | null {
  let best: { point: Point; mine: number } | null = null;
  for (const kit of activeKits(view)) {
    const mine = pathCells(grid, view.me, kit);
    if (mine < (best?.mine ?? Infinity)) {
      best = { point: kit, mine };
    }
  }
  if (best === null) {
    return null;
  }
  const theirs = pathCells(grid, view.enemy, best.point);
  return { point: best.point, side: best.mine < theirs ? 'closer' : 'farther' };
}

export function isNearZoneEdge(view: BotView): boolean {
  const distance = Math.hypot(view.me.x - view.zone.x, view.me.y - view.zone.y);
  return distance > view.zone.radius - ZONE_MARGIN;
}

function pointAt(from: Point, direction: number, reach: number): Point {
  return { x: from.x + Math.cos(direction) * reach, y: from.y + Math.sin(direction) * reach };
}

// Ближайший к желаемому свободный курс: отклонение 0, +15°, −15°, +30°… — свободны отрезок и клетка в его конце.
// null — вокруг танка всё занято.
export function freeCourse(grid: Grid, me: Point, bearing: number, angle: number, reach: number): number | null {
  for (let step = 0; step <= DEFLECT_STEPS; step++) {
    for (const sign of step === 0 ? [1] : [1, -1]) {
      const candidate = normalizeAngle(angle + sign * step * DEFLECT_STEP);
      const end = pointAt(me, bearing + candidate, reach);
      const start = pointAt(me, bearing + candidate, COURSE_PAD);
      if (isFreeAt(grid, end) && isSegmentClear(grid.walls, start.x, start.y, end.x, end.y, COURSE_PAD)) {
        return candidate;
      }
    }
  }
  return null;
}

// Угол хода к линии на дистанции distance для доли u распределения: значения по децилям корзин дистанции,
// между опорами соседних корзин — линейно, ближе первой и дальше последней опоры — как у крайней корзины.
export function courseAngleAt(deciles: CourseDeciles[SightKey], distance: number, u: number): number {
  const valueAt = (band: (typeof COURSE_BANDS)[number]): number => fromDeciles(deciles[band.label], u);
  const above = BAND_ANCHORS.findIndex((anchor) => anchor > distance);
  const upper = COURSE_BANDS[above];
  const lower = COURSE_BANDS[above - 1];
  if (upper === undefined || lower === undefined) {
    const edge = above === 0 ? COURSE_BANDS[0] : COURSE_BANDS.at(-1);
    return edge === undefined ? 0 : valueAt(edge) * DEGREES_TO_RADIANS;
  }
  const from = BAND_ANCHORS[above - 1] ?? 0;
  const to = BAND_ANCHORS[above] ?? 0;
  const position = (distance - from) / (to - from);
  return (valueAt(lower) + (valueAt(upper) - valueAt(lower)) * position) * DEGREES_TO_RADIANS;
}

// Режим «манёвр»: в моменты решений танк берёт долю u распределения угла хода к линии на противника и держит её
// до следующего решения; угол каждый тик — значение этой доли в распределении человека для своей видимости и
// нынешней дистанции. Решение — по интервалу, при смене видимости и когда аптечку, к которой ехал, забрали.
// Поездку к аптечке, которую танк решил довести, решения не прерывают: она держится, пока аптечка лежит.
// Сторона линии держится, пока стена не отклонит курс на другую сторону или танк не упрётся.
export class Manoeuvre {
  private intentState: ManoeuvreIntent = {
    kind: 'course',
    goal: { x: 0, y: 0 },
    angle: 0,
    strength: 1,
    isReverse: false,
  };
  private courseAngle = 0;
  private courseShare = 0;
  private side = 1;
  private sightKey: SightKey = 'sight';
  private ticksLeft = 0;
  private hull: HullSteering = { ...IDLE_HULL };
  private track: TrackPoint[] = [];
  private decisionCount = 0;
  // Аптечка поездки, которую танк доводит; null — такой поездки нет.
  private kitTrip: Point | null = null;
  private readonly follower = new PathFollower();

  constructor(
    private readonly settings: ManoeuvreSettings,
    private readonly random: Random,
  ) {}

  get intent(): Readonly<ManoeuvreIntent> {
    return this.intentState;
  }

  // Сколько решений о манёвре принято с начала раунда.
  get decisions(): number {
    return this.decisionCount;
  }

  reset(): void {
    this.ticksLeft = 0;
    this.decisionCount = 0;
    this.side = chance(this.random, SIDE_LEFT_CHANCE) ? 1 : -1;
    this.hull = { ...IDLE_HULL };
    this.track = [];
    this.kitTrip = null;
    this.follower.reset();
  }

  drive(view: BotView, grid: Grid, hasSight: boolean, distance: number): Drive {
    const isStuck = this.isStuck(view.me);
    const sightKey: SightKey = hasSight ? 'sight' : 'hidden';
    this.ticksLeft--;
    if (isStuck) {
      this.side = -this.side;
      this.unstick(view.me);
      return this.followIntent(view, grid);
    }
    const { kind, goal } = this.intentState;
    const isUnstuck = kind === 'unstick' && this.isNear(view.me, goal);
    const isKitGone = kind === 'kit' && !isKitActive(view, goal);
    const isFollowing = kind === 'kit' && !isKitGone && this.kitTrip !== null;
    const isDecisionDue = this.ticksLeft <= 0 || sightKey !== this.sightKey || isUnstuck || isKitGone;
    const isDeciding = isDecisionDue && !isFollowing;
    this.sightKey = sightKey;
    const isHeld = kind === 'unstick' || kind === 'kit';
    if (!isDeciding && isHeld) {
      return this.followIntent(view, grid);
    }
    if (isDeciding) {
      this.decide(view, grid);
    }
    if (this.intentState.kind !== 'kit') {
      this.courseAngle = courseAngleAt(this.settings.courseDecilesDeg[sightKey], distance, this.courseShare);
      this.aimCourse(view, grid);
    }
    if (isDeciding) {
      this.intentState.isReverse = this.wantsReverse(view.me, this.intentState.goal);
    }
    return this.followIntent(view, grid);
  }

  // К центру зоны в любом режиме; решение о манёвре при этом не тратится.
  driveToZone(view: BotView, grid: Grid): Drive {
    this.remember(view.me, true);
    return this.steer(view, this.follower.waypoint(grid, view.me, view.zone, view.tick), false);
  }

  // Выезд на место засады и стоянка на нём — режим «позиция»: поездку к аптечке танк при этом бросает.
  travel(view: BotView, grid: Grid, goal: Point): Drive {
    this.kitTrip = null;
    this.remember(view.me, true);
    return this.steer(view, this.follower.waypoint(grid, view.me, goal, view.tick), false);
  }

  stop(view: BotView): Drive {
    this.kitTrip = null;
    this.remember(view.me, false);
    this.hull = { ...IDLE_HULL };
    return HOLD;
  }

  // Решение: доля угла хода, сила стика, срок до следующего решения и, если на поле есть аптечка, — ехать ли к
  // ближайшей по пути с долей решений своей для случая «я ближе к ней, чем противник» и обратного. Поездку к
  // аптечке, которую танк доводит, решение продолжает — после отъезда от препятствия. Новая поездка с долей
  // kitFollowShare доводится; поездка к той же аптечке, к которой танк уже ехал, — не новая.
  private decide(view: BotView, grid: Grid): void {
    const previousKit = this.intentState.kind === 'kit' ? this.intentState.goal : null;
    this.courseShare = nextRandom(this.random);
    this.intentState.strength = sampleDeciles(this.random, this.settings.stickDeciles);
    this.ticksLeft = this.intervalTicks();
    this.decisionCount++;
    this.intentState.kind = 'course';
    const trip = this.kitTrip;
    if (trip !== null && isKitActive(view, trip)) {
      this.intentState = { ...this.intentState, kind: 'kit', goal: trip, angle: 0 };
      return;
    }
    this.kitTrip = null;
    const kit = nearestKit(view, grid);
    if (kit === null || !chance(this.random, this.settings.kitShare[kit.side])) {
      return;
    }
    this.intentState = { ...this.intentState, kind: 'kit', goal: kit.point, angle: 0 };
    const isNewTrip = previousKit === null || !isSamePoint(previousKit, kit.point);
    if (isNewTrip && chance(this.random, this.settings.kitFollowShare)) {
      this.kitTrip = kit.point;
    }
  }

  private unstick(me: TankView): void {
    const goal = {
      x: me.x - Math.cos(me.heading) * UNSTICK_DISTANCE,
      y: me.y - Math.sin(me.heading) * UNSTICK_DISTANCE,
    };
    this.track = [];
    this.ticksLeft = this.intervalTicks();
    this.intentState = { ...this.intentState, kind: 'unstick', goal, isReverse: this.wantsReverse(me, goal) };
  }

  private intervalTicks(): number {
    return Math.max(1, Math.round(sampleExponential(this.random, this.settings.decisionMeanS) * TICK_RATE));
  }

  // Курс считается каждый тик от текущего пеленга: угол к линии держится, пока танк и противник движутся.
  private aimCourse(view: BotView, grid: Grid): void {
    const { me, enemy } = view;
    const bearing = Math.atan2(enemy.y - me.y, enemy.x - me.x);
    const wanted = this.side * this.courseAngle;
    const reach = this.settings.courseReach;
    const angle = freeCourse(grid, me, bearing, wanted, reach);
    if (angle === null) {
      this.intentState = { ...this.intentState, kind: 'chase', goal: { x: enemy.x, y: enemy.y } };
      return;
    }
    const isAcross = angle !== 0 && Math.abs(angle) < Math.PI;
    if (isAcross && Math.sign(angle) !== this.side) {
      this.side = -this.side;
    }
    this.intentState = { ...this.intentState, kind: 'course', goal: pointAt(me, bearing + angle, reach), angle };
  }

  private wantsReverse(me: TankView, goal: Point): boolean {
    const isBehind = Math.abs(normalizeAngle(Math.atan2(goal.y - me.y, goal.x - me.x) - me.heading)) > Math.PI / 2;
    return this.settings.control === 'mouseKeys' && isBehind && chance(this.random, this.settings.reverseChance);
  }

  private isNear(me: Point, goal: Point): boolean {
    return Math.hypot(goal.x - me.x, goal.y - me.y) < WAYPOINT_REACHED;
  }

  private remember(me: TankView, isPushing: boolean): void {
    this.track.push({ x: me.x, y: me.y, isPushing });
    if (this.track.length > STUCK_TICKS) {
      this.track.shift();
    }
  }

  private isStuck(me: TankView): boolean {
    this.remember(me, Math.abs(this.hull.throttle) > STUCK_THROTTLE);
    const first = this.track[0];
    if (first === undefined || this.track.length < STUCK_TICKS || !this.track.every((point) => point.isPushing)) {
      return false;
    }
    return Math.hypot(me.x - first.x, me.y - first.y) < STUCK_SHIFT;
  }

  // Свободный курс — прямо на его точку; противник, аптечка и отъезд от препятствия — по пути в обход стен.
  private followIntent(view: BotView, grid: Grid): Drive {
    const { kind, goal, isReverse } = this.intentState;
    const waypoint = kind === 'course' ? goal : this.follower.waypoint(grid, view.me, goal, view.tick);
    return this.steer(view, waypoint, isReverse);
  }

  private steer(view: BotView, waypoint: Point, isReverse: boolean): Drive {
    const { me } = view;
    const strength = this.intentState.strength;
    if (this.settings.control === 'mouseKeys') {
      const keys = keysToward(me, waypoint, isReverse);
      this.hull = { ...keys, isReversing: isReverse };
      return keys;
    }
    const angle = Math.atan2(waypoint.y - me.y, waypoint.x - me.x);
    const stick = { dx: Math.cos(angle) * strength, dy: Math.sin(angle) * strength };
    this.hull = steerHull(stick, me.heading, me.stats.turnRate, this.hull, this.settings.pivotThrottle);
    return { throttle: this.hull.throttle, turn: this.hull.turn };
  }
}
