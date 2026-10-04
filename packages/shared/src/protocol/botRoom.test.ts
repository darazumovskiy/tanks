import { describe, expect, it } from 'vitest';
import { BOT_LEVEL_INFO, BOT_LEVELS, botLevelOf, botRoomCode, isBotRoomCode } from './botRoom.js';

describe('код комнаты против бота', () => {
  it('собирается и разбирается для каждого уровня', () => {
    for (const level of BOT_LEVELS) {
      const code = botRoomCode(level, 'k7m2px');
      expect(code).toMatch(/^bot\d\d[a-z0-9]+$/);
      expect(isBotRoomCode(code)).toBe(true);
      expect(botLevelOf(code)).toBe(level);
    }
  });

  it('у каждого уровня есть имя и описание', () => {
    for (const level of BOT_LEVELS) {
      expect(BOT_LEVEL_INFO[level].name).not.toBe('');
      expect(BOT_LEVEL_INFO[level].tagline).not.toBe('');
      expect(BOT_LEVEL_INFO[level].summary).not.toBe('');
    }
  });

  it('обычный код, код без цифр уровня, с одной цифрой и с незаполненным уровнем — не уровень', () => {
    expect(isBotRoomCode('e2eabc')).toBe(false);
    expect(botLevelOf('e2eabc')).toBeNull();
    expect(botLevelOf('botabc')).toBeNull();
    expect(botLevelOf('bot1abc')).toBeNull();
    expect(botLevelOf('bot00abc')).toBeNull();
    expect(botLevelOf('bot11abc')).toBeNull();
    expect(botLevelOf('bot99abc')).toBeNull();
  });
});
