import { normalizeAngle, TANK_RADIUS, TICK_RATE, type Side, type Wall } from '@tanks/shared/engine';
import { wallClearance } from './geometry.js';
import {
  FIGHT_PHASE,
  field,
  parseAction,
  parseKeyValues,
  type ClientLine,
  type ParsedRound,
  type Tick,
} from './logParser.js';
import { median, pct, roundTo, toRadians } from './numbers.js';
import { MOVING_SPEED } from './shots.js';

export const FULL_THROTTLE = 0.9;
// Ось команды считается тронутой, если отклонена больше чем на 0,05.
export const AXIS_TOUCH = 0.05;
const AXIS_FULL = 0.99;
const AXIS_LOW = 0.3;
const AXIS_HIGH = 0.7;
// Смена хода считается завершённой, когда скорость вдоль корпуса в новую сторону превысила 30.
const REVERSAL_SETTLED_SPEED = 30;
// Резкая остановка: со скорости больше 120 до меньше 30 не дольше чем за 10 тиков.
const SHARP_STOP_FROM = 120;
const SHARP_STOP_TO = 30;
const SHARP_STOP_WINDOW_TICKS = 10;
// Разворот: непрерывный поворот корпуса одного знака больше 90° с перерывами не длиннее трёх тиков.
const TURN_AROUND_RAD = toRadians(90);
const TURN_STEP_EPSILON = 0.002;
const TURN_GAP_MAX_TICKS = 3;
// Кайтинг и кружение — на скорости выше 80; кружение — дистанция за тик меняется меньше чем на 2, а направление
// на противника — больше чем на 0,6°.
export const KITE_SPEED = 80;
export const CIRCLE_RADIAL_PER_TICK = 2;
export const CIRCLE_BEARING_PER_TICK = toRadians(0.6);
const NEAR_WALL = 150;
// У стены — зазор между корпусом и стеной меньше 36.
const TOUCHING_WALL_GAP = 36;
export const TOUCHING_WALL = TANK_RADIUS + TOUCHING_WALL_GAP;
const HALF_TURN = Math.PI / 2;
const SECONDS_PER_MINUTE = 60;
const INPUT_PREFIX = 'in seq=';
const INPUT_SKIP_PREFIX = 'in skip';
const AUTOFIRE_PREFIX = 'autofire on=';
const AUTOFIRE_ON = 'on=1';
const ROUND_START_PREFIX = 'net roundstart';
const SECOND_PREFIX = 'sec ';

export const AXIS_BUCKETS = ['0', '|v|<0.3', '0.3–0.7', '0.7–0.99', '±1'] as const;
export type AxisBucket = (typeof AXIS_BUCKETS)[number];
export const AXES = ['throttle', 'turn', 'turretTurn'] as const;
export type Axis = (typeof AXES)[number];
export type AxisHistogram = Record<Axis, Map<AxisBucket, number>>;

export function axisBucket(value: number): AxisBucket {
  const magnitude = Math.abs(value);
  if (value === 0) {
    return '0';
  }
  if (magnitude >= AXIS_FULL) {
    return '±1';
  }
  if (magnitude < AXIS_LOW) {
    return '|v|<0.3';
  }
  if (magnitude < AXIS_HIGH) {
    return '0.3–0.7';
  }
  return '0.7–0.99';
}

function emptyHistogram(): AxisHistogram {
  return { throttle: new Map(), turn: new Map(), turretTurn: new Map() };
}

function bump(histogram: Map<AxisBucket, number>, bucket: AxisBucket, amount = 1): void {
  histogram.set(bucket, (histogram.get(bucket) ?? 0) + amount);
}

function mergeHistogram(into: AxisHistogram, from: AxisHistogram): void {
  for (const axis of AXES) {
    for (const [bucket, amount] of from[axis]) {
      bump(into[axis], bucket, amount);
    }
  }
}

export interface MovementTotals {
  fightTicks: number;
  fullThrottleTicks: number;
  reverseTicks: number;
  idleTicks: number;
  silentTicks: number;
  batchedInputs: number;
  speedSum: number;
  speedSamples: number;
  histogram: AxisHistogram;
}

export function emptyMovement(): MovementTotals {
  return {
    fightTicks: 0,
    fullThrottleTicks: 0,
    reverseTicks: 0,
    idleTicks: 0,
    silentTicks: 0,
    batchedInputs: 0,
    speedSum: 0,
    speedSamples: 0,
    histogram: emptyHistogram(),
  };
}

