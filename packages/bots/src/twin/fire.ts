import { distanceBucketOf, type FireContext } from '@tanks/analysis/ruler';
import { TICK_RATE, type Random } from '@tanks/shared/engine';
import { chance, sampleDeciles } from './sampling.js';

export interface FireSettings {
  noStartPauseShare: number;
  startPauseDecilesS: readonly number[];
  releaseMeanS: number;
  longPausePerMinute: number;
  longPauseDecilesS: readonly number[];
  holdShare: Readonly<Record<FireContext, number>>;
  coverHoldShare: number;
}

// Контекст огня: видимость и корзина дистанции, как у модуля метрик; в позиции — свой контекст.
export type FireSituation = FireContext | 'cover';

const TICKS_PER_MINUTE = 60 * TICK_RATE;

export function fireContextOf(hasSight: boolean, distance: number): FireContext {
  return `${hasSight ? 'visible' : 'hidden'}|${distanceBucketOf(distance)}`;
}

function ticksOf(seconds: number): number {
  return Math.max(1, Math.round(seconds * TICK_RATE));
}

// Намерение стрелять — «палец на стике башни». После стартовой паузы включение и выключение — марковский
// процесс со средней длиной отпускания releaseMeanS; вероятности подобраны так, что доля зажатости в контексте
// равна holdShare. Поверх — поток длинных пауз.
export class FireIntent {
  private startTicksLeft = 0;
  private longPauseTicksLeft = 0;
  private isHeld = false;
  private hasStarted = false;

  constructor(
    private readonly settings: FireSettings,
    private readonly random: Random,
  ) {}

  reset(): void {
    const hasNoPause = chance(this.random, this.settings.noStartPauseShare);
    this.startTicksLeft = hasNoPause ? 0 : ticksOf(sampleDeciles(this.random, this.settings.startPauseDecilesS));
    this.longPauseTicksLeft = 0;
    this.isHeld = false;
    this.hasStarted = false;
  }

  tick(situation: FireSituation): boolean {
    if (this.startTicksLeft > 0) {
      this.startTicksLeft--;
      return false;
    }
    if (!this.hasStarted) {
      this.hasStarted = true;
      this.isHeld = true;
      return true;
    }
    if (this.longPauseTicksLeft > 0) {
      this.longPauseTicksLeft--;
      this.isHeld = this.longPauseTicksLeft === 0;
      return false;
    }
    if (chance(this.random, this.settings.longPausePerMinute / TICKS_PER_MINUTE)) {
      this.longPauseTicksLeft = ticksOf(sampleDeciles(this.random, this.settings.longPauseDecilesS)) - 1;
      this.isHeld = this.longPauseTicksLeft === 0;
      return false;
    }
    const { press, release } = this.switchChances(this.shareOf(situation));
    this.isHeld = this.isHeld ? !chance(this.random, release) : chance(this.random, press);
    return this.isHeld;
  }

  private shareOf(situation: FireSituation): number {
    return situation === 'cover' ? this.settings.coverHoldShare : this.settings.holdShare[situation];
  }

  // Доля зажатости h = press / (press + release); press = 1 / длина отпускания, пока release не больше 1.
  private switchChances(share: number): { press: number; release: number } {
    if (share >= 1) {
      return { press: 1, release: 0 };
    }
    if (share <= 0) {
      return { press: 0, release: 1 };
    }
    const press = 1 / ticksOf(this.settings.releaseMeanS);
    const release = (press * (1 - share)) / share;
    if (release <= 1) {
      return { press, release };
    }
    return { press: share / (1 - share), release: 1 };
  }
}
