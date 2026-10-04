import { DT, TURRET_RATE } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import {
  aimTurret,
  IDLE_HULL,
  isBehind,
  PIVOT_ANGLE,
  steerHull,
  type HullSteering,
  type StickVector,
} from './steering.js';

const TURN_RATE = 2;
const TURN_PER_TICK = TURN_RATE * DT;
const REVERSING: Readonly<HullSteering> = { throttle: -1, turn: 0, isReversing: true };

function stickAt(angle: number, magnitude = 1): StickVector {
  return { dx: Math.cos(angle) * magnitude, dy: Math.sin(angle) * magnitude };
}

const deg = (value: number): number => (value * Math.PI) / 180;
// Коэффициент разворота: косинус, сжатый к нулю на PIVOT_ANGLE.
const pivot = (angle: number): number => Math.cos((angle * (Math.PI / 2)) / PIVOT_ANGLE);

describe('steerHull — передний ход', () => {
  it('стик по курсу — полный газ без поворота', () => {
    expect(steerHull(stickAt(0), 0, TURN_RATE, IDLE_HULL)).toEqual({ throttle: 1, turn: 0, isReversing: false });
  });

  it('малое расхождение — дробный поворот, доводящий до курса за тик, газ по сжатому косинусу', () => {
    const steering = steerHull(stickAt(0.03), 0, TURN_RATE, IDLE_HULL);
    expect(steering.turn).toBeCloseTo(0.03 / TURN_PER_TICK, 6);
    expect(steering.throttle).toBeCloseTo(pivot(0.03), 6);
  });

  it('30° — газ cos 45°, поворот полный', () => {
    const steering = steerHull(stickAt(deg(30)), 0, TURN_RATE, IDLE_HULL);
    expect(steering.throttle).toBeCloseTo(Math.cos(deg(45)), 6);
    expect(steering.turn).toBe(1);
  });

  it('45° при половинном отклонении — газ 0,5·cos 67,5°', () => {
    const steering = steerHull(stickAt(deg(45), 0.5), 0, TURN_RATE, IDLE_HULL);
    expect(steering.throttle).toBeCloseTo(0.5 * Math.cos(deg(67.5)), 6);
    expect(steering.turn).toBe(1);
  });

  it('60°, 90°, 120° — разворот на месте в сторону стика, газа нет', () => {
    for (const angle of [60, 90, 120]) {
      const right = steerHull(stickAt(deg(angle)), 0, TURN_RATE, IDLE_HULL);
      expect(right.throttle).toBeCloseTo(0, 6);
      expect(right.turn).toBe(1);
      expect(right.isReversing).toBe(false);
      expect(steerHull(stickAt(deg(-angle)), 0, TURN_RATE, IDLE_HULL).turn).toBe(-1);
    }
  });

  it('стик против курса — разворот, не задний ход', () => {
    const steering = steerHull(stickAt(Math.PI), 0, TURN_RATE, IDLE_HULL);
    expect(steering.isReversing).toBe(false);
    expect(steering.throttle).toBeCloseTo(0, 6);
    expect(Math.abs(steering.turn)).toBe(1);
  });

  it('почти против курса — сторона поворота удерживается с прошлого тика', () => {
    const wasTurningLeft: HullSteering = { throttle: 0, turn: -1, isReversing: false };
    expect(steerHull(stickAt(deg(175)), 0, TURN_RATE, wasTurningLeft).turn).toBe(-1);
    expect(steerHull(stickAt(deg(175)), 0, TURN_RATE, IDLE_HULL).turn).toBe(1);
    expect(steerHull(stickAt(deg(150)), 0, TURN_RATE, wasTurningLeft).turn).toBe(1);
  });

  it('переход через ±π — короткий доворот, не круг', () => {
    const steering = steerHull(stickAt(-3.13), 3.13, TURN_RATE, IDLE_HULL);
    const error = 2 * Math.PI - 6.26;
    expect(steering.turn).toBeCloseTo(error / TURN_PER_TICK, 6);
    expect(steering.isReversing).toBe(false);
    expect(steering.throttle).toBeCloseTo(pivot(error), 6);
  });

  it('учитывает скорость поворота танка', () => {
    const slow = steerHull(stickAt(0.02), 0, 1, IDLE_HULL);
    const fast = steerHull(stickAt(0.02), 0, 4, IDLE_HULL);
    expect(slow.turn).toBeCloseTo(0.02 / (1 * DT), 6);
    expect(fast.turn).toBeCloseTo(0.02 / (4 * DT), 6);
  });
});

describe('steerHull — задний ход', () => {
  it('стик на корме — полный задний ход без поворота', () => {
    const steering = steerHull(stickAt(Math.PI), 0, TURN_RATE, REVERSING);
    expect(steering.isReversing).toBe(true);
    expect(steering.throttle).toBeCloseTo(-1, 6);
    expect(steering.turn).toBeCloseTo(0, 6);
  });

  it('стик в 40° от кормы — газ −cos 60°, корма доворачивает к пальцу', () => {
    const steering = steerHull(stickAt(deg(180 - 40)), 0, TURN_RATE, REVERSING);
    expect(steering.isReversing).toBe(true);
    expect(steering.throttle).toBeCloseTo(-0.5, 6);
    expect(steering.turn).toBe(-1);
  });

  it('стик в 70° от кормы — порог выхода включительно, остаёмся на заднем', () => {
    const steering = steerHull(stickAt(deg(180 - 70)), 0, TURN_RATE, REVERSING);
    expect(steering.isReversing).toBe(true);
    expect(steering.throttle).toBeCloseTo(0, 6);
  });

  it('стик в 80° от кормы — передний ход, нос к пальцу', () => {
    const steering = steerHull(stickAt(deg(100)), 0, TURN_RATE, REVERSING);
    expect(steering.isReversing).toBe(false);
    expect(steering.throttle).toBeCloseTo(0, 6);
    expect(steering.turn).toBe(1);
  });
});

describe('isBehind', () => {
  it('палец не дальше 60° от кормы', () => {
    expect(isBehind(stickAt(Math.PI), 0)).toBe(true);
    expect(isBehind(stickAt(deg(130)), 0)).toBe(true);
    expect(isBehind(stickAt(deg(110)), 0)).toBe(false);
    expect(isBehind(stickAt(0), 0)).toBe(false);
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
