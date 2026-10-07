import { readFileSync } from 'node:fs';
import { compileArenaBotScript, createBrain, type ArenaBotScript } from '@tanks/bots';
import type { Stats } from '@tanks/shared/engine';
import { BOT_LEVEL_INFO, type BotLevel } from '@tanks/shared/protocol';
import type { Connection, Seat } from '../room.js';
import { ArenaBot } from './arenaBot.js';

const PARALLAX_SCRIPT = new URL(import.meta.resolve('@tanks/bots/parallax.js'));
export const createParallax: ArenaBotScript = compileArenaBotScript(readFileSync(PARALLAX_SCRIPT, 'utf8'));

type JoinRoom = (connection: Connection, nickname: string, stats: Stats) => Seat;

export function createBot(level: BotLevel, random: () => number, join: JoinRoom): ArenaBot {
  const brain = createBrain(level, random, createParallax);
  return new ArenaBot(brain, (connection) => join(connection, BOT_LEVEL_INFO[level].name, brain.stats));
}
