import { describe, expect, it } from 'vitest';
import { leadPoint } from './lead.js';
import type { Point } from './maps.js';

const BULLET_SPEED = 550;

// Формула упреждения Охотника (`packages/server/src/bots/hunter.ts`) при полном учёте скорости цели.
function hunterLead(me: Point, enemy: Point & { vx: number; vy: number }, bulletSpeed: number): Point {
  let x = enemy.x;
  let y = enemy.y;
  for (let i = 0; i < 4; i++) {
    const flight = Math.hypot(x - me.x, y - me.y) / bulletSpeed;
    x = enemy.x + enemy.vx * flight;
    y = enemy.y + enemy.vy * flight;
  }
  return { x, y };
}

describe('leadPoint', () => {
  it('совпадает с формулой Охотника на разных положениях и скоростях', () => {
    const cases = [
      { me: { x: 140, y: 450 }, enemy: { x: 900, y: 300, vx: 0, vy: 150 } },
      { me: { x: 800, y: 100 }, enemy: { x: 300, y: 700, vx: -120, vy: 60 } },
      { me: { x: 1400, y: 800 }, enemy: { x: 1000, y: 400, vx: 176, vy: 0 } },
    ];
    for (const { me, enemy } of cases) {
      const expected = hunterLead(me, enemy, BULLET_SPEED);
      const actual = leadPoint(me, enemy, { x: enemy.vx, y: enemy.vy }, BULLET_SPEED);
      expect(actual.x).toBeCloseTo(expected.x, 9);
      expect(actual.y).toBeCloseTo(expected.y, 9);
    }
  });

  it('неподвижная цель — точка упреждения на ней', () => {
    expect(leadPoint({ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 0, y: 0 }, BULLET_SPEED)).toEqual({ x: 500, y: 0 });
  });

  it('цель едет поперёк — смещение по скорости, время полёта сходится', () => {
    const me = { x: 0, y: 0 };
    const enemy = { x: 500, y: 0 };
    const velocity = { x: 0, y: 150 };
    const lead = leadPoint(me, enemy, velocity, BULLET_SPEED);
    expect(lead.x).toBe(500);
    expect(lead.y).toBeGreaterThan(0);
    const flight = Math.hypot(lead.x - me.x, lead.y - me.y) / BULLET_SPEED;
    expect(lead.y / velocity.y).toBeCloseTo(flight, 2);
  });
});
