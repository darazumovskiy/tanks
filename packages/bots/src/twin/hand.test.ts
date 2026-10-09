import { createRandom, leadPoint, NO_CARRY, normalizeAngle, TICK_RATE, type Point } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { byBand, craftView } from './fixture.js';
import { Hand, type HandSettings } from './hand.js';
import { fromDeciles } from './sampling.js';

const PHONE_DECILES = [0, 6.1, 9.4, 14.3, 18.1, 23.2, 31.3, 44, 54.6, 78.6, 135.2];
const NO_ERROR = byBand(PHONE_DECILES.map(() => 0));
const STILL: Point = { x: 0, y: 0 };
const RADIANS_TO_DEGREES = 180 / Math.PI;
const ME = { x: 300, y: 450 };

function handWith(settings: Partial<HandSettings>, seed = 7): Hand {
  const hand = new Hand(
    { errorDecilesDeg: byBand(PHONE_DECILES), correlationTicks: 1, lagTicks: 0, leadShare: 0, ...settings },
    createRandom(seed),
  );
  hand.reset();
  return hand;
}

// Ошибка желаемого направления к стоящей цели, градусы со знаком.
function errorsAt(hand: Hand, distance: number, ticks: number): number[] {
  const me = craftView({ me: ME, enemy: { x: ME.x + distance, y: ME.y } }).me;
  const target = { x: ME.x + distance, y: ME.y };
  return Array.from({ length: ticks }, () => normalizeAngle(hand.wanted(me, target, STILL)) * RADIANS_TO_DEGREES);
}

function quantile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

