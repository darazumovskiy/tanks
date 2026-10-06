import { nextRandom, type Random } from '@tanks/shared/engine';

// Приближение функции ошибок многочленом от 1 / (1 + p·x): погрешность меньше 1,5·10⁻⁷.
const ERF_P = 0.3275911;
const ERF_A = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429] as const;

// Значение распределения по децилям (11 точек от минимума до максимума) для доли u из [0, 1], с линейной
// интерполяцией между соседними децилями.
export function fromDeciles(deciles: readonly number[], u: number): number {
  const steps = deciles.length - 1;
  const k = Math.min(steps, Math.max(0, u * steps));
  const low = Math.floor(k);
  const lowValue = deciles[low] ?? 0;
  const highValue = deciles[Math.min(steps, low + 1)] ?? lowValue;
  return lowValue + (highValue - lowValue) * (k - low);
}

export function sampleDeciles(random: Random, deciles: readonly number[]): number {
  return fromDeciles(deciles, nextRandom(random));
}

// Стандартное нормальное по Боксу — Мюллеру; 1 − u не даёт логарифма нуля.
export function standardNormal(random: Random): number {
  const radius = Math.sqrt(-2 * Math.log(1 - nextRandom(random)));
  return radius * Math.cos(2 * Math.PI * nextRandom(random));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + ERF_P * Math.abs(x));
  const poly = ERF_A.reduceRight((total, coefficient) => total * t + coefficient, 0) * t;
  return sign * (1 - poly * Math.exp(-x * x));
}

export function normalCdf(z: number): number {
  return (1 + erf(z / Math.SQRT2)) / 2;
}

// Показательное распределение со средним mean; 1 − u не даёт логарифма нуля.
export function sampleExponential(random: Random, mean: number): number {
  return -Math.log(1 - nextRandom(random)) * mean;
}

export function chance(random: Random, probability: number): boolean {
  return nextRandom(random) < probability;
}
