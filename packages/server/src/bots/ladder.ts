import type { Stats } from '@tanks/shared/engine';
import { BOT_LEVEL_INFO, type BotLevel } from '@tanks/shared/protocol';
import type { Connection, Seat } from '../room.js';
import { ArenaBot, type BotBrain } from './arenaBot.js';
import { HunterBrain } from './hunter.js';
import { PROFILES } from './profile.js';
import { loadArenaBotScript, ScriptBrain } from './scriptBot.js';

const PARALLAX_PATH = new URL('../../bots/parallax/bot.js', import.meta.url);
const createParallax = loadArenaBotScript(PARALLAX_PATH);

export function createBrain(level: BotLevel, random: () => number): BotBrain {
  if (level === 10) {
    return new ScriptBrain(createParallax());
  }
  return new HunterBrain(PROFILES[level], random);
}

type JoinRoom = (connection: Connection, nickname: string, stats: Stats) => Seat;

export function createBot(level: BotLevel, random: () => number, join: JoinRoom): ArenaBot {
  const brain = createBrain(level, random);
  return new ArenaBot(brain, (connection) => join(connection, BOT_LEVEL_INFO[level].name, brain.stats));
}
