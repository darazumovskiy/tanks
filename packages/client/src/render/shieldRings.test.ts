import { describe, expect, it } from 'vitest';
import { FFA } from '@tanks/shared/engine';
import { ShieldRings } from './shieldRings.js';

const ME = 1;
const FRAME_MS = 16;

describe('кольца неуязвимости', () => {
  it('у своего — дуга остатка, у чужих — полное кольцо; без неуязвимости и подбитые — без кольца', () => {
    const rings = new ShieldRings().update(
      [
        { id: ME, isAlive: true, shieldLeft: FFA.shieldSeconds * 0.4 },
        { id: 2, isAlive: true, shieldLeft: 1 },
        { id: 3, isAlive: true, shieldLeft: 0 },
        { id: 4, isAlive: false, shieldLeft: 2 },
      ],
      ME,
      FRAME_MS,
    );
    expect(rings).toHaveLength(2);
    expect(rings[0]).toMatchObject({ id: ME, alpha: 1 });
    expect(rings[0]?.share).toBeCloseTo(0.4, 9);
    expect(rings[1]).toEqual({ id: 2, alpha: 1, share: null });
  });

  it('выстрел снял неуязвимость — кольцо гаснет за 150 мс с прежней дугой; снова зажглось — сразу ярко', () => {
    const shields = new ShieldRings();
    shields.update([{ id: ME, isAlive: true, shieldLeft: 1.5 }], ME, FRAME_MS);
    const alphas: number[] = [];
    for (let ms = 0; ms < 160; ms += FRAME_MS) {
      const [ring] = shields.update([{ id: ME, isAlive: true, shieldLeft: 0 }], ME, FRAME_MS);
      alphas.push(ring?.alpha ?? 0);
      if (ring !== undefined) {
        expect(ring.share).toBeCloseTo(0.5, 9);
      }
    }
    expect(alphas[0]).toBeGreaterThan(0.9);
    expect(alphas.slice(1).every((alpha, index) => alpha < (alphas[index] ?? 1))).toBe(true);
    expect(alphas.filter((alpha) => alpha > 0)).toHaveLength(Math.ceil(150 / FRAME_MS) - 1);
    expect(alphas.at(-1)).toBe(0);
    shields.update([{ id: ME, isAlive: true, shieldLeft: 0 }], ME, FRAME_MS);
    expect(shields.update([{ id: 2, isAlive: true, shieldLeft: 3 }], ME, FRAME_MS)).toEqual([
      { id: 2, alpha: 1, share: null },
    ]);
  });
});
