import {
  isSegmentWithin,
  isTraceReturning,
  leadPoint,
  TANK_HIT_RADIUS,
  traceShot,
  type Field,
  type Point,
  type ShotSegment,
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

export interface AimPathInput {
  shooter: Point;
  bulletSpeed: number;
  // Живые чужие танки в кадре; пусто — целей нет, линия без состояний.
  targets: readonly AimLineEnemy[];
  hasLeadHint: boolean;
}

export interface AimLineInput extends AimPathInput {
  field: Field;
  shooter: Point & { turret: number };
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

// Точка упреждения по курсу и скорости противника; `null`, пока он слишком медленный, чтобы она отличалась от корпуса.
export function enemyLeadPoint(shooter: Point, enemy: AimLineEnemy, bulletSpeed: number): Point | null {
  if (Math.abs(enemy.speed) < LEAD_MIN_SPEED) {
    return null;
  }
  const velocity = { x: Math.cos(enemy.heading) * enemy.speed, y: Math.sin(enemy.heading) * enemy.speed };
  return leadPoint(shooter, enemy, velocity, bulletSpeed);
}

interface SegmentHit<T> {
  target: T;
  mark: AimMark;
}

// Из точек, в круг которых входит отрезок, — та, куда он входит раньше всех: её корпус принимает снаряд первым.
// Отрезка нет (хвоста после отскока нет) — точки нет.
function firstOnSegment<T extends Point>(segment: ShotSegment | null, targets: readonly T[]): SegmentHit<T> | null {
  if (segment === null) {
    return null;
  }
  let first: SegmentHit<T> | null = null;
  let firstDistance = Infinity;
  for (const target of targets) {
    if (!isSegmentWithin(segment, target, TANK_HIT_RADIUS)) {
      continue;
    }
    const mark = entryMark(segment, target, TANK_HIT_RADIUS);
    const distance = Math.hypot(mark.x - segment.x1, mark.y - segment.y1);
    if (distance < firstDistance) {
      first = { target, mark };
      firstDistance = distance;
    }
  }
  return first;
}

// Первый танк на пути снаряда — на первом отрезке, иначе на хвосте после отскока; `null` — путь ни в кого не входит.
export function firstTargetOnPath<T extends Point>(path: readonly ShotSegment[], targets: readonly T[]): T | null {
  const [first, returning] = path;
  if (first === undefined) {
    return null;
  }
  const onFirst = firstOnSegment(first, targets);
  if (onFirst !== null) {
    return onFirst.target;
  }
  return firstOnSegment(tailOf(returning), targets)?.target ?? null;
}

function leadPoints(input: AimPathInput): Point[] {
  if (!input.hasLeadHint) {
    return [];
  }
  return input.targets.flatMap((target) => enemyLeadPoint(input.shooter, target, input.bulletSpeed) ?? []);
}

export function computeAimLine(input: AimLineInput): AimLine {
  const { field, shooter, bulletSpeed } = input;
  return aimLineOnPath(traceShot(field, shooter, shooter.turret, bulletSpeed).segments, input);
}

// Упреждение считается по прямой, поэтому проверяется только на первом отрезке: после отскока путь длиннее
// прямой и формула не годится. Цель на первом отрезке принимает снаряд на себя — возврат в свой корпус не грозит.
export function aimLineOnPath(path: readonly ShotSegment[], input: AimPathInput): AimLine {
  const { shooter, targets } = input;
  const [first, returning] = path;
  if (first === undefined) {
    return EMPTY;
  }
  const onFirst = firstOnSegment(first, targets);
  if (onFirst !== null) {
    return { segments: [cutAt(first, onFirst.mark)], state: 'onTarget', mark: onFirst.mark, isReturning: false };
  }
  const tail = tailOf(returning);
  const shown = tail === null ? [first] : [first, tail];
  const isReturning = isTraceReturning(path, shooter, null);
  const onTail = firstOnSegment(tail, targets);
  if (onTail !== null) {
    return { segments: shown, state: 'onTarget', mark: onTail.mark, isReturning };
  }
  const lead = firstOnSegment(first, leadPoints(input));
  if (lead !== null) {
    return { segments: shown, state: 'lead', mark: lead.mark, isReturning };
  }
  return { segments: shown, state: 'none', mark: null, isReturning };
}
