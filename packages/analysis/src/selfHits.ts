import { clamp, normalizeAngle, TICK_RATE, type Side, type Wall } from '@tanks/shared/engine';
import type { Hit, TrackedBullet } from './bullets.js';
import { castRay } from './geometry.js';
import { isClear } from './ruler/geometry.js';
import type { ParsedRound, Tick } from './logParser.js';
import { isAutofireOnAt, type AutofireChange } from './movement.js';
import { roundTo, toDegrees } from './numbers.js';
import { MOVING_SPEED } from './shots.js';

// Стрелял по противнику — ошибка башни меньше 15°; стена «в упор» — ближе 200 единиц.
const AIMED_ERROR_DEG = 15;
const POINT_BLANK_DISTANCE = 200;
// Ехал в стену — скорость направлена вдоль башни больше чем наполовину.
const TOWARD_WALL_COSINE = 0.5;
const MIN_SPEED = 1e-9;

export const SELF_HIT_KIND = {
  aimedWallCloser: 'целился, но стена ближе',
  pointBlankNoTarget: 'в упор в стену без цели',
  farRicochet: 'рикошет издалека вернулся',
} as const;
export type SelfHitKind = (typeof SELF_HIT_KIND)[keyof typeof SELF_HIT_KIND];

export interface SelfHitRow {
  round: number;
  shotGt: number;
  hitGt: number;
  flightTicks: number;
  damage: number;
  wallDistance: number;
  incidenceDeg: number;
  enemyDistance: number;
  errCurDeg: number;
  hasLineOfSight: boolean;
  isAimed: boolean;
  speed: number;
  isTowardWall: boolean;
  isAutofireOn: boolean;
  kind: SelfHitKind;
}

function selfHitKind(isAimed: boolean, wallDistance: number, enemyDistance: number): SelfHitKind {
  if (isAimed && wallDistance < enemyDistance) {
    return SELF_HIT_KIND.aimedWallCloser;
  }
  if (!isAimed && wallDistance < POINT_BLANK_DISTANCE) {
    return SELF_HIT_KIND.pointBlankNoTarget;
  }
  return SELF_HIT_KIND.farRicochet;
}

// Самопопадание сопоставляется последнему своему снаряду с исходом «в себя», выпущенному до него.
function latestUnusedBullet(bullets: readonly TrackedBullet[], used: Set<number>, hitGt: number): TrackedBullet | null {
  let best: TrackedBullet | null = null;
  for (const bullet of bullets) {
    const isCandidate = bullet.shot.gt < hitGt && !used.has(bullet.shot.gt);
    if (isCandidate && (best === null || bullet.shot.gt > best.shot.gt)) {
      best = bullet;
    }
  }
  return best;
}

export function analyzeSelfHits(
  round: ParsedRound,
  bullets: readonly TrackedBullet[],
  hits: readonly Hit[],
  side: Side,
  enemy: Side,
  walls: readonly Wall[],
  autofireChanges: readonly AutofireChange[],
): SelfHitRow[] {
  const byGt = new Map<number, Tick>(round.ticks.map((tick) => [tick.gt, tick]));
  const ownSelfBullets = bullets.filter((bullet) => bullet.owner === side && bullet.outcome === 'self');
  const used = new Set<number>();
  const rows: SelfHitRow[] = [];
  for (const hit of hits) {
    if (hit.cause !== 'self' || hit.victim !== side) {
      continue;
    }
    const bullet = latestUnusedBullet(ownSelfBullets, used, hit.gt);
    if (bullet === null) {
      continue;
    }
    used.add(bullet.shot.gt);
    const tick = byGt.get(bullet.shot.gt);
    const prev = byGt.get(bullet.shot.gt - 1);
    if (tick === undefined || prev === undefined) {
      continue;
    }
    const me = tick.poses[side];
    const target = tick.poses[enemy];
    const dx = Math.cos(me.turret);
    const dy = Math.sin(me.turret);
    const ray = castRay(walls, bullet.shot.x, bullet.shot.y, dx, dy);
    const incidence = toDegrees(Math.acos(clamp(-(dx * ray.nx + dy * ray.ny), -1, 1)));
    const enemyDistance = Math.hypot(target.x - me.x, target.y - me.y);
    const errCur = Math.abs(normalizeAngle(me.turret - Math.atan2(target.y - me.y, target.x - me.x)));
    const vx = (me.x - prev.poses[side].x) * TICK_RATE;
    const vy = (me.y - prev.poses[side].y) * TICK_RATE;
    const speed = Math.hypot(vx, vy);
    const isTowardWall = speed > MOVING_SPEED && (vx * dx + vy * dy) / Math.max(speed, MIN_SPEED) > TOWARD_WALL_COSINE;
    const isAimed = toDegrees(errCur) < AIMED_ERROR_DEG;
    rows.push({
      round: round.idx,
      shotGt: bullet.shot.gt,
      hitGt: hit.gt,
      flightTicks: hit.gt - bullet.shot.gt,
      damage: hit.damage,
      wallDistance: roundTo(ray.distance, 0),
      incidenceDeg: roundTo(incidence, 0),
      enemyDistance: roundTo(enemyDistance, 0),
      errCurDeg: roundTo(toDegrees(errCur), 1),
      hasLineOfSight: isClear(walls, me.x, me.y, target.x, target.y),
      isAimed,
      speed: roundTo(speed, 0),
      isTowardWall,
      isAutofireOn: isAutofireOnAt(autofireChanges, bullet.shot.gt),
      kind: selfHitKind(isAimed, ray.distance, enemyDistance),
    });
  }
  return rows;
}
