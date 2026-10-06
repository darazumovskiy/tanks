import type { Condition } from '@tanks/analysis';
import { STAT_KEYS, type Side, type Stats } from '@tanks/shared/engine';
import { BOT_LEVELS, type BotLevel } from '@tanks/shared/protocol';
import type { TwinReference } from '../profile.js';

// Игра стенда — серия раундов одной комнаты: каждая карта дважды, одна сторона, одни условия.
export const SERIES_ROUNDS = 8;
// Раунды уровня — парами игр с обеих сторон.
const SIDES_PER_PAIR = 2;
export const ROUNDS_STEP = SERIES_ROUNDS * SIDES_PER_PAIR;
const BUILD_SEPARATOR = '/';
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const GAME_ID_PREFIX = 'T';
const LEVEL_DIGITS = 2;
const GAME_DIGITS = 4;
export const DEFAULT_ROUNDS = 1000;
// Уровни 1–2 правило выборки профиля отсекает — у Димы их раунды не считаются, у двойника тоже.
const MIN_STAND_LEVEL = 3;
export const STAND_LEVELS: readonly BotLevel[] = BOT_LEVELS.filter((level) => level >= MIN_STAND_LEVEL);

export interface RoundCondition {
  stats: Stats;
  wallSlidePercent: number;
  hasRicochetGuard: boolean;
}

export interface GamePlan {
  id: string;
  index: number;
  level: BotLevel;
  twinSide: Side;
  condition: RoundCondition;
  rounds: number;
  botSeed: number;
  roundSeeds: number[];
  mixRounds: number;
}

// roundsOf — сколько раундов сыграть на уровне, mixOf — сколько первых из них войдут в смесь уровней
// для метрик поведения.
export interface PlanOptions {
  levels: readonly BotLevel[];
  roundsOf: (level: BotLevel) => number;
  mixOf: (level: BotLevel) => number;
  seed: number;
}

function hashSeed(text: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), FNV_PRIME) >>> 0;
  }
  return hash;
}

function statsOf(build: string): Stats {
  const values = build.split(BUILD_SEPARATOR).map(Number);
  const stats = {} as Stats;
  STAT_KEYS.forEach((key, index) => {
    stats[key] = values[index] ?? 0;
  });
  return stats;
}

function allConditions(reference: TwinReference): Condition[] {
  const merged: Condition[] = [];
  for (const level of Object.values(reference.main.conditions)) {
    for (const condition of level.conditions) {
      const found = merged.find(
        (item) =>
          item.build === condition.build &&
          item.wallSlidePercent === condition.wallSlidePercent &&
          item.hasRicochetGuard === condition.hasRicochetGuard,
      );
      if (found === undefined) {
        merged.push({ ...condition });
        continue;
      }
      found.rounds += condition.rounds;
    }
  }
  return merged;
}

// Условия уровня в долях раундов Димы; уровень без раундов с условиями — доли всей выборки.
function levelConditions(reference: TwinReference, level: BotLevel): Condition[] {
  const own = reference.main.conditions[String(level)]?.conditions ?? [];
  return own.length > 0 ? own : allConditions(reference);
}

// Последовательность условий, у которой каждый префикс держит доли: следующей идёт самая недобранная.
function conditionSequence(conditions: readonly Condition[], count: number): Condition[] {
  const total = conditions.reduce((sum, condition) => sum + condition.rounds, 0);
  const assigned = conditions.map(() => 0);
  const sequence: Condition[] = [];
  for (let step = 0; step < count; step++) {
    let best = 0;
    let bestDeficit = -Infinity;
    conditions.forEach((condition, index) => {
      const deficit = (condition.rounds / total) * (step + 1) - (assigned[index] ?? 0);
      if (deficit > bestDeficit) {
        best = index;
        bestDeficit = deficit;
      }
    });
    assigned[best] = (assigned[best] ?? 0) + 1;
    const chosen = conditions[best];
    if (chosen !== undefined) {
      sequence.push(chosen);
    }
  }
  return sequence;
}

