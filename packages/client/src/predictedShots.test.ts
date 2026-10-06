import { describe, expect, it } from 'vitest';
import {
  isPredictedBullet,
  pairConfirmedBullets,
  PREDICTED_BULLET_ID_BASE,
  predictedBulletId,
} from './predictedShots.js';

describe('подтверждение своих выстрелов', () => {
  it('два выстрела в одном снимке — пары по порядку номеров, в каком бы порядке они ни пришли', () => {
    const first = predictedBulletId(7);
    const second = predictedBulletId(9);
    expect(pairConfirmedBullets([second, first], new Set(), 9, [41, 40])).toEqual([
      { predictedId: first, serverId: 40 },
      { predictedId: second, serverId: 41 },
    ]);
  });

  it('выстрел с командой новее подтверждённой и живой в предсказании — не подтверждён', () => {
    const acked = predictedBulletId(3);
    const pending = predictedBulletId(5);
    const alive = predictedBulletId(2);
    expect(pairConfirmedBullets([acked, pending, alive], new Set([alive]), 4, [12, 13])).toEqual([
      { predictedId: acked, serverId: 12 },
    ]);
  });

  it('номера предсказания — за пределом номеров сервера', () => {
    expect(isPredictedBullet(predictedBulletId(1))).toBe(true);
    expect(isPredictedBullet(PREDICTED_BULLET_ID_BASE - 1)).toBe(false);
  });
});
