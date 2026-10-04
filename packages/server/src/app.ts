import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { TICK_RATE } from '@tanks/shared/engine';
import {
  decode,
  encode,
  ErrorCode,
  isClientMessage,
  MessageType,
  PROTOCOL_VERSION,
  type ClientMessage,
} from '@tanks/shared/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { FileGameLog, LOG_ROUTE, NO_LOG, receiveClientLog, type GameLog } from './gameLog.js';
import { createMetrics, type Metrics } from './metrics.js';
import { DEFAULT_ROOM_OPTIONS, type Connection, type RoomOptions } from './room.js';
import { isValidRoomCode, RoomManager } from './roomManager.js';
import { APK_ROUTE, requestPath, serveApk, serveStatic } from './static.js';

// logDir — папка журналов игр; без неё журнал не ведётся и приёмщик строк клиента отключён.
export interface AppOptions {
  staticRoot?: string;
  apkPath?: string;
  logDir?: string;
  room?: RoomOptions;
  tickMs?: number;
  random?: () => number;
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

class SocketConnection implements Connection {
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
}

// binaryType сервера — nodebuffer (умолчание ws): сообщение всегда приходит одним Buffer.
function toBytes(data: RawData): Uint8Array {
  const buffer = data as Buffer;
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export function createApp(options: AppOptions = {}): App {
  const fileLog = options.logDir === undefined ? null : new FileGameLog(options.logDir);
  const log: GameLog = fileLog ?? NO_LOG;
  const metrics = createMetrics();
  const rooms = new RoomManager(options.room ?? DEFAULT_ROOM_OPTIONS, options.random ?? Math.random, log, metrics);
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
      response.end(metrics.render({ rooms: rooms.roomCount, connections: connections.size }));
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
  const connections = new Set<WebSocket>();
  let tick = 0;
  let tickDurationMaxMs = 0;
  let timer: NodeJS.Timeout | undefined;

  function stats(): AppStats {
    return { rooms: rooms.roomCount, connections: connections.size, tick, tickDurationMaxMs };
  }

  function sendError(socket: WebSocket, code: ErrorCode, text: string): void {
    socket.send(encode({ type: MessageType.Error, code, text }));
    socket.close();
  }

  function handleMessage(socket: WebSocket, connection: Connection, message: ClientMessage): void {
    const seat = rooms.seatOf(connection);
    if (message.type === MessageType.Join) {
      if (seat !== undefined) {
        return;
      }
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        sendError(socket, ErrorCode.BadProtocolVersion, 'обнови страницу: версия протокола устарела');
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
    connections.add(socket);
    const connection = new SocketConnection(socket, metrics);
    socket.on('message', (data: RawData) => {
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

  // Тик с компенсацией дрейфа таймера: следующий срок считается от расписания, а не от фактического времени.
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
          resolve(address.port);
        });
      });
    },
    close(): Promise<void> {
      clearTimeout(timer);
      metrics.close();
      fileLog?.close();
      for (const socket of connections) {
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