// Раскладка: на уровне раунды поровну по картам и сторонам, число раундов округляется вверх до ROUNDS_STEP;
// условия — парами игр в долях раундов Димы. Сиды — от общего сида, профиля, уровня и номера раунда, поэтому
// исход не зависит от числа потоков.
export function standPlan(reference: TwinReference, options: PlanOptions): GamePlan[] {
  const games: GamePlan[] = [];
  for (const level of options.levels) {
    const pairs = Math.ceil(options.roundsOf(level) / ROUNDS_STEP);
    const conditions = conditionSequence(levelConditions(reference, level), pairs);
    const mix = options.mixOf(level);
    const key = `${String(options.seed)}|${reference.profile}|${String(level)}`;
    for (let game = 0; game < pairs * SIDES_PER_PAIR; game++) {
      const condition = conditions[Math.floor(game / SIDES_PER_PAIR)];
      if (condition === undefined) {
        continue;
      }
      const first = game * SERIES_ROUNDS;
      games.push({
        id: `${GAME_ID_PREFIX}${String(level).padStart(LEVEL_DIGITS, '0')}${String(game).padStart(GAME_DIGITS, '0')}`,
        index: games.length,
        level,
        twinSide: game % SIDES_PER_PAIR === 0 ? 1 : 0,
        condition: {
          stats: statsOf(condition.build),
          wallSlidePercent: condition.wallSlidePercent,
          hasRicochetGuard: condition.hasRicochetGuard,
        },
        rounds: SERIES_ROUNDS,
        botSeed: hashSeed(`${key}|bot|${String(game)}`),
        roundSeeds: Array.from({ length: SERIES_ROUNDS }, (_, round) =>
          hashSeed(`${key}|round|${String(first + round)}`),
        ),
        mixRounds: mixRoundsOf(mix, game),
      });
    }
  }
  return games;
}

// Смесь набирается парами игр: раунды пары делятся между сторонами поровну, нечётный — первой игре пары.
function mixRoundsOf(mix: number, game: number): number {
  const pairMix = Math.min(ROUNDS_STEP, Math.max(0, mix - Math.floor(game / SIDES_PER_PAIR) * ROUNDS_STEP));
  return game % SIDES_PER_PAIR === 0 ? Math.ceil(pairMix / SIDES_PER_PAIR) : Math.floor(pairMix / SIDES_PER_PAIR);
}

// Раунды Димы по уровням главного окна — набор соперников калибровки и смеси уровней проверки.
export function referenceRounds(reference: TwinReference): Map<BotLevel, number> {
  const rounds = new Map<BotLevel, number>();
  for (const [level, conditions] of Object.entries(reference.main.conditions)) {
    rounds.set(Number(level) as BotLevel, conditions.guard.total);
  }
  return rounds;
}

// Раскладка проверки: на каждом уровне roundsPerLevel раундов (вверх до ROUNDS_STEP); смесь уровней для
// метрик поведения — в долях раундов Димы, столько раз, сколько помещается в прогон.
export function checkPlan(
  reference: TwinReference,
  levels: readonly BotLevel[],
  roundsPerLevel: number,
  seed: number,
): GamePlan[] {
  const dimaRounds = referenceRounds(reference);
  const rounds = Math.ceil(roundsPerLevel / ROUNDS_STEP) * ROUNDS_STEP;
  const shares = levels.flatMap((level) => {
    const count = dimaRounds.get(level) ?? 0;
    return count > 0 ? [rounds / count] : [];
  });
  const mixFactor = shares.length === 0 ? 0 : Math.max(1, Math.floor(Math.min(...shares)));
  return standPlan(reference, {
    levels,
    roundsOf: () => rounds,
    mixOf: (level) => mixFactor * (dimaRounds.get(level) ?? 0),
    seed,
  });
}

// Раскладка калибровки — раунды смеси проверки по умолчанию с теми же сидами: входы, на которых сошлась
// калибровка, — ровно входы проверки. Раунды игры после смеси на неё не влияют и не играются.
export function calibrationPlan(reference: TwinReference, seed: number): GamePlan[] {
  return checkPlan(reference, STAND_LEVELS, DEFAULT_ROUNDS, seed)
    .filter((game) => game.mixRounds > 0)
    .map((game, index) => ({
      ...game,
      index,
      rounds: game.mixRounds,
      roundSeeds: game.roundSeeds.slice(0, game.mixRounds),
    }));
}
