import { SHOT_INHERIT_MAX_PERCENT } from './constants.js';
import type { Point } from './maps.js';

// Снос — скорость, которую снаряд получает от танка-стрелка в момент выстрела по правилу shotInheritPercent.
export const NO_CARRY: Readonly<Point> = { x: 0, y: 0 };

export interface Carrier {
  heading: number;
  speed: number;
}

export interface ShotFlight {
  dirX: number;
  dirY: number;
  speed: number;
}

export function isCarried(carry: Readonly<Point>): boolean {
  return carry.x !== 0 || carry.y !== 0;
}

// Скорость танка — со знаком: задний ход сносит снаряд назад.
export function shotCarry(carrier: Readonly<Carrier>, inheritPercent: number): Point {
  if (inheritPercent === 0) {
    return { ...NO_CARRY };
  }
  const share = (carrier.speed * inheritPercent) / SHOT_INHERIT_MAX_PERCENT;
  return { x: Math.cos(carrier.heading) * share, y: Math.sin(carrier.heading) * share };
}

// Без сноса — направление ствола и скорость орудия как есть, без пересчёта через сумму: результат побитово прежний.
export function shotFlight(turret: number, bulletSpeed: number, carry: Readonly<Point>): ShotFlight {
  const dx = Math.cos(turret);
  const dy = Math.sin(turret);
  if (!isCarried(carry)) {
    return { dirX: dx, dirY: dy, speed: bulletSpeed };
  }
  const vx = dx * bulletSpeed + carry.x;
  const vy = dy * bulletSpeed + carry.y;
  const speed = Math.hypot(vx, vy);
  return { dirX: vx / speed, dirY: vy / speed, speed };
}
