import { normalizeAngle, type Round } from '@tanks/shared/engine';
import { duelSide } from '@tanks/shared/protocol';
import type { InterpolatedBullet, InterpolatedTank, WorldView } from '../prediction.js';

interface Point {
  x: number;
  y: number;
}

interface TankPose extends Point {
  heading: number;
  turret: number;
}

// Позы танков и снарядов перед шагом движка: картинка идёт от них к позам после шага.
export interface Poses {
  tanks: [TankPose, TankPose];
  bullets: ReadonlyMap<number, Point>;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function lerpAngle(from: number, to: number, t: number): number {
  return normalizeAngle(from + normalizeAngle(to - from) * t);
}

function poseOf(tank: Round['tanks'][number]): TankPose {
  return { x: tank.x, y: tank.y, heading: tank.heading, turret: tank.turret };
}

export function posesOf(round: Round): Poses {
  return {
    tanks: [poseOf(round.tanks[0]), poseOf(round.tanks[1])],
    bullets: new Map(round.bullets.map((bullet) => [bullet.id, { x: bullet.x, y: bullet.y }])),
  };
}

function tankAt(round: Round, side: 0 | 1, from: TankPose | null, t: number): InterpolatedTank {
  const tank = round.tanks[side];
  const base = {
    speed: tank.speed,
    hp: tank.hp,
    maxHp: tank.stats.maxHp,
    isAlive: tank.isAlive,
  };
  if (from === null) {
    return { ...base, ...poseOf(tank) };
  }
  return {
    ...base,
    x: lerp(from.x, tank.x, t),
    y: lerp(from.y, tank.y, t),
    heading: lerpAngle(from.heading, tank.heading, t),
    turret: lerpAngle(from.turret, tank.turret, t),
  };
}

// Кадр между двумя тиками: t — доля пути от поз перед последним шагом к текущим. Снаряд, родившийся на последнем
// шаге, — сразу на своём месте.
export function worldViewAt(round: Round, from: Poses | null, t: number): WorldView {
  const bullets: InterpolatedBullet[] = round.bullets.map((bullet) => {
    const start = from?.bullets.get(bullet.id) ?? null;
    const owner = duelSide(bullet.owner);
    if (start === null) {
      return { id: bullet.id, owner, x: bullet.x, y: bullet.y };
    }
    return { id: bullet.id, owner, x: lerp(start.x, bullet.x, t), y: lerp(start.y, bullet.y, t) };
  });
  return {
    round,
    tanks: [tankAt(round, 0, from?.tanks[0] ?? null, t), tankAt(round, 1, from?.tanks[1] ?? null, t)],
    bullets,
  };
}
