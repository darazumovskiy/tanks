// Пульт стенда «плохая сеть»: страница с кнопками и HTTP API. Пинг и неровность меняются у посредника на ходу;
// лаг-компенсация (догон снаряда), снаряд со скоростью танка и сглаживание — настройки сервера при старте, поэтому меняются
// перезапуском процесса сервера на том же порту.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { Agent, createServer, get, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOT_INHERIT_MAX_PERCENT, SHOT_LEAD_MAX_TICKS } from '@tanks/shared/engine';
import type { NetProxy } from './netProxy.js';
import {
  isJitterName,
  isPingMs,
  JITTERS,
  jitterAddedPingMs,
  MAX_PING_MS,
  networkShape,
  type JitterName,
  type NetworkSetting,
} from './networkProfile.js';
import type { GameServer } from './server.js';

// Пинг через посредника за последние замеры, мс; замеров ещё нет — null.
export interface MeasuredPing {
  medianMs: number;
  minMs: number;
  maxMs: number;
  samples: number;
}

// Настройки сервера стенда, которые меняются перезапуском.
export interface ServerSettings {
  shotLeadTicks: number;
  shotInheritPercent: number;
  hasNetSmoothing: boolean;
}

export interface PanelState extends ServerSettings {
  pingMs: number;
  jitter: JitterName;
  // Шаг пачек неровности от и до, мс; без пачек — 0.
  burstMs: number;
  burstMaxMs: number;
  // Сколько неровность сама добавляет к пингу в среднем, мс.
  jitterAddedMs: number;
  measuredPing: MeasuredPing | null;
  isRestarting: boolean;
  // Время последнего удачного перезапуска сервера пультом, мс от эпохи; null — не перезапускался.
  restartedAt: number | null;
  serverError: string | null;
  directPort: number;
  proxyPort: number;
  overflowLastMinute: number;
}

export interface PanelOptions extends ServerSettings {
  port: number;
  host: string;
  proxy: NetProxy;
  server: GameServer;
  network: NetworkSetting;
  directPort: number;
  proxyPort: number;
}

export interface BadNetPanel {
  port: number;
  close(): Promise<void>;
}

const PAGE_FILE = fileURLToPath(new URL('./badNetPanel.html', import.meta.url));
const FONTS_DIR = fileURLToPath(new URL('../../dist/fonts', import.meta.url));
const FONT_ROUTE = '/fonts/';
const FONT_FILE = /^[\w.-]+$/;
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
};
const JSON_TYPE = 'application/json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';
const BODY_LIMIT_BYTES = 4096;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;

// Строки журнала сервера: `ЧЧ:ММ:СС.ммм S gt=<тик> tc=<время боя> input overflow …`, время — UTC. Окно — последняя
// минута; файлы, не менявшиеся дольше окна, не читаются, у больших читается только хвост.
const OVERFLOW_LINE = /^(\d\d):(\d\d):(\d\d)\.(\d\d\d) S (?:gt=\d+ tc=\S+ )?input overflow /;
const LOG_EXTENSION = '.log';
const STATS_WINDOW_MS = 60_000;
const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

// Замер пинга: запрос состояния сервера через посредника по одному держащемуся соединению — круг проходит
// задержку и пачки в обе стороны, как сообщения игры. Ответ дольше `PROBE_TIMEOUT_MS` — замер выброшен.
const PROBE_HOST = '127.0.0.1';
const PROBE_PATH = '/healthz';
const PROBE_INTERVAL_MS = 1000;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_SAMPLES = 20;

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

class PingProbe {
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 1 });
  private readonly samples: number[] = [];
  private readonly timer: NodeJS.Timeout;
  private isWaiting = false;
  // Растёт при смене сети: ответ на запрос, ушедший по старой сети, не попадает в замеры новой.
  private generation = 0;

  constructor(private readonly proxyPort: number) {
    this.timer = setInterval(() => {
      this.probe();
    }, PROBE_INTERVAL_MS);
  }

  reset(): void {
    this.generation += 1;
    this.samples.length = 0;
  }

  measured(): MeasuredPing | null {
    if (this.samples.length === 0) {
      return null;
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      medianMs: Math.round(median(sorted)),
      minMs: Math.round(sorted[0] ?? 0),
      maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
      samples: sorted.length,
    };
  }

  close(): void {
    clearInterval(this.timer);
    this.agent.destroy();
  }

  private probe(): void {
    if (this.isWaiting) {
      return;
    }
    this.isWaiting = true;
    const generation = this.generation;
    const startedAt = performance.now();
    const request = get({ host: PROBE_HOST, port: this.proxyPort, path: PROBE_PATH, agent: this.agent }, (response) => {
      response.resume();
      response.on('end', () => {
        if (generation === this.generation) {
          this.record(performance.now() - startedAt);
        }
      });
    });
    request.setTimeout(PROBE_TIMEOUT_MS, () => request.destroy());
    request.on('error', () => undefined);
    request.on('close', () => {
      this.isWaiting = false;
    });
  }

  private record(roundTripMs: number): void {
    this.samples.push(roundTripMs);
    if (this.samples.length > PROBE_SAMPLES) {
      this.samples.shift();
    }
  }
}

