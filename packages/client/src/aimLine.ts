import {
  isSegmentWithin,
  isTraceReturning,
  leadPoint,
  TANK_HIT_RADIUS,
  traceShot,
  type Point,
  type ShotSegment,
  type Wall,
} from '@tanks/shared/engine';

// Хвост после отскока — ровно столько, чтобы показать направление рикошета, не рисуя второй путь через поле.
export const AIM_LINE_TAIL = 180;
// Медленнее — точка упреждения совпадает с корпусом, состояние «упреждаю» теряет смысл.
export const LEAD_MIN_SPEED = 30;

export type AimLineState = 'none' | 'onTarget' | 'lead';

export interface AimLineEnemy extends Point {
  heading: number;
  speed: number;
}

export interface AimLineInput {
  walls: readonly Wall[];
  shooter: Point & { turret: number };
  bulletSpeed: number;
  // Живой противник в кадре; `null` — цели нет, линия без состояний.
  enemy: AimLineEnemy | null;
  hasLeadHint: boolean;
}

// Засечка на пути: где снаряд входит в круг цели, и направление пути в этой точке.
export interface AimMark extends Point {
  angle: number;
}

export interface AimLine {
  segments: ShotSegment[];
  state: AimLineState;
  mark: AimMark | null;
  isReturning: boolean;
}

const EMPTY: AimLine = { segments: [], state: 'none', mark: null, isReturning: false };

function segmentAngle(segment: ShotSegment): number {
  return Math.atan2(segment.y2 - segment.y1, segment.x2 - segment.x1);
}

// Первая точка отрезка внутри круга; вызывать только когда `isSegmentWithin` подтвердил пересечение.
function entryMark(segment: ShotSegment, center: Point, radius: number): AimMark {
  const angle = segmentAngle(segment);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const length = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
  const fx = segment.x1 - center.x;
  const fy = segment.y1 - center.y;
  const b = fx * ux + fy * uy;
  const discriminant = Math.max(0, b * b - (fx * fx + fy * fy - radius * radius));
  const t = Math.min(length, Math.max(0, -b - Math.sqrt(discriminant)));
  return { x: segment.x1 + ux * t, y: segment.y1 + uy * t, angle };
}

function cutAt(segment: ShotSegment, end: Point): ShotSegment {
  return { x1: segment.x1, y1: segment.y1, x2: end.x, y2: end.y };
}

function tailOf(returning: ShotSegment | undefined): ShotSegment | null {
  if (returning === undefined) {
    return null;
  }
  const length = Math.hypot(returning.x2 - returning.x1, returning.y2 - returning.y1);
  if (length <= AIM_LINE_TAIL) {
    return returning;
  }
  const angle = segmentAngle(returning);
  return {
    x1: returning.x1,
    y1: returning.y1,
    x2: returning.x1 + Math.cos(angle) * AIM_LINE_TAIL,
    y2: returning.y1 + Math.sin(angle) * AIM_LINE_TAIL,
  };
}

function leadTarget(input: AimLineInput): Point | null {
  const { enemy } = input;
  if (!input.hasLeadHint || enemy === null || Math.abs(enemy.speed) < LEAD_MIN_SPEED) {
    return null;
  }
  const velocity = { x: Math.cos(enemy.heading) * enemy.speed, y: Math.sin(enemy.heading) * enemy.speed };
  return leadPoint(input.shooter, enemy, velocity, input.bulletSpeed);
}

// Упреждение считается по прямой, поэтому проверяется только на первом отрезке: после отскока путь длиннее
// прямой и формула не годится.
export function computeAimLine(input: AimLineInput): AimLine {
  const { walls, shooter, bulletSpeed, enemy } = input;
  const { segments } = traceShot(walls, shooter, shooter.turret, bulletSpeed);
  const first = segments[0];
  if (first === undefined) {
    return EMPTY;
  }
  if (enemy !== null && isSegmentWithin(first, enemy, TANK_HIT_RADIUS)) {
    const mark = entryMark(first, enemy, TANK_HIT_RADIUS);
    return { segments: [cutAt(first, mark)], state: 'onTarget', mark, isReturning: false };
  }
  const tail = tailOf(segments[1]);
  const shown = tail === null ? [first] : [first, tail];
  const isReturning = isTraceReturning(segments, shooter, enemy);
  if (enemy !== null && tail !== null && isSegmentWithin(tail, enemy, TANK_HIT_RADIUS)) {
    return { segments: shown, state: 'onTarget', mark: entryMark(tail, enemy, TANK_HIT_RADIUS), isReturning };
  }
  const lead = leadTarget(input);
  if (lead !== null && isSegmentWithin(first, lead, TANK_HIT_RADIUS)) {
    return { segments: shown, state: 'lead', mark: entryMark(first, lead, TANK_HIT_RADIUS), isReturning };
  }
  return { segments: shown, state: 'none', mark: null, isReturning };
}
