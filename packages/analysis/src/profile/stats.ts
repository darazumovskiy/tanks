// Квантили с линейной интерполяцией между соседними значениями, как в профиле: k = (n − 1) · f.
const QUARTER = 0.25;
const HALF = 0.5;
const THREE_QUARTERS = 0.75;
const DECILE_STEPS = 10;
const PERCENT = 100;
// z-квантиль нормального распределения для интервала 95 %.
const WILSON_Z = 1.96;

// deciles — от минимума до максимума через 10 %: 11 значений.
export interface Distribution {
  n: number;
  q1: number;
  median: number;
  q3: number;
  deciles: number[];
}

export interface Share {
  part: number;
  total: number;
  pct: number | null;
}

export interface Interval {
  low: number;
  high: number;
}

function quantile(sorted: readonly number[], fraction: number): number {
  const k = (sorted.length - 1) * fraction;
  const low = Math.floor(k);
  const high = Math.ceil(k);
  const lowValue = sorted[low] ?? 0;
  const highValue = sorted[high] ?? lowValue;
  return lowValue + (highValue - lowValue) * (k - low);
}

// null-значения — «не было события» — в распределение не входят.
export function distribution(values: readonly (number | null)[]): Distribution | null {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  return {
    n: sorted.length,
    q1: quantile(sorted, QUARTER),
    median: quantile(sorted, HALF),
    q3: quantile(sorted, THREE_QUARTERS),
    deciles: Array.from({ length: DECILE_STEPS + 1 }, (_, step) => quantile(sorted, step / DECILE_STEPS)),
  };
}

export function share(part: number, total: number): Share {
  return { part, total, pct: total === 0 ? null : (PERCENT * part) / total };
}

// Доверительный интервал Уилсона 95 % в процентах, без округления.
export function wilson(part: number, total: number): Interval | null {
  if (total === 0) {
    return null;
  }
  const p = part / total;
  const z2 = WILSON_Z * WILSON_Z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const half = (WILSON_Z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return { low: PERCENT * (center - half), high: PERCENT * (center + half) };
}

// Срединный элемент без интерполяции (верхний из двух средних) — так меряются медианы внутри пауз и отрезков.
export function upperMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
