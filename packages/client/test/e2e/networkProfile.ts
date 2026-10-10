// Связь для посредника: задержка в каждую сторону, шаг пачек от и до, паузы связи, мс. Без пачек и пауз — нули.
export interface NetworkShape {
  delayMs: number;
  burstMs: number;
  burstMaxMs: number;
  stallEveryMs: number;
  stallMs: number;
}

type JitterShape = Omit<NetworkShape, 'delayMs'>;

// Неровность — пачки: данные копятся и уходят разом на границах сетки со случайным шагом от и до, мс; или паузы:
// связь замирает в обе стороны на stallMs раз в stallEveryMs. stall — сеть боёв NC95 и 633T: при пинге около 50
// паузы между снимками 210–245 мс раз в 2 с.
export const JITTERS = {
  even: { burstMs: 0, burstMaxMs: 0, stallEveryMs: 0, stallMs: 0 },
  light: { burstMs: 50, burstMaxMs: 100, stallEveryMs: 0, stallMs: 0 },
  phone: { burstMs: 150, burstMaxMs: 250, stallEveryMs: 0, stallMs: 0 },
  stall: { burstMs: 0, burstMaxMs: 0, stallEveryMs: 2070, stallMs: 210 },
} as const satisfies Record<string, JitterShape>;

export type JitterName = keyof typeof JITTERS;

// Пинг — задержка туда-обратно без пачек, мс: посредник держит каждый кусок половину пинга в каждую сторону.
export interface NetworkSetting {
  pingMs: number;
  jitter: JitterName;
}

// night — сеть боя J7RF с телефона ночью, day — плохая дневная, smooth — ровный пинг 100 для сравнения.
export const NETWORK_PROFILES = {
  night: { pingMs: 80, jitter: 'phone' },
  day: { pingMs: 50, jitter: 'light' },
  smooth: { pingMs: 100, jitter: 'even' },
} as const satisfies Record<string, NetworkSetting>;

type ProfileName = keyof typeof NETWORK_PROFILES;

export const MAX_PING_MS = 2000;

// shotLeadTicks — догон снаряда на сервере стенда (`SHOT_LEAD_TICKS`), 0 — выключен; shotInheritPercent — доля
// скорости танка у снаряда (`SHOT_INHERIT_PERCENT`), 0 — выключено; hasNetSmoothing — сглаживание дёрганой сети
// (`NET_SMOOTHING`); port — порт сервера стенда, посредник — на следующем.
export interface NetworkChoice {
  network: NetworkSetting;
  shotLeadTicks: number;
  shotInheritPercent: number;
  hasNetSmoothing: boolean;
  port: number;
}

const DEFAULT_PROFILE: ProfileName = 'night';
const NO_SHOT_LEAD = 0;
const NO_SHOT_INHERIT = 0;
// Модуль читается до проверки сборки, поэтому не берёт предел из `@tanks/shared`.
const FULL_SHOT_INHERIT = 100;
export const DEFAULT_STAND_PORT = 8100;
// Посредник — на следующем порту, поэтому последний порт сервером занять нельзя.
const MAX_STAND_PORT = 65534;

const PING_FLAG = '--ping';
const JITTER_FLAG = '--jitter';
const LEAD_FLAG = '--lead';
const INHERIT_FLAG = '--inherit';
const SMOOTH_NET_FLAG = '--smooth-net';
const PORT_FLAG = '--port';
const DECIMAL_NUMBER = /^\d+$/;
const JITTER_NAMES = Object.keys(JITTERS).join('|');

export const NETWORK_USAGE = [
  `npm run bad-net -- [night|day|smooth] [--ping <мс>] [--jitter ${JITTER_NAMES}] [--lead <тиков>] [--inherit <процент>] [--smooth-net] [--port <порт>]`,
  ...Object.entries(NETWORK_PROFILES).map(([name, network]) => `  ${name.padEnd(7)}${describeNetwork(network)}`),
  `  --ping        пинг туда-обратно поверх сокращения, 0–${String(MAX_PING_MS)}`,
  `  --jitter      неровность поверх сокращения: ${describeJitters()}`,
  '  --lead        догон снаряда человека в тиках по 33 мс (SHOT_LEAD_TICKS сервера); без флага — выключен',
  '  --inherit     какую долю скорости танка получает снаряд, процент (SHOT_INHERIT_PERCENT сервера); без флага — 0',
  '  --smooth-net  сглаживание дёрганой сети (NET_SMOOTHING=1 сервера); без флага — выключено',
  `  --port        порт сервера, посредник — на следующем; без флага — ${String(DEFAULT_STAND_PORT)}`,
].join('\n');

function isProfileName(value: string): value is ProfileName {
  return Object.hasOwn(NETWORK_PROFILES, value);
}

export function isJitterName(value: unknown): value is JitterName {
  return typeof value === 'string' && Object.hasOwn(JITTERS, value);
}

export function isPingMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_PING_MS;
}

function parsePing(raw: string | undefined): number {
  const pingMs = Number(raw);
  if (raw === undefined || !DECIMAL_NUMBER.test(raw) || !isPingMs(pingMs)) {
    throw new Error(`${PING_FLAG} ждёт целое число мс от 0 до ${String(MAX_PING_MS)}, получено «${raw ?? ''}»`);
  }
  return pingMs;
}

function parseJitter(raw: string | undefined): JitterName {
  if (!isJitterName(raw)) {
    throw new Error(`${JITTER_FLAG} ждёт ${JITTER_NAMES}, получено «${raw ?? ''}»`);
  }
  return raw;
}

