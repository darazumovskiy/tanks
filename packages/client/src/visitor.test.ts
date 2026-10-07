import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientInfo } from './clientInfo.js';
import {
  cachedGpu,
  DEVICE_KEY,
  GPU_KEY,
  describeVisit,
  FIRST_FROM_KEY,
  FIRST_VISIT_KEY,
  HINTS_TIMEOUT_MS,
  readGpu,
  readHints,
  readVisitEnvironment,
  sendVisit,
  sourceOf,
  startVisit,
  trackVisit,
  VISITS_KEY,
  type VisitEnvironment,
  type VisitIdentity,
} from './visitor.js';

const FIRST_DAY = new Date('2026-10-05T10:07:49.000Z');
const NEXT_DAY = new Date('2026-10-06T09:00:00.000Z');
const DEVICE_ID_PATTERN = /^[a-z0-9]{24}$/;
const RENDERER_PARAM = 0x9246;

const CLIENT: ClientInfo = {
  platform: 'desktop',
  shell: 'browser',
  os: 'Windows',
  osVersion: '10',
  browser: 'Chrome',
  browserVersion: '154',
  appVersion: 'test',
  screen: '1920x1080',
  dpr: 1,
  touch: false,
};

const IDENTITY: VisitIdentity = {
  dev: 'abcdefghjk23456789mnpqrs',
  visit: 2,
  firstVisit: FIRST_DAY.toISOString(),
  firstFrom: 'arena',
};

const ENVIRONMENT: VisitEnvironment = {
  page: '/',
  nick: 'Рустам',
  referrer: 'https://t.me/',
  userAgent: 'Mozilla/5.0',
  languages: ['ru-RU', 'ru', 'en'],
  timeZone: 'Europe/Moscow',
  tzOffset: -180,
  cores: 8,
  memory: 8,
  gpu: 'ANGLE (Apple, M2)',
  connection: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
  viewport: '1291x600',
  isDark: true,
  isReducedMotion: false,
  hints: { model: 'Pixel 8', platformVersion: '15.0.0' },
};

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

class BrokenStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new Error('SecurityError');
  }

  override setItem(): void {
    throw new Error('QuotaExceededError');
  }
}

