import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STATS } from '@tanks/shared/engine';
import { MessageType, PROTOCOL_VERSION } from '@tanks/shared/protocol';
import { createApp, type App } from '../src/app.js';
import { Room } from '../src/room.js';
import { TestClient } from './client.js';
import { seededRandom, sleep } from './support.js';

const FAST_ROOM = { countdownTicks: 3, roundEndTicks: 3, maxInputsPerSecond: 90 };
const TICK_MS = 4;
const SCRAPE_WAIT_MS = 5000;
const EXPECTED_SERIES = [
  'tanks_tick_duration_ms{quantile="0.5"}',
  'tanks_tick_duration_ms{quantile="0.99"}',
  'tanks_tick_duration_ms{quantile="max"}',
  'tanks_event_loop_delay_ms{quantile="0.5"}',
  'tanks_event_loop_delay_ms{quantile="0.99"}',
  'tanks_event_loop_delay_ms{quantile="max"}',
  'tanks_bot_think_ms{quantile="0.5"}',
  'tanks_bot_think_ms{quantile="0.99"}',
  'tanks_bot_think_ms{quantile="max"}',
  'tanks_bot_wait_ticks{quantile="0.5"}',
  'tanks_bot_wait_ticks{quantile="0.99"}',
  'tanks_bot_wait_ticks{quantile="max"}',
  'tanks_bot_skipped_total',
  'tanks_ticks_total',
  'tanks_ticks_late_total',
  'tanks_rooms',
  'tanks_connections',
  ...['duel', 'ffa10', 'ffa30', 'ffa50'].flatMap((mode) =>
    ['human', 'bot', 'swarm'].map((kind) => `tanks_players{mode="${mode}",kind="${kind}"}`),
  ),
  'tanks_messages_total{direction="in"}',
  'tanks_messages_total{direction="out"}',
  'tanks_bytes_total{direction="in"}',
  'tanks_bytes_total{direction="out"}',
  'tanks_inputs_dropped_total{reason="stale"}',
  'tanks_inputs_dropped_total{reason="limit"}',
  'tanks_inputs_dropped_total{reason="overflow"}',
  'tanks_inputs_dropped_total{reason="backlog"}',
  'process_resident_memory_bytes',
  'process_cpu_seconds_total',
  'process_start_time_seconds',
];

let app: App;
let port: number;
const clients: TestClient[] = [];

async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(port);
  clients.push(client);
  return client;
}

type Series = Map<string, number>;

async function scrape(): Promise<Series> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
  const series: Series = new Map();
  for (const line of (await response.text()).split('\n')) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const space = line.lastIndexOf(' ');
    series.set(line.slice(0, space), Number(line.slice(space + 1)));
  }
  return series;
}

function valueOf(series: Series, key: string): number {
  const value = series.get(key);
  expect(value, key).toBeDefined();
  return value ?? 0;
}

async function startApp(tickMs: number): Promise<void> {
  app = createApp({ room: FAST_ROOM, random: seededRandom(42), tickMs });
  port = await app.listen(0, '127.0.0.1');
}

beforeEach(async () => {
  await startApp(TICK_MS);
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await app.close();
});

