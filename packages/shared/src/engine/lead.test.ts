import { describe, expect, it } from 'vitest';
import { leadPoint, leadShot } from './lead.js';
import type { Point } from './maps.js';
import { NO_CARRY } from './shot.js';

const BULLET_SPEED = 550;

// Формула упреждения Охотника (`packages/bots/src/hunter.ts`) при полном учёте скорости цели.
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
      const actual = leadPoint(me, enemy, { x: enemy.vx, y: enemy.vy }, BULLET_SPEED, NO_CARRY);
      expect(actual.x).toBe(expected.x);
      expect(actual.y).toBe(expected.y);
    }
  });

  it('неподвижная цель — точка упреждения на ней', () => {
    expect(leadPoint({ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 0, y: 0 }, BULLET_SPEED, NO_CARRY)).toEqual({
      x: 500,
      y: 0,
    });
  });

  it('цель едет поперёк — смещение по скорости, время полёта сходится', () => {
    const me = { x: 0, y: 0 };
    const enemy = { x: 500, y: 0 };
    const velocity = { x: 0, y: 150 };
    const lead = leadPoint(me, enemy, velocity, BULLET_SPEED, NO_CARRY);
    expect(lead.x).toBe(500);
    expect(lead.y).toBeGreaterThan(0);
    const flight = Math.hypot(lead.x - me.x, lead.y - me.y) / BULLET_SPEED;
    expect(lead.y / velocity.y).toBeCloseTo(flight, 2);
  });
});

describe('leadShot', () => {
  const me = { x: 0, y: 0 };
  const enemy = { x: 500, y: 0 };

  it('без сноса точка наводки и точка встречи — прежняя точка упреждения', () => {
    const velocity = { x: -40, y: 150 };
    const lead = leadShot(me, enemy, velocity, BULLET_SPEED, NO_CARRY);
    expect(lead.aim).toEqual(leadPoint(me, enemy, velocity, BULLET_SPEED, NO_CARRY));
    expect(lead.meet).toEqual(lead.aim);
  });

  it('стрелок со сносом поперёк, цель стоит: ствол — против сноса, встреча — у цели', () => {
    const carry = { x: 0, y: 176 };
    const lead = leadShot(me, enemy, { x: 0, y: 0 }, BULLET_SPEED, carry);
    expect(lead.aim.y).toBeLessThan(0);
    expect(lead.meet).toEqual(enemy);
  });

  it('встреча — точка наводки плюс снос за время полёта', () => {
    const velocity = { x: 30, y: 120 };
    const carry = { x: -50, y: 100 };
    const lead = leadShot(me, enemy, velocity, BULLET_SPEED, carry);
    const flight = Math.hypot(lead.aim.x - me.x, lead.aim.y - me.y) / BULLET_SPEED;
    expect(lead.meet.x).toBeCloseTo(lead.aim.x + carry.x * flight, 1);
    expect(lead.meet.y).toBeCloseTo(lead.aim.y + carry.y * flight, 1);
  });
});
