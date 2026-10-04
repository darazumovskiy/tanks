// Генератор с сидом (mulberry32): состояние — одно число, поэтому оно хранится в состоянии матча
// и повтор по журналу даёт те же решения.
export interface Random {
  state: number;
}

export function createRandom(seed: number): Random {
  return { state: seed >>> 0 };
}

// Число в [0, 1).
export function nextRandom(random: Random): number {
  random.state = (random.state + 0x6d2b79f5) >>> 0;
  let t = random.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randomIndex(random: Random, length: number): number {
  return Math.floor(nextRandom(random) * length);
}
