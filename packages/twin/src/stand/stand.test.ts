import { analyzeLogLines, analyzeLogs } from '@tanks/analysis';
import { makeLogDir, removeLogDirs } from '@tanks/analysis/logFixture';
import { calibrationWith } from '@tanks/bots/twinFixture';
import { DEFAULT_STATS } from '@tanks/shared/engine';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { twinProfile, type TwinReference } from '../profile.js';
import { playGame } from './match.js';
import { MemoryGameLog } from './memoryLog.js';
import { calibrationPlan, checkPlan, DEFAULT_ROUNDS, STAND_LEVELS, standPlan, type GamePlan } from './plan.js';
import { runStand } from './run.js';

const PHONE = JSON.parse(readFileSync(new URL('../../reference/phone.json', import.meta.url), 'utf8')) as TwinReference;
const HOLD = 0.8;
const CALIBRATION = calibrationWith({
  correlationTicks: 6,
  lagTicks: 2,
  holdShare: {
    'visible|<300': HOLD,
    'visible|300–600': HOLD,
    'visible|>600': HOLD,
    'hidden|<300': HOLD,
    'hidden|300–600': HOLD,
    'hidden|>600': HOLD,
  },
});
const PROFILE = twinProfile(PHONE, CALIBRATION);

function planOf(rounds: number, seed: number, level: 7 | 8 = 8): GamePlan[] {
  return standPlan(PHONE, { levels: [level], roundsOf: () => rounds, mixOf: () => rounds, seed });
}

function outcomes(rounds: readonly { id: string; isWon: boolean; durationS: number }[]): string[] {
  return rounds.map((round) => `${round.id}:${String(round.isWon)}:${String(round.durationS)}`);
}

afterEach(() => {
  removeLogDirs();
});

describe('раскладка стенда', () => {
  it('на уровне — пары игр длиной в игры игрока этого уровня по кругу, пока не наберётся; условия — в долях раундов', () => {
    const rounds = 47 * 16;
    const lengths = PHONE.main.conditions['8']?.gameRounds ?? [];
    const games = standPlan(PHONE, { levels: [8], roundsOf: () => rounds, mixOf: () => 0, seed: 1 });
    const pairs = games.filter((_, index) => index % 2 === 0);
    const total = games.reduce((sum, game) => sum + game.rounds, 0);
    const counts = new Map<string, number>();
    for (const game of games) {
      const key = `${String(game.condition.wallSlidePercent)}|${String(game.condition.hasRicochetGuard)}|${String(game.condition.stats.engine)}`;
      counts.set(key, (counts.get(key) ?? 0) + game.rounds);
    }
    const longest = 2 * Math.max(...lengths);

    expect(lengths.length).toBeGreaterThan(1);
    expect(pairs.map((game) => game.rounds)).toEqual(pairs.map((_, pair) => lengths[pair % lengths.length]));
    expect(games.every((game, index) => game.rounds === games[index - (index % 2)]?.rounds)).toBe(true);
    expect(games.every((game, index) => game.twinSide === (index % 2 === 0 ? 1 : 0))).toBe(true);
    expect(total).toBeGreaterThanOrEqual(rounds);
    expect(total - 2 * (pairs.at(-1)?.rounds ?? 0)).toBeLessThan(rounds);
    const dima: Record<string, number> = { '30|true|2': 6, '0|true|3': 11, '0|false|3': 13, '30|true|3': 17 };
    for (const [key, share] of Object.entries(dima)) {
      expect(Math.abs((counts.get(key) ?? 0) - (share / 47) * total)).toBeLessThanOrEqual(longest);
    }
  });

  it('уровень без игр игрока — длины и условия всей выборки; смесь — первые раунды пар, сиды раундов разные', () => {
    const lengths = Object.values(PHONE.main.conditions).flatMap((conditions) => conditions.gameRounds);
    const games = standPlan(PHONE, { levels: [3], roundsOf: () => 70, mixOf: () => 20, seed: 1 });
    const guarded = games.filter((game) => game.condition.hasRicochetGuard).length;
    const total = games.reduce((sum, game) => sum + game.rounds, 0);
    let left = 20;
    const mix = games.map((game, index) => {
      if (index % 2 === 0) {
        const pairMix = Math.min(2 * game.rounds, left);
        left -= pairMix;
        return [Math.ceil(pairMix / 2), Math.floor(pairMix / 2)];
      }
      return [];
    });

    expect(games.filter((_, index) => index % 2 === 0).map((game) => game.rounds)).toEqual(
      lengths.slice(0, games.length / 2),
    );
    expect(guarded).toBeGreaterThan(games.length / 2);
    expect(games.map((game) => game.mixRounds)).toEqual(mix.flat());
    expect(new Set(games.flatMap((game) => game.roundSeeds)).size).toBe(total);
  });

  it('смесь — обе стороны пары поровну, нечётный раунд — первой игре пары', () => {
    const games = standPlan(PHONE, { levels: [8], roundsOf: () => 16, mixOf: () => 7, seed: 1 });
    const [first] = PHONE.main.conditions['8']?.gameRounds ?? [];

    expect(first).toBe(2);
    expect(games.map((game) => [game.twinSide, game.mixRounds])).toEqual([
      [1, 2],
      [0, 2],
      [1, 2],
      [0, 1],
    ]);
  });

  it('раскладка калибровки — раунды смеси проверки по умолчанию: те же игры, стороны, условия и сиды', () => {
    const check = checkPlan(PHONE, STAND_LEVELS, DEFAULT_ROUNDS, 1).filter((game) => game.mixRounds > 0);
    const calibration = calibrationPlan(PHONE, 1);

    expect(calibration.map((game) => game.id)).toEqual(check.map((game) => game.id));
    calibration.forEach((game, index) => {
      const source = check[index];
      expect(game.rounds).toBe(source?.mixRounds);
      expect(game.roundSeeds).toEqual(source?.roundSeeds.slice(0, game.rounds));
      expect([game.twinSide, game.condition, game.botSeed]).toEqual([
        source?.twinSide,
        source?.condition,
        source?.botSeed,
      ]);
    });
  });
});

