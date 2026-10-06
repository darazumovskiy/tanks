import { deriveStats, DT, TICK_RATE } from '@tanks/shared/engine';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeLogLines, loadLoggedGames } from '../index.js';
import {
  action,
  BOT,
  countdownFrames,
  FIXTURE_SELECTION,
  fightFrame,
  HUMAN,
  LogBuilder,
  logFiles,
  makeLogDir,
  pose,
  profileRoundsOf,
  removeLogDirs,
  roundOver,
  shotEvent,
  START_SEC,
  type EventSpec,
} from '../logFixture.js';
import { profileMetrics, selectProfileRounds, wilson } from './index.js';
import { distribution } from './stats.js';

const BOT_POSE = pose(1400, 100, Math.PI, Math.PI);
const ROUND_TICKS = 160;
const DEATH_DAMAGE = deriveStats({ armor: 0, engine: 0, gun: 0, reload: 0 }).maxHp;

// Скорость за тик и промежуток между выстрелами по уровню характеристики: по ним анализатор выводит двигатель
// и перезарядку. Ствол не выводится по журналу без рикошетов и берётся по умолчанию — 2.
function stepOf(engine: number): number {
  return deriveStats({ armor: 0, engine, gun: 0, reload: 0 }).maxSpeed / TICK_RATE;
}

function shotEveryOf(reload: number): number {
  return Math.round(deriveStats({ armor: 0, engine: 0, gun: 0, reload }).reloadTime / DT);
}

interface GameSpec {
  rules?: string;
  flagsBeforeRound?: readonly (string | null)[];
  settings?: string;
  rtts?: readonly number[];
  winners: readonly (0 | 1 | null)[];
  engine?: number;
  reload?: number;
  isHumanKilled?: boolean;
}

function gameLog(spec: GameSpec): string {
  const rules = spec.rules === undefined ? '' : ` rules=${spec.rules}`;
  const builder = new LogBuilder(START_SEC).server(`game start room=bot05cond p0=Ветеран p1=Дима${rules}`);
  builder.client(HUMAN, 'net roundstart game=TEST idx=0 map=0 score=0:0');
  if (spec.settings !== undefined) {
    builder.client(HUMAN, `settings ${spec.settings}`);
  }
  const step = spec.engine === undefined ? 0 : stepOf(spec.engine);
  const shotEvery = shotEveryOf(spec.reload ?? 2);
  spec.winners.forEach((winner, idx) => {
    const flags = spec.flagsBeforeRound?.[idx] ?? null;
    if (flags !== null) {
      builder.client(HUMAN, `flags ${flags}`);
    }
    builder.roundStart(idx, 0).frames(countdownFrames([BOT_POSE, pose(200, 100)]));
    for (let tick = 0; tick < ROUND_TICKS; tick++) {
      const human = pose(200 + step * tick, 100);
      const events: EventSpec[] = tick % shotEvery === 0 ? [shotEvent(HUMAN, human)] : [];
      const isLast = tick === ROUND_TICKS - 1;
      if (isLast && spec.isHumanKilled === true) {
        events.push({ kind: 'hit', side: HUMAN, x: human.x, y: human.y, v: DEATH_DAMAGE });
        events.push({ kind: 'death', side: HUMAN, x: human.x, y: human.y });
      }
      builder.frame(
        fightFrame([BOT_POSE, human], {
          actions: [action(0), step > 0 ? action(1) : action(0, 0, 1)],
          events: isLast ? [...events, roundOver(winner)] : events,
        }),
      );
      const rtt = spec.rtts?.[tick];
      if (idx === 0 && rtt !== undefined) {
        builder.client(HUMAN, `sec fps=60 worst=20 rtt=${String(rtt)} pend=1`);
      }
    }
  });
  return builder.text();
}

const EARLY: GameSpec = {
  rules: '30',
  flagsBeforeRound: [null, 'autoaim=0 guard=1'],
  settings: '{"hasRicochetGuard":false,"pivotThrottle":0.5}',
  rtts: [0, 40, 60],
  winners: [BOT, HUMAN, BOT],
  engine: 3,
};
const LATE: GameSpec = {
  flagsBeforeRound: ['autoaim=0 guard=0'],
  settings: '{"hasRicochetGuard":true,"pivotThrottle":0.7}',
  rtts: [50],
  winners: [BOT],
  engine: 3,
};

afterEach(() => {
  removeLogDirs();
});

