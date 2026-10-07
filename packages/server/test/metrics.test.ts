import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
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
const SYSTEM_CPU_SERIES = [
  'tanks_cpu_pressure_seconds_total{scope="machine"}',
  'tanks_cpu_pressure_seconds_total{scope="game"}',
  'tanks_cpu_steal_seconds_total',
];
const SERIES_WITH_SYSTEM_CPU = EXPECTED_SERIES.flatMap((key) =>
  key === 'process_resident_memory_bytes' ? [...SYSTEM_CPU_SERIES, key] : [key],
);
const GAME_CGROUP = '/system.slice/tanks.service';
const MACHINE_PRESSURE = 'proc/pressure/cpu';
const OWN_CGROUP = 'proc/self/cgroup';
const GAME_PRESSURE = `sys/fs/cgroup${GAME_CGROUP}/cpu.pressure`;
const STAT = 'proc/stat';

let app: App;
let port: number;
const clients: TestClient[] = [];
const systemRoots: string[] = [];

function systemRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'tanks-system-'));
  systemRoots.push(root);
  writeSystemFiles(root, files);
  return root;
}

function writeSystemFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function pressureText(totalMicros: number): string {
  return `full avg10=0.00 avg60=0.00 avg300=0.00 total=7\nsome avg10=0.85 avg60=0.83 avg300=0.96 total=${String(totalMicros)}\n`;
}

function statText(stealTicks: number): string {
  return `cpu  5050 1398 3931 130405 70 0 346 ${String(stealTicks)} 0 0\ncpu0 2525 699 1965 65202 35 0 173 4 0 0\n`;
}

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

async function startApp(tickMs: number, root = systemRoot({})): Promise<void> {
  app = createApp({ room: FAST_ROOM, random: seededRandom(42), tickMs, systemRoot: root });
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

afterAll(() => {
  for (const root of systemRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
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

  it('игроки по видам: люди и серверные боты общей игры, бот роя, люди, бот лестницы и двойник в дуэли; ход ботов', async () => {
    const human = await connect();
    human.join('ffa10', 'Дима');
    const swarmBot = await connect();
    swarmBot.join('ffa30', 'Рой', DEFAULT_STATS, PROTOCOL_VERSION, '', true);
    const duelist = await connect();
    duelist.join('bot04x', 'Дуэлянт');
    await duelist.nextOfType(MessageType.RoundStart);
    const twinDuelist = await connect();
    twinDuelist.join('twinx', 'Себя-победитель');
    await twinDuelist.nextOfType(MessageType.RoundStart);
    let series = await scrape();
    const deadline = Date.now() + SCRAPE_WAIT_MS;
    while (valueOf(series, 'tanks_bot_think_ms{quantile="max"}') === 0 && Date.now() < deadline) {
      await sleep(5 * TICK_MS);
      series = await scrape();
    }
    const players = [...series].filter(([key, value]) => key.startsWith('tanks_players') && value !== 0);
    expect(Object.fromEntries(players)).toEqual({
      'tanks_players{mode="duel",kind="human"}': 2,
      'tanks_players{mode="duel",kind="bot"}': 2,
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

  it('давление на процессор машины и игры и steal читаются из системных файлов на каждый запрос', async () => {
    await app.close();
    const root = systemRoot({
      [MACHINE_PRESSURE]: pressureText(29_794_109),
      [OWN_CGROUP]: `1:name=systemd:/legacy\n0::${GAME_CGROUP}\n`,
      [GAME_PRESSURE]: pressureText(5_521_267),
      [STAT]: statText(123),
    });
    await startApp(TICK_MS, root);

    const first = await scrape();
    expect([...first.keys()]).toEqual(SERIES_WITH_SYSTEM_CPU);
    expect(valueOf(first, 'tanks_cpu_pressure_seconds_total{scope="machine"}')).toBe(29.794109);
    expect(valueOf(first, 'tanks_cpu_pressure_seconds_total{scope="game"}')).toBe(5.521267);
    expect(valueOf(first, 'tanks_cpu_steal_seconds_total')).toBe(1.23);

    writeSystemFiles(root, {
      [MACHINE_PRESSURE]: pressureText(30_000_000),
      [GAME_PRESSURE]: pressureText(6_000_000),
      [STAT]: statText(456),
    });
    const second = await scrape();
    expect(valueOf(second, 'tanks_cpu_pressure_seconds_total{scope="machine"}')).toBe(30);
    expect(valueOf(second, 'tanks_cpu_pressure_seconds_total{scope="game"}')).toBe(6);
    expect(valueOf(second, 'tanks_cpu_steal_seconds_total')).toBe(4.56);
  });

  it.each([
    {
      name: 'без строки some, без группы 0::, без строки cpu',
      files: {
        [MACHINE_PRESSURE]: 'full avg10=0.00 avg60=0.00 avg300=0.00 total=5\n',
        [OWN_CGROUP]: '1:name=systemd:/legacy\n',
        [STAT]: 'intr 5\n',
      },
    },
    {
      name: 'some без total, нет cpu.pressure своей группы, строка cpu короче восьми чисел',
      files: {
        [MACHINE_PRESSURE]: 'some avg10=0.00 avg60=0.00 avg300=0.00\n',
        [OWN_CGROUP]: `0::${GAME_CGROUP}\n`,
        [STAT]: 'cpu  1 2 3 4 5 6 7\n',
      },
    },
  ])('системные файлы не разобрались ($name) — рядов давления и steal нет', async ({ files }) => {
    await app.close();
    await startApp(TICK_MS, systemRoot(files));

    const series = await scrape();
    expect([...series.keys()]).toEqual(EXPECTED_SERIES);
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
