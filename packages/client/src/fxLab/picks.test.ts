import { describe, expect, it } from 'vitest';
import { PICKS_KEY, picksText, readPicks, togglePick, writePicks } from './picks.js';
import { AIM_LINE_ROUNDS } from './variants.js';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: () => null,
    length: 0,
  };
}

describe('отметки вариантов', () => {
  it('читает список из хранилища и отбрасывает мусор', () => {
    const storage = memoryStorage({
      [PICKS_KEY]: JSON.stringify(['1:tracer', '2:dots', 42, 'нет-двоеточия', ':x', 'y:']),
    });
    expect(readPicks(storage)).toEqual([
      { round: '1', variant: 'tracer' },
      { round: '2', variant: 'dots' },
    ]);
    expect(readPicks(memoryStorage())).toEqual([]);
    expect(readPicks(memoryStorage({ [PICKS_KEY]: '{битый' }))).toEqual([]);
    expect(readPicks(memoryStorage({ [PICKS_KEY]: '"строка"' }))).toEqual([]);
  });

  it('переключение добавляет и убирает отметку, исходник не меняется; запись читается обратно', () => {
    const initial = [{ round: '1', variant: 'tracer' }];
    const added = togglePick(initial, { round: '2', variant: 'dots' });
    expect(added).toHaveLength(2);
    expect(initial).toHaveLength(1);
    const removed = togglePick(added, { round: '1', variant: 'tracer' });
    expect(removed).toEqual([{ round: '2', variant: 'dots' }]);
    const storage = memoryStorage();
    writePicks(storage, added);
    expect(readPicks(storage)).toEqual(added);
  });

  it('текст списка — по строке на отметку в порядке раундов; пустой — «ничего не отмечено»', () => {
    const text = picksText(
      [
        { round: '2', variant: 'dots' },
        { round: '1', variant: 'tracer' },
        { round: '9', variant: 'ghost' },
      ],
      AIM_LINE_ROUNDS,
    );
    expect(text.split('\n')).toEqual([
      'Понравилось в лаборатории (линия выстрела):',
      '- раунд 1 · tracer · Трассер',
      '- раунд 2 · dots · Точки',
    ]);
    expect(picksText([], AIM_LINE_ROUNDS)).toBe('ничего не отмечено');
  });
});
