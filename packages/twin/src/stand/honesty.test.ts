import { wilson, type ProfileRound } from '@tanks/analysis';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calibrationWith } from '../fixture.js';
import { PROFILE_WINDOWS, twinProfile, type TwinCalibration, type TwinReference } from '../profile.js';
import {
  CALIBRATION_INPUTS,
  calibrationOf,
  checkInputs,
  inputSpread,
  isAtEdge,
  searchInputs,
  valuesOf,
  type CalibrationInput,
  type InputCheck,
  type Measurements,
  type ParamValues,
  type SearchInput,
} from './calibrate.js';
import { judge, outcomeNames, type PlayerMetrics, type StandCount } from './honesty.js';
import { emptyExclusionCounts } from './match.js';
import { standPlan } from './plan.js';
import { calibrationReport, checkReport } from './report.js';
import { runStand } from './run.js';

const PHONE = JSON.parse(readFileSync(new URL('../../reference/phone.json', import.meta.url), 'utf8')) as TwinReference;
const DIMA: PlayerMetrics = { main: PHONE.main, movement: PHONE.movement };
const MAIN_GAME = PROFILE_WINDOWS.phone.periods.find((period) => period.name === 'C2')?.games[0] ?? '';
// Доли раундов вне выборки как у игрока в главном окне.
const STAND: StandCount = { played: 94, excluded: { ...emptyExclusionCounts(), short: 6, noShot: 10, idle: 1 } };

function roundsOf(level: 6 | 7 | 8 | 9, wins: number, total: number): ProfileRound[] {
  return Array.from(
    { length: total },
    (_, index) =>
      ({ id: `${String(level)}#${String(index)}`, level, isFinished: true, isWon: index < wins }) as ProfileRound,
  );
}

function input(verdict: InputCheck['verdict']): InputCheck {
  return {
    name: 'Вход',
    param: 'lagTicks',
    dima: 0.5,
    twin: 0.5,
    value: 0.3,
    tolerance: 0.05,
    isAtEdge: false,
    verdict,
  };
}

// Обёртка метрик записывает путь каждого прочитанного значения; путь каждого выданного объекта — в paths.
function recording<T extends object>(target: T, reads: Set<string>, paths: WeakMap<object, string>, path = ''): T {
  const proxy = new Proxy(target, {
    get(object, key, receiver): unknown {
      const value: unknown = Reflect.get(object, key, receiver);
      if (typeof key === 'symbol') {
        return value;
      }
      const at = path === '' ? key : `${path}.${key}`;
      if (typeof value === 'object' && value !== null) {
        return recording(value, reads, paths, at);
      }
      reads.add(at);
      return value;
    },
  });
  paths.set(proxy, path);
  return proxy;
}

