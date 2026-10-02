import { describe, expect, it } from 'vitest';
import { DT, TICK_RATE } from './index.js';

describe('engine constants', () => {
  it('tick is 1/30 s', () => {
    expect(TICK_RATE).toBe(30);
    expect(DT * TICK_RATE).toBeCloseTo(1);
  });
});
