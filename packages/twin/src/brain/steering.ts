import { clamp, DT, normalizeAngle, TURRET_RATE, type Point, type TankView } from '@tanks/shared/engine';

// steerHull и aimTurret — копия клиентских: клиент — браузерный пакет, двойник рулит так же, как палец игрока.
const PIVOT_ANGLE = (60 * Math.PI) / 180;
const TURN_HOLD_ANGLE = (160 * Math.PI) / 180;
const REVERSE_EXIT_ANGLE = (70 * Math.PI) / 180;

export interface StickVector {
  dx: number;
  dy: number;
}

export interface HullSteering {
  throttle: number;
  turn: number;
  isReversing: boolean;
}

export const IDLE_HULL: Readonly<HullSteering> = { throttle: 0, turn: 0, isReversing: false };

function stickMagnitude(stick: StickVector): number {
  return Math.min(1, Math.hypot(stick.dx, stick.dy));
}

export function steerHull(
  stick: StickVector,
  heading: number,
  turnRate: number,
  previous: Readonly<HullSteering>,
  pivotThrottle: number,
): HullSteering {
  const wanted = Math.atan2(stick.dy, stick.dx);
  const tailError = normalizeAngle(wanted - heading - Math.PI);
  const isReversing = previous.isReversing && Math.abs(tailError) <= REVERSE_EXIT_ANGLE;
  const error = isReversing ? tailError : normalizeAngle(wanted - heading);
  const turn = turnTowards(error, turnRate, previous.turn);
  const drive = stickMagnitude(stick) * Math.max(pivotThrottle, pivotFactor(Math.abs(error)));
  return { throttle: isReversing ? -drive : drive, turn, isReversing };
}

function turnTowards(error: number, turnRate: number, previousTurn: number): number {
  const rate = clamp(Math.abs(error) / (turnRate * DT), 0, 1);
  const isHolding = Math.abs(error) > TURN_HOLD_ANGLE && previousTurn !== 0;
  const sign = isHolding ? Math.sign(previousTurn) : Math.sign(error);
  return sign * rate;
}

function pivotFactor(deviation: number): number {
  const scaled = Math.min(Math.PI / 2, (deviation * (Math.PI / 2)) / PIVOT_ANGLE);
  return Math.cos(scaled);
}

export function aimTurret(wanted: number, turret: number): number {
  const diff = normalizeAngle(wanted - turret);
  return clamp(diff / (TURRET_RATE * DT), -1, 1);
}

// Клавиши компьютера: оси только −1, 0, 1. Поворот — если курс расходится с точкой больше, чем танк
// поворачивает за тик; задним ходом к точке ведёт корма.
export function keysToward(me: TankView, point: Point, isReverse: boolean): Pick<HullSteering, 'throttle' | 'turn'> {
  const wanted = Math.atan2(point.y - me.y, point.x - me.x);
  const course = isReverse ? me.heading + Math.PI : me.heading;
  const error = normalizeAngle(wanted - course);
  const deadZone = me.stats.turnRate * DT;
  const turn = Math.abs(error) > deadZone ? Math.sign(error) : 0;
  return { throttle: isReverse ? -1 : 1, turn };
}
