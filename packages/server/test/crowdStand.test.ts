import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, ffaMap, TICK_RATE, type Action, type FfaSize } from '@tanks/shared/engine';
import { decode, EventFlag, FfaPhase, MessageType, type ServerMessage } from '@tanks/shared/protocol';
import { CrowdBot } from '../src/crowd/bot.js';
import { crowdPyramid, type CrowdLevel } from '../src/crowd/profile.js';
import { TargetBook } from '../src/crowd/targets.js';
import { DEFAULT_FFA_OPTIONS, FfaGame, type FfaConnection, type FfaOptions } from '../src/ffaGame.js';
import { NO_LOG } from '../src/gameLog.js';
import { NO_DROP_COUNTER } from '../src/metrics.js';
import type { Seat } from '../src/room.js';
import { seededRandom } from './support.js';

const SIZE: FfaSize = 30;
const MATCHES = 2;
const STILL_LIMIT_TICKS = 3 * TICK_RATE;
const STILL_MOVE = 10;
const IDLE_KICK_TICKS = 25 * TICK_RATE;
const SELF_DAMAGE_SHARE = 0.1;
const MAX_TICKS = 20_000;

const MATCH_SEEDS = [0x51a7, 0x51a8, 0x51a9];

interface StandBot {
  bot: CrowdBot;
  level: CrowdLevel;
  seat: Seat | null;
  anchor: { x: number; y: number } | null;
  stillTicks: number;
  maxStillTicks: number;
  lastAction: Action | null;
  sameTicks: number;
  maxSameTicks: number;
  isKicked: boolean;
}

interface LevelTally {
  kills: number;
  deaths: number;
}

interface StandResult {
  bots: StandBot[];
  matchesOver: number;
  damage: number;
  selfDamage: number;
  tally: Map<number, LevelTally>;
  visibleBullets: number;
  visibleSamples: number;
  visibleMax: number;
  damageTaken: number;
  offscreenDamage: number;
}

function isSameAction(a: Action, b: Action): boolean {
  return a.throttle === b.throttle && a.turn === b.turn && a.turretTurn === b.turretTurn && a.isFiring === b.isFiring;
}

function trackMovement(entry: StandBot, message: ServerMessage): void {
  if (message.type !== MessageType.FfaSnapshot) {
    return;
  }
  const me = message.tanks.find((tank) => tank.id === entry.bot.playerId);
  const isOnField = entry.bot.phase === FfaPhase.Fight && message.self.state === 'alive' && me !== undefined;
  if (!isOnField) {
    entry.anchor = null;
    entry.stillTicks = 0;
    return;
  }
  const anchor = entry.anchor ?? me;
  if (Math.hypot(me.x - anchor.x, me.y - anchor.y) >= STILL_MOVE) {
    entry.anchor = { x: me.x, y: me.y };
    entry.stillTicks = 0;
    return;
  }
  entry.anchor = anchor;
  entry.stillTicks++;
  entry.maxStillTicks = Math.max(entry.maxStillTicks, entry.stillTicks);
}

function trackAction(entry: StandBot, action: Action): void {
  if (entry.lastAction !== null && isSameAction(entry.lastAction, action)) {
    entry.sameTicks++;
    entry.maxSameTicks = Math.max(entry.maxSameTicks, entry.sameTicks);
  } else {
    entry.sameTicks = 0;
  }
  entry.lastAction = action;
}