describe('условия, настройки и сеть', () => {
  it('условия по уровню: билд, скольжение и предохранитель раунда; доля предохранителя; настройки — последняя строка', () => {
    const metrics = profileMetrics(profileRoundsOf({ 'EARL.log': gameLog(EARLY), 'LATE.log': gameLog(LATE) }));

    expect(metrics.conditions['5']).toEqual({
      guard: { part: 2, total: 4, pct: 50 },
      conditions: [
        { build: '3/3/2/2', wallSlidePercent: 30, hasRicochetGuard: false, rounds: 1 },
        { build: '3/3/2/2', wallSlidePercent: 30, hasRicochetGuard: true, rounds: 2 },
        { build: '3/3/2/2', wallSlidePercent: 0, hasRicochetGuard: false, rounds: 1 },
      ],
    });
    expect(metrics.skippedBuilds).toEqual([]);
    expect(metrics.settings).toEqual({ pivotThrottle: 0.7 });
    expect(metrics.rttMs).toMatchObject({ n: 3, median: 50 });
  });

  it('билд: недостающая характеристика — остаток бюджета; не выводится или не собирается — вне условий с причиной', () => {
    const skippedOf = (spec: Partial<GameSpec>): unknown => {
      const metrics = profileMetrics(profileRoundsOf({ 'BILD.log': gameLog({ winners: [BOT], ...spec }) }));
      return { conditions: metrics.conditions['5']?.conditions.length, skipped: metrics.skippedBuilds };
    };

    expect(skippedOf({ engine: 3, reload: 5 })).toEqual({ conditions: 1, skipped: [] });
    expect(skippedOf({})).toEqual({
      conditions: 0,
      skipped: [{ level: 5, build: '?/?/2/2', issue: 'incomplete', rounds: 1 }],
    });
    expect(skippedOf({ engine: 5, reload: 5 })).toEqual({
      conditions: 0,
      skipped: [{ level: 5, build: '?/5/2/5', issue: 'invalid', rounds: 1 }],
    });
    expect(skippedOf({ engine: 3, isHumanKilled: true })).toEqual({
      conditions: 0,
      skipped: [{ level: 5, build: '0/3/2/2', issue: 'invalid', rounds: 1 }],
    });
  });

  it('строка настроек не JSON или не объект — настроек нет; объект без поля — поле пустое', () => {
    const settingsOf = (settings: string): unknown =>
      profileMetrics(profileRoundsOf({ 'SETT.log': gameLog({ ...LATE, settings }) })).settings;

    expect(settingsOf('{oops')).toBeNull();
    expect(settingsOf('5')).toBeNull();
    expect(settingsOf('null')).toBeNull();
    expect(settingsOf('{"pivotThrottle":"fast"}')).toEqual({ pivotThrottle: null });
  });

  it('скольжение из строки старта: не число или вне 0–100 — липкие стены', () => {
    const slideOf = (rules: string): number | undefined =>
      analyzeLogLines(logFiles({ 'RULE.log': gameLog({ ...LATE, rules }) }))[0]?.parsed.wallSlidePercent;

    expect(slideOf('30')).toBe(30);
    expect(slideOf('abc')).toBe(0);
    expect(slideOf('150')).toBe(0);
    expect(slideOf('2.5')).toBe(0);
  });

  it('исходы по уровню и по манере: раунды и победы без готового интервала; ничья — не победа', () => {
    const outcomes = profileMetrics(
      profileRoundsOf({ 'EARL.log': gameLog(EARLY), 'LATE.log': gameLog({ ...LATE, winners: [null] }) }),
    ).outcomes;

    expect(outcomes).toMatchObject({ rounds: 4, wins: 1 });
    expect(outcomes).not.toHaveProperty('winrate');
    expect(outcomes.byLevel['5 Ветеран']).toMatchObject({ rounds: 4, wins: 1 });
    expect(outcomes.manoeuvreStyle).toEqual({ rounds: 4, wins: 1 });
    expect(outcomes.holdStyle).toEqual({ rounds: 0, wins: 0 });
  });
});

describe('журнал из папки и из памяти', () => {
  it('одни строки журнала дают одинаковые метрики при любом времени записи файлов', () => {
    const texts = { 'EARL.log': gameLog(EARLY), 'LATE.log': gameLog(LATE) };
    const dir = makeLogDir(texts);
    const longAgo = new Date(Date.UTC(2001, 0, 1));
    utimesSync(join(dir, 'LATE.log'), longAgo, longAgo);
    const fromDir = selectProfileRounds(loadLoggedGames(dir), FIXTURE_SELECTION);
    const fromMemory = selectProfileRounds(analyzeLogLines(logFiles(texts)), FIXTURE_SELECTION);

    expect(fromDir.kept.length).toBe(4);
    expect(profileMetrics(fromDir.kept)).toEqual(profileMetrics(fromMemory.kept));
  });
});

describe('статистика профиля', () => {
  it('интервал Уилсона 95 % в процентах без округления', () => {
    const rounded = (part: number, total: number): unknown => {
      const interval = wilson(part, total);
      return interval === null ? null : [Math.round(interval.low), Math.round(interval.high)];
    };

    expect(wilson(0, 19)?.high).toBeCloseTo(16.82, 2);
    expect(rounded(0, 19)).toEqual([0, 17]);
    expect(rounded(4, 45)).toEqual([4, 21]);
    expect(rounded(7, 70)).toEqual([5, 19]);
    expect(rounded(0, 0)).toBeNull();
  });

  it('квантили и децили — линейная интерполяция', () => {
    const result = distribution([4, 1, 3, 2, null]);
    expect(result).toMatchObject({ n: 4, q1: 1.75, median: 2.5, q3: 3.25 });
    expect(result?.deciles[0]).toBe(1);
    expect(result?.deciles[1]).toBeCloseTo(1.3, 9);
    expect(result?.deciles[10]).toBe(4);
    expect(distribution([null])).toBeNull();
  });
});
