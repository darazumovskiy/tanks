import { TICK_RATE, type FfaMap, type FfaSize } from '@tanks/shared/engine';
import {
  decode,
  encode,
  ErrorCode,
  FfaPhase,
  gameTimecode,
  MessageType,
  type ClientMessage,
  type ErrorMessage,
  type ServerMessage,
} from '@tanks/shared/protocol';
import { WebSocket } from 'ws';
import { CrowdBot } from '../crowd/bot.js';
import { CROWD_PROFILES, crowdPyramid } from '../crowd/profile.js';
import { TargetBook } from '../crowd/targets.js';

const DEFAULT_JOIN_INTERVAL_MS = 200;
const DEFAULT_PING_INTERVAL_MS = 1000;
// Сервер отвечает на каждый пинг: тишина дольше этого — связь пропала, а закрытие не дошло.
const DEFAULT_SILENCE_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 5000];
// Сервер держит максимум тика за последнюю секунду: опрос раз в секунду не теряет всплески между отчётами.
const HEALTH_POLL_MS = 1000;
const HEALTH_TIMEOUT_MS = 1000;
const HEALTH_PATH = '/healthz';
const BYTES_IN_KIB = 1024;
const MS_IN_SECOND = 1000;
const MICROSECONDS_IN_SECOND = 1_000_000;
const MIN_REPORT_SECONDS = 1e-3;
const SECONDS_IN_MINUTE = 60;
const PERCENT = 100;
const MEDIAN_SHARE = 0.5;
const PING_HIGH_SHARE = 0.95;
const BRAIN_HIGH_SHARE = 0.99;

export interface SwarmOptions {
  url: string;
  size: FfaSize;
  count: number;
  random: () => number;
  mapFor: (size: FfaSize) => FfaMap;
  joinIntervalMs?: number;
  pingIntervalMs?: number;
  silenceTimeoutMs?: number;
  // Паузы перед повторами подряд; последняя повторяется, пока сервер не ответит.
  retryDelaysMs?: readonly number[];
  healthUrl?: string;
  log?: (line: string) => void;
}

export interface SwarmBot {
  playerId: number | null;
  token: string;
  isOnline: boolean;
  isStopped: boolean;
}

interface Percentiles {
  median: number | null;
  high: number | null;
}

// Тик — последний снимок у ботов этой игры; до первого снимка (лобби) — null.
export interface SwarmGame {
  id: string;
  gameTick: number | null;
}

// Отчёт за время с прошлого отчёта: трафик и снимки — на бота в игре в секунду, высокий процентиль — 95-й у
// пинга и 99-й у мозга; доля процессора — от одного ядра; тик сервера — максимум за время отчёта.
export interface SwarmReport {
  online: number;
  total: number;
  games: SwarmGame[];
  phase: FfaPhase | null;
  matchTick: number;
  bytesPerSecond: { average: number; max: number };
  snapshotsPerSecond: number;
  gaps: number;
  pingMs: Percentiles;
  brainMs: Percentiles;
  cpuShare: number;
  serverTickMaxMs: number | null;
  visibleBullets: { average: number | null; max: number };
  offscreenShare: number | null;
}

export function healthUrlOf(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  parsed.pathname = HEALTH_PATH;
  return parsed.toString();
}

function gamesOf(bots: readonly CrowdBot[]): SwarmGame[] {
  const ticks = new Map<string, number | null>();
  for (const bot of bots) {
    const known = ticks.get(bot.gameId) ?? null;
    const tick = bot.gameTick;
    if (tick === null) {
      ticks.set(bot.gameId, known);
      continue;
    }
    ticks.set(bot.gameId, known === null ? tick : Math.max(known, tick));
  }
  return [...ticks].map(([id, gameTick]) => ({ id, gameTick }));
}

// Ближайший ранг: на двух значениях 95-й процентиль — большее из них.
function percentile(values: readonly number[], share: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(share * sorted.length) - 1] ?? null;
}

function hasTickDuration(body: unknown): body is { tickDurationMaxMs: number } {
  return (
    typeof body === 'object' &&
    body !== null &&
    'tickDurationMaxMs' in body &&
    typeof body.tickDurationMaxMs === 'number'
  );
}

async function readServerTick(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body: unknown = await response.json();
    if (!hasTickDuration(body)) {
      return null;
    }
    return body.tickDurationMaxMs;
  } catch {
    return null;
  }
}

interface MemberContext {
  options: SwarmOptions;
  isRunning: () => boolean;
  log: (line: string) => void;
}

