import {
  isSegmentClear,
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
import { distanceBucketOf, type DistanceBucketLabel } from '@tanks/analysis';
import { isFreeAt, PathFollower, WAYPOINT_REACHED, type Grid } from './path.js';
import { chance, sampleDeciles } from './sampling.js';
import { IDLE_HULL, keysToward, steerHull, type HullSteering } from './steering.js';

export type CourseDeciles = Readonly<Record<SightKey, Readonly<Record<DistanceBucketLabel, readonly number[]>>>>;

export interface ManoeuvreSettings {
  control: 'sticks' | 'mouseKeys';
  pivotThrottle: number;
  decisionDecilesS: readonly number[];
  stickDeciles: readonly number[];
  courseDecilesDeg: CourseDeciles;
  reverseChance: number;
}

// course — ход под углом к линии на противника; chase — путём к противнику, когда стена загородила сближение
// или вокруг танка ни одно направление не свободно; unstick — назад от препятствия.
export type IntentKind = 'course' | 'chase' | 'unstick';

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
// Курс смотрит на 150 вперёд; занятый стеной курс отклоняется шагами по 15° в обе стороны, вплоть до обратного.
const COURSE_REACH = 150;
const DEFLECT_STEP = 15 * DEGREES_TO_RADIANS;
const DEFLECT_STEPS = 12;
// Сближение, которое стена отклоняет больше чем на 45°, идёт путём в обход стены.
const APPROACH_DEFLECT_MAX = 45 * DEGREES_TO_RADIANS;
// Запас курса — полкорпуса: центр танка не подходит к стене ближе радиуса, и запас в радиус запер бы
// прижатый к стене танк.
const COURSE_PAD = TANK_RADIUS / 2;
const SIDE_LEFT_CHANCE = 0.5;

interface TrackPoint {
  x: number;
  y: number;
  isPushing: boolean;
}

export function isNearZoneEdge(view: BotView): boolean {
  const distance = Math.hypot(view.me.x - view.zone.x, view.me.y - view.zone.y);
  return distance > view.zone.radius - ZONE_MARGIN;
}

function pointAt(from: Point, direction: number): Point {
  return { x: from.x + Math.cos(direction) * COURSE_REACH, y: from.y + Math.sin(direction) * COURSE_REACH };
}

// Ближайший к желаемому свободный курс: отклонение 0, +15°, −15°, +30°… — свободны отрезок и клетка в его конце.
// null — вокруг танка всё занято.
export function freeCourse(grid: Grid, me: Point, bearing: number, angle: number): number | null {
  for (let step = 0; step <= DEFLECT_STEPS; step++) {
    for (const sign of step === 0 ? [1] : [1, -1]) {
      const candidate = normalizeAngle(angle + sign * step * DEFLECT_STEP);
      const end = pointAt(me, bearing + candidate);
      if (isFreeAt(grid, end) && isSegmentClear(grid.walls, me.x, me.y, end.x, end.y, COURSE_PAD)) {
        return candidate;
      }
    }
  }
  return null;
}

// Режим «манёвр»: в моменты решений танк берёт угол хода к линии на противника из распределения человека для
// своей видимости и корзины дистанции и держит этот угол до следующего решения. Решение — по интервалу профиля
// и при смене видимости. Сторона линии держится, пока стена не отклонит курс на другую сторону или танк
// не упрётся.
export class Manoeuvre {
  private intentState: ManoeuvreIntent = {
    kind: 'course',
    goal: { x: 0, y: 0 },
    angle: 0,
    strength: 1,
    isReverse: false,
  };
  private courseAngle = 0;
  private side = 1;
  private sightKey: SightKey = 'sight';
  private ticksLeft = 0;
  private hull: HullSteering = { ...IDLE_HULL };
  private track: TrackPoint[] = [];
  private readonly follower = new PathFollower();

  constructor(
    private readonly settings: ManoeuvreSettings,
    private readonly random: Random,
  ) {}

  get intent(): Readonly<ManoeuvreIntent> {
    return this.intentState;
  }

  reset(): void {
    this.ticksLeft = 0;
    this.side = chance(this.random, SIDE_LEFT_CHANCE) ? 1 : -1;
    this.hull = { ...IDLE_HULL };
    this.track = [];
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
    const isUnstuck = this.intentState.kind === 'unstick' && this.isNear(view.me, this.intentState.goal);
    const isDeciding = this.ticksLeft <= 0 || sightKey !== this.sightKey || isUnstuck;
    this.sightKey = sightKey;
    if (!isDeciding && this.intentState.kind === 'unstick') {
      return this.followIntent(view, grid);
    }
    if (isDeciding) {
      this.decide(sightKey, distance);
    }
    this.aimCourse(view, grid);
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

  travel(view: BotView, grid: Grid, goal: Point): Drive {
    this.remember(view.me, true);
    return this.steer(view, this.follower.waypoint(grid, view.me, goal, view.tick), false);
  }

  stop(view: BotView): Drive {
    this.remember(view.me, false);
    this.hull = { ...IDLE_HULL };
    return HOLD;
  }

  private decide(sightKey: SightKey, distance: number): void {
    const deciles = this.settings.courseDecilesDeg[sightKey][distanceBucketOf(distance)];
    this.courseAngle = sampleDeciles(this.random, deciles) * DEGREES_TO_RADIANS;
    this.intentState.strength = sampleDeciles(this.random, this.settings.stickDeciles);
    this.ticksLeft = this.intervalTicks();
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
    return Math.max(1, Math.round(sampleDeciles(this.random, this.settings.decisionDecilesS) * TICK_RATE));
  }

  // Курс считается каждый тик от текущего пеленга: угол к линии держится, пока танк и противник движутся.
  private aimCourse(view: BotView, grid: Grid): void {
    const { me, enemy } = view;
    const bearing = Math.atan2(enemy.y - me.y, enemy.x - me.x);
    const wanted = this.side * this.courseAngle;
    const angle = freeCourse(grid, me, bearing, wanted);
    const isApproach = this.courseAngle < Math.PI / 2;
    const isDetour = angle !== null && Math.abs(normalizeAngle(angle - wanted)) > APPROACH_DEFLECT_MAX;
    if (angle === null || (isApproach && isDetour)) {
      this.intentState = { ...this.intentState, kind: 'chase', goal: { x: enemy.x, y: enemy.y } };
      return;
    }
    const isAcross = angle !== 0 && Math.abs(angle) < Math.PI;
    if (isAcross && Math.sign(angle) !== this.side) {
      this.side = -this.side;
    }
    this.intentState = { ...this.intentState, kind: 'course', goal: pointAt(me, bearing + angle), angle };
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

  // Свободный курс — прямо на его точку; противник и отъезд от препятствия — по пути в обход стен.
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
