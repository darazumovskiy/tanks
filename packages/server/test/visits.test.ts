import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App, type AppOptions } from '../src/app.js';
import { GEO_CITY_FILE, GEO_PROVIDER_FILE } from '../src/geo.js';
import { postInTwoParts } from './support.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'geo');
const VISIT_BODY_LIMIT_BYTES = 16 * 1024;
const LINE_PATTERN = /^\d{2}:\d{2}:\d{2}\.\d{3} V (\{.*\})$/;
const DAY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.log$/;
const LONDON_IP = '81.2.69.142';
const TELSTRA_IP = '1.128.0.1';

const PROFILE = {
  dev: 'abcdefghjk23456789mnpqrs',
  visit: 3,
  firstVisit: '2026-10-05T10:07:49.000Z',
  from: 'arena',
  firstFrom: 'arena',
  page: '/',
  nick: 'МАКСИМ',
  ref: 'https://t.me/',
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0.0.0 Safari/537.36',
  model: 'Pixel 8',
  platformVersion: '15.0.0',
  langs: 'ru-RU,ru,en',
  tz: 'Europe/Moscow',
  tzOffset: -180,
  cores: 8,
  memory: 8,
  gpu: 'ANGLE (Apple, M2)',
  net: '4g',
  downlink: 10,
  rtt: 50,
  saveData: false,
  viewport: '1291x600',
  dark: true,
  reducedMotion: false,
  client: {
    platform: 'desktop',
    shell: 'browser',
    os: 'Windows',
    osVersion: '10',
    browser: 'Chrome',
    browserVersion: '154',
    appVersion: 'abc1234',
    screen: '1920x1080',
    dpr: 1.25,
    touch: false,
  },
};

let logDir: string;
let geoDir: string;
let app: App | null = null;
let base: string;

async function start(options: AppOptions = {}, host = '127.0.0.1'): Promise<void> {
  app = createApp({ logDir, ...options });
  const port = await app.listen(0, host);
  base = `http://127.0.0.1:${String(port)}`;
}

async function stop(): Promise<void> {
  await app?.close();
  app = null;
}

