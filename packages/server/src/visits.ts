import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { GameLog } from './gameLog.js';
import type { GeoLookup } from './geo.js';
import { readBody } from './httpBody.js';

export const VISIT_ROUTE = '/visit';
export const VISITS_DIR = 'visits';
const VISIT_SOURCE = 'V';
// Соединение отсюда — Caddy на той же машине: только ему верим в X-Forwarded-For.
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = ['127.0.0.1', '::1'];
// Живой игрок открывает страницу несколько раз в минуту; потолок дня — около 40 МБ визитов на диске и в Loki.
export const DEFAULT_VISIT_LIMITS: VisitLimits = { perMinute: 60, perDay: 20_000 };
const VISIT_BODY_LIMIT_BYTES = 16 * 1024;
const DEVICE_ID_PATTERN = /^[a-z0-9]{16,32}$/;
const ACCEPT_LANGUAGE_MAX = 100;
const IPV4_MAPPED_PREFIX = '::ffff:';
const DATE_KEY_LENGTH = 10;
const MINUTE_MS = 60_000;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_MANY_REQUESTS = 429;

export interface VisitLimits {
  perMinute: number;
  perDay: number;
}

function dateKey(now: Date): string {
  return now.toISOString().slice(0, DATE_KEY_LENGTH);
}

// Счёт визитов в памяти: окно минуты на адрес и потолок дня (UTC) на весь сервер — диск и квоту логов не засыпать.
export class VisitLimiter {
  private minuteStart = -Infinity;
  private readonly perAddress = new Map<string, number>();
  private day = '';
  private dayCount = 0;

  constructor(private readonly limits: VisitLimits) {}

  allow(ip: string, now: Date): boolean {
    if (now.getTime() - this.minuteStart >= MINUTE_MS) {
      this.minuteStart = now.getTime();
      this.perAddress.clear();
    }
    const day = dateKey(now);
    if (day !== this.day) {
      this.day = day;
      this.dayCount = 0;
    }
    const count = this.perAddress.get(ip) ?? 0;
    if (count >= this.limits.perMinute || this.dayCount >= this.limits.perDay) {
      return false;
    }
    this.perAddress.set(ip, count + 1);
    this.dayCount++;
    return true;
  }
}

type FieldRule = { kind: 'text'; max: number } | { kind: 'number'; min: number; max: number } | { kind: 'flag' };
type FieldValue = string | number | boolean;

function text(max: number): FieldRule {
  return { kind: 'text', max };
}

function range(min: number, max: number): FieldRule {
  return { kind: 'number', min, max };
}

const FLAG: FieldRule = { kind: 'flag' };

const VISIT_FIELDS: Readonly<Record<string, FieldRule>> = {
  visit: range(1, 1e9),
  firstVisit: text(32),
  from: text(40),
  firstFrom: text(40),
  page: text(64),
  nick: text(32),
  ref: text(300),
  ua: text(400),
  model: text(64),
  platformVersion: text(32),
  langs: text(100),
  tz: text(64),
  tzOffset: range(-1000, 1000),
  cores: range(1, 1024),
  memory: range(0, 1024),
  gpu: text(160),
  net: text(16),
  downlink: range(0, 100_000),
  rtt: range(0, 100_000),
  saveData: FLAG,
  viewport: text(16),
  dark: FLAG,
  reducedMotion: FLAG,
};

const CLIENT_FIELDS: Readonly<Record<string, FieldRule>> = {
  platform: text(16),
  shell: text(16),
  os: text(32),
  osVersion: text(32),
  browser: text(32),
  browserVersion: text(32),
  appVersion: text(32),
  screen: text(16),
  dpr: range(0, 16),
  touch: FLAG,
};

// now — часы в мс от эпохи: время записи, файл дня и окна ограничителя.
export interface VisitDeps {
  log: GameLog;
  geo: GeoLookup;
  trustedProxies: ReadonlySet<string>;
  limiter: VisitLimiter;
  now: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkField(value: unknown, rule: FieldRule): FieldValue | null {
  if (rule.kind === 'text') {
    return typeof value === 'string' ? value.slice(0, rule.max) : null;
  }
  if (rule.kind === 'flag') {
    return typeof value === 'boolean' ? value : null;
  }
  const isInRange = typeof value === 'number' && Number.isFinite(value) && value >= rule.min && value <= rule.max;
  return isInRange ? value : null;
}

// Белый список: незнакомые ключи и значения не того типа выбрасываются, строки обрезаются по длине поля.
function pickFields(
  source: Record<string, unknown>,
  rules: Readonly<Record<string, FieldRule>>,
): Record<string, FieldValue> {
  const picked: Record<string, FieldValue> = {};
  for (const [key, rule] of Object.entries(rules)) {
    const value = checkField(source[key], rule);
    if (value !== null) {
      picked[key] = value;
    }
  }
  return picked;
}

function parseVisit(body: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(raw)) {
    return null;
  }
  const dev = raw.dev;
  if (typeof dev !== 'string' || !DEVICE_ID_PATTERN.test(dev)) {
    return null;
  }
  const client = isRecord(raw.client) ? { client: pickFields(raw.client, CLIENT_FIELDS) } : {};
  return { dev, ...pickFields(raw, VISIT_FIELDS), ...client };
}

function plainAddress(address: string): string {
  return address.startsWith(IPV4_MAPPED_PREFIX) ? address.slice(IPV4_MAPPED_PREFIX.length) : address;
}

// Последний адрес X-Forwarded-For дописал сам доверенный прокси; всё левее мог прислать клиент.
function clientAddress(request: IncomingMessage, trustedProxies: ReadonlySet<string>): string {
  const remote = plainAddress(String(request.socket.remoteAddress));
  const header = request.headers['x-forwarded-for'];
  if (!trustedProxies.has(remote) || typeof header !== 'string') {
    return remote;
  }
  const forwarded = header.slice(header.lastIndexOf(',') + 1).trim();
  return isIP(forwarded) === 0 ? remote : plainAddress(forwarded);
}

// Визит страницы: `POST /visit`, тело — профиль JSON; запись дня — `visits/<ГГГГ-ММ-ДД>.log` (дата UTC).
export function receiveVisit(deps: VisitDeps, request: IncomingMessage, response: ServerResponse): void {
  readBody(request, response, VISIT_BODY_LIMIT_BYTES, (body) => {
    const ip = clientAddress(request, deps.trustedProxies);
    const now = new Date(deps.now());
    if (!deps.limiter.allow(ip, now)) {
      response.writeHead(HTTP_TOO_MANY_REQUESTS);
      response.end();
      return;
    }
    const fields = parseVisit(body);
    if (fields === null) {
      response.writeHead(HTTP_BAD_REQUEST);
      response.end();
      return;
    }
    const record = {
      at: now.toISOString(),
      ip,
      geo: deps.geo(ip),
      acceptLanguage: request.headers['accept-language']?.slice(0, ACCEPT_LANGUAGE_MAX),
      ...fields,
    };
    deps.log.write(dateKey(now), VISIT_SOURCE, JSON.stringify(record));
    response.writeHead(HTTP_NO_CONTENT);
    response.end();
  });
}
