import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { DEFAULT_RULES, FFA_SIZES, TICK_RATE, type FfaSize, type RoundRules } from '@tanks/shared/engine';
import {
  decode,
  encode,
  ErrorCode,
  ffaSizeOf,
  isClientMessage,
  isFfaRoomCode,
  MessageType,
  NO_ID,
  PROTOCOL_VERSION,
  type ClientMessage,
} from '@tanks/shared/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { DEFAULT_FFA_OPTIONS, type FfaConnection, type FfaOptions } from './ffaGame.js';
import { FileGameLog, LOG_ROUTE, NO_LOG, receiveClientLog, type GameLog } from './gameLog.js';
import { createMetrics, type Metrics } from './metrics.js';
import { DEFAULT_ROOM_OPTIONS, type RoomOptions } from './room.js';
import { isValidRoomCode, RoomManager } from './roomManager.js';
import { APK_ROUTE, requestPath, serveApk, serveStatic } from './static.js';

// logDir — папка журналов игр; без неё журнал не ведётся и приёмщик строк клиента отключён.
// rules — правила движка для всех комнат процесса.
// ffaEnv — переключатели общей игры строками окружения (ключ — имя переменной) поверх `ffa`; пусто — умолчание.
export interface AppOptions {
  staticRoot?: string;
  apkPath?: string;
  logDir?: string;
  rules?: RoundRules;
  room?: RoomOptions;
  ffa?: FfaOptions;
  ffaEnv?: Readonly<Record<string, string | undefined>>;
  tickMs?: number;
  random?: () => number;
  silenceTimeoutMs?: number;
}

export interface App {
  stats(): AppStats;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export interface AppStats {
  rooms: number;
  connections: number;
  tick: number;
  tickDurationMaxMs: number;
}

const WS_PATH = '/ws';
const HEALTH_PATH = '/healthz';
const METRICS_PATH = '/metrics';
// Отставание расписания больше этого числа тиков не навёрстывается пачкой — расписание начинается заново.
const CATCH_UP_LIMIT_TICKS = 5;
// Клиент шлёт Ping раз в секунду; молчание дольше — связь оборвана без закрытия (полуоткрытый TCP).
const DEFAULT_SILENCE_TIMEOUT_MS = 10_000;
const SILENCE_CHECKS_PER_TIMEOUT = 4;

const FFA_ENV = {
  minimum: 'FFA_MINIMUM',
  matchSeconds: 'FFA_MATCH_SECONDS',
  lobbyQuietSeconds: 'FFA_LOBBY_QUIET_SECONDS',
  resultsSeconds: 'FFA_RESULTS_SECONDS',
  idleWarnSeconds: 'FFA_IDLE_WARN_SECONDS',
  idleKickSeconds: 'FFA_IDLE_KICK_SECONDS',
  serverBots: 'FFA_SERVER_BOTS',
} as const;
const SWITCH_ON = '1';
const SWITCH_OFF = '0';
// Минимум один на все размеры, поэтому не больше самой маленькой игры.
const FFA_MINIMUM_LIMIT = Math.min(...FFA_SIZES);
// ticksLeft и idleTicksLeft уходят двумя байтами, а 0xFFFF там значит «нет»: длительность в тиках меньше него.
const FFA_SECONDS_LIMIT = Math.floor((NO_ID - 1) / TICK_RATE);

type FfaEnv = Readonly<Record<string, string | undefined>>;

function envInteger(env: FfaEnv, name: string, limit: number): number | null {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > limit) {
    throw new Error(`${name} должен быть целым от 1 до ${String(limit)}, получено «${raw}»`);
  }
  return value;
}

function envSwitch(env: FfaEnv, name: string): boolean | null {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return null;
  }
  if (raw !== SWITCH_ON && raw !== SWITCH_OFF) {
    throw new Error(`${name} должен быть ${SWITCH_OFF} или ${SWITCH_ON}, получено «${raw}»`);
  }
  return raw === SWITCH_ON;
}

function ticksOr(seconds: number | null, fallback: number): number {
  return seconds === null ? fallback : seconds * TICK_RATE;
}

