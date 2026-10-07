import { compileArenaBotScript, createBrain, type BotBrain } from '@tanks/bots';
import parallaxSource from '@tanks/bots/parallax.js?raw';
import { BOT_LEVEL_INFO, BOT_LEVELS } from '@tanks/shared/protocol';

// Боец боя ботов: badge — короткая метка в списке (номер уровня), createBrain — свежий мозг на каждый бой.
export interface Fighter {
  id: string;
  badge: string;
  name: string;
  tagline: string;
  createBrain: (random: () => number) => BotBrain;
}

const parallax = compileArenaBotScript(parallaxSource);

// Новый боец — ещё одна запись: страница, матч и отладка знают бойца только через поля Fighter.
export const FIGHTERS: readonly Fighter[] = BOT_LEVELS.map((level) => ({
  id: `bot${String(level)}`,
  badge: String(level),
  name: BOT_LEVEL_INFO[level].name,
  tagline: BOT_LEVEL_INFO[level].tagline,
  createBrain: (random) => createBrain(level, random, parallax),
}));

export function fighterById(id: string | null): Fighter | null {
  return FIGHTERS.find((fighter) => fighter.id === id) ?? null;
}
