import { TICK_RATE } from '@tanks/shared/engine';
import {
  featureVector,
  MODE_FEATURE_NAMES,
  type Coefficients,
  type ModeFeatureName,
  type ModeFeatures,
} from '../ruler/modeSwitch.js';
import { positionSegments } from './position.js';
import type { ProfileRound } from './rounds.js';

export interface ModeSample {
  roundId: string;
  isInPosition: boolean;
  hasSwitched: boolean;
  positionSeconds: number;
  features: ModeFeatures;
}

const L2_PENALTY = 0.1;
const MAX_ITERATIONS = 100;
const CONVERGED_STEP = 1e-9;
const PIVOT_EPSILON = 1e-12;

// Посекундные отсчёты боя: режим в начале секунды и был ли переход за эту секунду. Позиция, дожившая
// до конца боя, выходом не считается: последняя неполная секунда боя в отсчёты не идёт, и конец боя не попадает
// ни в одну секунду.
export function modeSamples(rounds: readonly ProfileRound[]): ModeSample[] {
  const result: ModeSample[] = [];
  for (const round of rounds) {
    const detail = round.detail;
    if (detail === null) {
      continue;
    }
    const segments = positionSegments(detail.samples);
    for (const second of detail.seconds) {
      const index = second.index;
      const windowEnd = index + TICK_RATE;
      const base = { roundId: round.id, features: second.features };
      const segment = segments.find((candidate) => candidate.start <= index && index < candidate.end);
      if (segment === undefined) {
        const hasEntered = segments.some((candidate) => index <= candidate.start && candidate.start < windowEnd);
        result.push({ ...base, isInPosition: false, hasSwitched: hasEntered, positionSeconds: 0 });
        continue;
      }
      const hasLeft = segment.end <= windowEnd;
      const positionSeconds = (index - segment.start) / TICK_RATE;
      result.push({ ...base, isInPosition: true, hasSwitched: hasLeft, positionSeconds });
    }
  }
  return result;
}

// Индексы матриц ниже всегда в пределах размера: значение по умолчанию недостижимо.
function at(values: readonly number[], index: number): number {
  return values[index] ?? 0;
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a.reduce((total, value, i) => total + value * at(b, i), 0);
}

// Решение системы a · x = b методом Гаусса — Жордана с выбором ведущего элемента; вырожденная — нулевой шаг.
function solve(matrix: readonly (readonly number[])[], vector: readonly number[]): number[] {
  let rows = matrix.map((row, i) => [...row, at(vector, i)]);
  for (let col = 0; col < vector.length; col++) {
    const candidates = rows.slice(col);
    const pivotOffset = candidates.reduce(
      (best, row, offset) => (Math.abs(at(row, col)) > Math.abs(at(candidates[best] ?? [], col)) ? offset : best),
      0,
    );
    const pivotRow = candidates[pivotOffset] ?? [];
    const pivot = at(pivotRow, col);
    if (Math.abs(pivot) < PIVOT_EPSILON) {
      return vector.map(() => 0);
    }
    rows = [...rows.slice(0, col), pivotRow, ...candidates.filter((_, offset) => offset !== pivotOffset)];
    rows = rows.map((row, i) => {
      if (i === col) {
        return row;
      }
      const factor = at(row, col) / pivot;
      return row.map((value, k) => value - factor * at(pivotRow, k));
    });
  }
  return rows.map((row, i) => at(row, vector.length) / at(row, i));
}

// Коэффициенты выбора режима — максимум правдоподобия с небольшим штрафом на величину (свободный член не
// штрафуется), логистическая регрессия методом Ньютона; samples — отсчёты одного потока. null — переходов нет или
// переход в каждом отсчёте: у правдоподобия нет максимума.
export function fitSwitchCoefficients(samples: readonly ModeSample[]): Coefficients | null {
  const switches = samples.filter((sample) => sample.hasSwitched).length;
  if (switches === 0 || switches === samples.length) {
    return null;
  }
  const xs = samples.map((sample) => {
    const vector = featureVector(sample.features, sample.positionSeconds);
    return [1, ...MODE_FEATURE_NAMES.map((name) => vector[name])];
  });
  const ys = samples.map((sample) => (sample.hasSwitched ? 1 : 0));
  const penalty = [0, ...MODE_FEATURE_NAMES.map(() => L2_PENALTY)];
  let beta = penalty.map(() => 0);
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let gradient = beta.map((value, j) => -at(penalty, j) * value);
    let hessian = penalty.map((value, i) => penalty.map((_, j) => (i === j ? value : 0)));
    xs.forEach((x, n) => {
      const p = 1 / (1 + Math.exp(-dot(x, beta)));
      const residual = at(ys, n) - p;
      const weight = p * (1 - p);
      gradient = gradient.map((value, i) => value + residual * at(x, i));
      hessian = hessian.map((row, i) => row.map((value, j) => value + weight * at(x, i) * at(x, j)));
    });
    const step = solve(hessian, gradient);
    beta = beta.map((value, j) => value + at(step, j));
    if (Math.max(...step.map(Math.abs)) < CONVERGED_STEP) {
      break;
    }
  }
  const weights = {} as Record<ModeFeatureName, number>;
  MODE_FEATURE_NAMES.forEach((name, j) => {
    weights[name] = at(beta, j + 1);
  });
  return { intercept: at(beta, 0), weights };
}
