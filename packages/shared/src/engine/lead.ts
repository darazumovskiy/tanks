import type { Point } from './maps.js';

// Время полёта зависит от точки, точка — от времени полёта; четыре приближения сходятся, пока цель заметно
// медленнее снаряда. Та же формула, что у ботов, — помощники на клиенте и сервере целятся одинаково.
const LEAD_ITERATIONS = 4;

// aim — куда навести ствол; meet — где цель встретит снаряд на поле.
export interface LeadSolution {
  aim: Point;
  meet: Point;
}

// Снаряд со сносом carry встречает цель так же, как снаряд без сноса — цель со скоростью velocity − carry: ствол
// наводится по этой относительной скорости, а встреча — там, куда цель доедет сама, на пути снаряда.
export function leadShot(
  shooter: Point,
  target: Point,
  velocity: Point,
  bulletSpeed: number,
  carry: Readonly<Point>,
): LeadSolution {
  const relativeX = velocity.x - carry.x;
  const relativeY = velocity.y - carry.y;
  let x = target.x;
  let y = target.y;
  let flight = 0;
  for (let i = 0; i < LEAD_ITERATIONS; i++) {
    flight = Math.hypot(x - shooter.x, y - shooter.y) / bulletSpeed;
    x = target.x + relativeX * flight;
    y = target.y + relativeY * flight;
  }
  return { aim: { x, y }, meet: { x: target.x + velocity.x * flight, y: target.y + velocity.y * flight } };
}

export function leadPoint(
  shooter: Point,
  target: Point,
  velocity: Point,
  bulletSpeed: number,
  carry: Readonly<Point>,
): Point {
  return leadShot(shooter, target, velocity, bulletSpeed, carry).aim;
}
