import type { ClientInfo } from './clientInfo.js';

const VISIT_ROUTE = '/visit';
export const DEVICE_KEY = 'tanks.device';
export const VISITS_KEY = 'tanks.visits';
export const FIRST_VISIT_KEY = 'tanks.firstVisit';
export const FIRST_FROM_KEY = 'tanks.firstFrom';
export const GPU_KEY = 'tanks.gpu';
export const HINTS_TIMEOUT_MS = 1000;
const DEVICE_ID_LENGTH = 24;
const DEVICE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DEVICE_ID_PATTERN = /^[a-z0-9]{24}$/;
const FROM_PARAM = 'from';
const FROM_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const HIGH_ENTROPY_HINTS = ['model', 'platformVersion'];
const LANGUAGE_SEPARATOR = ',';

// Номер устройства и счёт визитов; хранилище может бросать (приватный режим Safari) — тогда номер живёт до перезагрузки.
export interface VisitIdentity {
  dev: string;
  visit: number;
  firstVisit: string;
  firstFrom: string | null;
}

interface HighEntropyValues {
  model?: string;
  platformVersion?: string;
}

interface DeviceHints {
  model: string | undefined;
  platformVersion: string | undefined;
}

const NO_HINTS: DeviceHints = { model: undefined, platformVersion: undefined };

interface UserAgentData {
  getHighEntropyValues(hints: string[]): Promise<HighEntropyValues>;
}

interface NetworkInformation {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

// Поля навигатора, которых нет в описании DOM у TypeScript: есть не во всех браузерах.
interface NavigatorExtras {
  userAgentData?: UserAgentData;
  deviceMemory?: number;
  connection?: NetworkInformation;
}

export interface VisitEnvironment {
  page: string;
  nick: string;
  referrer: string;
  userAgent: string;
  languages: readonly string[];
  timeZone: string;
  tzOffset: number;
  cores: number;
  memory: number | undefined;
  gpu: string | undefined;
  connection: NetworkInformation | undefined;
  viewport: string;
  isDark: boolean;
  isReducedMotion: boolean;
  hints: DeviceHints;
}

// Пустые поля уходят из JSON сами: JSON.stringify пропускает undefined.
interface VisitProfile {
  dev: string;
  visit: number;
  firstVisit: string;
  from: string | undefined;
  firstFrom: string | undefined;
  page: string;
  nick: string | undefined;
  ref: string | undefined;
  ua: string;
  client: ClientInfo;
  model: string | undefined;
  platformVersion: string | undefined;
  langs: string;
  tz: string;
  tzOffset: number;
  cores: number;
  memory: number | undefined;
  gpu: string | undefined;
  net: string | undefined;
  downlink: number | undefined;
  rtt: number | undefined;
  saveData: boolean | undefined;
  viewport: string;
  dark: boolean;
  reducedMotion: boolean;
}

function readItem(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    return;
  }
}

function newDeviceId(randomBytes: (length: number) => Uint8Array): string {
  return Array.from(
    randomBytes(DEVICE_ID_LENGTH),
    (byte) => DEVICE_ID_ALPHABET[byte % DEVICE_ID_ALPHABET.length] ?? 'a',
  ).join('');
}

// Метка источника из адреса страницы: `?from=arena`.
export function sourceOf(search: string): string | null {
  const from = new URLSearchParams(search).get(FROM_PARAM);
  if (from === null || !FROM_PATTERN.test(from)) {
    return null;
  }
  return from;
}

