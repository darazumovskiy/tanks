import { normalizeAngle, TANK_RADIUS, TICK_RATE, type Side, type Wall } from '@tanks/shared/engine';
import type { TrackedBullet } from './bullets.js';
import { isClear, leadPoint } from './geometry.js';
import { FIGHT_PHASE, type ParsedRound, type Tick } from './logParser.js';
import { roundTo, toDegrees, toRadians } from './numbers.js';

// Противник быстрее 30 единиц в секунду считается движущимся.
export const MOVING_SPEED = 30;
// Наведение: от потери цели (ошибка башни больше 30°) до наведения (меньше 5°).
export const AIM_LOST_RAD = toRadians(30);
export const AIM_DONE_RAD = toRadians(5);
// Ошибка башни меньше 5° — башня смотрит на противника.
export const AIM_GOOD_DEG = 5;
// Доля упреждения не определена, когда точка упреждения почти совпадает с корпусом; вне коридора от −1 до 2 —
// выстрел не по противнику.
export const LEAD_SPAN_MIN_RAD = 0.01;
export const LEAD_FRACTION_MIN = -1;
export const LEAD_FRACTION_MAX = 2;
export const MIN_DISTANCE = 1;

export const SHOT_KIND = {
  standingHit: 'стоящий: в цель',
  standingMiss: 'стоящий: мимо',
  lead: 'упреждение',
  current: 'текущее',
  neither: 'мимо обоих',
} as const;
export type ShotKind = (typeof SHOT_KIND)[keyof typeof SHOT_KIND];

const NEAR_DISTANCE = 300;
export const FAR_DISTANCE = 600;
export const MID_DISTANCE_LABEL = '300–600';
export const DISTANCE_BUCKET_LABELS = ['<300', MID_DISTANCE_LABEL, '>600'] as const;
export type DistanceBucketLabel = (typeof DISTANCE_BUCKET_LABELS)[number];

export interface DistanceBucket {
  low: number;
  high: number;
  label: DistanceBucketLabel;
}

export const DISTANCE_BUCKETS: readonly DistanceBucket[] = [
  { low: 0, high: NEAR_DISTANCE, label: '<300' },
  { low: NEAR_DISTANCE, high: FAR_DISTANCE, label: MID_DISTANCE_LABEL },
  { low: FAR_DISTANCE, high: Infinity, label: '>600' },
];

export function distanceBucketOf(distance: number): DistanceBucketLabel {
  if (distance < NEAR_DISTANCE) {
    return '<300';
  }
  return distance < FAR_DISTANCE ? MID_DISTANCE_LABEL : '>600';
}

export interface ShotRow {
  gt: number;
  round: number;
  distance: number;
  enemySpeed: number;
  isMoving: boolean;
  errCurDeg: number;
  errLeadDeg: number;
  tankSizeDeg: number;
  kind: ShotKind;
  leadFraction: number | null;
  hasLineOfSight: boolean;
  bucket: string;
  isHit: boolean;
  isRicochetHit: boolean;
}

function ticksByGt(round: ParsedRound): Map<number, Tick> {
  return new Map(round.ticks.map((tick) => [tick.gt, tick]));
}

function shotKind(isMoving: boolean, errCur: number, errLead: number, size: number): ShotKind {
  if (!isMoving) {
    return errCur < size ? SHOT_KIND.standingHit : SHOT_KIND.standingMiss;
  }
  const isOnCurrent = errCur < size;
  const isOnLead = errLead < size;
  if (isOnCurrent && isOnLead) {
    return errLead < errCur ? SHOT_KIND.lead : SHOT_KIND.current;
  }
  if (isOnLead) {
    return SHOT_KIND.lead;
  }
  if (isOnCurrent) {
    return SHOT_KIND.current;
  }
  return SHOT_KIND.neither;
}

export function analyzeShots(
  round: ParsedRound,
  bullets: readonly TrackedBullet[],
  side: Side,
  enemy: Side,
  bulletSpeed: number,
  walls: readonly Wall[],
): ShotRow[] {
  const byGt = ticksByGt(round);
  const rows: ShotRow[] = [];
  for (const bullet of bullets) {
    if (bullet.owner !== side) {
      continue;
    }
    const tick = byGt.get(bullet.shot.gt);
    const prev = byGt.get(bullet.shot.gt - 1);
    if (tick === undefined || prev === undefined) {
      continue;
    }
    const me = tick.poses[side];
    const target = tick.poses[enemy];
    const before = prev.poses[enemy];
    const velocity = { x: (target.x - before.x) * TICK_RATE, y: (target.y - before.y) * TICK_RATE };
    const enemySpeed = Math.hypot(velocity.x, velocity.y);
    const distance = Math.hypot(target.x - me.x, target.y - me.y);
    const dirCur = Math.atan2(target.y - me.y, target.x - me.x);
    const lead = leadPoint(me, target, velocity, bulletSpeed);
    const dirLead = Math.atan2(lead.y - me.y, lead.x - me.x);
    const errCur = Math.abs(normalizeAngle(me.turret - dirCur));
    const errLead = Math.abs(normalizeAngle(me.turret - dirLead));
    const size = Math.atan(TANK_RADIUS / Math.max(distance, MIN_DISTANCE));
    const isMoving = enemySpeed > MOVING_SPEED;
    const leadSpan = normalizeAngle(dirLead - dirCur);
    const leadFraction = Math.abs(leadSpan) > LEAD_SPAN_MIN_RAD ? normalizeAngle(me.turret - dirCur) / leadSpan : null;
    const isHit = bullet.outcome === 'bullet';
    rows.push({
      gt: bullet.shot.gt,
      round: round.idx,
      distance: roundTo(distance, 1),
      enemySpeed: roundTo(enemySpeed, 1),
      isMoving,
      errCurDeg: roundTo(toDegrees(errCur), 2),
      errLeadDeg: roundTo(toDegrees(errLead), 2),
      tankSizeDeg: roundTo(toDegrees(size), 2),
      kind: shotKind(isMoving, errCur, errLead, size),
      leadFraction: leadFraction === null ? null : roundTo(leadFraction, 2),
      hasLineOfSight: isClear(walls, me.x, me.y, target.x, target.y),
      bucket: distanceBucketOf(distance),
      isHit,
      isRicochetHit: isHit && bullet.hasBounced,
    });
  }
  return rows;
}

export interface AimTracking {
  errorsWithSightDeg: number[];
  aimTimesTicks: number[];
}

// Ошибка башни по тикам боя при прямой видимости и время от потери цели до наведения.
export function analyzeAimTracking(round: ParsedRound, side: Side, enemy: Side, walls: readonly Wall[]): AimTracking {
  const errorsWithSightDeg: number[] = [];
  const aimTimesTicks: number[] = [];
  let seekingSinceGt: number | null = null;
  for (const tick of round.ticks) {
    if (tick.phase !== FIGHT_PHASE) {
      continue;
    }
    const me = tick.poses[side];
    const target = tick.poses[enemy];
    const error = Math.abs(normalizeAngle(me.turret - Math.atan2(target.y - me.y, target.x - me.x)));
    if (isClear(walls, me.x, me.y, target.x, target.y)) {
      errorsWithSightDeg.push(toDegrees(error));
    }
    if (error > AIM_LOST_RAD && seekingSinceGt === null) {
      seekingSinceGt = tick.gt;
    }
    if (seekingSinceGt !== null && error < AIM_DONE_RAD) {
      aimTimesTicks.push(tick.gt - seekingSinceGt);
      seekingSinceGt = null;
    }
  }
  return { errorsWithSightDeg, aimTimesTicks };
}
