import { switchProbability, type Coefficients, type ModeFeatures } from '@tanks/analysis';
import {
  countdownFrames,
  fightFrame,
  HUMAN,
  BOT,
  pose,
  profileRoundsOf,
  roundOver,
  startDuel,
  type EventSpec,
} from '@tanks/analysis/logFixture';
import { DEFAULT_STATS, deriveStats, mapByIndex } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { lossStreakAfter, modeFeatures, type HitRecord } from './modeSwitch.js';

// Бой длиннее окна урона в 5 с: ранние попадания выходят из него.
const FIGHT_TICKS = 250;

const ZERO: Coefficients = {
  intercept: -2,
  weights: {
    class8: 0,
    class9: 0,
    class10: 0,
    lossStreak: 0,
    roundIndex: 0,
    recentDamageShare: 0,
    healthShare: 0,
    exchangeShare: 0,
    hasCover: 0,
    fightSeconds: 0,
    positionSeconds: 0,
  },
};

function features(overrides: Partial<ModeFeatures> = {}): ModeFeatures {
  return {
    botClass: '3–7',
    lossStreak: 0,
    roundIndex: 0,
    recentDamageShare: 0,
    healthShare: 1,
    exchangeShare: 0,
    hasCover: false,
    fightSeconds: 0,
    hasSight: true,
    distance: 400,
    ...overrides,
  };
}

describe('выбор режима', () => {
  it('нулевые коэффициенты — частота равна свободному члену', () => {
    expect(switchProbability(ZERO, features({ lossStreak: 5, hasCover: true }), 7)).toBeCloseTo(
      1 / (1 + Math.exp(2)),
      12,
    );
  });

  it('один ненулевой коэффициент — частота растёт с его признаком и не зависит от остальных', () => {
    const damage: Coefficients = { ...ZERO, weights: { ...ZERO.weights, recentDamageShare: 3 } };
    const low = switchProbability(damage, features({ recentDamageShare: 0.1 }), 0);
    const high = switchProbability(damage, features({ recentDamageShare: 0.5 }), 0);
    const others = switchProbability(
      damage,
      features({ recentDamageShare: 0.1, lossStreak: 4, hasCover: true, botClass: '10', fightSeconds: 30 }),
      12,
    );

    expect(high).toBeGreaterThan(low);
    expect(others).toBeCloseTo(low, 12);
  });

  it('проигрыши подряд — по счёту на старте раунда; ничья и победа обрывают серию', () => {
    let streak = lossStreakAfter(0, null, [0, 0], 0);
    streak = lossStreakAfter(streak, [0, 0], [1, 0], 0);
    streak = lossStreakAfter(streak, [1, 0], [2, 0], 0);
    expect(streak).toBe(2);
    expect(lossStreakAfter(streak, [2, 0], [2, 0], 0)).toBe(0);
    expect(lossStreakAfter(streak, [2, 0], [2, 1], 0)).toBe(0);
  });

  it('признаки двойника по его восприятию — те же, что модуль метрик снимает с журнала', () => {
    const me = pose(200, 450);
    const bot = pose(1000, 450);
    const hitsAt: Record<number, EventSpec[]> = {
      10: [{ kind: 'hit', side: HUMAN, v: 20 }],
      20: [{ kind: 'hit', side: BOT, v: 15 }],
      40: [{ kind: 'pickup', side: HUMAN, v: 10 }],
      50: [{ kind: 'hit', side: HUMAN, v: 12 }],
    };
    const log = startDuel({ room: 'bot08feat' });
    log.roundStart(0, 0).frames(countdownFrames([bot, me]));
    const fightStart = log.gameTick + 1;
    const hits: HitRecord[] = [];
    for (let tick = 0; tick < FIGHT_TICKS; tick++) {
      const events = [...(hitsAt[tick] ?? []), ...(tick === FIGHT_TICKS - 1 ? [roundOver(HUMAN)] : [])];
      log.frame(fightFrame([bot, me], { events }));
      for (const event of hitsAt[tick] ?? []) {
        hits.push({
          tick: fightStart + tick,
          side: event.side ?? 0,
          value: event.v ?? 0,
          isPickup: event.kind === 'pickup',
        });
      }
    }
    const [round] = profileRoundsOf({ 'FEAT.log': log.text() });
    const seconds = round?.detail?.seconds ?? [];
    const maxHp = deriveStats(DEFAULT_STATS).maxHp;

    expect(seconds.length).toBe(8);
    expect(seconds.at(-1)?.features.recentDamageShare).toBe(0);
    expect(seconds.at(-1)?.features.healthShare).toBeLessThan(1);
    for (const second of seconds) {
      const twin = modeFeatures(
        {
          map: mapByIndex(0),
          me: { x: me.x, y: me.y, maxHp },
          enemy: bot,
          side: HUMAN,
          tick: fightStart + second.index,
          fightTick: second.index,
          hasSight: second.features.hasSight,
          distance: second.features.distance,
          hits,
        },
        { level: 8, roundIndex: 0, lossStreak: 0 },
      );
      expect(twin).toEqual(second.features);
    }
  });
});