describe('стенд', () => {
  // Уровень 7 — бот со случайностью (шум прицела, упреждение и уклонение через раз): сид меняет его поведение.
  it('один сид — одинаковые исходы и отпечаток команд, другой сид — другие; 1 и 4 потока — одинаково', async () => {
    const task = { profile: PROFILE, games: planOf(40, 1, 7), logDir: null };
    const first = await runStand(task, 1);
    const again = await runStand(task, 1);
    const threaded = await runStand(task, 4);
    const other = await runStand({ ...task, games: planOf(40, 2, 7) }, 1);

    expect(task.games).toHaveLength(6);
    expect(first.rounds.length).toBeGreaterThan(24);
    expect(again.print).toBe(first.print);
    expect(outcomes(again.rounds)).toEqual(outcomes(first.rounds));
    expect(threaded.print).toBe(first.print);
    expect(outcomes(threaded.rounds)).toEqual(outcomes(first.rounds));
    expect(other.print).not.toBe(first.print);
  }, 60000);

  it('журнал стенда через модуль метрик: сторона человека — двойник, уровень из кода комнаты, устройство, выстрелы', () => {
    const [plan] = planOf(16, 3);
    if (plan === undefined) {
      throw new Error('нет игры в раскладке');
    }
    const dir = makeLogDir({});
    const result = playGame(plan, PROFILE, dir);
    const files = readdirSync(dir).sort();
    const lines = files.map((name) => ({ name, lines: readFileSync(join(dir, name), 'utf8').split('\n') }));
    const [game] = analyzeLogLines(lines);
    const summary = game?.analysis.summary;
    const twinShots = (lines[0]?.lines ?? []).filter((line) =>
      line.includes(`ev kind=shot side=${String(plan.twinSide)}`),
    ).length;

    expect(files).toEqual([`${plan.id}.log`, 'room-bot08twin.log']);
    expect(summary).toMatchObject({
      human_side: plan.twinSide,
      level: 8,
      human_name: 'Двойник',
      device: 'tanks-twin/phone',
    });
    expect(result.rounds.reduce((total, round) => total + round.shotEvents, 0)).toBeLessThanOrEqual(twinShots);
    expect(game?.parsed.rounds.length).toBe(plan.rounds);
    expect(
      game?.parsed.rounds.reduce(
        (total, round) =>
          total + round.events.filter((event) => event.kind === 'shot' && event.side === plan.twinSide).length,
        0,
      ),
    ).toBe(twinShots);
  });

  it('--log-dir: файлы игр и комнаты; анализатор журналов разбирает папку', async () => {
    const dir = makeLogDir({}, 'logs');
    await runStand({ profile: PROFILE, games: planOf(16, 4), logDir: dir }, 1);
    const result = analyzeLogs(dir);

    expect(readdirSync(dir).sort()).toEqual([
      'T080000.log',
      'T080001.log',
      'T080002.log',
      'T080003.log',
      'room-bot08twin.log',
    ]);
    expect(result.games.map((game) => game.summary.human_name)).toEqual(['Двойник', 'Двойник', 'Двойник', 'Двойник']);
    expect(result.skipped).toEqual([]);
  });

  it('двойник без огня: раунд доигран до гибели, победа бота засчитана, игра закончена', () => {
    const passive = twinProfile(
      PHONE,
      calibrationWith({
        holdShare: {
          ...CALIBRATION.holdShare,
          'visible|<300': 0,
          'visible|300–600': 0,
          'visible|>600': 0,
          'hidden|<300': 0,
          'hidden|300–600': 0,
          'hidden|>600': 0,
        },
      }),
    );
    const plan: GamePlan = {
      id: 'T100000',
      index: 0,
      level: 10,
      twinSide: 1,
      condition: { stats: { ...DEFAULT_STATS }, wallSlidePercent: 0, hasRicochetGuard: true },
      rounds: 1,
      botSeed: 5,
      roundSeeds: [5],
      mixRounds: 1,
    };
    const dir = makeLogDir({});
    playGame(plan, passive, dir);
    const text = readFileSync(join(dir, 'T100000.log'), 'utf8');

    expect(text).toMatch(/ev kind=death side=1 /);
    expect(text).toMatch(/ev kind=roundOver side=0 /);
  }, 30000);

  it('журнал в памяти: строки сервера и клиента с условным временем, журнал комнаты — отдельно', () => {
    const log = new MemoryGameLog('T030001', 'bot03twin');
    log.write('ABCD', 'S', 'gt=45 tc=00:01 tick rt=1');
    log.write('room-bot03twin', 'C1', 'gt=0 tc=00:00 now=0 device ua=x');

    expect(log.files()).toEqual([
      { name: 'T030001.log', lines: ['12:00:01.500 S gt=45 tc=00:01 tick rt=1'] },
      { name: 'room-bot03twin.log', lines: ['12:00:00.000 C1 gt=0 tc=00:00 now=0 device ua=x'] },
    ]);
  });
});