export function addMovement(into: MovementTotals, from: MovementTotals): void {
  into.fightTicks += from.fightTicks;
  into.fullThrottleTicks += from.fullThrottleTicks;
  into.reverseTicks += from.reverseTicks;
  into.idleTicks += from.idleTicks;
  into.silentTicks += from.silentTicks;
  into.batchedInputs += from.batchedInputs;
  into.speedSum += from.speedSum;
  into.speedSamples += from.speedSamples;
  mergeHistogram(into.histogram, from.histogram);
}

interface TickPair {
  prev: Tick;
  cur: Tick;
}

// Пары соседних тиков, где текущий — тик боя.
function fightPairs(round: ParsedRound): TickPair[] {
  const pairs: TickPair[] = [];
  for (let i = 1; i < round.ticks.length; i++) {
    const prev = round.ticks[i - 1];
    const cur = round.ticks[i];
    if (prev !== undefined && cur?.phase === FIGHT_PHASE) {
      pairs.push({ prev, cur });
    }
  }
  return pairs;
}

function speedOf(prev: Tick, cur: Tick, side: Side): { vx: number; vy: number; speed: number } {
  const vx = (cur.poses[side].x - prev.poses[side].x) * TICK_RATE;
  const vy = (cur.poses[side].y - prev.poses[side].y) * TICK_RATE;
  return { vx, vy, speed: Math.hypot(vx, vy) };
}

export function analyzeMovement(round: ParsedRound, side: Side): MovementTotals {
  const totals = emptyMovement();
  totals.fightTicks = round.ticks.filter((tick) => tick.phase === FIGHT_PHASE).length;
  for (const { prev, cur } of fightPairs(round)) {
    const action = cur.actions[side];
    if (Math.abs(action.throttle) > FULL_THROTTLE) {
      totals.fullThrottleTicks++;
    }
    if (action.throttle < -AXIS_TOUCH) {
      totals.reverseTicks++;
    }
    if (action.throttle === 0 && action.turn === 0) {
      totals.idleTicks++;
    }
    if (cur.isSilent[side]) {
      totals.silentTicks++;
    }
    totals.batchedInputs += Math.max(0, cur.inputs[side] - 1);
    totals.speedSum += speedOf(prev, cur, side).speed;
    totals.speedSamples++;
    bump(totals.histogram.throttle, axisBucket(action.throttle));
    bump(totals.histogram.turn, axisBucket(action.turn));
    bump(totals.histogram.turretTurn, axisBucket(action.turretTurn));
  }
  return totals;
}

export interface DynamicsTotals {
  ticks: number;
  throttleFlips: number;
  flipSettleTicks: number[];
  sharpStops: number;
  turnarounds: number;
  turnaroundTicks: number[];
  kiteTicks: number;
  circleTicks: number;
  nearWallTicks: number;
  touchingWallTicks: number;
  distanceSum: number;
  reverseSpeedTicks: number;
}

export function emptyDynamics(): DynamicsTotals {
  return {
    ticks: 0,
    throttleFlips: 0,
    flipSettleTicks: [],
    sharpStops: 0,
    turnarounds: 0,
    turnaroundTicks: [],
    kiteTicks: 0,
    circleTicks: 0,
    nearWallTicks: 0,
    touchingWallTicks: 0,
    distanceSum: 0,
    reverseSpeedTicks: 0,
  };
}

export function addDynamics(into: DynamicsTotals, from: DynamicsTotals): void {
  into.ticks += from.ticks;
  into.throttleFlips += from.throttleFlips;
  into.flipSettleTicks.push(...from.flipSettleTicks);
  into.sharpStops += from.sharpStops;
  into.turnarounds += from.turnarounds;
  into.turnaroundTicks.push(...from.turnaroundTicks);
  into.kiteTicks += from.kiteTicks;
  into.circleTicks += from.circleTicks;
  into.nearWallTicks += from.nearWallTicks;
  into.touchingWallTicks += from.touchingWallTicks;
  into.distanceSum += from.distanceSum;
  into.reverseSpeedTicks += from.reverseSpeedTicks;
}

function signOf(value: number, threshold: number): number {
  if (value > threshold) {
    return 1;
  }
  if (value < -threshold) {
    return -1;
  }
  return 0;
}