// Предел проверяет сервер стенда: неверное значение — он не стартует и называет переменную.
function parseCount(flag: string, unit: string, raw: string | undefined): number {
  if (raw === undefined || !DECIMAL_NUMBER.test(raw)) {
    throw new Error(`${flag} ждёт целое число ${unit}, получено «${raw ?? ''}»`);
  }
  return Number(raw);
}

function parsePort(raw: string | undefined): number {
  const port = Number(raw);
  const isValid = raw !== undefined && DECIMAL_NUMBER.test(raw) && port >= 1 && port <= MAX_STAND_PORT;
  if (!isValid) {
    throw new Error(`${PORT_FLAG} ждёт порт от 1 до ${String(MAX_STAND_PORT)}, получено «${raw ?? ''}»`);
  }
  return port;
}

export function parseNetworkArgs(args: readonly string[]): NetworkChoice {
  let profile: ProfileName = DEFAULT_PROFILE;
  let pingMs: number | undefined;
  let jitter: JitterName | undefined;
  let shotLeadTicks = NO_SHOT_LEAD;
  let shotInheritPercent = NO_SHOT_INHERIT;
  let hasNetSmoothing = false;
  let port = DEFAULT_STAND_PORT;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === LEAD_FLAG) {
      index += 1;
      shotLeadTicks = parseCount(LEAD_FLAG, 'тиков', args[index]);
      continue;
    }
    if (arg === INHERIT_FLAG) {
      index += 1;
      shotInheritPercent = parseCount(INHERIT_FLAG, 'процентов', args[index]);
      continue;
    }
    if (arg === SMOOTH_NET_FLAG) {
      hasNetSmoothing = true;
      continue;
    }
    if (arg === PORT_FLAG) {
      index += 1;
      port = parsePort(args[index]);
      continue;
    }
    if (arg === PING_FLAG) {
      index += 1;
      pingMs = parsePing(args[index]);
      continue;
    }
    if (arg === JITTER_FLAG) {
      index += 1;
      jitter = parseJitter(args[index]);
      continue;
    }
    if (!isProfileName(arg)) {
      throw new Error(`непонятный аргумент «${arg}»`);
    }
    profile = arg;
  }
  const base = NETWORK_PROFILES[profile];
  const network = { pingMs: pingMs ?? base.pingMs, jitter: jitter ?? base.jitter };
  return { network, shotLeadTicks, shotInheritPercent, hasNetSmoothing, port };
}

export function networkShape(network: NetworkSetting): NetworkShape {
  return { delayMs: network.pingMs / 2, ...JITTERS[network.jitter] };
}

// Ожидание ближайшей пачки в одну сторону при случайном шаге сетки X — в среднем E[X²] / (2·E[X]): в длинный шаг
// попадает больше кусков. Туда-обратно — вдвое больше. Для шага, равномерного от a до b, E[X²] / E[X] —
// 2·(a² + ab + b²) / (3·(a + b)). Пауза s раз в T: кусок попадает в неё с долей s / T и ждёт в среднем s / 2 —
// в одну сторону s² / (2·T), туда-обратно s² / T.
export function jitterAddedPingMs(jitter: JitterName): number {
  const { burstMs: low, burstMaxMs: high, stallEveryMs, stallMs } = JITTERS[jitter];
  if (stallEveryMs > 0) {
    return (stallMs * stallMs) / stallEveryMs;
  }
  if (high === 0) {
    return 0;
  }
  return (2 * (low * low + low * high + high * high)) / (3 * (low + high));
}

function describeJitter(jitter: JitterName): string {
  const { burstMs, burstMaxMs, stallEveryMs, stallMs } = JITTERS[jitter];
  const added = Math.round(jitterAddedPingMs(jitter));
  if (stallEveryMs > 0) {
    return `связь замирает на ${String(stallMs)} мс раз в ${String(stallEveryMs)} мс, к пингу в среднем +${String(added)} мс`;
  }
  if (burstMs === 0) {
    return 'без пачек';
  }
  return `пачки раз в ${String(burstMs)}–${String(burstMaxMs)} мс, к пингу в среднем +${String(added)} мс`;
}

function describeJitters(): string {
  return (Object.keys(JITTERS) as JitterName[]).map((jitter) => `${jitter} — ${describeJitter(jitter)}`).join('; ');
}

export function describeNetSmoothing(hasNetSmoothing: boolean): string {
  if (!hasNetSmoothing) {
    return `выключено (${SMOOTH_NET_FLAG} — включить)`;
  }
  return 'включено — очередь команд под пачки, плавная поправка своего танка, отставание чужих под паузы снимков';
}

export function describeShotLead(shotLeadTicks: number): string {
  if (shotLeadTicks === NO_SHOT_LEAD) {
    return `выключен (${LEAD_FLAG} 2 — включить)`;
  }
  return `тиков: ${String(shotLeadTicks)} — снаряд человека рождается дальше по полёту`;
}

export function describeShotInherit(shotInheritPercent: number): string {
  if (shotInheritPercent === NO_SHOT_INHERIT) {
    return `выключено (${INHERIT_FLAG} 100 — включить)`;
  }
  if (shotInheritPercent === FULL_SHOT_INHERIT) {
    return `${String(shotInheritPercent)} % — снаряд получает скорость танка и на ходу идёт по линии ствола`;
  }
  return `${String(shotInheritPercent)} % — снаряд получает эту долю скорости танка`;
}

export function describeNetwork(network: NetworkSetting): string {
  return `пинг ${String(network.pingMs)} мс, неровность ${network.jitter} — ${describeJitter(network.jitter)}`;
}
