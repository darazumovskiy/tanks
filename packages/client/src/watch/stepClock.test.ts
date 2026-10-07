import { describe, expect, it } from 'vitest';
import { MAX_FRAME_MS, MAX_STEPS_PER_FRAME, StepClock, WATCH_SPEEDS } from './stepClock.js';

const MS_PER_S = 1000;
const TICKS_PER_S = 30;

function stepsInSecond(fps: number, speed: number): number {
  const clock = new StepClock();
  let steps = 0;
  for (let frame = 0; frame < fps; frame++) {
    steps += clock.advance(MS_PER_S / fps, speed);
  }
  return steps;
}

describe('шаги движка за кадр', () => {
  it('за секунду — 30 шагов на ×1, 60 на ×2, 120 на ×4 при 60 и 30 кадрах', () => {
    for (const fps of [60, 30]) {
      for (const speed of WATCH_SPEEDS) {
        expect(stepsInSecond(fps, speed), `${String(fps)} к/с, ×${String(speed)}`).toBe(TICKS_PER_S * speed);
      }
    }
  });

  it('остаток кадра переходит в следующий: доля шага растёт, шаги не теряются', () => {
    const clock = new StepClock();
    expect(clock.advance(20, 1)).toBe(0);
    expect(clock.fraction).toBeCloseTo(0.6);
    expect(clock.advance(20, 1)).toBe(1);
    expect(clock.fraction).toBeCloseTo(0.2);
  });

  it('просадка кадров: не больше потолка шагов, накопленное выбрасывается', () => {
    const clock = new StepClock();
    expect(clock.advance(MAX_FRAME_MS, 4)).toBe(MAX_STEPS_PER_FRAME);
    expect(clock.fraction).toBe(0);
  });

  it('промежуток длиннее предела — вкладка спала: бой не двигается', () => {
    const clock = new StepClock();
    expect(clock.advance(MAX_FRAME_MS + 1, 4)).toBe(0);
    expect(clock.advance(MS_PER_S, 1)).toBe(0);
  });

  it('сброс обнуляет накопленное', () => {
    const clock = new StepClock();
    clock.advance(30, 1);
    clock.reset();
    expect(clock.fraction).toBe(0);
    expect(clock.advance(10, 1)).toBe(0);
  });
});