describe('GET /metrics', () => {
  it('на пустом сервере отдаёт все ряды, комнат и сокетов ноль, память и старт процесса заполнены', async () => {
    const series = await scrape();
    expect([...series.keys()]).toEqual(EXPECTED_SERIES);
    expect(valueOf(series, 'tanks_rooms')).toBe(0);
    expect(valueOf(series, 'tanks_connections')).toBe(0);
    expect(valueOf(series, 'tanks_bot_skipped_total')).toBe(0);
    expect([...series].filter(([key, value]) => key.startsWith('tanks_players') && value !== 0)).toEqual([]);
    expect(valueOf(series, 'tanks_inputs_dropped_total{reason="stale"}')).toBe(0);
    expect(valueOf(series, 'process_resident_memory_bytes')).toBeGreaterThan(0);
    expect(valueOf(series, 'process_cpu_seconds_total')).toBeGreaterThan(0);
    expect(valueOf(series, 'process_start_time_seconds')).toBeLessThanOrEqual(Date.now() / 1000);
  });

  it('во время дуэли считает комнаты, сокеты, сообщения и байты в обе стороны', async () => {
    const a = await connect();
    const b = await connect();
    a.join('metr1', 'Алиса');
    b.join('metr1', 'Боб');
    await a.nextOfType(MessageType.RoundStart);
    await b.nextOfType(MessageType.RoundStart);
    const inputs = 10;
    for (let i = 0; i < inputs; i++) {
      a.input({ throttle: 1 });
    }
    // Под нагрузкой таймер тика опаздывает: ждать нужного числа тиков, а не фиксированного времени.
    let series = await scrape();
    const deadline = Date.now() + SCRAPE_WAIT_MS;
    while (valueOf(series, 'tanks_ticks_total') <= 10 && Date.now() < deadline) {
      await sleep(20 * TICK_MS);
      series = await scrape();
    }
    expect(valueOf(series, 'tanks_rooms')).toBe(1);
    expect(valueOf(series, 'tanks_connections')).toBe(2);
    expect(valueOf(series, 'tanks_ticks_total')).toBeGreaterThan(10);
    expect(valueOf(series, 'tanks_messages_total{direction="in"}')).toBe(inputs + 2);
    expect(valueOf(series, 'tanks_bytes_total{direction="in"}')).toBeGreaterThan(inputs);
    const snapshotsOut = valueOf(series, 'tanks_messages_total{direction="out"}');
    expect(snapshotsOut).toBeGreaterThan(20);
    expect(valueOf(series, 'tanks_bytes_total{direction="out"}')).toBeGreaterThan(snapshotsOut);
    expect(valueOf(series, 'tanks_tick_duration_ms{quantile="max"}')).toBeGreaterThan(0);
    expect(valueOf(series, 'tanks_tick_duration_ms{quantile="0.5"}')).toBeLessThanOrEqual(
      valueOf(series, 'tanks_tick_duration_ms{quantile="max"}'),
    );
  });

  it('игроки по видам: люди и серверные боты общей игры, бот роя, человек и бот лестницы в дуэли; ход ботов', async () => {
    const human = await connect();
    human.join('ffa10', 'Дима');
    const swarmBot = await connect();
    swarmBot.join('ffa30', 'Рой', DEFAULT_STATS, PROTOCOL_VERSION, '', true);
    const duelist = await connect();
    duelist.join('bot04x', 'Дуэлянт');
    await duelist.nextOfType(MessageType.RoundStart);
    let series = await scrape();
    const deadline = Date.now() + SCRAPE_WAIT_MS;
    while (valueOf(series, 'tanks_bot_think_ms{quantile="max"}') === 0 && Date.now() < deadline) {
      await sleep(5 * TICK_MS);
      series = await scrape();
    }
    const players = [...series].filter(([key, value]) => key.startsWith('tanks_players') && value !== 0);
    expect(Object.fromEntries(players)).toEqual({
      'tanks_players{mode="duel",kind="human"}': 1,
      'tanks_players{mode="duel",kind="bot"}': 1,
      'tanks_players{mode="ffa10",kind="human"}': 1,
      'tanks_players{mode="ffa10",kind="bot"}': 6,
      'tanks_players{mode="ffa30",kind="swarm"}': 1,
    });
    expect(valueOf(series, 'tanks_bot_think_ms{quantile="max"}')).toBeGreaterThan(0);
  });

  it('отброшенные команды считаются по причине ровно по числу отброшенных', async () => {
    const a = await connect();
    const b = await connect();
    a.join('metr2', 'Алиса');
    b.join('metr2', 'Боб');
    await a.nextOfType(MessageType.RoundStart);
    await b.nextOfType(MessageType.RoundStart);
    const overLimit = 5;
    for (let i = 0; i < FAST_ROOM.maxInputsPerSecond + overLimit; i++) {
      a.input({ throttle: 1 });
    }
    const staleCount = 3;
    for (let i = 0; i < staleCount; i++) {
      a.send({ type: MessageType.Input, seq: 1, action: { throttle: 0, turn: 0, turretTurn: 0, isFiring: false } });
    }
    await sleep(5 * TICK_MS);

    const series = await scrape();
    expect(valueOf(series, 'tanks_inputs_dropped_total{reason="limit"}')).toBe(overLimit);
    expect(valueOf(series, 'tanks_inputs_dropped_total{reason="stale"}')).toBe(staleCount);
  });

  it('комната без счётчика (стенд бот против бота) отбрасывает устаревшую команду молча', () => {
    const room = new Room('solo', FAST_ROOM);
    const idle = { throttle: 0, turn: 0, turretTurn: 0, isFiring: false };
    const seat = room.join(0, { send: () => undefined }, 'А', DEFAULT_STATS);
    room.join(1, { send: () => undefined }, 'Б', DEFAULT_STATS);
    seat.input(1, idle);
    expect(() => {
      seat.input(1, idle);
    }).not.toThrow();
  });

  it('квантили тика считаются за окно с прошлого запроса, счётчики не уменьшаются', async () => {
    await app.close();
    const slowTickMs = 300;
    await startApp(slowTickMs);

    const beforeFirstTick = await scrape();
    expect(valueOf(beforeFirstTick, 'tanks_ticks_total')).toBe(0);
    expect(valueOf(beforeFirstTick, 'tanks_tick_duration_ms{quantile="max"}')).toBe(0);

    await sleep(slowTickMs * 1.5);
    const afterTick = await scrape();
    expect(valueOf(afterTick, 'tanks_ticks_total')).toBe(1);
    expect(valueOf(afterTick, 'tanks_tick_duration_ms{quantile="max"}')).toBeGreaterThan(0);

    const emptyWindow = await scrape();
    expect(valueOf(emptyWindow, 'tanks_ticks_total')).toBe(1);
    expect(valueOf(emptyWindow, 'tanks_tick_duration_ms{quantile="max"}')).toBe(0);
  });

  it('остановка процесса видна как опоздавшие тики и задержка цикла событий', async () => {
    await sleep(10 * TICK_MS);
    await scrape();
    const blockMs = 25 * TICK_MS;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
    await sleep(5 * TICK_MS);

    const series = await scrape();
    expect(valueOf(series, 'tanks_ticks_late_total')).toBeGreaterThanOrEqual(1);
    expect(valueOf(series, 'tanks_event_loop_delay_ms{quantile="max"}')).toBeGreaterThanOrEqual(blockMs * 0.8);
    expect(valueOf(series, 'tanks_event_loop_delay_ms{quantile="0.5"}')).toBeLessThanOrEqual(
      valueOf(series, 'tanks_event_loop_delay_ms{quantile="max"}'),
    );
  });
});
