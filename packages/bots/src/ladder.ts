import type { BotLevel } from '@tanks/shared/protocol';
import type { BotBrain } from './brain.js';
import { HunterBrain } from './hunter.js';
import { PROFILES } from './profile.js';
import { ScriptBrain, type ArenaBotScript } from './scriptBot.js';

// Текст скрипта уровня 10 берёт платформа: сервер читает файл, браузер получает его сборкой.
export function createBrain(level: BotLevel, random: () => number, parallax: ArenaBotScript): BotBrain {
  if (level === 10) {
    return new ScriptBrain(parallax());
  }
  return new HunterBrain(PROFILES[level], random);
}
