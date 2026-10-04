import { describe, expect, it } from 'vitest';
import { MAPS, type Side } from '@tanks/shared/engine';
import { decode, MessageType, type BotLevel } from '@tanks/shared/protocol';
import { createBot } from '../src/bots/ladder.js';
import { Room, type Connection } from '../src/room.js';
import { seededRandom } from './support.js';

const FAST_ROOM = { countdownTicks: 2, roundEndTicks: 2, maxInputsPerSecond: 100000 };
// Старший уровень обязан выигрывать большинство на каждой карте с обеих сторон; ничья и поражение — не победа.
const PAIRS: readonly [BotLevel, BotLevel][] = [
  [2, 1],
  [3, 2],
  [10, 3],
];
const MIN_WINS_OF_EIGHT = 6;
const MAX_TICKS = 8 * 4000;

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
    const level = levels[side];
    createBot(level, seededRandom(42 + side), (connection, nickname, stats) => {
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

function winsOf(result: MatchResult, side: Side): number {
  return result.wins[side];
}

describe('лестница ботов: старший уровень сильнее младшего', () => {
  for (const [strong, weak] of PAIRS) {
    it(`уровень ${String(strong)} против уровня ${String(weak)}: не меньше ${String(MIN_WINS_OF_EIGHT)} побед из 8`, () => {
      const asFirst = playMatch([strong, weak], MAPS.length);
      const asSecond = playMatch([weak, strong], MAPS.length);
      const strongWins = winsOf(asFirst, 0) + winsOf(asSecond, 1);
      const weakWins = winsOf(asFirst, 1) + winsOf(asSecond, 0);
      expect(strongWins).toBeGreaterThanOrEqual(MIN_WINS_OF_EIGHT);
      expect(strongWins).toBeGreaterThan(weakWins);
    }, 120000);
  }
});
