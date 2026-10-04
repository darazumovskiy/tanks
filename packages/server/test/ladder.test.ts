import { describe, expect, it } from 'vitest';
import { MAPS } from '@tanks/shared/engine';
import { BOT_LEVELS, decode, MessageType, type BotLevel } from '@tanks/shared/protocol';
import { createBot } from '../src/bots/ladder.js';
import { Room, type Connection } from '../src/room.js';
import { seededRandom } from './support.js';

const FAST_ROOM = { countdownTicks: 2, roundEndTicks: 2, maxInputsPerSecond: 100000 };
const MAX_TICKS = 8 * 4000;
// Соседние уровни близки по замыслу — старший не проигрывает по сумме; через ступень разрыв обязан быть явным.
const MIN_WINS_SKIP_ONE = 6;

interface MatchResult {
  wins: [number, number];
  draws: number;
}

// Комната без сокета: два бота на двух местах, тик крутится в цикле до нужного числа раундов.
function playMatch(levels: [BotLevel, BotLevel], rounds: number): MatchResult {
  const room = new Room('ladder', FAST_ROOM);
  const result: MatchResult = { wins: [0, 0], draws: 0 };
  let finished = 0;
  let isCounted = false;
  for (const side of [0, 1] as const) {
    createBot(levels[side], seededRandom(42 + side), (connection, nickname, stats) => {
      const watcher: Connection = {
        send: (bytes) => {
          connection.send(bytes);
          const message = decode(bytes);
          if (message.type === MessageType.RoundStart) {
            isCounted = false;
          }
          if (message.type === MessageType.Snapshot && message.isOver && side === 0 && !isCounted) {
            isCounted = true;
            finished++;
            if (message.winner === null) {
              result.draws++;
            } else {
              result.wins[message.winner]++;
            }
          }
        },
      };
      return room.join(side, watcher, nickname, stats);
    });
  }
  for (let tick = 0; tick < MAX_TICKS && finished < rounds; tick++) {
    room.step();
  }
  expect(finished).toBe(rounds);
  return result;
}

// Четыре карты с обеих сторон: [победы старшего, победы младшего].
function duel(strong: BotLevel, weak: BotLevel): [number, number] {
  const asFirst = playMatch([strong, weak], MAPS.length);
  const asSecond = playMatch([weak, strong], MAPS.length);
  return [asFirst.wins[0] + asSecond.wins[1], asFirst.wins[1] + asSecond.wins[0]];
}

describe('лестница ботов', () => {
  const levels: readonly BotLevel[] = BOT_LEVELS;
  for (let index = 1; index < levels.length; index++) {
    const strong = levels[index];
    const weak = levels[index - 1];
    if (strong === undefined || weak === undefined) {
      continue;
    }
    it(`уровень ${String(strong)} не слабее уровня ${String(weak)}`, () => {
      const [strongWins, weakWins] = duel(strong, weak);
      expect(strongWins).toBeGreaterThanOrEqual(weakWins);
    }, 120000);
  }
  for (let index = 2; index < levels.length; index++) {
    const strong = levels[index];
    const weak = levels[index - 2];
    if (strong === undefined || weak === undefined) {
      continue;
    }
    it(`уровень ${String(strong)} бьёт уровень ${String(weak)} не меньше ${String(MIN_WINS_SKIP_ONE)} раз из 8`, () => {
      const [strongWins] = duel(strong, weak);
      expect(strongWins).toBeGreaterThanOrEqual(MIN_WINS_SKIP_ONE);
    }, 120000);
  }
});