function sameSideRuns(errors: readonly number[]): number[] {
  const runs: number[] = [];
  let run = 0;
  let side = 0;
  for (const error of errors) {
    const sign = error >= 0 ? 1 : -1;
    if (run > 0 && sign !== side) {
      runs.push(run);
      run = 0;
    }
    side = sign;
    run++;
  }
  return runs;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

describe('рука на башне', () => {
  it('стоящий противник: модуль ошибки — по децилям профиля, знак — примерно поровну', () => {
    const errors = errorsAt(handWith({}), 400, 20000);
    const sorted = errors.map(Math.abs).sort((a, b) => a - b);

    for (let decile = 1; decile <= 9; decile++) {
      const expected = PHONE_DECILES[decile] ?? 0;
      expect(Math.abs(quantile(sorted, decile / 10) - expected)).toBeLessThan(Math.max(0.5, expected * 0.1));
    }
    expect(errors.filter((error) => error > 0).length / errors.length).toBeCloseTo(0.5, 1);
  });

  it('ошибка — из корзины дистанции до цели: на 200, 400 и 800 свои децили при том же пути процесса', () => {
    const scaled = (factor: number): number[] => PHONE_DECILES.map((value) => value * factor);
    const errorDecilesDeg = { '<300': scaled(1), '300–600': scaled(0.5), '>600': scaled(0.1) };
    const near = errorsAt(handWith({ errorDecilesDeg }), 200, 500);
    const middle = errorsAt(handWith({ errorDecilesDeg }), 400, 500);
    const far = errorsAt(handWith({ errorDecilesDeg }), 800, 500);

    near.forEach((error, tick) => {
      expect(error / 2).toBeCloseTo(middle[tick] ?? Infinity, 6);
      expect(error / 10).toBeCloseTo(far[tick] ?? Infinity, 6);
    });
    expect(Math.max(...near.map(Math.abs))).toBeGreaterThan(10);
  });

  it('память ошибки: длительность по одну сторону растёт с correlationTicks, при 1 — без памяти', () => {
    const means = [1, 4, 12, 30].map((correlationTicks) =>
      mean(sameSideRuns(errorsAt(handWith({ correlationTicks }), 400, 40000))),
    );
    const iid = errorsAt(handWith({ correlationTicks: 1 }), 400, 40000);
    const sameSign = iid.slice(1).filter((error, tick) => Math.sign(error) === Math.sign(iid[tick] ?? 0)).length;

    means.slice(1).forEach((value, index) => {
      expect(value).toBeGreaterThan(1.5 * (means[index] ?? Infinity));
    });
    expect(means[0]).toBeCloseTo(2, 1);
    expect(sameSign / (iid.length - 1)).toBeCloseTo(0.5, 1);
  });

  it('противник перескакивает на новый пеленг: желаемое направление идёт к нему через lagTicks, не раньше', () => {
    const lagTicks = 4;
    const hand = handWith({ errorDecilesDeg: NO_ERROR, lagTicks });
    const me = craftView({ me: ME, enemy: { x: 700, y: 450 } }).me;
    const before = { x: 700, y: 450 };
    const after = { x: 300, y: 850 };
    for (let tick = 0; tick < 10; tick++) {
      hand.wanted(me, before, STILL);
    }
    const seen = Array.from({ length: lagTicks + 1 }, () => hand.wanted(me, after, STILL));

    expect(seen.slice(0, lagTicks).every((angle) => Math.abs(angle) < 1e-9)).toBe(true);
    expect(seen[lagTicks]).toBeCloseTo(Math.PI / 2, 9);
  });

  it('противник едет поперёк: при leadShare 0 ошибка у корпуса, при 1 — у точки упреждения', () => {
    const enemy = { x: 700, y: 450 };
    const velocity = { x: 0, y: 150 };
    const me = craftView({ me: ME, enemy }).me;
    const lead = { x: enemy.x, y: enemy.y };
    for (let i = 0; i < 4; i++) {
      const flight = Math.hypot(lead.x - me.x, lead.y - me.y) / me.stats.bulletSpeed;
      lead.y = enemy.y + velocity.y * flight;
    }
    const toLead = Math.atan2(lead.y - me.y, lead.x - me.x);

    expect(handWith({ errorDecilesDeg: NO_ERROR, leadShare: 0 }).wanted(me, enemy, velocity)).toBeCloseTo(0, 9);
    expect(handWith({ errorDecilesDeg: NO_ERROR, leadShare: 1 }).wanted(me, enemy, velocity)).toBeCloseTo(toLead, 9);
    expect(handWith({ errorDecilesDeg: NO_ERROR, leadShare: 0.5 }).wanted(me, enemy, velocity)).toBeCloseTo(
      toLead / 2,
      9,
    );
  });

  it('упреждение от запоздалой цели — со скоростью того же момента, а не текущей', () => {
    const lagTicks = 3;
    const hand = handWith({ errorDecilesDeg: NO_ERROR, lagTicks, leadShare: 1 });
    const me = craftView({ me: ME, enemy: { x: 700, y: 450 } }).me;
    const target = { x: 700, y: 450 };
    const before = { x: 0, y: 150 };
    hand.wanted(me, target, before);
    const seen = [1, 2, 3].map(() => hand.wanted(me, target, { x: 0, y: -150 }))[lagTicks - 1];
    const lead = leadPoint(me, target, before, me.stats.bulletSpeed, NO_CARRY);

    expect(seen).toBeCloseTo(Math.atan2(lead.y - ME.y, lead.x - ME.x), 9);
  });

  it('отрицательное запаздывание — рука впереди цели: положение продолжается по её скорости', () => {
    const hand = handWith({ errorDecilesDeg: NO_ERROR, lagTicks: -6 });
    const me = craftView({ me: ME, enemy: { x: 700, y: 450 } }).me;
    const velocity = { x: 0, y: 150 };
    const ahead = { x: 700, y: 450 + (velocity.y * 6) / TICK_RATE };

    expect(hand.wanted(me, { x: 700, y: 450 }, velocity)).toBeCloseTo(Math.atan2(ahead.y - ME.y, ahead.x - ME.x), 9);
  });

  it('децили: интерполяция между соседними точками, края — минимум и максимум', () => {
    expect(fromDeciles(PHONE_DECILES, 0)).toBe(0);
    expect(fromDeciles(PHONE_DECILES, 1)).toBe(135.2);
    expect(fromDeciles(PHONE_DECILES, 0.05)).toBeCloseTo(3.05, 9);
  });
});