// Игра толпы без сокетов: боты подключены как соединения процесса и отвечают на каждый снимок синхронно.
function runStand(count: number): StandResult {
  let seedIndex = 0;
  const options: FfaOptions = {
    ...DEFAULT_FFA_OPTIONS,
    countdownTicks: 3,
    resultsTicks: 5,
    lobbyQuietTicks: 1,
    maxInputsPerSecond: 1000,
    matchSeed: () => MATCH_SEEDS[seedIndex++ % MATCH_SEEDS.length] ?? 0,
  };
  const game = new FfaGame(SIZE, options, NO_LOG, NO_DROP_COUNTER, DEFAULT_RULES);
  const book = new TargetBook();
  const result: StandResult = {
    bots: [],
    matchesOver: 0,
    damage: 0,
    selfDamage: 0,
    tally: new Map(),
    visibleBullets: 0,
    visibleSamples: 0,
    visibleMax: 0,
    damageTaken: 0,
    offscreenDamage: 0,
  };
  const levelOf = new Map<number, CrowdLevel>();
  crowdPyramid(count).forEach((level, index) => {
    const bot = new CrowdBot({
      level,
      nickname: `Бот ${String(index + 1)}`,
      size: SIZE,
      random: seededRandom(1000 + index),
      book,
      phase: index,
      mapFor: ffaMap,
    });
    const entry: StandBot = {
      bot,
      level,
      seat: null,
      anchor: null,
      stillTicks: 0,
      maxStillTicks: 0,
      lastAction: null,
      sameTicks: 0,
      maxSameTicks: 0,
      isKicked: false,
    };
    const isObserver = index === 0;
    const connection: FfaConnection = {
      send: (bytes) => {
        const message = decode(bytes) as ServerMessage;
        if (isObserver) {
          observe(message);
        }
        if (message.type === MessageType.Error) {
          entry.isKicked = true;
          return;
        }
        const input = bot.receive(message);
        trackMovement(entry, message);
        if (input === null) {
          return;
        }
        trackAction(entry, input.action);
        entry.seat?.input(input.seq, input.action);
      },
      close: () => undefined,
    };
    const join = bot.joinMessage();
    entry.seat = game.join(connection, join.nickname, join.stats, true);
    if (bot.playerId !== null) {
      levelOf.set(bot.playerId, level);
    }
    result.bots.push(entry);
  });

  let lastScore: ServerMessage | null = null;
  function observe(message: ServerMessage): void {
    if (message.type === MessageType.FfaScore) {
      lastScore = message;
    }
    if (message.type === MessageType.FfaState && message.phase === FfaPhase.Results && lastScore !== null) {
      result.matchesOver++;
      if (lastScore.type === MessageType.FfaScore) {
        for (const row of lastScore.rows) {
          const level = levelOf.get(row.id) ?? 1;
          const tally = result.tally.get(level) ?? { kills: 0, deaths: 0 };
          tally.kills += row.kills;
          tally.deaths += row.deaths;
          result.tally.set(level, tally);
        }
      }
    }
    if (message.type !== MessageType.FfaSnapshot) {
      return;
    }
    for (const event of message.events) {
      if (event.kind !== 'hit') {
        continue;
      }
      result.damage += event.value;
      if ((event.flags & EventFlag.Self) !== 0) {
        result.selfDamage += event.value;
      }
    }
  }

  for (let tick = 0; tick < MAX_TICKS && result.matchesOver < MATCHES; tick++) {
    game.step();
  }
  for (const entry of result.bots) {
    const counters = entry.bot.takeCounters();
    result.visibleBullets += counters.visibleBullets;
    result.visibleSamples += counters.visibleSamples;
    result.visibleMax = Math.max(result.visibleMax, counters.visibleMax);
    result.damageTaken += counters.damageTaken;
    result.offscreenDamage += counters.offscreenDamage;
  }
  return result;
}

function killsPerLife(tally: Map<number, LevelTally>, levels: readonly CrowdLevel[]): number {
  let kills = 0;
  let deaths = 0;
  for (const level of levels) {
    const entry = tally.get(level);
    kills += entry?.kills ?? 0;
    deaths += entry?.deaths ?? 0;
  }
  return kills / (deaths + 1);
}

describe('стенд толпы: 30 ботов по пирамиде, два матча на карте ffa30', () => {
  const result = runStand(SIZE);

  it('матчи доигрываются без ошибок и без выкинутых', () => {
    expect(result.matchesOver).toBe(MATCHES);
    expect(result.bots.filter((entry) => entry.isKicked)).toEqual([]);
  });

  it('ни один живой бот не стоит на месте дольше 3 с', () => {
    const stuck = result.bots
      .filter((entry) => entry.maxStillTicks >= STILL_LIMIT_TICKS)
      .map((entry) => `${entry.bot.nickname} (уровень ${String(entry.level)}): ${String(entry.maxStillTicks)} тиков`);
    expect(stuck).toEqual([]);
  });

  it('ни один бот не держит одну команду 25 с — сервер не выкинул бы его за бездействие', () => {
    const idle = result.bots.filter((entry) => entry.maxSameTicks >= IDLE_KICK_TICKS);
    expect(idle.map((entry) => entry.bot.nickname)).toEqual([]);
  });

  it('урон по себе — меньше 10 % всего урона', () => {
    expect(result.damage).toBeGreaterThan(0);
    expect(result.selfDamage / result.damage).toBeLessThan(SELF_DAMAGE_SHARE);
  });

  it('чем выше уровень, тем больше убийств на жизнь', () => {
    const low = killsPerLife(result.tally, [1, 2]);
    const middle = killsPerLife(result.tally, [3, 4]);
    const high = killsPerLife(result.tally, [5, 6, 7]);
    console.log(
      `убийств на жизнь: 1–2 ${low.toFixed(2)}, 3–4 ${middle.toFixed(2)}, 5–7 ${high.toFixed(2)}; ` +
        `снарядов в окне ${(result.visibleBullets / Math.max(1, result.visibleSamples)).toFixed(1)}` +
        ` (макс ${String(result.visibleMax)}); урон из-за экрана ` +
        `${((100 * result.offscreenDamage) / Math.max(1, result.damageTaken)).toFixed(0)} %; ` +
        `самострел ${((100 * result.selfDamage) / Math.max(1, result.damage)).toFixed(1)} %`,
    );
    expect(low).toBeLessThan(middle);
    expect(middle).toBeLessThan(high);
  });
});
