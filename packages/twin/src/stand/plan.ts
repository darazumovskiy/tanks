import type { Condition } from '@tanks/analysis';
import { STAT_KEYS, type Side, type Stats } from '@tanks/shared/engine';
import { BOT_LEVELS, type BotLevel } from '@tanks/shared/protocol';
import type { TwinReference } from '../profile.js';

// Игры уровня идут парами с обеих сторон: у пары одна длина и одни условия.
const SIDES_PER_PAIR = 2;
const BUILD_SEPARATOR = '/';
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const GAME_ID_PREFIX = 'T';
const LEVEL_DIGITS = 2;
const GAME_DIGITS = 4;
export const DEFAULT_ROUNDS = 1000;
// Уровни 1–2 правило выборки профиля отсекает — у игрока их раунды не считаются, у двойника тоже.
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

// roundsOf — сколько раундов сыграть на уровне не меньше, mixOf — сколько первых из них войдут в смесь уровней
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

// Условия уровня в долях раундов игрока; уровень без раундов с условиями — доли всей выборки.
function levelConditions(reference: TwinReference, level: BotLevel): Condition[] {
  const own = reference.main.conditions[String(level)]?.conditions ?? [];
  return own.length > 0 ? own : allConditions(reference);
}

// Длины игр игрока на уровне по порядку; уровень без его игр — длины всех игр выборки.
function gameLengths(reference: TwinReference, level: BotLevel): number[] {
  const own = reference.main.conditions[String(level)]?.gameRounds ?? [];
  if (own.length > 0) {
    return own;
  }
  const all = Object.values(reference.main.conditions).flatMap((conditions) => conditions.gameRounds);
  if (all.length === 0) {
    throw new Error(`в справке ${reference.profile} нет длин игр`);
  }
  return all;
}

// Длины пар игр уровня: длины игр игрока по кругу, пока раундов не наберётся rounds.
export function pairLengths(reference: TwinReference, level: BotLevel, rounds: number): number[] {
  const lengths = gameLengths(reference, level);
  const pairs: number[] = [];
  for (let total = 0; total < rounds;) {
    const length = lengths[pairs.length % lengths.length] ?? 0;
    pairs.push(length);
    total += length * SIDES_PER_PAIR;
  }
  return pairs;
}

// Последовательность условий пар, у которой каждый префикс держит доли раундов: следующей паре достаётся самое
// недобранное по раундам условие.
function conditionSequence(conditions: readonly Condition[], pairRounds: readonly number[]): Condition[] {
  const total = conditions.reduce((sum, condition) => sum + condition.rounds, 0);
  const assigned = conditions.map(() => 0);
  const sequence: Condition[] = [];
  let played = 0;
  for (const rounds of pairRounds) {
    played += rounds;
    let best = 0;
    let bestDeficit = -Infinity;
    conditions.forEach((condition, index) => {
      const deficit = (condition.rounds / total) * played - (assigned[index] ?? 0);
      if (deficit > bestDeficit) {
        best = index;
        bestDeficit = deficit;
      }
    });
    assigned[best] = (assigned[best] ?? 0) + rounds;
    const chosen = conditions[best];
    if (chosen !== undefined) {
      sequence.push(chosen);
    }
  }
  return sequence;
}

// Смесь набирается парами игр: раунды пары делятся между сторонами поровну, нечётный — первой игре пары.
function mixRoundsOf(remaining: number, length: number, side: number): number {
  const pairMix = Math.min(length * SIDES_PER_PAIR, Math.max(0, remaining));
  return side === 0 ? Math.ceil(pairMix / SIDES_PER_PAIR) : Math.floor(pairMix / SIDES_PER_PAIR);
}

// Раскладка: на уровне — пары игр с обеих сторон длиной в игры игрока этого уровня, пока не наберётся roundsOf;
// условия — парами в долях раундов игрока. Сиды — от общего сида, профиля, уровня и номера игры или раунда на
// уровне, поэтому исход не зависит от числа потоков.
export function standPlan(reference: TwinReference, options: PlanOptions): GamePlan[] {
  const games: GamePlan[] = [];
  for (const level of options.levels) {
    const pairs = pairLengths(reference, level, options.roundsOf(level));
    const conditions = conditionSequence(
      levelConditions(reference, level),
      pairs.map((length) => length * SIDES_PER_PAIR),
    );
    const mix = options.mixOf(level);
    const key = `${String(options.seed)}|${reference.profile}|${String(level)}`;
    let first = 0;
    pairs.forEach((length, pair) => {
      const condition = conditions[pair];
      if (condition === undefined) {
        return;
      }
      const remaining = mix - first;
      for (let side = 0; side < SIDES_PER_PAIR; side++) {
        const game = pair * SIDES_PER_PAIR + side;
        const start = first;
        games.push({
          id: `${GAME_ID_PREFIX}${String(level).padStart(LEVEL_DIGITS, '0')}${String(game).padStart(GAME_DIGITS, '0')}`,
          index: games.length,
          level,
          twinSide: side === 0 ? 1 : 0,
          condition: {
            stats: statsOf(condition.build),
            wallSlidePercent: condition.wallSlidePercent,
            hasRicochetGuard: condition.hasRicochetGuard,
          },
          rounds: length,
          botSeed: hashSeed(`${key}|bot|${String(game)}`),
          roundSeeds: Array.from({ length }, (_, round) => hashSeed(`${key}|round|${String(start + round)}`)),
          mixRounds: mixRoundsOf(remaining, length, side),
        });
        first += length;
      }
    });
  }
  return games;
}

// Раунды игрока по уровням главного окна — набор соперников калибровки и смеси уровней проверки.
export function referenceRounds(reference: TwinReference): Map<BotLevel, number> {
  const rounds = new Map<BotLevel, number>();
  for (const [level, conditions] of Object.entries(reference.main.conditions)) {
    rounds.set(Number(level) as BotLevel, conditions.guard.total);
  }
  return rounds;
}

// Раскладка проверки: на каждом уровне не меньше roundsPerLevel раундов целыми парами игр; смесь уровней для
// метрик поведения — в долях раундов игрока, столько раз, сколько помещается в раунды каждого уровня.
export function checkPlan(
  reference: TwinReference,
  levels: readonly BotLevel[],
  roundsPerLevel: number,
  seed: number,
): GamePlan[] {
  const dimaRounds = referenceRounds(reference);
  const shares = levels.flatMap((level) => {
    const count = dimaRounds.get(level) ?? 0;
    const played = pairLengths(reference, level, roundsPerLevel).reduce((sum, length) => sum + length, 0);
    return count > 0 ? [(played * SIDES_PER_PAIR) / count] : [];
  });
  const mixFactor = shares.length === 0 ? 0 : Math.max(1, Math.floor(Math.min(...shares)));
  return standPlan(reference, {
    levels,
    roundsOf: () => roundsPerLevel,
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
