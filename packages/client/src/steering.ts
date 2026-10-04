import { clamp, DT, normalizeAngle, TURRET_RATE } from '@tanks/shared/engine';

// Дальше этого расхождения с желаемым курсом газа нет: танк тормозит и разворачивается на месте, а не дугой.
export const PIVOT_ANGLE = (60 * Math.PI) / 180;
// Палец почти против курса — сторона поворота берётся с прошлого тика, чтобы у 180° танк не дрожал.
const TURN_HOLD_ANGLE = (160 * Math.PI) / 180;
// Бросок включает задний ход, только если палец встал не дальше этого от кормы.
const REVERSE_ENTER_ANGLE = (60 * Math.PI) / 180;
const REVERSE_EXIT_ANGLE = (70 * Math.PI) / 180;

// Отклонение стика: координаты экрана (y вниз), длина не больше 1.
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

export function stickMagnitude(stick: StickVector): number {
  return Math.min(1, Math.hypot(stick.dx, stick.dy));
}

// Активный стик задаёт желаемый курс; танк крутится к нему коротким путём и едет вперёд, куда бы палец ни стоял.
// Сам стик задний ход не включает: он приходит снаружи через `previous.isReversing` (жест броска) и держится,
// пока палец не ушёл далеко от кормы.
export function steerHull(
  stick: StickVector,
  heading: number,
  turnRate: number,
  previous: Readonly<HullSteering>,
): HullSteering {
  const wanted = Math.atan2(stick.dy, stick.dx);
  const tailError = normalizeAngle(wanted - heading - Math.PI);
  const isReversing = previous.isReversing && Math.abs(tailError) <= REVERSE_EXIT_ANGLE;
  const error = isReversing ? tailError : normalizeAngle(wanted - heading);
  const turn = turnTowards(error, turnRate, previous.turn);
  const drive = stickMagnitude(stick) * pivotFactor(Math.abs(error));
  return { throttle: isReversing ? -drive : drive, turn, isReversing };
}

// Палец позади танка: отсюда бросок переводит на задний ход.
export function isBehind(stick: StickVector, heading: number): boolean {
  const wanted = Math.atan2(stick.dy, stick.dx);
  return Math.abs(normalizeAngle(wanted - heading - Math.PI)) <= REVERSE_ENTER_ANGLE;
}

function turnTowards(error: number, turnRate: number, previousTurn: number): number {
  const rate = clamp(Math.abs(error) / (turnRate * DT), 0, 1);
  const isHolding = Math.abs(error) > TURN_HOLD_ANGLE && previousTurn !== 0;
  const sign = isHolding ? Math.sign(previousTurn) : Math.sign(error);
  return sign * rate;
}

// Косинус, сжатый так, чтобы обнулиться на PIVOT_ANGLE вместо 90°.
function pivotFactor(deviation: number): number {
  const scaled = Math.min(Math.PI / 2, (deviation * (Math.PI / 2)) / PIVOT_ANGLE);
  return Math.cos(scaled);
}

// Скорость поворота башни, доводящая её до желаемого угла за тик, но не быстрее предела движка.
export function aimTurret(wanted: number, turret: number): number {
  const diff = normalizeAngle(wanted - turret);
  return clamp(diff / (TURRET_RATE * DT), -1, 1);
}
