// Детерминированная случайность для манекена: тест не должен зависеть от удачи.
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MICROS_PER_MS = 1000;

// Процессорное время своего потока в мс: в отличие от часов процесса, не растёт, пока систему занимают другие.
export function threadCpuMs(): number {
  const usage = process.threadCpuUsage();
  return (usage.user + usage.system) / MICROS_PER_MS;
}
