import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { connect, createServer, type AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { NetProxy, type NetProxyOptions } from './netProxy.js';

const LOOPBACK = '127.0.0.1';
const CHUNKS = 400;
const CHUNK_EVERY_MS = 3;
const NUMBERS_PER_CHUNK = 16;
const BYTES_PER_NUMBER = 4;
// Куски одной пачки приходят почти разом; разрыв больше этого — уже следующая пачка.
const SAME_BURST_MS = 15;
const DELIVERY_TIMEOUT_MS = 10_000;
const POLL_MS = 20;

interface Stream {
  sent: Buffer;
  received: Buffer;
  burstGaps: number[];
}

function numberedChunk(index: number): Buffer {
  const chunk = Buffer.alloc(NUMBERS_PER_CHUNK * BYTES_PER_NUMBER);
  for (let slot = 0; slot < NUMBERS_PER_CHUNK; slot += 1) {
    chunk.writeUInt32BE(index * NUMBERS_PER_CHUNK + slot, slot * BYTES_PER_NUMBER);
  }
  return chunk;
}

function burstGaps(arrivals: readonly number[]): number[] {
  const starts = arrivals.filter((at, index) => index === 0 || at - (arrivals[index - 1] ?? at) > SAME_BURST_MS);
  return starts.slice(1).map((at, index) => at - (starts[index] ?? at));
}

// Поток нумерованных кусков уходит через посредника в TCP-эхо и обратно — дважды через очереди пачек. beforeChunk —
// до отправки куска с этим номером, например смена сети на ходу.
async function streamThroughEcho(
  options: NetProxyOptions,
  beforeChunk: (index: number, proxy: NetProxy) => void = () => undefined,
): Promise<Stream> {
  const echo = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => echo.listen(0, LOOPBACK, resolve));
  const proxy = await NetProxy.start((echo.address() as AddressInfo).port, options);
  const client = connect(proxy.port, LOOPBACK);
  await once(client, 'connect');
  const received: Buffer[] = [];
  const arrivals: number[] = [];
  client.on('data', (chunk: Buffer) => {
    received.push(chunk);
    arrivals.push(performance.now());
  });
  const sent: Buffer[] = [];
  for (let index = 0; index < CHUNKS; index += 1) {
    beforeChunk(index, proxy);
    const chunk = numberedChunk(index);
    client.write(chunk);
    sent.push(chunk);
    await sleep(CHUNK_EVERY_MS);
  }
  const total = Buffer.concat(sent).length;
  const deadline = performance.now() + DELIVERY_TIMEOUT_MS;
  while (Buffer.concat(received).length < total && performance.now() < deadline) {
    await sleep(POLL_MS);
  }
  client.destroy();
  await proxy.close();
  await new Promise<void>((resolve) => {
    echo.close(() => {
      resolve();
    });
  });
  return { sent: Buffer.concat(sent), received: Buffer.concat(received), burstGaps: burstGaps(arrivals) };
}

function spread(values: readonly number[]): number {
  return Math.max(...values) - Math.min(...values);
}

test.describe('посредник: пачки', () => {
  test('неровные пачки — поток приходит целиком и по порядку, шаг пачек гуляет', async () => {
    const stream = await streamThroughEcho({ delayMs: 20, burstMs: 40, burstMaxMs: 140 });
    expect(stream.received.length).toBe(stream.sent.length);
    expect(stream.received.equals(stream.sent)).toBe(true);
    expect(stream.burstGaps.length).toBeGreaterThan(5);
    expect(Math.min(...stream.burstGaps)).toBeGreaterThanOrEqual(40 - SAME_BURST_MS);
    expect(spread(stream.burstGaps)).toBeGreaterThan(40);
  });

  test('ровные пачки — поток целиком и по порядку, шаг пачек постоянный', async () => {
    const stream = await streamThroughEcho({ delayMs: 20, burstMs: 80 });
    expect(stream.received.equals(stream.sent)).toBe(true);
    expect(stream.burstGaps.length).toBeGreaterThan(5);
    expect(spread(stream.burstGaps)).toBeLessThan(25);
  });
});

test.describe('посредник: смена сети на ходу', () => {
  const NIGHT: NetProxyOptions = { delayMs: 40, burstMs: 150, burstMaxMs: 250 };
  const CLEAN: NetProxyOptions = { delayMs: 0, burstMs: 0, burstMaxMs: 0 };

  test('ночная → без помех → ночная → без помех — поток целиком и по порядку', async () => {
    const quarter = CHUNKS / 4;
    const stream = await streamThroughEcho(NIGHT, (index, proxy) => {
      if (index > 0 && index % quarter === 0) {
        proxy.setShape((index / quarter) % 2 === 1 ? CLEAN : NIGHT);
      }
    });
    expect(stream.received.length).toBe(stream.sent.length);
    expect(stream.received.equals(stream.sent)).toBe(true);
  });

  test('ровная задержка 300 мс → без помех — куски после смены ждут ушедших раньше', async () => {
    const stream = await streamThroughEcho({ delayMs: 300 }, (index, proxy) => {
      if (index === CHUNKS / 2) {
        proxy.setShape(CLEAN);
      }
    });
    expect(stream.received.length).toBe(stream.sent.length);
    expect(stream.received.equals(stream.sent)).toBe(true);
  });
});
