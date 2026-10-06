import { FIRE_CONTEXTS, movementMetrics, profileMetrics, type FireContext, type ProfileRound } from '@tanks/analysis';
import { twinProfile, type TwinCalibration, type TwinProfile, type TwinReference } from '../profile.js';
import type { PlayerMetrics, Verdict } from './honesty.js';
import { calibrationPlan, type GamePlan } from './plan.js';
import { runStand } from './run.js';

// Калибруемые параметры — по одному на метрику-вход; исходы сюда не входят.
export type CalibrationParam =
  'correlationTicks' | 'lagTicks' | `hold ${FireContext}` | 'coverHoldShare' | 'reverseChance';

// Сетка поиска — равномерная по значению или по логарифму значения.
type GridScale = 'linear' | 'log';

export interface CalibrationInput {
  param: CalibrationParam;
  name: string;
  tolerance: number;
  range: readonly [number, number];
  scale: GridScale;
  isApplicable: (profile: TwinProfile) => boolean;
  measure: (metrics: PlayerMetrics) => number | null;
}

export interface InputCheck {
  name: string;
  param: CalibrationParam;
  dima: number | null;
  twin: number | null;
  value: number;
  tolerance: number;
  isAtEdge: boolean;
  verdict: Verdict;
}

// Допуски — в пределах округления профиля: тики до половины, доли до пункта.
const TICKS_TOLERANCE = 0.5;
const SHARE_TOLERANCE = 1;
// Погрешность входа — полуширина 95 %: 1,96 стандартной ошибки, оценённой по 10 частям раундов.
const SPREAD_PARTS = 10;
const SPREAD_Z = 1.96;
// Грубая сетка — 7 точек на четверти игр, уточнение — 4 деления шага пополам на всех играх около минимума.
const GRID_POINTS = 7;
const REFINE_STEPS = 4;
const COARSE_PAIR_STRIDE = 4;
const MAX_PASSES = 3;
// Параметр ближе 2 % диапазона к краю — на краю: метрика Димы, возможно, вне досягаемости модели.
const EDGE_SHARE = 0.02;
const ALWAYS = (): boolean => true;
const GAMES_PER_PAIR = 2;

// Закрытый список метрик-входов в порядке зависимостей: рука, огонь, манёвр. У каждого параметра — своя метрика.
export const CALIBRATION_INPUTS: readonly CalibrationInput[] = [
  {
    param: 'correlationTicks',
    name: 'Остаток ошибки по одну сторону, тиков',
    tolerance: TICKS_TOLERANCE,
    range: [1, 120],
    scale: 'log',
    isApplicable: ALWAYS,
    measure: (m) => m.main.aim.aimFit.residualSameSideTicks?.median ?? null,
  },
  {
    param: 'lagTicks',
    name: 'Отставание башни по ходу цели, тиков',
    tolerance: TICKS_TOLERANCE,
    range: [-30, 20],
    scale: 'linear',
    isApplicable: ALWAYS,
    measure: (m) => m.main.aim.aimFit.lagTicks,
  },
  ...FIRE_CONTEXTS.map((context): CalibrationInput => ({
    param: `hold ${context}`,
    name: `Огонь зажат после стартовой паузы ${context}, %`,
    tolerance: SHARE_TOLERANCE,
    range: [0, 1],
    scale: 'linear',
    isApplicable: ALWAYS,
    measure: (m) => m.main.fire.heldAfterStartByContext[context].pct,
  })),
  {
    param: 'coverHoldShare',
    name: 'Огонь зажат в позиции, %',
    tolerance: SHARE_TOLERANCE,
    range: [0, 1],
    scale: 'linear',
    isApplicable: (profile) => profile.cover !== null,
    measure: (m) => m.main.position.hold.firing.pct,
  },
  {
    param: 'reverseChance',
    name: 'Задний ход, %',
    tolerance: SHARE_TOLERANCE,
    range: [0, 1],
    scale: 'linear',
    isApplicable: (profile) => profile.control === 'mouseKeys',
    measure: (m) => m.movement.reverse.pct,
  },
];

export type ParamValues = Record<CalibrationParam, number>;

export function calibrationOf(values: Readonly<ParamValues>): TwinCalibration {
  const holdShare = {} as Record<FireContext, number>;
  for (const context of FIRE_CONTEXTS) {
    holdShare[context] = values[`hold ${context}`];
  }
  return {
    correlationTicks: values.correlationTicks,
    lagTicks: values.lagTicks,
    holdShare,
    reverseChance: values.reverseChance,
    coverHoldShare: values.coverHoldShare,
  };
}

export function valuesOf(calibration: TwinCalibration): ParamValues {
  const values = {
    correlationTicks: calibration.correlationTicks,
    lagTicks: calibration.lagTicks,
    reverseChance: calibration.reverseChance,
    coverHoldShare: calibration.coverHoldShare,
  } as ParamValues;
  for (const context of FIRE_CONTEXTS) {
    values[`hold ${context}`] = calibration.holdShare[context];
  }
  return values;
}

