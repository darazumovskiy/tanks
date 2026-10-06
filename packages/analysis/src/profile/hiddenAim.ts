import {
  isSegmentWithin,
  normalizeAngle,
  TANK_HIT_RADIUS,
  traceShot,
  type BattleMap,
  type Point,
} from '@tanks/shared/engine';
import { isClear } from '../geometry.js';
import { gridPath } from './cover.js';

// Куда человек может вести башню, когда противника не видно: пеленг сквозь стену, точка выхода — первая видимая
// точка пути противника ко мне, рикошет в противника, место, где противник был виден последний раз.
export const HIDDEN_AIM_TARGETS = ['bearing', 'exit', 'ricochet', 'lastSeen'] as const;
export type HiddenAimTarget = (typeof HIDDEN_AIM_TARGETS)[number];
export type HiddenAimDirections = Record<HiddenAimTarget, number[]>;

// Башня на цели — ближе 10° к одному из её направлений.
export const HIDDEN_AIM_WINDOW = (10 * Math.PI) / 180;
// Направления рикошета перебираются через 2°, доля круга для случайной башни — через 1°.
const RICOCHET_STEPS = 180;
const COVERAGE_STEPS = 360;
const FULL_TURN = 2 * Math.PI;

export function bearingOf(from: Point, to: Point): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

export function exitPointOf(map: BattleMap, me: Point, enemy: Point): Point | null {
  return gridPath(map, enemy, me).find((point) => isClear(map.walls, me.x, me.y, point.x, point.y)) ?? null;
}

// Направления башни, при которых снаряд после единственного отскока проходит через противника, не задев его до
// отскока и не вернувшись в стрелка.
export function ricochetAnglesOf(map: BattleMap, me: Point, enemy: Point, bulletSpeed: number): number[] {
  const angles: number[] = [];
  for (let step = 0; step < RICOCHET_STEPS; step++) {
    const angle = normalizeAngle((FULL_TURN * step) / RICOCHET_STEPS);
    const [first, second] = traceShot(map, me, angle, bulletSpeed).segments;
    if (first === undefined || second === undefined || isSegmentWithin(first, enemy, TANK_HIT_RADIUS)) {
      continue;
    }
    if (isSegmentWithin(second, enemy, TANK_HIT_RADIUS) && !isSegmentWithin(second, me, TANK_HIT_RADIUS)) {
      angles.push(angle);
    }
  }
  return angles;
}

function gapOf(from: number, to: number): number {
  return Math.abs(normalizeAngle(from - to));
}

// Рикошет в противника, ближайший к near; null — рикошета нет.
export function ricochetAngleOf(
  map: BattleMap,
  me: Point,
  enemy: Point,
  bulletSpeed: number,
  near: number,
): number | null {
  let best: number | null = null;
  for (const angle of ricochetAnglesOf(map, me, enemy, bulletSpeed)) {
    if (best === null || gapOf(angle, near) < gapOf(best, near)) {
      best = angle;
    }
  }
  return best;
}

// Направления целей из точки me; у цели, которой нет (нет пути, рикошета, противник не был виден), — пусто.
export function hiddenAimDirections(
  map: BattleMap,
  me: Point,
  enemy: Point,
  lastSeen: Point | null,
  bulletSpeed: number,
): HiddenAimDirections {
  const exit = exitPointOf(map, me, enemy);
  return {
    bearing: [bearingOf(me, enemy)],
    exit: exit === null ? [] : [bearingOf(me, exit)],
    ricochet: ricochetAnglesOf(map, me, enemy, bulletSpeed),
    lastSeen: lastSeen === null ? [] : [bearingOf(me, lastSeen)],
  };
}

function isOn(turret: number, angles: readonly number[]): boolean {
  return angles.some((angle) => gapOf(turret, angle) < HIDDEN_AIM_WINDOW);
}

// Цель, в окне которой башня, если это окно ни с одной другой целью не пересекается в этой точке; null — башня
// ни на одной цели или сразу на нескольких. Совпадающие цели не отличить, поэтому их общая зона не в счёт.
export function soleHiddenAim(turret: number, directions: HiddenAimDirections): HiddenAimTarget | null {
  const on = HIDDEN_AIM_TARGETS.filter((target) => isOn(turret, directions[target]));
  return on.length === 1 ? (on[0] ?? null) : null;
}

// Доля круга, где башня, направленная наугад, была бы на одной этой цели: столько дала бы случайная башня.
export function soleChance(directions: HiddenAimDirections): Record<HiddenAimTarget, number> {
  const counts = Object.fromEntries(HIDDEN_AIM_TARGETS.map((target) => [target, 0])) as Record<HiddenAimTarget, number>;
  for (let step = 0; step < COVERAGE_STEPS; step++) {
    const sole = soleHiddenAim(normalizeAngle((FULL_TURN * step) / COVERAGE_STEPS), directions);
    if (sole !== null) {
      counts[sole]++;
    }
  }
  for (const target of HIDDEN_AIM_TARGETS) {
    counts[target] /= COVERAGE_STEPS;
  }
  return counts;
}