// Один бот роя на своём сокете: вход, пинг, команды, переподключение.
class Member {
  isStopped = false;
  bytes = 0;
  pings: number[] = [];
  brainTimes: number[] = [];
  private socket: WebSocket | null = null;
  private attempt = 0;
  private heardAt = 0;
  private pingTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly bot: CrowdBot,
    private readonly context: MemberContext,
  ) {}

  get isOnline(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.bot.playerId !== null;
  }

  connect(): void {
    const options = this.context.options;
    const socket = new WebSocket(options.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.on('open', () => {
      this.heardAt = performance.now();
      this.send(this.bot.joinMessage());
      const silenceMs = options.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
      this.pingTimer = setInterval(() => {
        if (performance.now() - this.heardAt > silenceMs) {
          socket.terminate();
          return;
        }
        this.send({ type: MessageType.Ping, clientTime: performance.now() });
      }, options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
    });
    // Текстовые сообщения — не протокол игры: игровой сервер шлёт только двоичные.
    socket.on('message', (data: ArrayBuffer, isBinary: boolean) => {
      if (!isBinary) {
        return;
      }
      this.receive(socket, new Uint8Array(data));
    });
    socket.on('close', () => {
      this.onClose();
    });
    // Ошибка соединения всегда сопровождается закрытием — повтор планирует обработчик закрытия.
    socket.on('error', () => undefined);
  }

  close(): Promise<void> {
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const socket = this.socket;
    if (socket === null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      socket.once('close', () => {
        resolve();
      });
      socket.terminate();
    });
  }

  private send(message: ClientMessage): void {
    this.socket?.send(encode(message));
  }

  // Нераспознанное сообщение — не игровой сервер или другая версия протокола: бот останавливается, рой живёт.
  private receive(socket: WebSocket, bytes: Uint8Array): void {
    this.heardAt = performance.now();
    this.bytes += bytes.byteLength;
    let message: ServerMessage;
    try {
      message = decode(bytes) as ServerMessage;
    } catch {
      this.stop('сервер прислал сообщение не по протоколу игры — проверь адрес и сборку');
      socket.terminate();
      return;
    }
    if (message.type === MessageType.FfaWelcome) {
      this.attempt = 0;
    }
    if (message.type === MessageType.Pong) {
      this.pings.push(performance.now() - message.clientTime);
      return;
    }
    if (message.type === MessageType.Error) {
      this.onError(message);
      return;
    }
    const started = performance.now();
    const input = this.bot.receive(message);
    if (message.type === MessageType.FfaSnapshot) {
      this.brainTimes.push(performance.now() - started);
    }
    if (input !== null) {
      this.send(input);
    }
  }

  // Бездействие — вход заново новым игроком; прочие ошибки окончательные: перехват места, версия протокола.
  private onError(message: ErrorMessage): void {
    if (message.code === ErrorCode.Idle) {
      this.bot.forgetToken();
      this.context.log(`${this.bot.nickname}: выкинуло за бездействие, вхожу заново`);
      return;
    }
    this.stop(message.text);
  }

  private stop(reason: string): void {
    this.isStopped = true;
    this.context.log(`${this.bot.nickname} остановлен: ${reason}`);
  }

  // Пауза перед повтором — по номеру попытки подряд; после последней из списка повторяется последняя.
  private onClose(): void {
    clearInterval(this.pingTimer);
    this.socket = null;
    this.bot.disconnect();
    if (!this.context.isRunning() || this.isStopped) {
      return;
    }
    const delays = this.context.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const delay = delays.slice(0, this.attempt + 1).reduce((_, value) => value, 0);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}

// Рой: N ботов толпы входят по одному в общую игру через сокет, как обычные игроки.
export class Swarm {
  private readonly members: Member[];
  private readonly joinTimers: NodeJS.Timeout[] = [];
  private healthTimer: NodeJS.Timeout | undefined;
  private isRunning = false;
  private serverTickMaxMs: number | null = null;
  private reportedAt = performance.now();
  private cpuAt = process.cpuUsage();

  constructor(private readonly options: SwarmOptions) {
    const book = new TargetBook();
    const context: MemberContext = {
      options,
      isRunning: () => this.isRunning,
      log: options.log ?? console.log,
    };
    this.members = crowdPyramid(options.count).map((level, index) => {
      const bot = new CrowdBot({
        level,
        nickname: `${CROWD_PROFILES[level].name} ${String(index + 1)}`,
        size: options.size,
        random: options.random,
        book,
        phase: index,
        mapFor: options.mapFor,
      });
      return new Member(bot, context);
    });
  }

  get isDone(): boolean {
    return this.members.every((member) => member.isStopped);
  }

  start(): void {
    this.isRunning = true;
    const interval = this.options.joinIntervalMs ?? DEFAULT_JOIN_INTERVAL_MS;
    this.members.forEach((member, index) => {
      this.joinTimers.push(
        setTimeout(() => {
          member.connect();
        }, index * interval),
      );
    });
    this.pollHealth();
    this.healthTimer = setInterval(() => {
      this.pollHealth();
    }, HEALTH_POLL_MS);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    clearInterval(this.healthTimer);
    for (const timer of this.joinTimers.splice(0)) {
      clearTimeout(timer);
    }
    await Promise.all(this.members.map((member) => member.close()));
  }

  bots(): SwarmBot[] {
    return this.members.map((member) => ({
      playerId: member.bot.playerId,
      token: member.bot.token,
      isOnline: member.isOnline,
      isStopped: member.isStopped,
    }));
  }

  report(): SwarmReport {
    const now = performance.now();
    const seconds = Math.max(MIN_REPORT_SECONDS, (now - this.reportedAt) / MS_IN_SECOND);
    this.reportedAt = now;
    const cpu = process.cpuUsage(this.cpuAt);
    this.cpuAt = process.cpuUsage();
    const online = this.members.filter((member) => member.isOnline);
    const perBot = Math.max(1, online.length);
    const rates: number[] = [];
    const pings: number[] = [];
    const brainTimes: number[] = [];
    let snapshots = 0;
    let gaps = 0;
    let visibleSum = 0;
    let visibleSamples = 0;
    let visibleMax = 0;
    let damageTaken = 0;
    let offscreenDamage = 0;
    for (const member of this.members) {
      rates.push(member.bytes / seconds);
      pings.push(...member.pings.splice(0));
      brainTimes.push(...member.brainTimes.splice(0));
      member.bytes = 0;
      const counters = member.bot.takeCounters();
      snapshots += counters.snapshots;
      gaps += counters.gaps;
      visibleSum += counters.visibleBullets;
      visibleSamples += counters.visibleSamples;
      visibleMax = Math.max(visibleMax, counters.visibleMax);
      damageTaken += counters.damageTaken;
      offscreenDamage += counters.offscreenDamage;
    }
    const serverTickMaxMs = this.serverTickMaxMs;
    this.serverTickMaxMs = null;
    const lead = online.find((member) => member.bot.phase !== null)?.bot;
    return {
      online: online.length,
      total: this.members.length,
      games: gamesOf(online.map((member) => member.bot)),
      phase: lead?.phase ?? null,
      matchTick: lead?.matchTick ?? 0,
      bytesPerSecond: { average: rates.reduce((sum, rate) => sum + rate, 0) / perBot, max: Math.max(...rates) },
      snapshotsPerSecond: snapshots / perBot / seconds,
      gaps,
      pingMs: { median: percentile(pings, MEDIAN_SHARE), high: percentile(pings, PING_HIGH_SHARE) },
      brainMs: { median: percentile(brainTimes, MEDIAN_SHARE), high: percentile(brainTimes, BRAIN_HIGH_SHARE) },
      cpuShare: (cpu.user + cpu.system) / MICROSECONDS_IN_SECOND / seconds,
      serverTickMaxMs,
      visibleBullets: { average: visibleSamples > 0 ? visibleSum / visibleSamples : null, max: visibleMax },
      offscreenShare: damageTaken > 0 ? offscreenDamage / damageTaken : null,
    };
  }

  private pollHealth(): void {
    void readServerTick(this.options.healthUrl ?? healthUrlOf(this.options.url)).then((tickMs) => {
      if (tickMs === null) {
        return;
      }
      this.serverTickMaxMs = Math.max(this.serverTickMaxMs ?? 0, tickMs);
    });
  }
}

function decimal(value: number, digits: number): string {
  return value.toFixed(digits).replace('.', ',');
}

function optional(value: number | null, digits: number): string {
  return value === null ? '—' : decimal(value, digits);
}

function phaseText(report: SwarmReport): string {
  switch (report.phase) {
    case FfaPhase.Lobby:
      return 'лобби';
    case FfaPhase.Countdown:
      return 'отсчёт';
    case FfaPhase.Fight: {
      const seconds = Math.floor(report.matchTick / TICK_RATE);
      const minutes = Math.floor(seconds / SECONDS_IN_MINUTE);
      return `бой ${String(minutes)}:${String(seconds % SECONDS_IN_MINUTE).padStart(2, '0')}`;
    }
    case FfaPhase.Results:
      return 'итоги';
    case null:
      return 'нет игры';
  }
}

// Игра — как в строке внизу экрана игрока: номер и таймкод; по ним ищется журнал игры на сервере.
function gamesText(games: readonly SwarmGame[]): string[] {
  if (games.length === 0) {
    return [];
  }
  const parts = games.map((game) => (game.gameTick === null ? game.id : `${game.id} ${gameTimecode(game.gameTick)}`));
  return [parts.join(', ')];
}

export function formatReport(report: SwarmReport): string {
  const percent = (share: number | null): string => optional(share === null ? null : share * PERCENT, 0);
  const bytes = report.bytesPerSecond;
  return [
    `${String(report.online)}/${String(report.total)} в игре`,
    ...gamesText(report.games),
    phaseText(report),
    `вход на бота ${decimal(bytes.average / BYTES_IN_KIB, 0)} КиБ/с (макс ${decimal(bytes.max / BYTES_IN_KIB, 0)})`,
    `снимков ${decimal(report.snapshotsPerSecond, 0)}/с, пропусков ${String(report.gaps)}`,
    `пинг ${optional(report.pingMs.median, 0)}/${optional(report.pingMs.high, 0)} мс`,
    `мозг ${optional(report.brainMs.median, 2)}/${optional(report.brainMs.high, 2)} мс`,
    `рой ${percent(report.cpuShare)} % ядра`,
    `тик сервера макс ${optional(report.serverTickMaxMs, 1)} мс`,
    `снарядов в окне ${optional(report.visibleBullets.average, 1)}/${String(report.visibleBullets.max)}`,
    `урон из-за экрана ${percent(report.offscreenShare)} %`,
  ].join(' · ');
}