function bodyOf(init: RequestInit | undefined): unknown {
  const body = init?.body;
  return typeof body === 'string' ? JSON.parse(body) : null;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('номер устройства и счёт визитов', () => {
  it('первый визит: новый номер, визит 1, время и метка первого визита', () => {
    const storage = new MemoryStorage();
    const identity = trackVisit(storage, 'arena', FIRST_DAY, randomBytes);
    expect(identity.dev).toMatch(DEVICE_ID_PATTERN);
    expect(identity).toMatchObject({ visit: 1, firstVisit: FIRST_DAY.toISOString(), firstFrom: 'arena' });
    expect(storage.getItem(DEVICE_KEY)).toBe(identity.dev);
    expect(storage.getItem(VISITS_KEY)).toBe('1');
  });

  it('второй визит с другой меткой: тот же номер, визит 2, первые время и метка прежние', () => {
    const storage = new MemoryStorage();
    const first = trackVisit(storage, 'arena', FIRST_DAY, randomBytes);
    const second = trackVisit(storage, 'tg', NEXT_DAY, randomBytes);
    expect(second).toEqual({ dev: first.dev, visit: 2, firstVisit: FIRST_DAY.toISOString(), firstFrom: 'arena' });
  });

  it('без метки первая метка не запоминается; следующая метка становится первой', () => {
    const storage = new MemoryStorage();
    expect(trackVisit(storage, null, FIRST_DAY, randomBytes).firstFrom).toBeNull();
    expect(storage.getItem(FIRST_FROM_KEY)).toBeNull();
    expect(trackVisit(storage, 'tg', NEXT_DAY, randomBytes).firstFrom).toBe('tg');
  });

  it('испорченный номер — новый номер и счёт с единицы; испорченный счётчик — визит 1', () => {
    const storage = new MemoryStorage();
    storage.setItem(DEVICE_KEY, 'ABC');
    storage.setItem(VISITS_KEY, '7');
    storage.setItem(FIRST_VISIT_KEY, 'давно');
    const fresh = trackVisit(storage, null, NEXT_DAY, randomBytes);
    expect(fresh).toMatchObject({ visit: 1, firstVisit: NEXT_DAY.toISOString() });
    expect(fresh.dev).toMatch(DEVICE_ID_PATTERN);
    storage.setItem(VISITS_KEY, 'много');
    expect(trackVisit(storage, null, NEXT_DAY, randomBytes)).toMatchObject({ dev: fresh.dev, visit: 1 });
  });

  it('хранилище бросает — профиль собран, визит 1, исключения наружу нет', () => {
    const identity = trackVisit(new BrokenStorage(), 'arena', FIRST_DAY, randomBytes);
    expect(identity.dev).toMatch(DEVICE_ID_PATTERN);
    expect(identity).toMatchObject({ visit: 1, firstFrom: 'arena' });
  });

  it.each([
    ['?from=arena', 'arena'],
    ['?x=1&from=tg_chan-2', 'tg_chan-2'],
    ['?from=два слова', null],
    [`?from=${'a'.repeat(41)}`, null],
    ['?from=', null],
    ['', null],
  ])('метка из адреса %s — %s', (search, expected) => {
    expect(sourceOf(search)).toBe(expected);
  });
});

describe('профиль визита', () => {
  it('собирает все поля', () => {
    const profile = describeVisit(IDENTITY, 'tg', CLIENT, ENVIRONMENT);
    expect(JSON.parse(JSON.stringify(profile))).toEqual({
      dev: IDENTITY.dev,
      visit: 2,
      firstVisit: IDENTITY.firstVisit,
      from: 'tg',
      firstFrom: 'arena',
      page: '/',
      nick: 'Рустам',
      ref: 'https://t.me/',
      ua: 'Mozilla/5.0',
      client: CLIENT,
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
    });
  });

  it('чего нет в браузере, того нет в профиле; пустая модель компьютера тоже не уходит', () => {
    const bare: VisitEnvironment = {
      ...ENVIRONMENT,
      nick: '',
      referrer: '',
      memory: undefined,
      gpu: undefined,
      connection: undefined,
      hints: { model: '', platformVersion: undefined },
    };
    const profile = JSON.parse(
      JSON.stringify(describeVisit({ ...IDENTITY, firstFrom: null }, null, CLIENT, bare)),
    ) as object;
    for (const key of [
      'from',
      'firstFrom',
      'nick',
      'ref',
      'memory',
      'gpu',
      'net',
      'downlink',
      'rtt',
      'saveData',
      'model',
      'platformVersion',
    ]) {
      expect(profile).not.toHaveProperty(key);
    }
  });
});

describe('подсказки браузера', () => {
  it('нет userAgentData — пусто', async () => {
    expect(await readHints(undefined, HINTS_TIMEOUT_MS)).toEqual({});
  });

  it('ответил — модель и версия системы; отказал — пусто', async () => {
    const answered = {
      getHighEntropyValues: () => Promise.resolve({ model: 'Pixel 8', platformVersion: '15.0.0', brands: [] }),
    };
    expect(await readHints(answered, HINTS_TIMEOUT_MS)).toEqual({ model: 'Pixel 8', platformVersion: '15.0.0' });
    const refused = { getHighEntropyValues: () => Promise.reject(new Error('нет')) };
    expect(await readHints(refused, HINTS_TIMEOUT_MS)).toEqual({});
  });

  it('молчит — пусто не позже чем через 1 с', async () => {
    vi.useFakeTimers();
    const silent = { getHighEntropyValues: () => new Promise<never>(() => undefined) };
    const hints = readHints(silent, HINTS_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(HINTS_TIMEOUT_MS);
    expect(await hints).toEqual({});
  });
});

describe('видеокарта', () => {
  function stubWebGl(hasRendererInfo: boolean): { lost: number } {
    const state = { lost: 0 };
    const gl = {
      getExtension: (name: string): object | null => {
        if (name === 'WEBGL_lose_context') {
          return { loseContext: () => (state.lost += 1) };
        }
        return hasRendererInfo ? { UNMASKED_RENDERER_WEBGL: RENDERER_PARAM } : null;
      },
      getParameter: (param: number): string => (param === RENDERER_PARAM ? 'ANGLE (Apple, M2)' : ''),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(gl as unknown as WebGLRenderingContext);
    return state;
  }

  it('название из WebGL, контекст отдан обратно', () => {
    const state = stubWebGl(true);
    expect(readGpu()).toBe('ANGLE (Apple, M2)');
    expect(state.lost).toBe(1);
  });

  it('браузер скрывает название — пусто; WebGL нет — пусто', () => {
    stubWebGl(false);
    expect(readGpu()).toBeUndefined();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(readGpu()).toBeUndefined();
  });

  it('WebGL — один раз на устройство: дальше название из хранилища, пустое тоже запоминается', () => {
    const storage = new MemoryStorage();
    const read = vi.fn(() => 'ANGLE (Apple, M2)');
    expect(cachedGpu(storage, read)).toBe('ANGLE (Apple, M2)');
    expect(cachedGpu(storage, read)).toBe('ANGLE (Apple, M2)');
    expect(read).toHaveBeenCalledTimes(1);
    const hidden = new MemoryStorage();
    const readNothing = vi.fn((): string | undefined => undefined);
    expect(cachedGpu(hidden, readNothing)).toBeUndefined();
    expect(cachedGpu(hidden, readNothing)).toBeUndefined();
    expect(readNothing).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GPU_KEY)).toBe('ANGLE (Apple, M2)');
  });
});

describe('окружение и отправка', () => {
  it('окружение из браузера: страница, ник, язык, железо, связь, подсказки', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 16)',
      languages: ['ru-RU', 'en'],
      hardwareConcurrency: 6,
      deviceMemory: 4,
      connection: { effectiveType: '3g', rtt: 300 },
      userAgentData: { getHighEntropyValues: () => Promise.resolve({ model: 'SM-S918B' }) },
    });
    const environment = await readVisitEnvironment('Вася', new MemoryStorage());
    expect(environment).toMatchObject({
      page: location.pathname,
      nick: 'Вася',
      userAgent: 'Mozilla/5.0 (Linux; Android 16)',
      languages: ['ru-RU', 'en'],
      cores: 6,
      memory: 4,
      gpu: undefined,
      connection: { effectiveType: '3g', rtt: 300 },
      hints: { model: 'SM-S918B' },
    });
    expect(environment.viewport).toBe(`${String(innerWidth)}x${String(innerHeight)}`);
    expect(typeof environment.timeZone).toBe('string');
  });

  it('POST /visit с keepalive и профилем JSON; отказ сети наружу не выходит', async () => {
    const post = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));
    const profile = describeVisit(IDENTITY, null, CLIENT, ENVIRONMENT);
    await sendVisit(profile, post);
    const [url, init] = post.mock.calls[0] ?? [];
    expect(url).toBe('/visit');
    expect(init).toMatchObject({ method: 'POST', keepalive: true });
    expect(bodyOf(init)).toMatchObject({ dev: IDENTITY.dev, visit: 2 });
    await expect(sendVisit(profile, () => Promise.reject(new Error('offline')))).resolves.toBeUndefined();
  });

  it('визит страницы: номер сразу, профиль уходит на сервер, когда соберётся', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const post = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', post);
    const storage = new MemoryStorage();
    const identity = startVisit(storage, 'Вася', CLIENT);
    expect(identity.dev).toMatch(DEVICE_ID_PATTERN);
    await vi.waitFor(() => {
      expect(post).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf(post.mock.calls[0]?.[1])).toMatchObject({
      dev: identity.dev,
      visit: 1,
      nick: 'Вася',
      client: CLIENT,
    });
  });

  it('сбор профиля бросил исключение — визит не уходит, страница не ломается', async () => {
    const post = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', post);
    vi.stubGlobal('navigator', { userAgent: 'старый WebView' });
    const identity = startVisit(new MemoryStorage(), '', CLIENT);
    expect(identity.dev).toMatch(DEVICE_ID_PATTERN);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(post).not.toHaveBeenCalled();
  });
});
