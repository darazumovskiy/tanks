export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[middle - 1] ?? 0;
  return (lower + upper) / 2;
}

export function pct(part: number, total: number): number | null {
  if (total === 0) {
    return null;
  }
  return roundTo((100 * part) / total, 1);
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

export function count<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let total = 0;
  for (const item of items) {
    if (predicate(item)) {
      total++;
    }
  }
  return total;
}

// При равенстве частот побеждает значение, встретившееся раньше.
export function mostCommon(values: readonly number[]): number | null {
  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [value, total] of counts) {
    if (total > bestCount) {
      best = value;
      bestCount = total;
    }
  }
  return best;
}

// При равном расстоянии побеждает кандидат, стоящий в списке раньше.
export function nearest(value: number, candidates: readonly number[]): number {
  let best = candidates[0] ?? value;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