// Положение значения в диапазоне от 0 до 1 — по шкале сетки входа.
function toUnit(input: Pick<CalibrationInput, 'range' | 'scale'>, value: number): number {
  const [low, high] = input.range;
  if (input.scale === 'log') {
    return Math.log(value / low) / Math.log(high / low);
  }
  return (value - low) / (high - low);
}

function fromUnit(input: Pick<CalibrationInput, 'range' | 'scale'>, unit: number): number {
  const [low, high] = input.range;
  const clamped = Math.min(1, Math.max(0, unit));
  if (input.scale === 'log') {
    return low * Math.pow(high / low, clamped);
  }
  return low + (high - low) * clamped;
}

export function isAtEdge(input: Pick<CalibrationInput, 'range' | 'scale'>, value: number): boolean {
  const unit = toUnit(input, value);
  return unit <= EDGE_SHARE || unit >= 1 - EDGE_SHARE;
}

// Неприменимый параметр (задний ход на телефоне, позиция без позиции в журналах) — 0: он ни на что не влияет.
function startValues(profile: TwinProfile): ParamValues {
  const values = {} as ParamValues;
  for (const input of CALIBRATION_INPUTS) {
    values[input.param] = input.isApplicable(profile) ? fromUnit(input, 1 / 2) : 0;
  }
  return values;
}

export interface SearchInput {
  param: CalibrationParam;
  target: number;
  tolerance: number;
  range: readonly [number, number];
  scale: GridScale;
}

export type Measurements = Partial<Record<CalibrationParam, number | null>>;

// Стенд: coarse — грубый прогон на части игр, иначе — на всех играх раскладки.
export type Evaluate = (values: Readonly<ParamValues>, isCoarse: boolean) => Promise<Measurements>;

export interface GridPoint {
  value: number;
  measured: number | null;
}

export interface SearchResult {
  values: ParamValues;
  measured: Measurements;
  sensitivity: Map<CalibrationParam, GridPoint[]>;
  evaluations: number;
  isConverged: boolean;
}

function missOf(measured: number | null | undefined, target: number): number {
  return measured === null || measured === undefined ? Infinity : Math.abs(measured - target);
}

function isWithin(measured: number | null | undefined, input: SearchInput): boolean {
  return missOf(measured, input.target) <= input.tolerance;
}

interface Probe {
  unit: number;
  measurements: Measurements;
}

// Поиск по очереди: каждый параметр — только по своей метрике, остальные стоят. Грубая сетка на части игр
// находит минимум |метрика − цель|, уточнение на всех играх делит шаг пополам около него — немонотонная метрика
// не уводит к краю, как деление отрезка. Проходов несколько: параметры руки и манёвра влияют на чужие входы
// через видимость и дистанцию.
export async function searchInputs(
  inputs: readonly SearchInput[],
  start: Readonly<ParamValues>,
  evaluate: Evaluate,
): Promise<SearchResult> {
  const values = { ...start };
  const sensitivity = new Map<CalibrationParam, GridPoint[]>();
  let evaluations = 0;
  const run = async (isCoarse: boolean): Promise<Measurements> => {
    evaluations++;
    return evaluate(values, isCoarse);
  };
  let measured = await run(false);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (pass > 0 && inputs.every((input) => isWithin(measured[input.param], input))) {
      break;
    }
    for (const input of inputs) {
      // Первый проход ищет по сетке каждый параметр: его сетка — замер чувствительности метрики.
      if (pass > 0 && isWithin(measured[input.param], input)) {
        continue;
      }
      const grid: GridPoint[] = [];
      let best = { unit: toUnit(input, values[input.param]), miss: Infinity };
      for (let point = 0; point < GRID_POINTS; point++) {
        const unit = point / (GRID_POINTS - 1);
        values[input.param] = fromUnit(input, unit);
        const value = (await run(true))[input.param] ?? null;
        grid.push({ value: values[input.param], measured: value });
        const miss = missOf(value, input.target);
        if (miss < best.miss) {
          best = { unit, miss };
        }
      }
      if (!sensitivity.has(input.param)) {
        sensitivity.set(input.param, grid);
      }
      values[input.param] = fromUnit(input, best.unit);
      let probe: Probe = { unit: best.unit, measurements: await run(false) };
      let step = 1 / (GRID_POINTS - 1);
      for (let refine = 0; refine < REFINE_STEPS && !isWithin(probe.measurements[input.param], input); refine++) {
        step /= 2;
        for (const unit of [probe.unit - step, probe.unit + step].filter((item) => item >= 0 && item <= 1)) {
          values[input.param] = fromUnit(input, unit);
          const measurements = await run(false);
          if (missOf(measurements[input.param], input.target) < missOf(probe.measurements[input.param], input.target)) {
            probe = { unit, measurements };
          }
        }
      }
      values[input.param] = fromUnit(input, probe.unit);
      measured = probe.measurements;
    }
  }
  const isConverged = inputs.every((input) => isWithin(measured[input.param], input));
  return { values, measured, sensitivity, evaluations, isConverged };
}