function countSharpStops(speeds: readonly number[]): number {
  let stops = 0;
  let i = 0;
  while (i < speeds.length) {
    const speed = speeds[i] ?? 0;
    if (speed > SHARP_STOP_FROM) {
      const window = speeds.slice(i + 1, i + 1 + SHARP_STOP_WINDOW_TICKS);
      if (window.some((value) => value < SHARP_STOP_TO)) {
        stops++;
        i += SHARP_STOP_WINDOW_TICKS;
        continue;
      }
    }
    i++;
  }
  return stops;
}

// Поворот корпуса одного знака с короткими перерывами; закрывается сменой знака или длинной паузой.
class TurnTracker {
  private sign = 0;
  private accumulated = 0;
  private length = 0;
  private gap = 0;

  constructor(private readonly totals: DynamicsTotals) {}

  step(deltaHeading: number): void {
    const sign = signOf(deltaHeading, TURN_STEP_EPSILON);
    const isSameDirection = sign !== 0 && (this.sign === 0 || sign === this.sign);
    if (isSameDirection) {
      this.sign = sign;
      this.accumulated += deltaHeading;
      this.length += 1 + this.gap;
      this.gap = 0;
      return;
    }
    const isShortPause = sign === 0 && this.sign !== 0 && this.gap < TURN_GAP_MAX_TICKS;
    if (isShortPause) {
      this.gap++;
      return;
    }
    this.close();
    this.sign = sign;
    this.accumulated = sign === 0 ? 0 : deltaHeading;
    this.length = sign === 0 ? 0 : 1;
    this.gap = 0;
  }

  close(): void {
    if (Math.abs(this.accumulated) > TURN_AROUND_RAD) {
      this.totals.turnarounds++;
      this.totals.turnaroundTicks.push(this.length);
    }
  }
}

// Резкость и манёвренность движения стороны за раунд: смены хода, остановки, развороты, кайтинг, кружение.
export function analyzeDynamics(round: ParsedRound, side: Side, enemy: Side, walls: readonly Wall[]): DynamicsTotals {
  const totals = emptyDynamics();
  const pairs = fightPairs(round);
  totals.ticks = pairs.length;
  const speeds: number[] = [];
  const turn = new TurnTracker(totals);
  let lastThrottleSign = 0;
  let pendingFlip: { gt: number; sign: number } | null = null;
  let prevDistance: number | null = null;
  let prevBearing = 0;
  for (const { prev, cur } of pairs) {
    const action = cur.actions[side];
    const me = cur.poses[side];
    const target = cur.poses[enemy];
    const { vx, vy, speed } = speedOf(prev, cur, side);
    const along = vx * Math.cos(me.heading) + vy * Math.sin(me.heading);
    speeds.push(speed);
    if (along < -MOVING_SPEED) {
      totals.reverseSpeedTicks++;
    }

    const throttleSign = signOf(action.throttle, AXIS_TOUCH);
    if (throttleSign !== 0 && lastThrottleSign !== 0 && throttleSign !== lastThrottleSign) {
      totals.throttleFlips++;
      pendingFlip = { gt: cur.gt, sign: throttleSign };
    }
    if (throttleSign !== 0) {
      lastThrottleSign = throttleSign;
    }
    if (pendingFlip !== null && along * pendingFlip.sign > REVERSAL_SETTLED_SPEED) {
      totals.flipSettleTicks.push(cur.gt - pendingFlip.gt);
      pendingFlip = null;
    }

    turn.step(normalizeAngle(me.heading - prev.poses[side].heading));

    const distance = Math.hypot(target.x - me.x, target.y - me.y);
    const bearing = Math.atan2(target.y - me.y, target.x - me.x);
    totals.distanceSum += distance;
    if (speed > KITE_SPEED) {
      const velocityAngle = Math.atan2(vy, vx);
      const isTurretBack = Math.abs(normalizeAngle(me.turret - velocityAngle)) > HALF_TURN;
      const isEnemyBack = Math.abs(normalizeAngle(bearing - velocityAngle)) > HALF_TURN;
      if (isTurretBack && isEnemyBack) {
        totals.kiteTicks++;
      }
      const isRadiusSteady = prevDistance !== null && Math.abs(distance - prevDistance) < CIRCLE_RADIAL_PER_TICK;
      if (isRadiusSteady && Math.abs(normalizeAngle(bearing - prevBearing)) > CIRCLE_BEARING_PER_TICK) {
        totals.circleTicks++;
      }
    }
    prevDistance = distance;
    prevBearing = bearing;
    const clearance = wallClearance(walls, me.x, me.y);
    if (clearance < NEAR_WALL) {
      totals.nearWallTicks++;
    }
    if (clearance < TOUCHING_WALL) {
      totals.touchingWallTicks++;
    }
  }
  turn.close();
  totals.sharpStops = countSharpStops(speeds);
  return totals;
}