// Один вызов — один визит: счётчик растёт, первая увиденная метка запоминается навсегда.
export function trackVisit(
  storage: Storage,
  from: string | null,
  now: Date,
  randomBytes: (length: number) => Uint8Array,
): VisitIdentity {
  const stored = readItem(storage, DEVICE_KEY);
  const isKnown = stored !== null && DEVICE_ID_PATTERN.test(stored);
  const dev = isKnown ? stored : newDeviceId(randomBytes);
  const previous = isKnown ? Number(readItem(storage, VISITS_KEY)) : 0;
  const visit = Number.isInteger(previous) && previous > 0 ? previous + 1 : 1;
  const firstVisit = (isKnown ? readItem(storage, FIRST_VISIT_KEY) : null) ?? now.toISOString();
  const firstFrom = (isKnown ? readItem(storage, FIRST_FROM_KEY) : null) ?? from;
  writeItem(storage, DEVICE_KEY, dev);
  writeItem(storage, VISITS_KEY, String(visit));
  writeItem(storage, FIRST_VISIT_KEY, firstVisit);
  if (firstFrom !== null) {
    writeItem(storage, FIRST_FROM_KEY, firstFrom);
  }
  return { dev, visit, firstVisit, firstFrom };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

export function describeVisit(
  identity: VisitIdentity,
  from: string | null,
  client: ClientInfo,
  environment: VisitEnvironment,
): VisitProfile {
  const connection = environment.connection;
  return {
    dev: identity.dev,
    visit: identity.visit,
    firstVisit: identity.firstVisit,
    from: from ?? undefined,
    firstFrom: identity.firstFrom ?? undefined,
    page: environment.page,
    nick: nonEmpty(environment.nick),
    ref: nonEmpty(environment.referrer),
    ua: environment.userAgent,
    client,
    model: nonEmpty(environment.hints.model),
    platformVersion: nonEmpty(environment.hints.platformVersion),
    langs: environment.languages.join(LANGUAGE_SEPARATOR),
    tz: environment.timeZone,
    tzOffset: environment.tzOffset,
    cores: environment.cores,
    memory: environment.memory,
    gpu: environment.gpu,
    net: connection?.effectiveType,
    downlink: connection?.downlink,
    rtt: connection?.rtt,
    saveData: connection?.saveData,
    viewport: environment.viewport,
    dark: environment.isDark,
    reducedMotion: environment.isReducedMotion,
  };
}

// Модель и точная версия системы — только в Chrome и Edge; не ответил вовремя — визит уходит без них.
export async function readHints(data: UserAgentData | undefined, timeoutMs: number): Promise<DeviceHints> {
  if (data === undefined) {
    return NO_HINTS;
  }
  const answer = data.getHighEntropyValues(HIGH_ENTROPY_HINTS).then(
    (values): DeviceHints => ({ model: values.model, platformVersion: values.platformVersion }),
    (): DeviceHints => NO_HINTS,
  );
  const timeout = new Promise<DeviceHints>((resolve) => {
    setTimeout(() => {
      resolve(NO_HINTS);
    }, timeoutMs);
  });
  return Promise.race([answer, timeout]);
}

// Название видеокарты; контекст WebGL сразу отдаётся обратно, чтобы не держать его рядом с игрой.
export function readGpu(): string | undefined {
  const gl = document.createElement('canvas').getContext('webgl');
  if (gl === null) {
    return undefined;
  }
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = info === null ? undefined : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return name;
}

// Видеокарта устройства не меняется: WebGL создаётся один раз, на первом визите, а не на каждой странице боя.
export function cachedGpu(storage: Storage, read: () => string | undefined = readGpu): string | undefined {
  const stored = readItem(storage, GPU_KEY);
  if (stored !== null) {
    return nonEmpty(stored);
  }
  const gpu = read();
  writeItem(storage, GPU_KEY, gpu ?? '');
  return gpu;
}

export async function readVisitEnvironment(nick: string, storage: Storage): Promise<VisitEnvironment> {
  const extras = navigator as Navigator & NavigatorExtras;
  const hints = await readHints(extras.userAgentData, HINTS_TIMEOUT_MS);
  return {
    page: location.pathname,
    nick,
    referrer: document.referrer,
    userAgent: navigator.userAgent,
    languages: navigator.languages,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tzOffset: new Date().getTimezoneOffset(),
    cores: navigator.hardwareConcurrency,
    memory: extras.deviceMemory,
    gpu: cachedGpu(storage),
    connection: extras.connection,
    viewport: `${String(innerWidth)}x${String(innerHeight)}`,
    isDark: matchMedia('(prefers-color-scheme: dark)').matches,
    isReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    hints,
  };
}

// «Выстрелил и забыл»: ответ не читается, ошибка сети глотается.
export async function sendVisit(profile: VisitProfile, post: typeof fetch = fetch): Promise<void> {
  try {
    await post(VISIT_ROUTE, {
      method: 'POST',
      body: JSON.stringify(profile),
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    });
  } catch {
    return;
  }
}

// Визит страницы: номер устройства нужен сразу (строка `device` боя), профиль уходит, когда соберётся.
export function startVisit(storage: Storage, nick: string, client: ClientInfo): VisitIdentity {
  const from = sourceOf(location.search);
  const identity = trackVisit(storage, from, new Date(), (length) => crypto.getRandomValues(new Uint8Array(length)));
  readVisitEnvironment(nick, storage)
    .then((environment) => sendVisit(describeVisit(identity, from, client, environment)))
    .catch(() => undefined);
  return identity;
}
