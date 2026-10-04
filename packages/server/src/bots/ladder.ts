import type { Stats } from '@tanks/shared/engine';
import { BOT_LEVEL_INFO, type BotLevel } from '@tanks/shared/protocol';
import type { Connection, Seat } from '../room.js';
import { ArenaBot, type BotBrain } from './arenaBot.js';
import { CarouselBrain } from './carousel.js';
import { DummyBrain } from './dummy.js';
import { HunterBrain } from './hunter.js';
import { loadArenaBotScript, ScriptBrain } from './scriptBot.js';

const PARALLAX_PATH = new URL('../../bots/parallax/bot.js', import.meta.url);
const createParallax = loadArenaBotScript(PARALLAX_PATH);

const BRAINS: Readonly<Record<BotLevel, (random: () => number) => BotBrain>> = {
  1: (random) => new DummyBrain(random),
  2: () => new CarouselBrain(),
  3: () => new HunterBrain(),
  10: () => new ScriptBrain(createParallax()),
};

type JoinRoom = (connection: Connection, nickname: string, stats: Stats) => Seat;

export function createBot(level: BotLevel, random: () => number, join: JoinRoom): ArenaBot {
  const brain = BRAINS[level](random);
  return new ArenaBot(brain, (connection) => join(connection, BOT_LEVEL_INFO[level].name, brain.stats));
}
