import { describe, expect, it } from 'vitest';
import { normalCdf } from './sampling.js';

describe('распределения мозга двойника', () => {
  it('нормальная функция распределения симметрична около нуля', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 6);
    expect(normalCdf(-1) + normalCdf(1)).toBeCloseTo(1, 7);
  });
});
