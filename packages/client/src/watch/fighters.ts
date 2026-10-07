import { compileArenaBotScript, createBrain, type BotBrain } from '@tanks/bots';
import parallaxSource from '@tanks/bots/parallax.js?raw';
import { BOT_LEVEL_INFO, BOT_LEVELS, TWIN_INFO } from '@tanks/shared/protocol';
import { TWIN_BADGE, TWIN_RIVAL } from '../rival.js';

export type BrainFactory = (random: () => number) => BotBrain;

// Боец боя ботов: badge — короткая метка в списке (номер уровня или знак двойника), loadBrain — фабрика свежих
// мозгов на каждый бой; мозг с данными может грузиться отдельным куском сборки.
export interface Fighter {
  id: string;
  badge: string;
  name: string;
  tagline: string;
  loadBrain: () => Promise<BrainFactory>;
}

// Боец с загруженным мозгом — то, что нужно матчу.
export interface ReadyFighter {
  id: string;
  name: string;
  createBrain: BrainFactory;
}

const parallax = compileArenaBotScript(parallaxSource);

// Мозг двойника и его профиль — отдельный кусок сборки: страница грузит его, только когда двойник выбран.
async function loadTwinBrain(): Promise<BrainFactory> {
  const [twin, { default: rivalText }] = await Promise.all([
    import('@tanks/bots/twin'),
    import('@tanks/bots/twin-rival.json?raw'),
  ]);
  const rival = twin.parseTwinRival(rivalText);
  return (random) => new twin.TwinBot(rival, random);
}

// Новый боец — ещё одна запись: страница, матч и отладка знают бойца только через поля Fighter.
export const FIGHTERS: readonly Fighter[] = [
  ...BOT_LEVELS.map((level) => ({
    id: `bot${String(level)}`,
    badge: String(level),
    name: BOT_LEVEL_INFO[level].name,
    tagline: BOT_LEVEL_INFO[level].tagline,
    loadBrain: (): Promise<BrainFactory> => Promise.resolve((random) => createBrain(level, random, parallax)),
  })),
  {
    id: TWIN_RIVAL,
    badge: TWIN_BADGE,
    name: TWIN_INFO.name,
    tagline: TWIN_INFO.tagline,
    loadBrain: loadTwinBrain,
  },
];

export function fighterById(id: string | null): Fighter | null {
  return FIGHTERS.find((fighter) => fighter.id === id) ?? null;
}

export async function readyFighter(fighter: Fighter): Promise<ReadyFighter> {
  return { id: fighter.id, name: fighter.name, createBrain: await fighter.loadBrain() };
}
