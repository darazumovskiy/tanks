import type { FireContext } from '@tanks/analysis/ruler';
import { createRandom, TICK_RATE } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { FireIntent, fireContextOf, type FireSettings } from './fire.js';

const START_DECILES_S = [0.1, 0.5, 1.6, 2.1, 2.5, 4.4, 4.8, 5.2, 6, 8.7, 21.6];
const HOLD: Record<FireContext, number> = {
  'visible|<300': 0.78,
  'visible|300–600': 0.91,
  'visible|>600': 0.68,
  'hidden|<300': 0.71,
  'hidden|300–600': 0.83,
  'hidden|>600': 0.27,
};

function settingsWith(overrides: Partial<FireSettings> = {}): FireSettings {
  return {
    noStartPauseShare: 0,
    startPauseDecilesS: START_DECILES_S,
    releaseMeanS: 0.55,
    longPausePerMinute: 0,
    longPauseDecilesS: [2, 2.3, 2.6, 2.8, 3.3, 3.6, 3.7, 3.9, 4.2, 6.4, 8.3],
    holdShare: HOLD,
    coverHoldShare: 0.95,
    ...overrides,
  };
}

function firstHeldTick(intent: FireIntent): number {
  for (let tick = 0; ; tick++) {
    if (intent.tick('visible|300–600')) {
      return tick;
    }
  }
}

describe('огонь двойника', () => {
  it('начало раунда: без огня всю стартовую паузу; длительности за много раундов — по распределению профиля', () => {
    const intent = new FireIntent(settingsWith(), createRandom(3));
    const pauses: number[] = [];
    for (let round = 0; round < 4000; round++) {
      intent.reset();
      pauses.push(firstHeldTick(intent) / TICK_RATE);
    }
    pauses.sort((a, b) => a - b);

    for (let decile = 1; decile <= 9; decile++) {
      const expected = START_DECILES_S[decile] ?? 0;
      const measured = pauses[Math.floor((decile / 10) * pauses.length)] ?? 0;
      expect(Math.abs(measured - expected)).toBeLessThan(Math.max(0.1, expected * 0.1));
    }
  });

  it('доля раундов без стартовой паузы: огонь с первого тика боя', () => {
    const intent = new FireIntent(settingsWith({ noStartPauseShare: 0.3 }), createRandom(5));
    let immediate = 0;
    for (let round = 0; round < 4000; round++) {
      intent.reset();
      immediate += firstHeldTick(intent) === 0 ? 1 : 0;
    }

    expect(immediate / 4000).toBeCloseTo(0.3, 1);
  });

  it('доли зажатости по контексту: на длинном прогоне — holdShare в пределах 2 пунктов', () => {
    const contexts = [...(Object.keys(HOLD) as FireContext[]), 'cover'] as const;
    for (const context of contexts) {
      const intent = new FireIntent(settingsWith({ noStartPauseShare: 1 }), createRandom(11));
      intent.reset();
      let held = 0;
      const ticks = 200000;
      for (let tick = 0; tick < ticks; tick++) {
        held += intent.tick(context) ? 1 : 0;
      }
      const expected = context === 'cover' ? 0.95 : HOLD[context];
      expect(Math.abs(held / ticks - expected), context).toBeLessThan(0.02);
    }
  });

  it('доля 0 — огня нет, доля 1 — огонь всё время; очень высокая и очень низкая доли держатся при отрезке в тик', () => {
    const shares = { ...HOLD, 'visible|<300': 0, 'visible|>600': 1, 'hidden|>600': 0.995, 'hidden|<300': 0.005 };
    const intent = new FireIntent(
      settingsWith({ noStartPauseShare: 1, holdShare: shares, releaseMeanS: 0.5 }),
      createRandom(2),
    );
    intent.reset();
    intent.tick('visible|<300');
    const ticks = 100000;
    let never = 0;
    let always = 0;
    let high = 0;
    for (let tick = 0; tick < ticks; tick++) {
      never += intent.tick('visible|<300') ? 1 : 0;
    }
    for (let tick = 0; tick < ticks; tick++) {
      always += intent.tick('visible|>600') ? 1 : 0;
    }
    for (let tick = 0; tick < ticks; tick++) {
      high += intent.tick('hidden|>600') ? 1 : 0;
    }
    let low = 0;
    for (let tick = 0; tick < ticks; tick++) {
      low += intent.tick('hidden|<300') ? 1 : 0;
    }

    expect(never).toBe(0);
    expect(always).toBe(ticks);
    expect(high / ticks).toBeCloseTo(0.995, 2);
    expect(low / ticks).toBeCloseTo(0.005, 2);
  });

  it('длинные паузы посреди боя: частота и длительность по профилю', () => {
    const intent = new FireIntent(
      settingsWith({ noStartPauseShare: 1, holdShare: { ...HOLD, 'visible|300–600': 1 }, longPausePerMinute: 2 }),
      createRandom(9),
    );
    intent.reset();
    const minutes = 200;
    const runs: number[] = [];
    let run = 0;
    for (let tick = 0; tick < minutes * 60 * TICK_RATE; tick++) {
      if (intent.tick('visible|300–600')) {
        if (run > 0) {
          runs.push(run);
        }
        run = 0;
        continue;
      }
      run++;
    }
    const meanS = runs.reduce((total, ticks) => total + ticks, 0) / runs.length / TICK_RATE;

    expect(runs.length / minutes).toBeGreaterThan(1.7);
    expect(runs.length / minutes).toBeLessThan(2.3);
    expect(meanS).toBeGreaterThan(3.3);
    expect(meanS).toBeLessThan(4.3);
  });

  it('контекст огня — видимость и корзина дистанции, как у модуля метрик', () => {
    expect(fireContextOf(true, 299)).toBe('visible|<300');
    expect(fireContextOf(true, 300)).toBe('visible|300–600');
    expect(fireContextOf(false, 600)).toBe('hidden|>600');
  });
});
