import { clamp, DT, normalizeAngle, TURRET_RATE } from '@tanks/shared/engine';

const REVERSE_ENTER_ANGLE = (110 * Math.PI) / 180;
// С быстрым задним ходом назад едет всё, что за спиной, без разворота на месте.
const QUICK_REVERSE_ENTER_ANGLE = (90 * Math.PI) / 180;
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

export function stickMagnitude(stick: StickVector): number {
  return Math.min(1, Math.hypot(stick.dx, stick.dy));
}

// Активный стик задаёт желаемый курс; поворот доводит до него за тик, газ падает с ростом угла доворота.
// Задний ход включается при большом расхождении и выключается при малом — с зазором, чтобы режим не дрожал.
export function steerHull(
  stick: StickVector,
  heading: number,
  turnRate: number,
  isReversing: boolean,
  hasQuickReverse: boolean,
): HullSteering {
  const wanted = Math.atan2(stick.dy, stick.dx);
  const forwardError = normalizeAngle(wanted - heading);
  const isReversingNow = nextReverseMode(Math.abs(forwardError), isReversing, hasQuickReverse);
  const error = isReversingNow ? normalizeAngle(forwardError + Math.PI) : forwardError;
  const turn = clamp(error / (turnRate * DT), -1, 1);
  const drive = stickMagnitude(stick) * Math.max(0, Math.cos(error));
  return { throttle: isReversingNow ? -drive : drive, turn, isReversing: isReversingNow };
}

function nextReverseMode(deviation: number, isReversing: boolean, hasQuickReverse: boolean): boolean {
  if (isReversing) {
    return deviation > REVERSE_EXIT_ANGLE;
  }
  const enterAngle = hasQuickReverse ? QUICK_REVERSE_ENTER_ANGLE : REVERSE_ENTER_ANGLE;
  return deviation > enterAngle;
}

// Скорость поворота башни, доводящая её до желаемого угла за тик, но не быстрее предела движка.
export function aimTurret(wanted: number, turret: number): number {
  const diff = normalizeAngle(wanted - turret);
  return clamp(diff / (TURRET_RATE * DT), -1, 1);
}
