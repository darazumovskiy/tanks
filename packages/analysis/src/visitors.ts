import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLine, type RoomLog } from './logParser.js';

const VISITS_DIR = 'visits';
const VISIT_LINE_PATTERN = /^\S+ V (\{.*\})$/;
const DEVICE_LINE_PATTERN = /^device .* dev=([a-z0-9]{16,32})$/;
const FFA_MODE_MARK = ' mode=ffa ';
const LOG_EXTENSION = '.log';
const MS_PER_HOUR = 3_600_000;
const LOCAL_DATE_LENGTH = 10;
const LOCAL_MINUTE_LENGTH = 16;
const APP_SHELL = 'app';
export const DIRECT_SOURCE = 'прямой заход';

// Запись визита из файла дня: поля, которые нужны сводке; чего не было в визите — undefined.
interface VisitRecord {
  at: string;
  dev: string;
  ip: string | undefined;
  nick: string | undefined;
  from: string | undefined;
  firstFrom: string | undefined;
  ref: string | undefined;
  model: string | undefined;
  langs: string | undefined;
  tz: string | undefined;
  country: string | undefined;
  countryName: string | undefined;
  city: string | undefined;
  org: string | undefined;
  os: string | undefined;
  osVersion: string | undefined;
  browser: string | undefined;
  browserVersion: string | undefined;
  shell: string | undefined;
}

export interface VisitorSummary {
  dev: string;
  first_visit: string | null;
  last_visit: string | null;
  visits: number;
  days: number;
  is_returning: boolean;
  battles_duel: number;
  battles_ffa: number;
  nicks: string[];
  country: string | null;
  city: string | null;
  org: string | null;
  ips: string[];
  device: string | null;
  langs: string | null;
  tz: string | null;
  source: string;
}

interface Battles {
  duel: number;
  ffa: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function objectOf(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return isRecord(value) ? value : {};
}

function parseVisitLine(line: string): VisitRecord | null {
  const match = VISIT_LINE_PATTERN.exec(line);
  if (match === null) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(match[1] ?? '');
  } catch {
    return null;
  }
  if (!isRecord(raw)) {
    return null;
  }
  const at = textOf(raw, 'at');
  const dev = textOf(raw, 'dev');
  if (at === undefined || dev === undefined) {
    return null;
  }
  const geo = objectOf(raw, 'geo');
  const client = objectOf(raw, 'client');
  return {
    at,
    dev,
    ip: textOf(raw, 'ip'),
    nick: textOf(raw, 'nick'),
    from: textOf(raw, 'from'),
    firstFrom: textOf(raw, 'firstFrom'),
    ref: textOf(raw, 'ref'),
    model: textOf(raw, 'model'),
    langs: textOf(raw, 'langs'),
    tz: textOf(raw, 'tz'),
    country: textOf(geo, 'country'),
    countryName: textOf(geo, 'countryName'),
    city: textOf(geo, 'city'),
    org: textOf(geo, 'org'),
    os: textOf(client, 'os'),
    osVersion: textOf(client, 'osVersion'),
    browser: textOf(client, 'browser'),
    browserVersion: textOf(client, 'browserVersion'),
    shell: textOf(client, 'shell'),
  };
}

// Визиты из `<папка>/visits/*.log`; битые строки пропускаются.
export function readVisits(logDir: string): VisitRecord[] {
  const dir = join(logDir, VISITS_DIR);
  if (!existsSync(dir)) {
    return [];
  }
  const records: VisitRecord[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(LOG_EXTENSION))) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      const record = parseVisitLine(line);
      if (record !== null) {
        records.push(record);
      }
    }
  }
  return records;
}

// Каждая строка `device … dev=` — одно открытие страницы боя этим устройством.
function battlesByDevice(rooms: readonly RoomLog[]): Map<string, Battles> {
  const battles = new Map<string, Battles>();
  for (const room of rooms) {
    for (const raw of room.lines) {
      const body = parseLine(raw)?.body ?? '';
      const match = DEVICE_LINE_PATTERN.exec(body);
      if (match === null) {
        continue;
      }
      const dev = match[1] ?? '';
      const count = battles.get(dev) ?? { duel: 0, ffa: 0 };
      if (body.includes(FFA_MODE_MARK)) {
        count.ffa++;
      } else {
        count.duel++;
      }
      battles.set(dev, count);
    }
  }
  return battles;
}

