import { describe, expect, it } from 'vitest';
import { STAT_MAX } from './constants.js';
import { deriveStats } from './stats.js';

// Скорости снаряда по уровням пушки, как в tank-arena: любая правка формулы меняет баланс всех ботов.
const BULLET_SPEED_BY_GUN = [450, 500, 550, 600, 650, 700];

describe('характеристики танка', () => {
  it('скорость снаряда по уровням пушки 0–5 совпадает с эталоном', () => {
    const speeds = Array.from(
      { length: STAT_MAX + 1 },
      (_, gun) => deriveStats({ armor: 0, engine: 0, gun, reload: 0 }).bulletSpeed,
    );
    expect(speeds).toEqual(BULLET_SPEED_BY_GUN);
  });
});