describe('критерии честности', () => {
  it('винрейт внутри интервала игрока — честно, снаружи — нарушение; уровень с 9 раундами игрока — без вердикта', () => {
    const rounds = [...roundsOf(8, 10, 100), ...roundsOf(9, 40, 100), ...roundsOf(7, 90, 100)];
    const honesty = judge(PHONE, [7, 8, 9], rounds, STAND, DIMA, []);

    expect(honesty.levels.map((row) => [row.level, row.verdict])).toEqual([
      [7, 'без вердикта'],
      [8, 'честно'],
      [9, 'нарушение'],
    ]);
    expect(honesty.isHonest).toBe(false);
  });

  it('сводный винрейт взвешен долями раундов игрока и сверяется с его сводным интервалом без округления', () => {
    const rounds = [...roundsOf(6, 1, 8), ...roundsOf(7, 2, 9), ...roundsOf(8, 4, 47), ...roundsOf(9, 0, 13)];
    const honesty = judge(PHONE, [6, 7, 8, 9], rounds, STAND, DIMA, []);

    expect(honesty.overall.twinPct).toBeCloseTo((100 * 7) / 77, 9);
    expect(honesty.overall.verdict).toBe('честно');
    expect(honesty.levels.every((row) => row.verdict !== 'нарушение')).toBe(true);
  });

  it('исходы: медиана в квартилях и доля в интервале игрока — честно, снаружи — нарушение; n < 30 у игрока — без вердикта', () => {
    const shifted = structuredClone(DIMA);
    shifted.main.dodge.dodge.dodged = { part: 1, total: 100, pct: 1 };
    const speed = shifted.movement.speed;
    if (speed !== null) {
      speed.median = speed.q3 + 1;
    }
    const honesty = judge(PHONE, [8], roundsOf(8, 4, 47), STAND, shifted, [input('честно')]);
    const verdictOf = (name: string): string | undefined => honesty.outcomes.find((row) => row.name === name)?.verdict;

    expect(verdictOf('Ошибка по стоящему, °')).toBe('честно');
    expect(verdictOf('Уклонение')).toBe('нарушение');
    expect(verdictOf('Скорость')).toBe('нарушение');
    expect(verdictOf('Ошибка по движущемуся >600, °')).toBe('честно');
    expect(verdictOf('Выстрелов в минуту')).toBe('без вердикта');
    expect(verdictOf('Попадания в позиции')).toBe('без вердикта');
  });

  it('доля сверяется интервалами: точка двойника вне интервала игрока, но интервалы пересекаются — честно', () => {
    const dima = DIMA.main.dodge.dodge.dodged;
    const wide = structuredClone(DIMA);
    wide.main.dodge.dodge.dodged = { part: 1, total: 3, pct: 100 / 3 };
    const verdict = judge(PHONE, [8], roundsOf(8, 4, 47), STAND, wide, []).outcomes.find(
      (row) => row.name === 'Уклонение',
    )?.verdict;

    expect(dima.total).toBeGreaterThanOrEqual(30);
    expect(wilson(dima.part, dima.total)?.low).toBeGreaterThan(100 / 3);
    expect(verdict).toBe('честно');
  });

  it('свой же профиль против себя — честен; нарушение входа — нечестен; отчёт перечисляет нарушения', () => {
    const rounds = [...roundsOf(6, 1, 8), ...roundsOf(7, 2, 9), ...roundsOf(8, 4, 47), ...roundsOf(9, 0, 13)];
    const honest = judge(PHONE, [6, 7, 8, 9], rounds, STAND, DIMA, [input('честно')]);
    const broken = judge(PHONE, [6, 7, 8, 9], rounds, STAND, DIMA, [input('нарушение')]);
    const report = checkReport(broken, 0xabc);

    expect(honest.isHonest).toBe(true);
    expect(checkReport(honest, 1).at(-1)).toBe('Итог: честен');
    expect(broken.isHonest).toBe(false);
    expect(report.at(-1)).toBe('Итог: нарушения — вход: Вход');
    expect(report).toContain('Отпечаток команд: 00000abc');
    expect(report).toContain('| 8 | 47 | 8.5 % [3.4–19.9] | 4 из 47 [3.4–19.9] | честно |');
  });

  it('параметр на краю при входе вне допуска — нечестен, «край» в итоге; на краю при сошедшемся входе — честен', () => {
    const rounds = [...roundsOf(6, 1, 8), ...roundsOf(7, 2, 9), ...roundsOf(8, 4, 47), ...roundsOf(9, 0, 13)];
    const missed = judge(PHONE, [6, 7, 8, 9], rounds, STAND, DIMA, [{ ...input('нарушение'), isAtEdge: true }]);
    const settled = judge(PHONE, [6, 7, 8, 9], rounds, STAND, DIMA, [{ ...input('честно'), isAtEdge: true }]);
    const settledReport = checkReport(settled, 1);

    expect(missed.isHonest).toBe(false);
    expect(checkReport(missed, 1).at(-1)).toBe('Итог: нарушения — вход: Вход; край: lagTicks');
    expect(settled.isHonest).toBe(true);
    expect(settledReport.at(-1)).toBe('Итог: честен');
    expect(settledReport.some((line) => line.startsWith('Нарушение честности'))).toBe(false);
  });
});

describe('раунды вне выборки', () => {
  it('доля «не играл» у двойника сверяется с долей игрока в главном окне; втрое больше коротких — нарушение', () => {
    const rounds = roundsOf(8, 4, 47);
    const same = judge(PHONE, [8], rounds, STAND, DIMA, []);
    const dying = judge(PHONE, [8], rounds, { played: 94, excluded: { ...STAND.excluded, short: 30 } }, DIMA, []);
    const verdictOf = (honesty: typeof same, name: string): string | undefined =>
      honesty.outcomes.find((row) => row.name === name)?.verdict;

    expect(verdictOf(same, 'Вне выборки: не играл')).toBe('честно');
    expect(verdictOf(dying, 'Вне выборки: короткий бой')).toBe('нарушение');
    expect(verdictOf(dying, 'Вне выборки: не играл')).toBe('нарушение');
  });

  it('событие, которое у игрока случилось меньше 5 раз, — без вердикта даже при явном расхождении; 5 раз — с вердиктом', () => {
    const rounds = roundsOf(8, 4, 47);
    const verdictOf = (dimaIdle: number): string | undefined => {
      const reference = structuredClone(PHONE);
      reference.rounds.excluded.idle = Array.from({ length: dimaIdle }, (_, round) => `${MAIN_GAME}#${String(round)}`);
      const stand = { played: 94, excluded: { ...STAND.excluded, idle: 60 } };
      return judge(reference, [8], rounds, stand, DIMA, []).outcomes.find(
        (row) => row.name === 'Вне выборки: без управления',
      )?.verdict;
    };

    expect(verdictOf(4)).toBe('без вердикта');
    expect(verdictOf(5)).toBe('нарушение');
  });
});