function ffaOptionsFromEnv(base: FfaOptions, env: FfaEnv): FfaOptions {
  const minimum = envInteger(env, FFA_ENV.minimum, FFA_MINIMUM_LIMIT);
  const matchSeconds = envInteger(env, FFA_ENV.matchSeconds, FFA_SECONDS_LIMIT);
  const lobbyQuietSeconds = envInteger(env, FFA_ENV.lobbyQuietSeconds, FFA_SECONDS_LIMIT);
  const resultsSeconds = envInteger(env, FFA_ENV.resultsSeconds, FFA_SECONDS_LIMIT);
  const idleWarnSeconds = envInteger(env, FFA_ENV.idleWarnSeconds, FFA_SECONDS_LIMIT);
  const idleKickSeconds = envInteger(env, FFA_ENV.idleKickSeconds, FFA_SECONDS_LIMIT);
  const idleWarnTicks = ticksOr(idleWarnSeconds, base.idleWarnTicks);
  const idleKickTicks = ticksOr(idleKickSeconds, base.idleKickTicks);
  const isIdleSet = idleWarnSeconds !== null || idleKickSeconds !== null;
  if (isIdleSet && idleWarnTicks >= idleKickTicks) {
    throw new Error(`${FFA_ENV.idleWarnSeconds} должен быть меньше ${FFA_ENV.idleKickSeconds}`);
  }
  const minimums: Readonly<Record<FfaSize, number>> =
    minimum === null ? base.minimum : { 10: minimum, 30: minimum, 50: minimum };
  return {
    ...base,
    hasServerBots: envSwitch(env, FFA_ENV.serverBots) ?? base.hasServerBots,
    minimum: minimums,
    matchSeconds: matchSeconds ?? base.matchSeconds,
    lobbyQuietTicks: ticksOr(lobbyQuietSeconds, base.lobbyQuietTicks),
    resultsTicks: ticksOr(resultsSeconds, base.resultsTicks),
    idleWarnTicks,
    idleKickTicks,
  };
}

class SocketConnection implements FfaConnection {
  constructor(
    private readonly socket: WebSocket,
    private readonly metrics: Metrics,
  ) {}

  send(bytes: Uint8Array): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.metrics.countMessage('out', bytes.byteLength);
    this.socket.send(bytes);
  }

  close(): void {
    this.socket.close();
  }
}

