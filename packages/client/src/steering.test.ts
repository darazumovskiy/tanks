import { DT, TURRET_RATE } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { aimTurret, steerHull, type StickVector } from './steering.js';

const TURN_RATE = 2;
const TURN_PER_TICK = TURN_RATE * DT;

function stickAt(angle: number, magnitude = 1): StickVector {
  return { dx: Math.cos(angle) * magnitude, dy: Math.sin(angle) * magnitude };
}

const deg = (value: number): number => (value * Math.PI) / 180;

describe('steerHull', () => {
  it('стик по курсу — полный газ без поворота', () => {
    expect(steerHull(stickAt(0), 0, TURN_RATE, false, false)).toEqual({ throttle: 1, turn: 0, isReversing: false });
  });

  it('стик под 90° — поворот на месте в сторону стика', () => {
    const right = steerHull(stickAt(deg(90)), 0, TURN_RATE, false, false);
    expect(right.turn).toBe(1);
    expect(right.throttle).toBeCloseTo(0, 6);
    const left = steerHull(stickAt(deg(-90)), 0, TURN_RATE, false, false);
    expect(left.turn).toBe(-1);
  });

  it('малое расхождение — дробный поворот, доводящий до курса за тик', () => {
    const steering = steerHull(stickAt(0.03), 0, TURN_RATE, false, false);
    expect(steering.turn).toBeCloseTo(0.03 / TURN_PER_TICK, 6);
    expect(steering.throttle).toBeCloseTo(Math.cos(0.03), 6);
  });

  it('45° при половинном отклонении — газ 0,5·cos 45°, поворот полный', () => {
    const steering = steerHull(stickAt(deg(45), 0.5), 0, TURN_RATE, false, false);
    expect(steering.throttle).toBeCloseTo(0.5 * Math.cos(deg(45)), 6);
    expect(steering.turn).toBe(1);
  });

  it('стик против курса — задний ход без поворота', () => {
    const steering = steerHull(stickAt(Math.PI), 0, TURN_RATE, false, false);
    expect(steering.isReversing).toBe(true);
    expect(steering.throttle).toBeCloseTo(-1, 6);
    expect(steering.turn).toBeCloseTo(0, 6);
  });

  it('100° из переднего хода — остаёмся на переднем', () => {
    const steering = steerHull(stickAt(deg(100)), 0, TURN_RATE, false, false);
    expect(steering.isReversing).toBe(false);
    expect(steering.turn).toBe(1);
    expect(steering.throttle).toBe(0);
  });

  it('100° с быстрым задним ходом — задний ход', () => {
    const steering = steerHull(stickAt(deg(100)), 0, TURN_RATE, false, true);
    expect(steering.isReversing).toBe(true);
    expect(steering.throttle).toBeLessThan(0);
    expect(steering.turn).toBe(-1);
  });

  it('80° из переднего хода — передний в обоих режимах', () => {
    expect(steerHull(stickAt(deg(80)), 0, TURN_RATE, false, false).isReversing).toBe(false);
    expect(steerHull(stickAt(deg(80)), 0, TURN_RATE, false, true).isReversing).toBe(false);
  });

  it('80° из заднего хода — остаёмся на заднем, доворачиваем кормой (в обоих режимах)', () => {
    const steering = steerHull(stickAt(deg(80)), 0, TURN_RATE, true, false);
    expect(steering.isReversing).toBe(true);
    expect(steering.turn).toBe(-1);
    expect(steering.throttle).toBeCloseTo(0, 6);
    expect(steerHull(stickAt(deg(80)), 0, TURN_RATE, true, true).isReversing).toBe(true);
  });

  it('60° из заднего хода — переход на передний (в обоих режимах)', () => {
    const steering = steerHull(stickAt(deg(60)), 0, TURN_RATE, true, false);
    expect(steering.isReversing).toBe(false);
    expect(steering.turn).toBe(1);
    expect(steering.throttle).toBeCloseTo(0.5, 6);
    expect(steerHull(stickAt(deg(60)), 0, TURN_RATE, true, true).isReversing).toBe(false);
  });

  it('переход через ±π — короткий доворот, не круг', () => {
    const steering = steerHull(stickAt(-3.13), 3.13, TURN_RATE, false, false);
    const error = 2 * Math.PI - 6.26;
    expect(steering.turn).toBeCloseTo(error / TURN_PER_TICK, 6);
    expect(steering.isReversing).toBe(false);
    expect(steering.throttle).toBeCloseTo(Math.cos(error), 6);
  });

  it('учитывает скорость поворота танка', () => {
    const slow = steerHull(stickAt(0.02), 0, 1, false, false);
    const fast = steerHull(stickAt(0.02), 0, 4, false, false);
    expect(slow.turn).toBeCloseTo(0.02 / (1 * DT), 6);
    expect(fast.turn).toBeCloseTo(0.02 / (4 * DT), 6);
  });
});

describe('aimTurret', () => {
  it('далёкая цель — предельная скорость в сторону цели', () => {
    expect(aimTurret(deg(90), 0)).toBe(1);
    expect(aimTurret(deg(-90), 0)).toBe(-1);
  });

  it('цель в пределах тика — дробная скорость', () => {
    expect(aimTurret(0.05, 0)).toBeCloseTo(0.05 / (TURRET_RATE * DT), 6);
  });

  it('переход через ±π — короткий путь', () => {
    expect(aimTurret(-3.1, 3.1)).toBeGreaterThan(0);
  });
});