export interface ClientInputs {
  inputs: number;
  skipped_inputs: number;
  turn_sign_flips: number;
  turn_full_flips: number;
  turn_changes: number;
  throttle_changes: number;
  minutes: number;
  turn_sign_flips_per_min: number | null;
  turn_full_flips_per_min: number | null;
  turn_changes_pct: number | null;
  throttle_changes_pct: number | null;
}

// Клиентские строки `in`: дрожание поворота между ±1 и смены желаемого курса.
// Шаг `in skip` — тик без команды: идёт во время игры, но не в смены поворота и газа.
export function analyzeClientInputs(lines: readonly ClientLine[]): ClientInputs {
  let inputs = 0;
  let skippedInputs = 0;
  let turnSignFlips = 0;
  let turnFullFlips = 0;
  let turnChanges = 0;
  let throttleChanges = 0;
  let prevTurn: number | null = null;
  let prevThrottle = 0;
  for (const line of lines) {
    if (line.text.startsWith(INPUT_SKIP_PREFIX)) {
      skippedInputs++;
      continue;
    }
    if (!line.text.startsWith(INPUT_PREFIX)) {
      continue;
    }
    const action = parseAction(field(parseKeyValues(line.text), 'a'));
    if (action === null) {
      continue;
    }
    inputs++;
    if (prevTurn !== null) {
      if (action.turn !== prevTurn) {
        turnChanges++;
      }
      if (action.throttle !== prevThrottle) {
        throttleChanges++;
      }
      if (action.turn * prevTurn < 0) {
        turnSignFlips++;
        if (Math.abs(action.turn) >= AXIS_FULL && Math.abs(prevTurn) >= AXIS_FULL) {
          turnFullFlips++;
        }
      }
    }
    prevTurn = action.turn;
    prevThrottle = action.throttle;
  }
  const minutes = (inputs + skippedInputs) / TICK_RATE / SECONDS_PER_MINUTE;
  const perMinute = (value: number): number | null => (minutes === 0 ? null : roundTo(value / minutes, 1));
  return {
    inputs,
    skipped_inputs: skippedInputs,
    turn_sign_flips: turnSignFlips,
    turn_full_flips: turnFullFlips,
    turn_changes: turnChanges,
    throttle_changes: throttleChanges,
    minutes: roundTo(minutes, 2),
    turn_sign_flips_per_min: perMinute(turnSignFlips),
    turn_full_flips_per_min: perMinute(turnFullFlips),
    turn_changes_pct: pct(turnChanges, inputs),
    throttle_changes_pct: pct(throttleChanges, inputs),
  };
}

export interface AutofireChange {
  gt: number;
  isOn: boolean;
}

// Новый раунд выключает авто-огонь на клиенте — в журнале это строка `net roundstart`.
export function autofireChangesOf(lines: readonly ClientLine[]): AutofireChange[] {
  const changes: AutofireChange[] = [];
  for (const line of lines) {
    if (line.text.startsWith(ROUND_START_PREFIX)) {
      changes.push({ gt: line.gt, isOn: false });
      continue;
    }
    if (line.text.startsWith(AUTOFIRE_PREFIX)) {
      changes.push({ gt: line.gt, isOn: line.text.endsWith(AUTOFIRE_ON) });
    }
  }
  return changes;
}

export function isAutofireOnAt(changes: readonly AutofireChange[], gt: number): boolean {
  let isOn = false;
  for (const change of changes) {
    if (change.gt > gt) {
      break;
    }
    isOn = change.isOn;
  }
  return isOn;
}

export interface ClientSummary {
  rtt_median: number | null;
  fps_median: number | null;
  autofire_on_count: number;
}

export function clientSummary(lines: readonly ClientLine[]): ClientSummary {
  const rtts: number[] = [];
  const fps: number[] = [];
  let autofireOnCount = 0;
  for (const line of lines) {
    if (line.text.startsWith(SECOND_PREFIX)) {
      const values = parseKeyValues(line.text);
      rtts.push(Number(field(values, 'rtt')));
      fps.push(Number(field(values, 'fps')));
      continue;
    }
    if (line.text.startsWith(`${AUTOFIRE_PREFIX}1`)) {
      autofireOnCount++;
    }
  }
  return { rtt_median: median(rtts), fps_median: median(fps), autofire_on_count: autofireOnCount };
}
