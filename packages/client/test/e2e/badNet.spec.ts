import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  envFileText,
  serverSettingsEnv,
  serverSettingsFromEnvFile,
  startPanel,
  type PanelState,
} from './badNetPanel.js';
import { jitterAddedPingMs, NETWORK_PROFILES, networkShape, parseNetworkArgs } from './networkProfile.js';
import { Player, until } from './player.js';
import { stopChild } from './server.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const LOADER = `${ROOT}/packages/client/test/e2e/tsLoader.mjs`;
const SCRIPT = `${ROOT}/packages/client/test/e2e/badNet.ts`;
const DIRECT_PORT = 8100;
// Запуски целиком — на своих портах: 8099–8101 может занимать стенд оператора. Пульт — на порту перед сервером,
// посредник — после.
const RUN_PORT = 8120;
const RUN_PROXY_PORT = RUN_PORT + 1;
const RUN_PANEL_PORT = RUN_PORT - 1;
const RUN_PORTS = [RUN_PANEL_PORT, RUN_PORT, RUN_PROXY_PORT];
const PANEL_RUN_PORT = 8130;
const PANEL_RUN_PORTS = [PANEL_RUN_PORT - 1, PANEL_RUN_PORT, PANEL_RUN_PORT + 1];
const PANEL_URL = `http://127.0.0.1:${String(PANEL_RUN_PORT - 1)}`;
const PANEL_PROXY_URL = `http://127.0.0.1:${String(PANEL_RUN_PORT + 1)}`;
const READY_LINE = 'Ctrl+C';
const LOG_DIR_LINE = /Журналы сервера: (\S+)/;
const START_TIMEOUT_MS = 15_000;
const FFA_SIZE = 10;
const STATS = '2233';
const JOIN_TIMEOUT_MS = 20_000;
const RECONNECT_TIMEOUT_MS = 30_000;
const OVERFLOW_TIMEOUT_MS = 20_000;
// Ровный пинг 100: страница через посредника отвечает не быстрее 100 мс; без помех — на этой машине почти сразу.
const SMOOTH_ROUND_TRIP_MS = 100;
const SMOOTH_MEASURED_MAX_MS = 140;
const CLEAN_ROUND_TRIP_MS = 50;
const MEASURE_TIMEOUT_MS = 10_000;
const LATENCY_SAMPLES = 3;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
const HOME_REQUEST = 'GET / HTTP/1.1\r\nHost: stand\r\nConnection: close\r\n\r\n';
const BAD_PANEL_REQUESTS: readonly [string, string][] = [
  ['/api/network', JSON.stringify({ jitter: 'evening' })],
  ['/api/network', JSON.stringify({ pingMs: -1 })],
  ['/api/network', JSON.stringify({ pingMs: 1.5 })],
  ['/api/network', JSON.stringify({ pingMs: 2001 })],
  ['/api/network', JSON.stringify({ pingMs: 'сто' })],
  ['/api/network', JSON.stringify({})],
  ['/api/network', 'не json'],
  ['/api/server', JSON.stringify({ shotLeadTicks: 7 })],
  ['/api/server', JSON.stringify({ shotLeadTicks: -1 })],
  ['/api/server', JSON.stringify({ shotLeadTicks: 1.5 })],
  ['/api/server', JSON.stringify({ shotLeadTicks: 'два' })],
  ['/api/server', JSON.stringify({ shotInheritPercent: 101 })],
  ['/api/server', JSON.stringify({ shotInheritPercent: -1 })],
  ['/api/server', JSON.stringify({ shotInheritPercent: 1.5 })],
  ['/api/server', JSON.stringify({ shotInheritPercent: 'сто' })],
  ['/api/server', JSON.stringify({ hasNetSmoothing: 'да' })],
  ['/api/server', 'не json'],
];

const children: ChildProcess[] = [];

test.afterEach(async () => {
  for (const child of children.splice(0)) {
    await stopChild(child, 'SIGKILL');
  }
});

function runBadNet(args: readonly string[]): { child: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, ['--import', LOADER, SCRIPT, ...args], { cwd: ROOT });
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return { child, output: () => output };
}

