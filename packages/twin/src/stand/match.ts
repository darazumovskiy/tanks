import {
  analyzeLogLines,
  EXCLUSION_REASONS,
  selectProfileRounds,
  type ExclusionReason,
  type ProfileRound,
} from '@tanks/analysis';
import { TwinBrain } from '@tanks/bots/twin';
import type { TwinProfile } from '@tanks/bots/twin';
import { createBot } from '@tanks/server/bots/ladder';
import { Room } from '@tanks/server/room';
import { createRandom, nextRandom, ROUND_SECONDS, TICK_RATE, type Side } from '@tanks/shared/engine';
import { botRoomCode } from '@tanks/shared/protocol';
import { TwinPlayer } from '../player.js';
import { TWIN_NICK, twinSelection } from '../profile.js';
import { MemoryGameLog } from './memoryLog.js';
import type { GamePlan } from './plan.js';

// Отсчёт и пауза между раундами — по 2 тика, как в стенде лестницы; лимит команд — как на бою.
const STAND_ROOM = { countdownTicks: 2, roundEndTicks: 2, maxInputsPerSecond: 90 };
const ROOM_SUFFIX = 'twin';
const ROUND_TICKS_LIMIT = ROUND_SECONDS * TICK_RATE + STAND_ROOM.countdownTicks + STAND_ROOM.roundEndTicks + TICK_RATE;
const FNV_PRIME = 0x01000193;

export type ExclusionCounts = Record<ExclusionReason, number>;

export interface GameResult {
  index: number;
  rounds: ProfileRound[];
  excluded: ExclusionCounts;
  print: number;
}

export function emptyExclusionCounts(): ExclusionCounts {
  return Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0])) as ExclusionCounts;
}

function seededRandom(seed: number): () => number {
  const random = createRandom(seed);
  return () => nextRandom(random);
}

export function mixPrint(hash: number, value: number): number {
  return Math.imul(hash ^ value, FNV_PRIME) >>> 0;
}

function hashText(hash: number, text: string): number {
  let next = hash;
  for (let i = 0; i < text.length; i++) {
    next = mixPrint(next, text.charCodeAt(i));
  }
  return next;
}

// Отпечаток команд двойника — строки `in seq=` его журнала.
function commandPrint(lines: readonly string[]): number {
  return lines.filter((line) => line.includes(' in seq=')).reduce(hashText, 0);
}

// Одна игра стенда: комната сервера, бот лестницы как на бою и двойник за каналом сети; журнал — в памяти,
// разбор — тем же модулем метрик, что журналы игрока. Детали раунда остаются только у раундов смеси.
export function playGame(plan: GamePlan, profile: TwinProfile, logDir: string | null): GameResult {
  const roomCode = botRoomCode(plan.level, ROOM_SUFFIX);
  const log = new MemoryGameLog(plan.id, roomCode);
  const room = new Room(roomCode, STAND_ROOM, log, undefined, { wallSlidePercent: plan.condition.wallSlidePercent });
  const botSide: Side = plan.twinSide === 0 ? 1 : 0;
  createBot(plan.level, seededRandom(plan.botSeed), (connection, nickname, stats) =>
    room.join(botSide, connection, nickname, stats),
  );
  const twin = new TwinPlayer({
    profile,
    brain: new TwinBrain(profile),
    level: plan.level,
    hasRicochetGuard: plan.condition.hasRicochetGuard,
    roundSeeds: plan.roundSeeds,
    roomCode,
    log,
  });
  twin.attach(room.join(plan.twinSide, twin, TWIN_NICK, plan.condition.stats));
  const limit = plan.rounds * ROUND_TICKS_LIMIT;
  for (let tick = 0; tick < limit && twin.finishedRounds < plan.rounds; tick++) {
    room.step();
    twin.step();
  }
  if (twin.finishedRounds < plan.rounds) {
    throw new Error(`игра ${plan.id}: сыграно ${String(twin.finishedRounds)} раундов из ${String(plan.rounds)}`);
  }
  if (logDir !== null) {
    log.save(logDir);
  }
  const files = log.files();
  const selected = selectProfileRounds(analyzeLogLines(files), twinSelection());
  const rounds = selected.kept.map((round) => (round.idx < plan.mixRounds ? round : { ...round, detail: null }));
  const excluded = emptyExclusionCounts();
  for (const reason of EXCLUSION_REASONS) {
    excluded[reason] = selected.excluded[reason].length;
  }
  return { index: plan.index, rounds, excluded, print: commandPrint(files[0]?.lines ?? []) };
}
