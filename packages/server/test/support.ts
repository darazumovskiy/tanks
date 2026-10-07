import { once } from 'node:events';
import { request as httpRequest, type IncomingMessage } from 'node:http';

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
const PART_PAUSE_MS = 50;

// Процессорное время своего потока в мс: в отличие от часов процесса, не растёт, пока систему занимают другие.
export function threadCpuMs(): number {
  const usage = process.threadCpuUsage();
  return (usage.user + usage.system) / MICROS_PER_MS;
}

// Тело двумя записями с паузой: вторая гарантированно приходит отдельным куском уже после отказа — иначе
// дочитывание лишнего тела проверялось бы, только если TCP сам порежет тело на куски после лимита.
export async function postInTwoParts(url: string, first: string, second: string): Promise<number | undefined> {
  const request = httpRequest(url, { method: 'POST' });
  const answered = once(request, 'response') as Promise<[IncomingMessage]>;
  request.write(first);
  await sleep(PART_PAUSE_MS);
  request.end(second);
  const [response] = await answered;
  response.resume();
  return response.statusCode;
}