async function isListening(port: number): Promise<boolean> {
  const socket = connect(port, '127.0.0.1');
  try {
    await once(socket, 'connect');
    return true;
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

async function isAnyListening(ports: readonly number[]): Promise<boolean> {
  for (const port of ports) {
    if (await isListening(port)) {
      return true;
    }
  }
  return false;
}

function logDirOf(output: string): string {
  return LOG_DIR_LINE.exec(output)?.[1] ?? '';
}

async function expectStopped(child: ChildProcess, ports: readonly number[]): Promise<void> {
  const exited = once(child, 'exit');
  child.kill('SIGINT');
  const [code] = (await exited) as [number | null];
  expect(code).toBe(0);
  expect(await isAnyListening(ports)).toBe(false);
}

interface PanelReply {
  status: number;
  body: PanelState & { error?: string };
}

async function callPanel(path: string, body?: string): Promise<PanelReply> {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
  const response = await fetch(`${PANEL_URL}${path}`, init);
  return { status: response.status, body: (await response.json()) as PanelReply['body'] };
}

async function openSocket(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  return socket;
}

// Открытое заранее соединение с сервером: ответил по нему — процесс сервера тот же, что был при открытии.
async function answersOn(socket: Socket): Promise<boolean> {
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.on('error', () => undefined);
  if (!socket.destroyed) {
    socket.write(HOME_REQUEST);
  }
  if (!socket.destroyed) {
    await once(socket, 'close');
  }
  return Buffer.concat(chunks).toString().startsWith('HTTP/1.1 200');
}

async function homeRoundTripMs(baseUrl: string): Promise<number> {
  const samples: number[] = [];
  for (let sample = 0; sample < LATENCY_SAMPLES; sample += 1) {
    const at = performance.now();
    await (await fetch(`${baseUrl}/`)).arrayBuffer();
    samples.push(performance.now() - at);
  }
  return Math.min(...samples);
}

function gameStartLine(logDir: string, gameId: string): string {
  const file = join(logDir, `${gameId}.log`);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  return text.split('\n').find((line) => line.includes(' game start ')) ?? '';
}

interface GameRules {
  gameId: string | null;
  hasNetSmoothing: boolean;
}

function gameRules(page: Page): Promise<GameRules | null> {
  return page.evaluate(() => {
    const game = (window as unknown as { tanksGame?: { debugState(): GameRules & { mode?: string } } }).tanksGame;
    const state = game?.debugState() ?? null;
    return state?.mode === 'ffa' ? { gameId: state.gameId, hasNetSmoothing: state.hasNetSmoothing } : null;
  });
}

test.describe('сеть плохой сети из аргументов', () => {
  test('без аргументов — ночная сеть: пинг 80 и неровность телефона, без сглаживания, порт 8100', () => {
    expect(parseNetworkArgs([])).toEqual({
      network: { pingMs: 80, jitter: 'phone' },
      shotLeadTicks: 0,
      shotInheritPercent: 0,
      hasNetSmoothing: false,
      port: DIRECT_PORT,
    });
  });

  test('сглаживание сети — флаг --smooth-net; порт сервера — --port', () => {
    expect(parseNetworkArgs(['night', '--smooth-net']).hasNetSmoothing).toBe(true);
    expect(parseNetworkArgs(['--port', '8110', 'day'])).toMatchObject({ network: NETWORK_PROFILES.day, port: 8110 });
  });

  test('сокращения ставят пинг и неровность', () => {
    expect(parseNetworkArgs(['day']).network).toEqual({ pingMs: 50, jitter: 'light' });
    expect(parseNetworkArgs(['smooth']).network).toEqual({ pingMs: 100, jitter: 'even' });
  });

  test('форма сети у посредника — половина пинга в каждую сторону, шаг пачек или паузы связи', () => {
    const noStalls = { stallEveryMs: 0, stallMs: 0 };
    expect(networkShape({ pingMs: 80, jitter: 'phone' })).toEqual({
      delayMs: 40,
      burstMs: 150,
      burstMaxMs: 250,
      ...noStalls,
    });
    expect(networkShape({ pingMs: 50, jitter: 'light' })).toEqual({
      delayMs: 25,
      burstMs: 50,
      burstMaxMs: 100,
      ...noStalls,
    });
    expect(networkShape({ pingMs: 100, jitter: 'even' })).toEqual({
      delayMs: 50,
      burstMs: 0,
      burstMaxMs: 0,
      ...noStalls,
    });
    expect(networkShape({ pingMs: 50, jitter: 'stall' })).toEqual({
      delayMs: 25,
      burstMs: 0,
      burstMaxMs: 0,
      stallEveryMs: 2070,
      stallMs: 210,
    });
    expect(networkShape({ pingMs: 75, jitter: 'even' }).delayMs).toBe(37.5);
  });

  test('паузы связи добавляют к пингу в среднем s² / T', () => {
    expect(jitterAddedPingMs('stall')).toBeCloseTo((210 * 210) / 2070, 6);
    expect(parseNetworkArgs(['--ping', '50', '--jitter', 'stall']).network).toEqual({ pingMs: 50, jitter: 'stall' });
  });

  test('пинг и неровность поверх сокращения', () => {
    expect(parseNetworkArgs(['day', '--ping', '150']).network).toEqual({ pingMs: 150, jitter: 'light' });
    expect(parseNetworkArgs(['--jitter', 'even']).network).toEqual({ pingMs: 80, jitter: 'even' });
    expect(parseNetworkArgs(['--ping', '0', 'smooth', '--jitter', 'phone']).network).toEqual({
      pingMs: 0,
      jitter: 'phone',
    });
  });

  test('догон снаряда — флаг --lead, без флага выключен', () => {
    expect(parseNetworkArgs(['night', '--lead', '2'])).toMatchObject({
      network: NETWORK_PROFILES.night,
      shotLeadTicks: 2,
    });
    expect(parseNetworkArgs(['--lead', '0', 'day']).shotLeadTicks).toBe(0);
    expect(parseNetworkArgs(['smooth']).shotLeadTicks).toBe(0);
  });

  test('снаряд со скоростью танка — флаг --inherit, без флага выключен', () => {
    expect(parseNetworkArgs(['night', '--inherit', '100'])).toMatchObject({
      network: NETWORK_PROFILES.night,
      shotInheritPercent: 100,
    });
    expect(parseNetworkArgs(['--inherit', '50', '--lead', '2'])).toMatchObject({
      shotInheritPercent: 50,
      shotLeadTicks: 2,
    });
    expect(parseNetworkArgs(['smooth']).shotInheritPercent).toBe(0);
  });

  for (const args of [
    ['evening'],
    ['--ping'],
    ['--ping', 'x'],
    ['--ping', '2001'],
    ['--jitter'],
    ['--jitter', 'evening'],
    ['--lead'],
    ['--lead', 'два'],
    ['--lead', '-1'],
    ['--inherit'],
    ['--inherit', 'сто'],
    ['--inherit', '-1'],
    ['--port'],
    ['--port', '0'],
    ['--port', '65535'],
    ['--port', 'x'],
  ]) {
    test(`ошибка: ${args.join(' ')}`, () => {
      expect(() => parseNetworkArgs(args)).toThrow();
    });
  }
});

test.describe('npm run bad-net', () => {
  test('поднимает сервер, посредника и пульт, печатает ссылки, Ctrl+C гасит всё', async () => {
    test.skip(await isAnyListening(RUN_PORTS), 'порты запуска заняты');
    const { child, output } = runBadNet([
      'smooth',
      '--lead',
      '2',
      '--inherit',
      '100',
      '--smooth-net',
      '--port',
      String(RUN_PORT),
    ]);
    await expect.poll(output, { timeout: START_TIMEOUT_MS }).toContain(READY_LINE);
    expect(output()).toContain('Лаг-компенсация: тиков: 2');
    expect(output()).toContain('Снаряд со скоростью танка: 100 %');
    expect(output()).toContain('Сглаживание сети: включено');
    expect(output()).toContain(`http://localhost:${String(RUN_PANEL_PORT)}/`);
    expect(output()).toContain(`http://localhost:${String(RUN_PROXY_PORT)}/ffa/10`);
    expect(output()).toContain(`http://localhost:${String(RUN_PORT)}/ffa/10`);
    expect(existsSync(logDirOf(output()))).toBe(true);
    for (const port of RUN_PORTS) {
      const page = await fetch(`http://127.0.0.1:${String(port)}/`);
      expect(page.status).toBe(200);
    }
    await expectStopped(child, RUN_PORTS);
  });

  test('непонятный аргумент — подсказка и код ошибки', async () => {
    const { child, output } = runBadNet(['--ping', 'x']);
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(1);
    expect(output()).toContain('npm run bad-net --');
  });
});

test.describe('пульт bad-net', () => {
  test('сеть меняется на ходу без перезапуска; догон, скорость танка у снаряда и сглаживание — перезапуском сервера', async ({
    browser,
  }) => {
    test.skip(await isAnyListening(PANEL_RUN_PORTS), 'порты пульта заняты');
    const { child, output } = runBadNet(['smooth', '--port', String(PANEL_RUN_PORT)]);
    await expect.poll(output, { timeout: START_TIMEOUT_MS }).toContain(READY_LINE);
    expect(output()).toContain(`http://localhost:${String(PANEL_RUN_PORT - 1)}/`);
    const logDir = logDirOf(output());

    const page = await fetch(`${PANEL_URL}/`);
    expect(page.status).toBe(HTTP_OK);
    expect(await page.text()).toContain('Плохая сеть');
    const font = await fetch(`${PANEL_URL}/fonts/russo-one-cyrillic.woff2`);
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect((await callPanel('/api/state')).body).toMatchObject({
      bench: { pingMs: 100, jitter: 'even', directPort: PANEL_RUN_PORT, proxyPort: PANEL_RUN_PORT + 1 },
      shotLeadTicks: 0,
      shotInheritPercent: 0,
      hasNetSmoothing: false,
      restartedAt: null,
    });
    const measuredMs = async (): Promise<number | null> =>
      (await callPanel('/api/state')).body.bench?.measuredPing?.medianMs ?? null;
    await expect.poll(measuredMs, { timeout: MEASURE_TIMEOUT_MS }).not.toBeNull();
    expect(await measuredMs()).toBeGreaterThanOrEqual(SMOOTH_ROUND_TRIP_MS);
    expect(await measuredMs()).toBeLessThanOrEqual(SMOOTH_MEASURED_MAX_MS);

    expect(await homeRoundTripMs(PANEL_PROXY_URL)).toBeGreaterThanOrEqual(SMOOTH_ROUND_TRIP_MS);
    const kept = await openSocket(PANEL_RUN_PORT);
    const clean = await callPanel('/api/network', JSON.stringify({ pingMs: 0 }));
    expect(clean.status).toBe(HTTP_OK);
    expect(clean.body).toMatchObject({ bench: { pingMs: 0, jitter: 'even', measuredPing: null } });
    expect(await answersOn(kept)).toBe(true);
    expect(await homeRoundTripMs(PANEL_PROXY_URL)).toBeLessThan(CLEAN_ROUND_TRIP_MS);
    await expect.poll(measuredMs, { timeout: MEASURE_TIMEOUT_MS }).not.toBeNull();
    expect(await measuredMs()).toBeLessThan(CLEAN_ROUND_TRIP_MS);

    for (const [path, body] of BAD_PANEL_REQUESTS) {
      expect((await callPanel(path, body)).status, `${path} ${body}`).toBe(HTTP_BAD_REQUEST);
    }
    expect((await callPanel('/api/state')).body).toMatchObject({
      bench: { pingMs: 0, jitter: 'even' },
      shotLeadTicks: 0,
      shotInheritPercent: 0,
      hasNetSmoothing: false,
    });

    const player = await Player.openFfa(browser, PANEL_PROXY_URL, FFA_SIZE, 'Пульт', STATS);
    try {
      const before = await player.waitForFfa((state) => state.gameId !== null, JOIN_TIMEOUT_MS, 'вход в бой');
      const dropped = await openSocket(PANEL_RUN_PORT);
      const lead = await callPanel('/api/server', JSON.stringify({ shotLeadTicks: 2 }));
      expect(lead.status).toBe(HTTP_OK);
      expect(lead.body).toMatchObject({
        shotLeadTicks: 2,
        hasNetSmoothing: false,
        isRestarting: false,
        serverError: null,
      });
      expect(lead.body.restartedAt).not.toBeNull();
      expect(await answersOn(dropped)).toBe(false);
      const afterLead = await player.waitForFfa(
        (state) => state.gameId !== null && state.gameId !== before.gameId,
        RECONNECT_TIMEOUT_MS,
        'новая игра после перезапуска с догоном',
      );
      await expect.poll(() => gameStartLine(logDir, afterLead.gameId ?? '')).toMatch(/ lead=2 inherit=0\b/);

      const inherit = await callPanel('/api/server', JSON.stringify({ shotInheritPercent: 100 }));
      expect(inherit.status).toBe(HTTP_OK);
      expect(inherit.body).toMatchObject({ shotLeadTicks: 2, shotInheritPercent: 100, isRestarting: false });
      const afterInherit = await player.waitForFfa(
        (state) => state.gameId !== null && state.gameId !== afterLead.gameId,
        RECONNECT_TIMEOUT_MS,
        'новая игра после перезапуска со снарядом со скоростью танка',
      );
      await expect.poll(() => gameStartLine(logDir, afterInherit.gameId ?? '')).toMatch(/ lead=2 inherit=100$/);

      const replies = await Promise.all([
        callPanel('/api/server', JSON.stringify({ hasNetSmoothing: true })),
        callPanel('/api/server', JSON.stringify({ hasNetSmoothing: true })),
      ]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([HTTP_OK, HTTP_CONFLICT]);
      expect((await callPanel('/api/state')).body).toMatchObject({
        shotLeadTicks: 2,
        shotInheritPercent: 100,
        hasNetSmoothing: true,
      });
      await until(
        async () => {
          const rules = await gameRules(player.page);
          const isNewGame = rules !== null && rules.gameId !== null && rules.gameId !== afterInherit.gameId;
          return isNewGame && rules.hasNetSmoothing ? rules : null;
        },
        RECONNECT_TIMEOUT_MS,
        'сглаживание в открытой вкладке без перезагрузки',
      );

      expect((await callPanel('/api/state')).body.overflowLastMinute).toBe(0);
      const phone = await callPanel('/api/network', JSON.stringify({ jitter: 'phone' }));
      expect(phone.body).toMatchObject({ bench: { pingMs: 0, jitter: 'phone' } });
      await expect
        .poll(async () => (await callPanel('/api/state')).body.overflowLastMinute, { timeout: OVERFLOW_TIMEOUT_MS })
        .toBeGreaterThan(0);
    } finally {
      await player.close();
    }
    await expectStopped(child, PANEL_RUN_PORTS);
  });
});

test.describe('пульт без посредника — админка тестовой машины', () => {
  test('файл настроек: туда и обратно; чужие и битые значения — выключено', () => {
    const settings = { shotLeadTicks: 4, shotInheritPercent: 50, hasNetSmoothing: true };
    expect(serverSettingsFromEnvFile(envFileText(serverSettingsEnv(settings)))).toEqual(settings);
    expect(serverSettingsFromEnvFile('')).toEqual({ shotLeadTicks: 0, shotInheritPercent: 0, hasNetSmoothing: false });
    expect(
      serverSettingsFromEnvFile('SHOT_LEAD_TICKS=7\nSHOT_INHERIT_PERCENT=сто\nNET_SMOOTHING=yes\nWALL_SLIDE=30\n'),
    ).toEqual({ shotLeadTicks: 0, shotInheritPercent: 0, hasNetSmoothing: false });
  });

  test('только настройки сервера: сети нет, смена — перезапуск с полным набором переменных', async () => {
    const restarts: Record<string, string>[] = [];
    let failure: Error | null = null;
    const server = {
      logDir: mkdtempSync(join(tmpdir(), 'tanks-admin-log-')),
      restart: (env: Record<string, string>): Promise<void> => {
        restarts.push(env);
        return failure === null ? Promise.resolve() : Promise.reject(failure);
      },
    };
    const panel = await startPanel({
      port: 0,
      host: '127.0.0.1',
      server,
      bench: null,
      serverName: 'test · tanks-test',
      shotLeadTicks: 0,
      shotInheritPercent: 0,
      hasNetSmoothing: true,
    });
    const url = `http://127.0.0.1:${String(panel.port)}`;
    const call = async (path: string, body?: string): Promise<PanelReply> => {
      const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
      const response = await fetch(`${url}${path}`, init);
      return { status: response.status, body: (await response.json()) as PanelReply['body'] };
    };
    try {
      expect((await fetch(`${url}/`)).status).toBe(HTTP_OK);
      expect((await call('/api/state')).body).toMatchObject({
        bench: null,
        serverName: 'test · tanks-test',
        shotLeadTicks: 0,
        hasNetSmoothing: true,
      });
      expect((await call('/api/network', JSON.stringify({ pingMs: 0 }))).status).toBe(HTTP_NOT_FOUND);

      const lead = await call('/api/server', JSON.stringify({ shotLeadTicks: 4 }));
      expect(lead.status).toBe(HTTP_OK);
      expect(lead.body).toMatchObject({ shotLeadTicks: 4, serverError: null, isRestarting: false });
      expect(lead.body.restartedAt).not.toBeNull();
      expect(restarts).toEqual([{ SHOT_LEAD_TICKS: '4', SHOT_INHERIT_PERCENT: '0', NET_SMOOTHING: '1' }]);

      failure = new Error('служба не поднялась');
      const failed = await call('/api/server', JSON.stringify({ hasNetSmoothing: false }));
      expect(failed.status).toBe(HTTP_SERVER_ERROR);
      expect(failed.body.serverError).toBe('служба не поднялась');
    } finally {
      await panel.close();
    }
  });
});