function localTime(at: string, tzHours: number): string {
  return new Date(Date.parse(at) + tzHours * MS_PER_HOUR).toISOString().slice(0, LOCAL_MINUTE_LENGTH).replace('T', ' ');
}

function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined && value !== ''))];
}

function lastWhere(visits: readonly VisitRecord[], isMatch: (visit: VisitRecord) => boolean): VisitRecord | undefined {
  return [...visits].reverse().find(isMatch);
}

function lastDefined<K extends keyof VisitRecord>(visits: readonly VisitRecord[], key: K): VisitRecord[K] | undefined {
  return lastWhere(visits, (visit) => visit[key] !== undefined)?.[key];
}

function hostOf(ref: string): string {
  try {
    return new URL(ref).host;
  } catch {
    return ref;
  }
}

// Первая метка `from`; без неё — сайт, с которого пришёл первый визит.
function sourceOf(visits: readonly VisitRecord[]): string {
  const label = visits[0]?.firstFrom ?? visits.find((visit) => visit.from !== undefined)?.from;
  if (label !== undefined) {
    return label;
  }
  const ref = visits[0]?.ref;
  return ref === undefined || ref === '' ? DIRECT_SOURCE : hostOf(ref);
}

function deviceOf(visit: VisitRecord | undefined): string | null {
  if (visit?.os === undefined) {
    return null;
  }
  const model = visit.model === undefined || visit.model === '' ? '' : ` (${visit.model})`;
  const browser = visit.browser === undefined ? '' : `, ${visit.browser} ${visit.browserVersion ?? ''}`.trimEnd();
  const shell = visit.shell === APP_SHELL ? ', приложение' : '';
  return `${visit.os} ${visit.osVersion ?? ''}`.trimEnd() + model + browser + shell;
}

function summarize(dev: string, visits: readonly VisitRecord[], battles: Battles, tzHours: number): VisitorSummary {
  const days = new Set(visits.map((visit) => localTime(visit.at, tzHours).slice(0, LOCAL_DATE_LENGTH)));
  const first = visits[0];
  const last = visits.at(-1);
  const place = lastWhere(visits, (visit) => visit.country !== undefined);
  return {
    dev,
    first_visit: first === undefined ? null : localTime(first.at, tzHours),
    last_visit: last === undefined ? null : localTime(last.at, tzHours),
    visits: visits.length,
    days: days.size,
    is_returning: days.size > 1,
    battles_duel: battles.duel,
    battles_ffa: battles.ffa,
    nicks: unique(visits.map((visit) => visit.nick)),
    country: place?.countryName ?? place?.country ?? null,
    city: place?.city ?? null,
    org: lastDefined(visits, 'org') ?? null,
    ips: unique(visits.map((visit) => visit.ip)),
    device: deviceOf(last),
    langs: lastDefined(visits, 'langs') ?? null,
    tz: lastDefined(visits, 'tz') ?? null,
    source: sourceOf(visits),
  };
}

// Сводка по устройствам: визиты склеиваются с открытиями боя по номеру устройства; свежие — первыми.
export function summarizeVisitors(
  visits: readonly VisitRecord[],
  rooms: readonly RoomLog[],
  tzHours: number,
): VisitorSummary[] {
  const byDevice = new Map<string, VisitRecord[]>();
  for (const visit of [...visits].sort((a, b) => a.at.localeCompare(b.at))) {
    const known = byDevice.get(visit.dev);
    if (known === undefined) {
      byDevice.set(visit.dev, [visit]);
      continue;
    }
    known.push(visit);
  }
  const battles = battlesByDevice(rooms);
  const devices = new Set([...byDevice.keys(), ...battles.keys()]);
  return [...devices]
    .map((dev) => summarize(dev, byDevice.get(dev) ?? [], battles.get(dev) ?? { duel: 0, ffa: 0 }, tzHours))
    .sort((a, b) => (b.last_visit ?? '').localeCompare(a.last_visit ?? ''));
}