async function standMetrics(profile: TwinProfile, games: GamePlan[], threads: number): Promise<PlayerMetrics> {
  const result = await runStand({ profile, games, logDir: null }, threads);
  const mix = result.rounds.filter((round) => round.detail !== null);
  return { main: profileMetrics(mix), movement: movementMetrics(mix) };
}

function applicableInputs(profile: TwinProfile): CalibrationInput[] {
  return CALIBRATION_INPUTS.filter((input) => input.isApplicable(profile));
}

// Грубый прогон — каждая COARSE_PAIR_STRIDE-я пара игр уровня: доли уровней и сторон сохраняются.
function coarseGames(games: readonly GamePlan[]): GamePlan[] {
  const seen = new Map<number, number>();
  return games.filter((game) => {
    const order = seen.get(game.level) ?? 0;
    seen.set(game.level, order + 1);
    return Math.floor(order / GAMES_PER_PAIR) % COARSE_PAIR_STRIDE === 0;
  });
}

// Входы двойника против Диминых; twinValue — значение входа у двойника, spread — его погрешность.
// Допуск — погрешность, но не меньше округления профиля.
export function checkInputs(
  reference: TwinReference,
  profile: TwinProfile,
  calibration: TwinCalibration,
  twinValue: (input: CalibrationInput) => number | null,
  spread: (input: CalibrationInput) => number,
): InputCheck[] {
  const dimaMetrics: PlayerMetrics = { main: reference.main, movement: reference.movement };
  const values = valuesOf(calibration);
  return applicableInputs(profile).map((input) => {
    const dima = input.measure(dimaMetrics);
    const value = twinValue(input);
    const tolerance = Math.max(input.tolerance, spread(input));
    const isOk = dima !== null && value !== null && Math.abs(value - dima) <= tolerance;
    return {
      name: input.name,
      param: input.param,
      dima,
      twin: value,
      value: values[input.param],
      tolerance,
      isAtEdge: isAtEdge(input, values[input.param]),
      verdict: isOk ? 'честно' : 'нарушение',
    };
  });
}

// Стандартная ошибка входа при этом числе раундов — разброс входа между частями раундов, делённый на корень
// из их числа.
export function inputSpread(rounds: readonly ProfileRound[]): (input: CalibrationInput) => number {
  const parts = Array.from({ length: SPREAD_PARTS }, (_, part) =>
    rounds.filter((_, index) => index % SPREAD_PARTS === part),
  );
  const metrics = parts.map((part): PlayerMetrics => ({ main: profileMetrics(part), movement: movementMetrics(part) }));
  return (input) => {
    const values = metrics.flatMap((item) => {
      const value = input.measure(item);
      return value === null ? [] : [value];
    });
    if (values.length < 2) {
      return 0;
    }
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
    return (SPREAD_Z * Math.sqrt(variance)) / Math.sqrt(values.length);
  };
}

export interface Sensitivity {
  name: string;
  points: GridPoint[];
}

export interface CalibrationRun {
  calibration: TwinCalibration;
  inputs: InputCheck[];
  sensitivity: Sensitivity[];
  evaluations: number;
  isConverged: boolean;
}

// Калибровка входов: двойник играет раунды смеси проверки, модуль метрик меряет входы, параметры подбираются
// по своим метрикам. Входы, которых у Димы нет, не калибруются.
export async function calibrate(reference: TwinReference, seed: number, threads: number): Promise<CalibrationRun> {
  const base = twinProfile(reference, null);
  const games = calibrationPlan(reference, seed);
  const coarse = coarseGames(games);
  const dimaMetrics: PlayerMetrics = { main: reference.main, movement: reference.movement };
  const applicable = applicableInputs(base);
  const inputs = applicable.flatMap((input): SearchInput[] => {
    const target = input.measure(dimaMetrics);
    return target === null ? [] : [{ ...input, target }];
  });
  const result = await searchInputs(inputs, startValues(base), async (values, isCoarse) => {
    const profile = { ...base, calibration: calibrationOf(values) };
    const metrics = await standMetrics(profile, isCoarse ? coarse : games, threads);
    return Object.fromEntries(CALIBRATION_INPUTS.map((input) => [input.param, input.measure(metrics)]));
  });
  const calibration = calibrationOf(result.values);
  return {
    calibration,
    inputs: checkInputs(
      reference,
      base,
      calibration,
      (input) => result.measured[input.param] ?? null,
      () => 0,
    ),
    sensitivity: applicable.flatMap((input) => {
      const points = result.sensitivity.get(input.param);
      return points === undefined ? [] : [{ name: input.name, points }];
    }),
    evaluations: result.evaluations,
    isConverged: result.isConverged,
  };
}
