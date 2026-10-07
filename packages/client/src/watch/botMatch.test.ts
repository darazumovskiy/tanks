import { describe, expect, it } from 'vitest';
import type { BotBrain } from '@tanks/bots';
import {
  DEFAULT_STATS,
  DUEL_COUNTDOWN_TICKS,
  IDLE_ACTION,
  MAPS,
  ROUND_SECONDS,
  TICK_RATE,
  type Action,
} from '@tanks/shared/engine';
import { BotMatch, ROUND_END_TICKS, type MatchFighter } from './botMatch.js';
import { fighterById, type Fighter } from './fighters.js';

// Предел тиков на раунд: серия без конца раунда — ошибка, а не зависание теста.
const MAX_ROUND_TICKS = DUEL_COUNTDOWN_TICKS + ROUND_SECONDS * TICK_RATE + ROUND_END_TICKS + 1;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const SPY_REACTION_TICKS = 5;
// Десять секунд боя: каждый Параллакс успевает и сдвинуться, и выстрелить.
const SAME_FIGHTERS_TICKS = 10 * TICK_RATE;
const FULL_THROTTLE: Action = { ...IDLE_ACTION, throttle: 1 };

function fighter(id: string): Fighter {
  const found = fighterById(id);
  if (found === null) {
    throw new Error(`нет бойца ${id}`);
  }
  return found;
}

function scriptedFighter(name: string, action: Action, reactionTicks = 0, seen: number[] = []): MatchFighter {
  return {
    name,
    createBrain: (): BotBrain => ({
      stats: DEFAULT_STATS,
      reactionTicks,
      tick: (view) => {
        seen.push(view.enemy.x);
        return action;
      },
    }),
  };
}

function hashText(hash: number, text: string): number {
  let next = hash;
  for (let i = 0; i < text.length; i++) {
    next = Math.imul(next ^ text.charCodeAt(i), FNV_PRIME) >>> 0;
  }
  return next;
}

// Прогон до конца rounds раундов: счёт, тики и отпечаток всех событий с их тиками.
function play(match: BotMatch, rounds: number): { score: readonly [number, number]; ticks: number; print: number } {
  let print = FNV_OFFSET;
  let finished = 0;
  while (finished < rounds) {
    if (match.totalTicks > MAX_ROUND_TICKS * rounds) {
      throw new Error('раунды не кончаются');
    }
    const step = match.step();
    for (const event of step.events) {
      print = hashText(print, `${String(match.totalTicks)}:${event.kind}:${event.x.toFixed(2)};`);
      if (event.kind === 'roundOver') {
        finished++;
      }
    }
  }
  return { score: [match.score[0], match.score[1]], ticks: match.totalTicks, print };
}

function stepUntil(match: BotMatch, isDone: () => boolean): void {
  for (let tick = 0; tick < MAX_ROUND_TICKS; tick++) {
    if (isDone()) {
      return;
    }
    match.step();
  }
  throw new Error('не дождался');
}

describe('бой ботов', () => {
  it('одно зерно — один исход', () => {
    const pair = [fighter('bot5'), fighter('bot6')] as const;
    const first = play(new BotMatch(pair, 7), 3);
    const second = play(new BotMatch(pair, 7), 3);
    expect(second).toEqual(first);
  });

  it('другое зерно — другой бой', () => {
    const pair = [fighter('bot3'), fighter('bot5')] as const;
    expect(play(new BotMatch(pair, 1), 2).print).not.toBe(play(new BotMatch(pair, 2), 2).print);
  });

  it('фазы: отсчёт без движения, бой, итог, следующий раунд на следующей карте', () => {
    const match = new BotMatch([fighter('bot10'), fighter('bot1')], 3);
    const spawn = { x: match.round.tanks[0].x, y: match.round.tanks[0].y };
    expect(match.phase).toBe('countdown');
    for (let tick = 0; tick < DUEL_COUNTDOWN_TICKS; tick++) {
      expect(match.step()).toEqual({ events: [], isNewRound: false, hasRoundStepped: false });
    }
    expect({ x: match.round.tanks[0].x, y: match.round.tanks[0].y }).toEqual(spawn);
    expect(match.phase).toBe('fight');
    expect(match.step().hasRoundStepped).toBe(true);

    stepUntil(match, () => match.phase === 'roundEnd');
    const outcome = match.outcome;
    if (outcome?.winner === undefined || outcome.winner === null) {
      throw new Error('Параллакс не победил Манекена');
    }
    expect(match.score[outcome.winner]).toBe(1);
    expect(match.score[0] + match.score[1]).toBe(1);

    for (let tick = 1; tick < ROUND_END_TICKS; tick++) {
      expect(match.step().isNewRound).toBe(false);
    }
    expect(match.step().isNewRound).toBe(true);
    expect(match.phase).toBe('countdown');
    expect(match.roundIndex).toBe(1);
    expect(match.round.mapIndex).toBe(1 % MAPS.length);
    expect(match.outcome).toBeNull();
  });

  it('одинаковые бойцы: оба едут и стреляют, каждый своим мозгом', () => {
    const parallax = fighter('bot10');
    const match = new BotMatch([parallax, parallax], 11);
    stepUntil(match, () => match.phase === 'fight');
    const spawns = match.round.tanks.map((tank) => ({ x: tank.x, y: tank.y }));
    const shooters = new Set<number | null>();
    for (let tick = 0; tick < SAME_FIGHTERS_TICKS && match.phase === 'fight'; tick++) {
      for (const event of match.step().events) {
        if (event.kind === 'shot') {
          shooters.add(event.side);
        }
      }
    }
    expect(match.names).toEqual([parallax.name, parallax.name]);
    expect(shooters).toEqual(new Set([0, 1]));
    match.round.tanks.forEach((tank, side) => {
      expect({ x: tank.x, y: tank.y }).not.toEqual(spawns[side]);
    });
  });

  it('долгий раунд двух бездельников — ничья, счёт не меняется, следующий раунд идёт', () => {
    const idle = scriptedFighter('Стоит', IDLE_ACTION);
    const match = new BotMatch([idle, idle], 1);
    stepUntil(match, () => match.phase === 'roundEnd');
    expect(match.round.time).toBeGreaterThan(ROUND_SECONDS / 2);
    expect(match.outcome?.winner).toBeNull();
    expect(match.score).toEqual([0, 0]);
    stepUntil(match, () => match.roundIndex === 1);
    expect(match.phase).toBe('countdown');
  });

  it('противника мозг видит с задержкой своей реакции', () => {
    const seen: number[] = [];
    const match = new BotMatch(
      [scriptedFighter('Едет', FULL_THROTTLE), scriptedFighter('Смотрит', IDLE_ACTION, SPY_REACTION_TICKS, seen)],
      1,
    );
    stepUntil(match, () => match.phase === 'fight');
    const actual: number[] = [];
    seen.length = 0;
    for (let tick = 0; tick < TICK_RATE; tick++) {
      actual.push(match.round.tanks[0].x);
      match.step();
    }
    expect(seen.slice(SPY_REACTION_TICKS)).toEqual(actual.slice(0, -SPY_REACTION_TICKS));
    expect(new Set(actual).size).toBeGreaterThan(1);
  });
});