describe('калибровка входов', () => {
  const START = { lagTicks: 0.5, correlationTicks: 1 } as ParamValues;
  // Горб, как у медианы доли упреждения при большой ошибке руки: середина выше краёв.
  const hump = async (values: Readonly<ParamValues>): Promise<Measurements> => {
    await Promise.resolve();
    return { lagTicks: 0.45 - (values.lagTicks - 0.5) ** 2, correlationTicks: 17 * values.correlationTicks };
  };

  it('монотонная метрика на логарифмической сетке — сходится в допуск; повтор — те же значения', async () => {
    const inputs: SearchInput[] = [
      { param: 'correlationTicks', target: 30, tolerance: 1, range: [1, 120], scale: 'log', isSparse: false },
    ];
    const result = await searchInputs(inputs, START, hump);
    const again = await searchInputs(inputs, START, hump);

    expect(result.isConverged).toBe(true);
    expect(Math.abs(17 * result.values.correlationTicks - 30)).toBeLessThanOrEqual(1);
    expect(again).toEqual(result);
  });

  it('немонотонная метрика: минимум |метрика − цель| внутри, поиск не уходит к краю, как деление пополам', async () => {
    const lag: SearchInput = {
      param: 'lagTicks',
      target: 0.4,
      tolerance: 0.01,
      range: [-1, 2],
      scale: 'linear',
      isSparse: false,
    };
    const result = await searchInputs([lag], START, hump);

    expect(result.isConverged).toBe(true);
    expect(isAtEdge(lag, result.values.lagTicks)).toBe(false);
    expect(result.sensitivity.get('lagTicks')?.map((point) => point.value)).toEqual([-1, -0.5, 0, 0.5, 1, 1.5, 2]);
  });

  it('вход по редким событиям — грубая сетка на всех играх, остальные входы — на части игр', async () => {
    const coarseRuns = async (isSparse: boolean): Promise<number> => {
      let coarse = 0;
      const counting = (values: Readonly<ParamValues>, isCoarse: boolean): Promise<Measurements> => {
        coarse += isCoarse ? 1 : 0;
        return hump(values);
      };
      const input: SearchInput = {
        param: 'lagTicks',
        target: 0.4,
        tolerance: 0.01,
        range: [-1, 2],
        scale: 'linear',
        isSparse,
      };
      await searchInputs([input], START, counting);
      return coarse;
    };

    expect(await coarseRuns(true)).toBe(0);
    expect(await coarseRuns(false)).toBeGreaterThan(0);
  });

  it('недостижимый вход — параметр на краю диапазона, поиск сообщает, что не сошёлся', async () => {
    const memory: SearchInput = {
      param: 'correlationTicks',
      target: 5000,
      tolerance: 1,
      range: [1, 120],
      scale: 'log',
      isSparse: false,
    };
    const result = await searchInputs([memory], START, hump);

    expect(result.isConverged).toBe(false);
    expect(isAtEdge(memory, result.values.correlationTicks)).toBe(true);
  });

  it('у каждого калибруемого параметра — ровно одна метрика-вход, имена входов профиля не совпадают с исходами', () => {
    const outcomes = new Set(outcomeNames(PHONE));
    const applicable = CALIBRATION_INPUTS.filter((item) => item.isApplicable(twinProfile(PHONE, null)));
    const params = CALIBRATION_INPUTS.map((item) => item.param);
    const calibration: TwinCalibration = calibrationOf(
      valuesOf(calibrationOf(Object.fromEntries(params.map((param) => [param, 0.5])) as ParamValues)),
    );

    expect(applicable.filter((item) => outcomes.has(item.name))).toEqual([]);
    expect(new Set(params).size).toBe(params.length);
    expect(Object.keys(valuesOf(calibration)).sort()).toEqual([...params].sort());
  });

  it('исходы во входы не попадают: ни одно поле метрик, которое сверяет исход, не читает ни один вход', () => {
    const paths = new WeakMap<object, string>();
    const outcomeReads = new Set<string>();
    const honesty = judge(PHONE, [8], roundsOf(8, 4, 47), STAND, recording(DIMA, outcomeReads, paths), []);
    for (const row of honesty.outcomes) {
      const path = row.twin.kind === 'rate' || row.twin.value === null ? undefined : paths.get(row.twin.value);
      if (path !== undefined) {
        outcomeReads.add(path);
      }
    }
    const inputReads = new Set<string>();
    const applicable = CALIBRATION_INPUTS.filter((item) => item.isApplicable(twinProfile(PHONE, null)));
    for (const item of applicable) {
      item.measure(recording(DIMA, inputReads, paths));
    }
    const isRelated = (a: string, b: string): boolean => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

    expect(outcomeReads.size).toBeGreaterThan(outcomeNames(PHONE).length);
    expect(inputReads.size).toBeGreaterThanOrEqual(applicable.length);
    expect([...inputReads].filter((input) => [...outcomeReads].some((outcome) => isRelated(input, outcome)))).toEqual(
      [],
    );
  });

  it('допуск входа в check — погрешность двойника по частям раундов, но не меньше округления профиля', async () => {
    const profile = twinProfile(PHONE, calibrationWith());
    const games = standPlan(PHONE, { levels: [8], roundsOf: () => 8, mixOf: () => 8, seed: 1 }).slice(0, 1);
    const round = (await runStand({ profile, games, logDir: null }, 1)).rounds.find((item) => item.detail !== null);
    const lag = CALIBRATION_INPUTS.find((item) => item.param === 'lagTicks');
    if (round === undefined || lag === undefined) {
      throw new Error('нет раунда стенда или входа отставания');
    }
    const rounds = new Array<ProfileRound>(25).fill(round);
    const roundCount: CalibrationInput = { ...lag, measure: (m) => m.main.rounds };
    const sizes = [3, 3, 3, 3, 3, 2, 2, 2, 2, 2];
    const mean = sizes.reduce((total, size) => total + size, 0) / sizes.length;
    const deviation = Math.sqrt(sizes.reduce((total, size) => total + (size - mean) ** 2, 0) / (sizes.length - 1));

    expect(inputSpread(rounds)(roundCount)).toBeCloseTo((1.96 * deviation) / Math.sqrt(sizes.length), 9);

    const spreadOf = (input: CalibrationInput): number => (input.param === 'lagTicks' ? 3 : 0.2);
    const checks = checkInputs(PHONE, profile, calibrationWith(), (input) => (input.measure(DIMA) ?? 0) + 2, spreadOf);
    const checkOf = (param: string): InputCheck | undefined => checks.find((item) => item.param === param);

    expect(checkOf('lagTicks')).toMatchObject({ tolerance: 3, verdict: 'честно' });
    expect(checkOf('correlationTicks')).toMatchObject({ tolerance: 0.5, verdict: 'нарушение' });
  });

  it('отчёт калибровки: вход — игрок, двойник, параметр; край при входе вне допуска и сетка чувствительности', () => {
    const edge = { ...input('нарушение'), twin: 3.5, value: 0, isAtEdge: true };
    const settled = {
      ...input('честно'),
      name: 'Пеленг',
      param: 'hiddenAim bearing' as const,
      value: 0,
      isAtEdge: true,
    };
    const report = calibrationReport({
      inputs: [edge, settled],
      sensitivity: [
        {
          name: 'Вход',
          points: [
            { value: 0, measured: 0.3 },
            { value: 1, measured: null },
          ],
        },
      ],
      evaluations: 7,
      isConverged: false,
    });

    expect(report).toEqual([
      '| Вход | Игрок | Двойник | Параметр |',
      '| --- | --- | --- | --- |',
      '| Вход | 0.50 | 3.50 | lagTicks = 0.000 |',
      '| Пеленг | 0.50 | 0.50 | hiddenAim bearing = 0.000 |',
      'Нарушение честности: lagTicks = 0.000 на краю физического диапазона, вход вне допуска — модели не хватает свойства (вход «Вход»)',
      '',
      'Чувствительность: параметр → метрика по грубой сетке первого прохода',
      '| Вход | Сетка |',
      '| --- | --- |',
      '| Вход | 0.00 → 0.30; 1.00 → — |',
      '',
      'Прогонов стенда: 7; не все входы в допуске',
    ]);
  });
});
