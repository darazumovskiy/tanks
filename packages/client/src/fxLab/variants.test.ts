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

  it('выбор каждого раунда ссылается на его варианты; текущий раунд — последний', () => {
    for (const round of AIM_LINE_ROUNDS) {
      const ids = round.variants.map((variant) => variant.id);
      for (const pick of round.picks) {
        expect(ids).toContain(pick);
      }
    }
    expect(currentRound().id).toBe(AIM_LINE_ROUNDS[AIM_LINE_ROUNDS.length - 1]?.id);
  });

  it('roundById находит раунд, иначе отдаёт текущий', () => {
    expect(roundById('1').id).toBe('1');
    expect(roundById('нет').id).toBe(currentRound().id);
    expect(roundById(null).id).toBe(currentRound().id);
  });
});
