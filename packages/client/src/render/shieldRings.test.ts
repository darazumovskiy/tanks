import { describe, expect, it } from 'vitest';
import { FFA } from '@tanks/shared/engine';
import { shieldedBodyAlpha, ShieldRings } from './shieldRings.js';

const ME = 1;
const OTHER = 2;
const FRAME_MS = 16;

describe('кольца неуязвимости', () => {
  it('P4 у каждого танка — дуга остатка, у своего и чужого одинаково; без неуязвимости и подбитые — без кольца', () => {
    const rings = new ShieldRings().update(
      [
        { id: ME, isAlive: true, shieldLeft: FFA.shieldSeconds * 0.4 },
        { id: OTHER, isAlive: true, shieldLeft: FFA.shieldSeconds * 0.5 },
        { id: 3, isAlive: true, shieldLeft: 0 },
        { id: 4, isAlive: false, shieldLeft: 2 },
        { id: 5, isAlive: true, shieldLeft: FFA.shieldSeconds * 2 },
      ],
      FRAME_MS,
    );
    expect(rings.map((ring) => ring.id)).toEqual([ME, OTHER, 5]);
    expect(rings[0]?.share).toBeCloseTo(0.4, 9);
    expect(rings[1]).toEqual({ id: OTHER, alpha: 1, share: 0.5 });
    expect(rings[2]?.share).toBe(1);
  });

  it('выстрел снял неуязвимость — кольцо гаснет за 150 мс с прежней дугой; снова зажглось — сразу ярко', () => {
    const shields = new ShieldRings();
    shields.update([{ id: OTHER, isAlive: true, shieldLeft: 1.5 }], FRAME_MS);
    const alphas: number[] = [];
    for (let ms = 0; ms < 160; ms += FRAME_MS) {
      const [ring] = shields.update([{ id: OTHER, isAlive: true, shieldLeft: 0 }], FRAME_MS);
      alphas.push(ring?.alpha ?? 0);
      if (ring !== undefined) {
        expect(ring.share).toBeCloseTo(0.5, 9);
      }
    }
    expect(alphas[0]).toBeGreaterThan(0.9);
    expect(alphas.slice(1).every((alpha, index) => alpha < (alphas[index] ?? 1))).toBe(true);
    expect(alphas.filter((alpha) => alpha > 0)).toHaveLength(Math.ceil(150 / FRAME_MS) - 1);
    expect(alphas.at(-1)).toBe(0);
    shields.update([{ id: OTHER, isAlive: true, shieldLeft: 0 }], FRAME_MS);
    expect(shields.update([{ id: ME, isAlive: true, shieldLeft: FFA.shieldSeconds }], FRAME_MS)).toEqual([
      { id: ME, alpha: 1, share: 1 },
    ]);
  });

  it('P5 корпус неуязвимого — 0,55 у своего и чужого; гаснущее кольцо возвращает корпус к непрозрачному; без кольца — 1', () => {
    const shields = new ShieldRings();
    const lit = shields.update(
      [
        { id: ME, isAlive: true, shieldLeft: 2 },
        { id: OTHER, isAlive: true, shieldLeft: 1 },
      ],
      FRAME_MS,
    );
    expect(shieldedBodyAlpha(lit, ME)).toBeCloseTo(0.55, 9);
    expect(shieldedBodyAlpha(lit, OTHER)).toBeCloseTo(0.55, 9);
    expect(shieldedBodyAlpha(lit, 3)).toBe(1);
    const fading = shields.update([{ id: ME, isAlive: true, shieldLeft: 0 }], 75);
    const half = shieldedBodyAlpha(fading, ME);
    expect(half).toBeGreaterThan(0.55);
    expect(half).toBeLessThan(1);
    const gone = shields.update([{ id: ME, isAlive: true, shieldLeft: 0 }], 100);
    expect(shieldedBodyAlpha(gone, ME)).toBe(1);
  });
});
