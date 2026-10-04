import { describe, expect, it } from 'vitest';
import { AIM_LINE_ROUNDS, currentRound, roundById } from './variants.js';

describe('раунды вариантов линии выстрела', () => {
  it('в каждом раунде идентификаторы уникальны и есть оба якоря', () => {
    for (const round of AIM_LINE_ROUNDS) {
      const ids = round.variants.map((variant) => variant.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(round.variants.some((variant) => variant.anchor === 'safe')).toBe(true);
      expect(round.variants.some((variant) => variant.anchor === 'bad')).toBe(true);
    }
  });

  it('выбор закрытого раунда ссылается на его вариант; текущий раунд — последний и открыт', () => {
    const closed = AIM_LINE_ROUNDS.slice(0, -1);
    for (const round of closed) {
      expect(round.variants.map((variant) => variant.id)).toContain(round.pick);
    }
    const current = currentRound();
    expect(current.id).toBe(AIM_LINE_ROUNDS[AIM_LINE_ROUNDS.length - 1]?.id);
    expect(current.pick).toBeNull();
  });

  it('roundById находит раунд, иначе отдаёт текущий', () => {
    expect(roundById('1').id).toBe('1');
    expect(roundById('нет').id).toBe(currentRound().id);
    expect(roundById(null).id).toBe(currentRound().id);
  });
});
