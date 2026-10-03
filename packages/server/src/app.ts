import { createServer, type IncomingMessage, type Server } from 'node:http';
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
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_ROOM_OPTIONS, type Connection, type RoomOptions } from './room.js';
import { isValidRoomCode, RoomManager } from './roomManager.js';
import { APK_ROUTE, serveApk, serveStatic } from './static.js';

export interface AppOptions {
  staticRoot?: string;
  apkPath?: string;
  room?: RoomOptions;
  tickMs?: number;
  random?: () => number;
}

export interface App {
  server: Server;
  rooms: RoomManager;
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

class SocketConnection implements Connection {
  constructor(private readonly socket: WebSocket) {}

  send(bytes: Uint8Array): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(bytes);
    }
  }

  close(): void {
    this.socket.close();
  }
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function createApp(options: AppOptions = {}): App {
  const rooms = new RoomManager(options.room ?? DEFAULT_ROOM_OPTIONS, options.random ?? Math.random);
  const tickMs = options.tickMs ?? 1000 / TICK_RATE;
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    if (path === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(stats()));
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
  let timer: NodeJS.Timeout | null = null;

  function stats(): AppStats {
    return { rooms: rooms.roomCount, connections: connections.size, tick, tickDurationMaxMs };
  }

  function sendError(socket: WebSocket, code: ErrorCode, text: string): void {
    socket.send(encode({ type: MessageType.Error, code, text }));
    socket.close();
  }

  function handleMessage(socket: WebSocket, connection: Connection, message: ClientMessage): void {
    const room = rooms.roomOf(connection);
    if (message.type === MessageType.Join) {
      if (room !== undefined) {
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
      const target = rooms.getOrCreate(message.roomCode);
      const side = target.join(connection, message.nickname, message.stats);
      if (side === null) {
        sendError(socket, ErrorCode.RoomFull, 'в комнате уже два игрока');
        return;
      }
      rooms.attach(connection, target);
      return;
    }
    if (room === undefined) {
      return;
    }
    if (message.type === MessageType.Input) {
      room.input(connection, message.seq, message.action);
      return;
    }
    room.ping(connection, message.clientTime);
  }

  wss.on('connection', (socket: WebSocket) => {
    connections.add(socket);
    const connection = new SocketConnection(socket);
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      let message;
      try {
        message = decode(toBytes(data));
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
    socket.on('error', () => {
      socket.close();
    });
  });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== '/ws') {
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
      rooms.step();
      tick++;
      const duration = performance.now() - started;
      if (started - windowStart > 1000) {
        windowStart = started;
        tickDurationMaxMs = 0;
      }
      tickDurationMaxMs = Math.max(tickDurationMaxMs, duration);
      next += tickMs;
      const delay = next - performance.now();
      if (delay < -5 * tickMs) {
        next = performance.now() + tickMs;
      }
      timer = setTimeout(run, Math.max(0, delay));
    };
    timer = setTimeout(run, tickMs);
  }

  return {
    server,
    rooms,
    stats,
    listen(port: number, host = '0.0.0.0'): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          startLoop();
          resolve(typeof address === 'object' && address !== null ? address.port : port);
        });
      });
    },
    close(): Promise<void> {
      if (timer !== null) {
        clearTimeout(timer);
      }
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