function isIntegerUpTo(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function overflowTimeOfDay(line: string): number | null {
  const match = OVERFLOW_LINE.exec(line);
  if (match === null) {
    return null;
  }
  const [, hh, mm, ss, ms] = match.map(Number);
  return (((hh ?? 0) * 60 + (mm ?? 0)) * 60 + (ss ?? 0)) * 1000 + (ms ?? 0);
}

function logTail(file: string, size: number): string {
  const length = Math.min(size, LOG_TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(file, 'r');
  try {
    readSync(descriptor, buffer, 0, length, size - length);
  } finally {
    closeSync(descriptor);
  }
  return buffer.toString('utf8');
}

function overflowLastMinute(logDir: string, now: number): number {
  if (!existsSync(logDir)) {
    return 0;
  }
  const nowOfDay = now % DAY_MS;
  let count = 0;
  for (const name of readdirSync(logDir)) {
    if (extname(name) !== LOG_EXTENSION) {
      continue;
    }
    const file = join(logDir, name);
    const { mtimeMs, size } = statSync(file);
    if (now - mtimeMs > STATS_WINDOW_MS) {
      continue;
    }
    for (const line of logTail(file, size).split('\n')) {
      const lineOfDay = overflowTimeOfDay(line);
      if (lineOfDay !== null && (nowOfDay - lineOfDay + DAY_MS) % DAY_MS <= STATS_WINDOW_MS) {
        count += 1;
      }
    }
  }
  return count;
}

class PanelControl {
  private network: NetworkSetting;
  private settings: ServerSettings;
  private isRestarting = false;
  private restartedAt: number | null = null;
  private serverError: string | null = null;
  private readonly probe: PingProbe;

  constructor(private readonly options: PanelOptions) {
    this.network = options.network;
    this.settings = {
      shotLeadTicks: options.shotLeadTicks,
      shotInheritPercent: options.shotInheritPercent,
      hasNetSmoothing: options.hasNetSmoothing,
    };
    this.probe = new PingProbe(options.proxyPort);
  }

  state(): PanelState {
    return {
      pingMs: this.network.pingMs,
      jitter: this.network.jitter,
      ...JITTERS[this.network.jitter],
      jitterAddedMs: Math.round(jitterAddedPingMs(this.network.jitter)),
      measuredPing: this.probe.measured(),
      ...this.settings,
      isRestarting: this.isRestarting,
      restartedAt: this.restartedAt,
      serverError: this.serverError,
      directPort: this.options.directPort,
      proxyPort: this.options.proxyPort,
      overflowLastMinute: overflowLastMinute(this.options.server.logDir, Date.now()),
    };
  }

  setNetwork(change: Partial<NetworkSetting>): void {
    this.network = { ...this.network, ...change };
    this.options.proxy.setShape(networkShape(this.network));
    this.probe.reset();
  }

  close(): void {
    this.probe.close();
  }

  get isBusy(): boolean {
    return this.isRestarting;
  }

  async restartServer(settings: ServerSettings): Promise<boolean> {
    this.isRestarting = true;
    this.settings = settings;
    try {
      await this.options.server.restart(serverSettingsEnv(settings));
      this.restartedAt = Date.now();
      this.serverError = null;
      return true;
    } catch (error) {
      this.serverError = errorText(error);
      return false;
    } finally {
      this.isRestarting = false;
    }
  }

  serverSettings(): ServerSettings {
    return { ...this.settings };
  }
}

export function serverSettingsEnv(settings: ServerSettings): Record<string, string> {
  return {
    SHOT_LEAD_TICKS: String(settings.shotLeadTicks),
    SHOT_INHERIT_PERCENT: String(settings.shotInheritPercent),
    NET_SMOOTHING: settings.hasNetSmoothing ? '1' : '0',
  };
}

function send(response: ServerResponse, status: number, type: string, body: string | Buffer): void {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, JSON_TYPE, JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, error: string): void {
  sendJson(response, status, { error });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > BODY_LIMIT_BYTES) {
      return null;
    }
  }
  try {
    const value: unknown = JSON.parse(body);
    const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);
    return isObject ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sendFont(response: ServerResponse, name: string): void {
  const file = join(FONTS_DIR, name);
  const type = CONTENT_TYPES[extname(name)];
  if (!FONT_FILE.test(name) || type === undefined || !existsSync(file)) {
    sendError(response, HTTP_NOT_FOUND, 'нет такого файла');
    return;
  }
  send(response, HTTP_OK, type, readFileSync(file));
}

async function changeNetwork(control: PanelControl, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson(request);
  if (body === null) {
    sendError(response, HTTP_BAD_REQUEST, 'тело — объект JSON');
    return;
  }
  const { pingMs, jitter } = body;
  if (pingMs === undefined && jitter === undefined) {
    sendError(response, HTTP_BAD_REQUEST, 'нужен пинг (pingMs) или неровность (jitter)');
    return;
  }
  if (pingMs !== undefined && !isPingMs(pingMs)) {
    sendError(response, HTTP_BAD_REQUEST, `пинг — целое от 0 до ${String(MAX_PING_MS)}`);
    return;
  }
  if (jitter !== undefined && !isJitterName(jitter)) {
    sendError(response, HTTP_BAD_REQUEST, `неровность — одна из: ${Object.keys(JITTERS).join(', ')}`);
    return;
  }
  control.setNetwork({ ...(pingMs === undefined ? {} : { pingMs }), ...(jitter === undefined ? {} : { jitter }) });
  sendJson(response, HTTP_OK, control.state());
}

async function changeServer(control: PanelControl, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson(request);
  if (body === null) {
    sendError(response, HTTP_BAD_REQUEST, 'тело — объект JSON');
    return;
  }
  const current = control.serverSettings();
  const shotLeadTicks = body.shotLeadTicks ?? current.shotLeadTicks;
  const shotInheritPercent = body.shotInheritPercent ?? current.shotInheritPercent;
  const hasNetSmoothing = body.hasNetSmoothing ?? current.hasNetSmoothing;
  if (!isIntegerUpTo(shotLeadTicks, SHOT_LEAD_MAX_TICKS)) {
    sendError(response, HTTP_BAD_REQUEST, `лаг-компенсация — целое от 0 до ${String(SHOT_LEAD_MAX_TICKS)}`);
    return;
  }
  if (!isIntegerUpTo(shotInheritPercent, SHOT_INHERIT_MAX_PERCENT)) {
    sendError(
      response,
      HTTP_BAD_REQUEST,
      `скорость танка у снаряда — целое от 0 до ${String(SHOT_INHERIT_MAX_PERCENT)}`,
    );
    return;
  }
  if (typeof hasNetSmoothing !== 'boolean') {
    sendError(response, HTTP_BAD_REQUEST, 'сглаживание — true или false');
    return;
  }
  if (control.isBusy) {
    sendError(response, HTTP_CONFLICT, 'сервер уже перезапускается');
    return;
  }
  const isRestarted = await control.restartServer({ shotLeadTicks, shotInheritPercent, hasNetSmoothing });
  sendJson(response, isRestarted ? HTTP_OK : HTTP_SERVER_ERROR, control.state());
}

async function route(
  control: PanelControl,
  page: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = new URL(String(request.url), 'http://localhost').pathname;
  const endpoint = `${String(request.method)} ${path}`;
  if (endpoint === 'GET /') {
    send(response, HTTP_OK, HTML_TYPE, page);
    return;
  }
  if (endpoint === 'GET /api/state') {
    sendJson(response, HTTP_OK, control.state());
    return;
  }
  if (endpoint === 'POST /api/network') {
    await changeNetwork(control, request, response);
    return;
  }
  if (endpoint === 'POST /api/server') {
    await changeServer(control, request, response);
    return;
  }
  if (request.method === 'GET' && path.startsWith(FONT_ROUTE)) {
    sendFont(response, path.slice(FONT_ROUTE.length));
    return;
  }
  sendError(response, HTTP_NOT_FOUND, 'нет такой страницы');
}

export async function startPanel(options: PanelOptions): Promise<BadNetPanel> {
  const control = new PanelControl(options);
  const page = readFileSync(PAGE_FILE, 'utf8');
  const http: Server = createServer((request, response) => {
    route(control, page, request, response).catch((error: unknown) => {
      sendError(response, HTTP_SERVER_ERROR, errorText(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, () => {
      http.off('error', reject);
      resolve();
    });
  }).catch((error: unknown) => {
    control.close();
    throw error;
  });
  return {
    port: (http.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        control.close();
        http.closeAllConnections();
        http.close(() => {
          resolve();
        });
      }),
  };
}
