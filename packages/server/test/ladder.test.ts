import { describe, expect, it } from 'vitest';
import { MAPS, type Action } from '@tanks/shared/engine';
import { BOT_LEVELS, decode, MessageType, type BotLevel } from '@tanks/shared/protocol';
import { createBot } from '../src/bots/ladder.js';
import { Room, type Connection } from '../src/room.js';
import { seededRandom } from './support.js';

const FAST_ROOM = { countdownTicks: 2, roundEndTicks: 2, maxInputsPerSecond: 100000 };
const MAX_TICKS = 8 * 4000;
// Соседние уровни близки по замыслу — старший не проигрывает по сумме; через ступень разрыв обязан быть явным.
const MIN_WINS_SKIP_ONE = 6;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

interface MatchResult {
  wins: [number, number];
  draws: number;
  // Отпечаток всех команд обоих ботов: любое изменение поведения лестницы меняет его.
  print: number;
}

function hashText(hash: number, text: string): number {
  let next = hash;
  for (let i = 0; i < text.length; i++) {
    next = Math.imul(next ^ text.charCodeAt(i), FNV_PRIME) >>> 0;
  }
  return next;
}

function actionText(side: number, seq: number, action: Action): string {
  const fire = action.isFiring ? 1 : 0;
  return `${String(side)}:${String(seq)}:${String(action.throttle)},${String(action.turn)},${String(action.turretTurn)},${String(fire)};`;
}

// Комната без сокета: два бота на двух местах, тик крутится в цикле до нужного числа раундов.
function playMatch(levels: [BotLevel, BotLevel], rounds: number): MatchResult {
  const room = new Room('ladder', FAST_ROOM);
  const result: MatchResult = { wins: [0, 0], draws: 0, print: FNV_OFFSET };
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
      const seat = room.join(side, watcher, nickname, stats);
      return {
        ...seat,
        input: (seq, action) => {
          result.print = hashText(result.print, actionText(side, seq, action));
          seat.input(seq, action);
        },
      };
    });
  }
  for (let tick = 0; tick < MAX_TICKS && finished < rounds; tick++) {
    room.step();
  }
  expect(finished).toBe(rounds);
  return result;
}

interface DuelResult {
  strongWins: number;
  weakWins: number;
  print: string;
}

// Четыре карты с обеих сторон.
function duel(strong: BotLevel, weak: BotLevel): DuelResult {
  const asFirst = playMatch([strong, weak], MAPS.length);
  const asSecond = playMatch([weak, strong], MAPS.length);
  return {
    strongWins: asFirst.wins[0] + asSecond.wins[1],
    weakWins: asFirst.wins[1] + asSecond.wins[0],
    print: `${asFirst.print.toString(16)}-${asSecond.print.toString(16)}`,
  };
}

// Эталон поведения лестницы, отлаженной Димой: лестница заморожена, отпечаток меняется только по его решению.
const REFERENCE_PRINTS: Readonly<Record<string, string>> = {
  '2-1': '6c43ef79-40350a1a',
  '3-2': '8a9fa736-6161e366',
  '4-3': 'b137df8-2e93d1f5',
  '5-4': '24f66bec-71621c59',
  '6-5': '302d46d3-1d3f47eb',
  '7-6': '54ba01f7-eacfaaee',
  '8-7': '31df8f54-fe5e17e1',
  '9-8': 'c7e15c0a-3dad0b13',
  '10-9': '467dddbe-f840d024',
  '3-1': '43c4495e-85048b91',
  '4-2': '97771beb-d805f08',
  '5-3': 'c898930-6a927d79',
  '6-4': 'd63875f4-75146e22',
  '7-5': '44c7823d-7f999c8d',
  '8-6': 'a50f13f8-8a08be71',
  '9-7': '25a8697e-c04cbb24',
  '10-8': '94067403-a58d922e',
};

describe('лестница ботов', () => {
  const levels: readonly BotLevel[] = BOT_LEVELS;
  for (let index = 1; index < levels.length; index++) {
    const strong = levels[index];
    const weak = levels[index - 1];
    if (strong === undefined || weak === undefined) {
      continue;
    }
    it(`уровень ${String(strong)} не слабее уровня ${String(weak)}, поведение совпадает с эталоном`, () => {
      const result = duel(strong, weak);
      expect(result.strongWins).toBeGreaterThanOrEqual(result.weakWins);
      expect(result.print).toBe(REFERENCE_PRINTS[`${String(strong)}-${String(weak)}`]);
    }, 120000);
  }
  for (let index = 2; index < levels.length; index++) {
    const strong = levels[index];
    const weak = levels[index - 2];
    if (strong === undefined || weak === undefined) {
      continue;
    }
    it(`уровень ${String(strong)} бьёт уровень ${String(weak)} не меньше ${String(MIN_WINS_SKIP_ONE)} раз из 8`, () => {
      const result = duel(strong, weak);
      expect(result.strongWins).toBeGreaterThanOrEqual(MIN_WINS_SKIP_ONE);
      expect(result.print).toBe(REFERENCE_PRINTS[`${String(strong)}-${String(weak)}`]);
    }, 120000);
  }
});
