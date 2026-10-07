import { readFileSync } from 'node:fs';
import { parseTwinRival, TwinBot } from '@tanks/bots/twin';
import type { Stats } from '@tanks/shared/engine';
import { TWIN_INFO } from '@tanks/shared/protocol';
import type { Connection, Seat } from '../room.js';
import { ArenaBot } from './arenaBot.js';

const RIVAL_FILE = new URL(import.meta.resolve('@tanks/bots/twin-rival.json'));
const RIVAL = parseTwinRival(readFileSync(RIVAL_FILE, 'utf8'));

type JoinRoom = (connection: Connection, nickname: string, stats: Stats) => Seat;

export function createTwin(random: () => number, join: JoinRoom): ArenaBot {
  const brain = new TwinBot(RIVAL, random);
  return new ArenaBot(brain, (connection) => join(connection, TWIN_INFO.name, brain.stats));
}
