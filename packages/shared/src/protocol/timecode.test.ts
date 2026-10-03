import { describe, expect, it } from 'vitest';
import { gameTimecode } from './timecode.js';

describe('gameTimecode', () => {
  it('переводит тики в «мм:сс», отбрасывая доли секунды', () => {
    expect(gameTimecode(0)).toBe('00:00');
    expect(gameTimecode(29)).toBe('00:00');
    expect(gameTimecode(30)).toBe('00:01');
    expect(gameTimecode(30 * 92 + 15)).toBe('01:32');
    expect(gameTimecode(30 * 3600)).toBe('60:00');
  });
});
