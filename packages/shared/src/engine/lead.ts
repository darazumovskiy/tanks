import type { Point } from './maps.js';

// Время полёта зависит от точки, точка — от времени полёта; четыре приближения сходятся, пока цель заметно
// медленнее снаряда. Та же формула, что у ботов, — помощники на клиенте и сервере целятся одинаково.
const LEAD_ITERATIONS = 4;

export function leadPoint(shooter: Point, target: Point, velocity: Point, bulletSpeed: number): Point {
  let x = target.x;
  let y = target.y;
  for (let i = 0; i < LEAD_ITERATIONS; i++) {
    const flight = Math.hypot(x - shooter.x, y - shooter.y) / bulletSpeed;
    x = target.x + velocity.x * flight;
    y = target.y + velocity.y * flight;
  }
  return { x, y };
}
