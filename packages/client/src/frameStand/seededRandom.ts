// mulberry32 вместо `Math.random` страницы: частицы, тряска и конфетти повторяются от показа к показу.
// Возвращает сброс последовательности к началу.
export function installSeededRandom(seed: number): () => void {
  const increment = 0x6d2b79f5;
  const range = 4294967296;
  let state = seed;
  Math.random = (): number => {
    state = (state + increment) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / range;
  };
  return (): void => {
    state = seed;
  };
}
