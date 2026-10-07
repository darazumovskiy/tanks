import { DT } from '@tanks/shared/engine';

export const WATCH_SPEEDS = [1, 2, 4] as const;
export type WatchSpeed = (typeof WATCH_SPEEDS)[number];

const TICK_MS = DT * 1000;
// Потолок шагов движка за кадр: ×4 держится до 15 кадров в секунду; реже — бой замедляется, а не догоняет рывком.
export const MAX_STEPS_PER_FRAME = 8;
// Кадр длиннее — вкладка спала или браузер завис: такой промежуток бой не двигает. Отрицательный промежуток —
// первый кадр с отметкой времени раньше старта — тоже.
export const MAX_FRAME_MS = 250;
// Погрешность сложения долей шага: шестьдесят кадров по 1/60 секунды дают ровно тридцать шагов.
const TICK_EPSILON_MS = 1e-6;

// Фиксированный шаг: время кадра × скорость копится и отдаётся целыми шагами по одному тику движка, остаток переходит
// в следующий кадр. Исход боя зависит только от числа шагов, не от частоты кадров.
export class StepClock {
  private carryMs = 0;

  advance(frameMs: number, speed: number): number {
    if (frameMs < 0 || frameMs > MAX_FRAME_MS) {
      return 0;
    }
    this.carryMs += frameMs * speed;
    const steps = Math.floor((this.carryMs + TICK_EPSILON_MS) / TICK_MS);
    if (steps > MAX_STEPS_PER_FRAME) {
      this.carryMs = 0;
      return MAX_STEPS_PER_FRAME;
    }
    this.carryMs = Math.max(0, this.carryMs - steps * TICK_MS);
    return steps;
  }

  // Доля следующего шага, уже накопленная, — для плавной картинки между двумя тиками.
  get fraction(): number {
    return Math.min(1, this.carryMs / TICK_MS);
  }

  reset(): void {
    this.carryMs = 0;
  }
}