// binaryType сервера — nodebuffer (умолчание ws): сообщение всегда приходит одним Buffer.
function toBytes(data: RawData): Uint8Array {
  const buffer = data as Buffer;
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export function createApp(options: AppOptions = {}): App {
  const ffaOptions = ffaOptionsFromEnv(options.ffa ?? DEFAULT_FFA_OPTIONS, options.ffaEnv ?? {});
  const fileLog = options.logDir === undefined ? null : new FileGameLog(options.logDir);
  const log: GameLog = fileLog ?? NO_LOG;
  const metrics = createMetrics();
  const rooms = new RoomManager(
    options.room ?? DEFAULT_ROOM_OPTIONS,
    options.random ?? Math.random,
    log,
    metrics,
    options.rules ?? DEFAULT_RULES,
    ffaOptions,
  );
  const tickMs = options.tickMs ?? 1000 / TICK_RATE;
  const server = createServer((request, response) => {
    const path = requestPath(request);
    if (path === HEALTH_PATH) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(stats()));
      return;
    }
    if (path === METRICS_PATH) {
      response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      response.end(
        metrics.render({ rooms: rooms.roomCount, connections: connections.size, players: rooms.playerCounts() }),
      );
      return;
    }
    if (path === LOG_ROUTE && request.method === 'POST' && fileLog !== null) {
      receiveClientLog(fileLog, request, response);
      return;
    }
    if (path === APK_ROUTE && options.apkPath !== undefined && serveApk(options.apkPath, request, response)) {
      return;
    }
    if (options.staticRoot !== undefined && serveStatic(options.staticRoot, request, response)) {
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  // Соединение → когда от него последний раз что-то пришло.
  const connections = new Map<WebSocket, number>();
  const silenceTimeoutMs = options.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
  let tick = 0;
  let tickDurationMaxMs = 0;
  let timer: NodeJS.Timeout | undefined;
  let thinkTimer: NodeJS.Immediate | undefined;
  let silenceTimer: NodeJS.Timeout | undefined;

  function stats(): AppStats {
    return { rooms: rooms.roomCount, connections: connections.size, tick, tickDurationMaxMs };
  }

  function sendError(socket: WebSocket, code: ErrorCode, text: string): void {
    socket.send(encode({ type: MessageType.Error, code, text }));
    socket.close();
  }

  function handleMessage(socket: WebSocket, connection: SocketConnection, message: ClientMessage): void {
    const seat = rooms.seatOf(connection);
    if (message.type === MessageType.Join) {
      if (seat !== undefined) {
        return;
      }
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        sendError(socket, ErrorCode.BadProtocolVersion, 'обнови страницу: версия протокола устарела');
        return;
      }
      if (isFfaRoomCode(message.roomCode)) {
        const size = ffaSizeOf(message.roomCode);
        if (size === null) {
          sendError(socket, ErrorCode.BadMessage, 'неверный размер общей игры');
          return;
        }
        rooms.joinFfa(size, connection, message);
        return;
      }
      if (!isValidRoomCode(message.roomCode)) {
        sendError(socket, ErrorCode.BadMessage, 'неверный код комнаты');
        return;
      }
      const room = rooms.getOrCreate(message.roomCode);
      const side = room.freeSide();
      if (side === null) {
        sendError(socket, ErrorCode.RoomFull, 'в комнате уже два игрока');
        return;
      }
      rooms.attach(connection, room, room.join(side, connection, message.nickname, message.stats));
      return;
    }
    if (seat === undefined) {
      return;
    }
    if (message.type === MessageType.Input) {
      seat.input(message.seq, message.action);
      return;
    }
    seat.ping(message.clientTime);
  }

  wss.on('connection', (socket: WebSocket) => {
    connections.set(socket, performance.now());
    const connection = new SocketConnection(socket, metrics);
    socket.on('message', (data: RawData) => {
      connections.set(socket, performance.now());
      const bytes = toBytes(data);
      metrics.countMessage('in', bytes.byteLength);
      let message;
      try {
        message = decode(bytes);
      } catch {
        sendError(socket, ErrorCode.BadMessage, 'сообщение не распознано');
        return;
      }
      if (!isClientMessage(message)) {
        sendError(socket, ErrorCode.BadMessage, 'сообщение не от клиента');
        return;
      }
      handleMessage(socket, connection, message);
    });
    socket.on('close', () => {
      connections.delete(socket);
      rooms.detach(connection);
    });
    // Ошибка протокола WebSocket: ws сам закрывает соединение, слушатель нужен, чтобы ошибка не уронила процесс.
    socket.on('error', () => undefined);
  });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (requestPath(request) !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  // Закрытие приходит обычным путём (close → detach): игрок общей игры уходит в окно возврата.
  function closeSilent(): void {
    const now = performance.now();
    for (const [socket, heardAt] of connections) {
      if (now - heardAt > silenceTimeoutMs) {
        socket.terminate();
      }
    }
  }

  function thinkBots(): void {
    const started = performance.now();
    rooms.thinkBots();
    metrics.recordBotThink(performance.now() - started);
  }

  // Тик с компенсацией дрейфа таймера: следующий срок считается от расписания, а не от фактического времени.
  // Мозг серверных ботов ходит отдельной задачей после тика: тик он не удлиняет.
  function startLoop(): void {
    let next = performance.now() + tickMs;
    let windowStart = performance.now();
    const run = (): void => {
      const started = performance.now();
      const lateMs = Math.max(0, started - next);
      rooms.step(lateMs);
      tick++;
      const duration = performance.now() - started;
      if (started - windowStart > 1000) {
        windowStart = started;
        tickDurationMaxMs = 0;
      }
      tickDurationMaxMs = Math.max(tickDurationMaxMs, duration);
      metrics.recordTick(duration, lateMs > tickMs);
      thinkTimer = setImmediate(thinkBots);
      next += tickMs;
      const delay = next - performance.now();
      if (delay < -CATCH_UP_LIMIT_TICKS * tickMs) {
        next = performance.now() + tickMs;
      }
      timer = setTimeout(run, Math.max(0, delay));
    };
    timer = setTimeout(run, tickMs);
  }

  return {
    stats,
    listen(port: number, host = '0.0.0.0'): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          // TCP-сокет: address() — всегда AddressInfo.
          const address = server.address() as AddressInfo;
          startLoop();
          silenceTimer = setInterval(closeSilent, silenceTimeoutMs / SILENCE_CHECKS_PER_TIMEOUT);
          resolve(address.port);
        });
      });
    },
    close(): Promise<void> {
      clearTimeout(timer);
      clearImmediate(thinkTimer);
      clearInterval(silenceTimer);
      metrics.close();
      fileLog?.close();
      for (const socket of connections.keys()) {
        socket.terminate();
      }
      wss.close();
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