function postVisit(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/visit`, { method: 'POST', body: JSON.stringify(body), headers });
}

// fetch всегда шлёт Accept-Language, http.request — нет.
async function postWithoutLanguage(body: unknown): Promise<number | undefined> {
  const request = httpRequest(`${base}/visit`, { method: 'POST' });
  const answered = once(request, 'response') as Promise<[IncomingMessage]>;
  request.end(JSON.stringify(body));
  const [response] = await answered;
  response.resume();
  return response.statusCode;
}

function visitsDir(): string {
  return join(logDir, 'visits');
}

// Записи визитов после закрытия сервера: закрытие дописывает буфер журнала на диск.
async function records(): Promise<Record<string, unknown>[]> {
  await stop();
  const lines: string[] = [];
  for (const name of readdirSync(visitsDir())) {
    expect(name).toMatch(DAY_FILE_PATTERN);
    lines.push(
      ...readFileSync(join(visitsDir(), name), 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
    );
  }
  return lines.map((line) => {
    const match = LINE_PATTERN.exec(line);
    expect(match).not.toBeNull();
    return JSON.parse(match?.[1] ?? '') as Record<string, unknown>;
  });
}

function withGeo(files: readonly [string, string][]): string {
  for (const [fixture, name] of files) {
    copyFileSync(join(FIXTURES, fixture), join(geoDir, name));
  }
  return geoDir;
}

const ALL_GEO: readonly [string, string][] = [
  ['GeoIP2-City-Test.mmdb', GEO_CITY_FILE],
  ['GeoLite2-ASN-Test.mmdb', GEO_PROVIDER_FILE],
];

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'tanks-visits-'));
  geoDir = mkdtempSync(join(tmpdir(), 'tanks-geo-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stop();
  rmSync(logDir, { recursive: true, force: true });
  rmSync(geoDir, { recursive: true, force: true });
});

describe('POST /visit', () => {
  it('пишет полный профиль одной строкой в файл дня с адресом, временем и языком из заголовка', async () => {
    await start();
    const response = await postVisit(PROFILE, { 'Accept-Language': 'ru-RU,ru;q=0.9' });
    expect(response.status).toBe(204);
    const [record] = await records();
    expect(record).toEqual({
      ...PROFILE,
      at: expect.any(String) as string,
      ip: '127.0.0.1',
      geo: {},
      acceptLanguage: 'ru-RU,ru;q=0.9',
    });
    const files = readdirSync(visitsDir());
    expect(files).toEqual([`${String(record?.at).slice(0, 10)}.log`]);
  });

  it('два визита — две строки одного дня; без заголовка языка поле не пишется', async () => {
    await start();
    expect(await postWithoutLanguage({ dev: PROFILE.dev, visit: 1 })).toBe(204);
    expect(await postWithoutLanguage({ dev: PROFILE.dev, visit: 2 })).toBe(204);
    const visits = await records();
    expect(visits.map((visit) => visit.visit)).toEqual([1, 2]);
    expect(readdirSync(visitsDir())).toHaveLength(1);
    expect(visits[0]).not.toHaveProperty('acceptLanguage');
  });

  it('за доверенным прокси берёт последний адрес X-Forwarded-For и находит страну, город и провайдера', async () => {
    await start({ geoDir: withGeo(ALL_GEO) });
    await postVisit({ dev: PROFILE.dev }, { 'X-Forwarded-For': `1.2.3.4, ${LONDON_IP}` });
    await postVisit({ dev: PROFILE.dev }, { 'X-Forwarded-For': TELSTRA_IP });
    await postVisit({ dev: PROFILE.dev }, { 'X-Forwarded-For': 'garbage' });
    const [london, telstra, garbage] = await records();
    expect(london).toMatchObject({
      ip: LONDON_IP,
      geo: { country: 'GB', countryName: 'United Kingdom', city: 'London' },
    });
    expect(telstra).toMatchObject({ ip: TELSTRA_IP, geo: { asn: 1221, org: 'Telstra Pty Ltd' } });
    expect(telstra?.geo).not.toHaveProperty('country');
    expect(garbage).toMatchObject({ ip: '127.0.0.1', geo: {} });
  });

  it('от недоверенного соединения X-Forwarded-For не читается', async () => {
    await start({ trustedProxies: [] });
    await postVisit({ dev: PROFILE.dev }, { 'X-Forwarded-For': LONDON_IP });
    const [record] = await records();
    expect(record?.ip).toBe('127.0.0.1');
  });

  it('на сервере, который слушает IPv6, адрес IPv4 приходит без префикса ::ffff: — и свой, и пересланный', async () => {
    await start({ geoDir: withGeo(ALL_GEO) }, '::');
    await postVisit({ dev: PROFILE.dev });
    await postVisit({ dev: PROFILE.dev }, { 'X-Forwarded-For': `::ffff:${LONDON_IP}` });
    const [own, forwarded] = await records();
    expect(own?.ip).toBe('127.0.0.1');
    expect(forwarded).toMatchObject({ ip: LONDON_IP, geo: { city: 'London' } });
  });

  it('только с базой городов провайдера нет; частный адрес и адрес не из базы — без гео', async () => {
    await start({ geoDir: withGeo([['GeoIP2-City-Test.mmdb', GEO_CITY_FILE]]) });
    await postVisit({ dev: PROFILE.dev }, { 'X-Forwarded-For': LONDON_IP });
    await postVisit({ dev: PROFILE.dev }, { 'X-Forwarded-For': TELSTRA_IP });
    await postVisit({ dev: PROFILE.dev });
    const [london, telstra, local] = await records();
    expect(london?.geo).toEqual({ country: 'GB', countryName: 'United Kingdom', city: 'London' });
    expect(telstra?.geo).toEqual({});
    expect(local?.geo).toEqual({});
  });

  it('битая база гео не роняет сервер: визит записан без страны, провайдер находится', async () => {
    writeFileSync(join(geoDir, GEO_CITY_FILE), 'не база');
    withGeo([['GeoLite2-ASN-Test.mmdb', GEO_PROVIDER_FILE]]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await start({ geoDir });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(GEO_CITY_FILE));
    await postVisit({ dev: PROFILE.dev }, { 'X-Forwarded-For': TELSTRA_IP });
    const [record] = await records();
    expect(record?.geo).toEqual({ asn: 1221, org: 'Telstra Pty Ltd' });
  });

  it('с одного адреса — не больше лимита в минуту: лишний визит 429 и не записан; через минуту снова можно', async () => {
    let clock = Date.parse('2026-10-07T10:00:00.000Z');
    await start({ visitLimits: { perMinute: 2, perDay: 100 }, wallClock: () => clock });
    expect((await postVisit({ dev: PROFILE.dev, visit: 1 })).status).toBe(204);
    expect((await postVisit({ dev: PROFILE.dev, visit: 2 })).status).toBe(204);
    expect((await postVisit({ dev: PROFILE.dev, visit: 3 })).status).toBe(429);
    expect((await postVisit({ dev: PROFILE.dev, visit: 4 }, { 'X-Forwarded-For': LONDON_IP })).status).toBe(204);
    clock += 60_000;
    expect((await postVisit({ dev: PROFILE.dev, visit: 5 })).status).toBe(204);
    const visits = await records();
    expect(visits.map((visit) => visit.visit)).toEqual([1, 2, 4, 5]);
    expect(visits[3]?.at).toBe('2026-10-07T10:01:00.000Z');
  });

  it('потолок визитов в сутки на весь сервер; новые сутки UTC — новый счёт и новый файл', async () => {
    let clock = Date.parse('2026-10-07T23:58:00.000Z');
    await start({ visitLimits: { perMinute: 100, perDay: 2 }, wallClock: () => clock });
    expect((await postVisit({ dev: PROFILE.dev })).status).toBe(204);
    expect((await postVisit({ dev: PROFILE.dev }, { 'X-Forwarded-For': LONDON_IP })).status).toBe(204);
    expect((await postVisit({ dev: PROFILE.dev }, { 'X-Forwarded-For': TELSTRA_IP })).status).toBe(429);
    clock = Date.parse('2026-10-08T00:00:30.000Z');
    expect((await postVisit({ dev: PROFILE.dev })).status).toBe(204);
    await stop();
    expect(readdirSync(visitsDir()).sort()).toEqual(['2026-10-07.log', '2026-10-08.log']);
  });

  it('пропускает незнакомые ключи и значения не того типа, обрезает длинные строки', async () => {
    await start();
    await postVisit({
      dev: PROFILE.dev,
      visit: '3',
      ua: 'x'.repeat(1000),
      cores: 0,
      tzOffset: 5000,
      downlink: 1e9,
      dark: 'да',
      secret: 'пароль',
      client: { platform: 'android', dpr: 99, touch: 1, extra: true, os: 42 },
    });
    await postVisit({ dev: PROFILE.dev, client: 'android' });
    const [mixed, plain] = await records();
    expect(mixed).toEqual({
      dev: PROFILE.dev,
      at: expect.any(String) as string,
      ip: '127.0.0.1',
      geo: {},
      acceptLanguage: '*',
      ua: 'x'.repeat(400),
      client: { platform: 'android' },
    });
    expect(plain).not.toHaveProperty('client');
  });

  it('перевод строки и кавычки в нике не рвут строку журнала', async () => {
    await start();
    await postVisit({ dev: PROFILE.dev, nick: 'Вася\n"Танк"' });
    const [record] = await records();
    expect(record?.nick).toBe('Вася\n"Танк"');
  });

  it.each([
    ['не JSON', 'привет'],
    ['массив', '[1]'],
    ['null', 'null'],
    ['без номера устройства', '{}'],
    ['номер с заглавными', JSON.stringify({ dev: 'ABCDEFGHJK23456789MNPQRS' })],
    ['номер короче 16 знаков', JSON.stringify({ dev: 'abc123' })],
    ['номер не строкой', JSON.stringify({ dev: 1234567890123456 })],
  ])('отвечает 400 на тело %s и ничего не пишет', async (_name, body) => {
    await start();
    const response = await fetch(`${base}/visit`, { method: 'POST', body });
    expect(response.status).toBe(400);
    await stop();
    expect(readdirSync(visitsDir())).toEqual([]);
  });

  it('отвечает 413 на тело больше 16 КБ', async () => {
    await start();
    const overLimit = 'y'.repeat(VISIT_BODY_LIMIT_BYTES + 1);
    expect(await postInTwoParts(`${base}/visit`, overLimit, 'z'.repeat(1024))).toBe(413);
    await stop();
    expect(readdirSync(visitsDir())).toEqual([]);
  });

  it('GET /visit — 404', async () => {
    await start();
    expect((await fetch(`${base}/visit`)).status).toBe(404);
  });

  it('без папки журнала — 404 и папки визитов нет', async () => {
    app = createApp({});
    const port = await app.listen(0, '127.0.0.1');
    const response = await fetch(`http://127.0.0.1:${String(port)}/visit`, {
      method: 'POST',
      body: JSON.stringify({ dev: PROFILE.dev }),
    });
    expect(response.status).toBe(404);
    expect(existsSync(visitsDir())).toBe(false);
  });

  it('закрытие сразу после визита дописывает строку на диск', async () => {
    mkdirSync(join(logDir, 'visits'), { recursive: true });
    await start();
    await postVisit({ dev: PROFILE.dev });
    await stop();
    const [file] = readdirSync(visitsDir());
    expect(readFileSync(join(visitsDir(), String(file)), 'utf8')).toContain(PROFILE.dev);
  });
});
