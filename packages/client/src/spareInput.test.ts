import { describe, expect, it } from 'vitest';
import { SpareInput } from './spareInput.js';

describe('пропуск шага ввода по запасу команд', () => {
  it('флаг — ровно один пропуск; повтор флага до подтверждения команды после пропуска — без пропуска', () => {
    const spare = new SpareInput();
    expect(spare.shouldSkip(11)).toBe(false);
    spare.noteSnapshot(8, true);
    expect(spare.shouldSkip(11)).toBe(true);
    expect(spare.shouldSkip(11)).toBe(false);
    spare.noteSnapshot(9, true);
    spare.noteSnapshot(10, true);
    expect(spare.shouldSkip(12)).toBe(false);
    spare.noteSnapshot(11, false);
    expect(spare.shouldSkip(12)).toBe(false);
    spare.noteSnapshot(12, true);
    expect(spare.shouldSkip(13)).toBe(true);
  });

  it('новое соединение — номера с единицы, прошлый пропуск забыт', () => {
    const spare = new SpareInput();
    spare.noteSnapshot(50, true);
    expect(spare.shouldSkip(60)).toBe(true);
    spare.noteSnapshot(55, true);
    spare.reset();
    expect(spare.shouldSkip(1)).toBe(false);
    spare.noteSnapshot(1, true);
    expect(spare.shouldSkip(2)).toBe(true);
  });
});
