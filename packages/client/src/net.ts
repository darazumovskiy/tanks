import type { Action, Stats } from '@tanks/shared/engine';
import {
  decode,
  encode,
  MessageType,
  PROTOCOL_VERSION,
  type ErrorMessage,
  type RoomStateMessage,
  type RoundStartMessage,
  type ServerMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from '@tanks/shared/protocol';

export interface NetHandlers {
  onWelcome(message: WelcomeMessage): void;
  onRoomState(message: RoomStateMessage): void;
  onRoundStart(message: RoundStartMessage): void;
  onSnapshot(message: SnapshotMessage, receivedAt: number): void;
  onError(message: ErrorMessage): void;
  onDisconnect(retryInMs: number): void;
}

// Подмножество WebSocket, которое нужно клиенту; в тестах заменяется поддельным сокетом.
export interface SocketLike {
  binaryType: BinaryType;
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<ArrayBuffer | string>) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

export interface NetOptions {
  createSocket?: (url: string) => SocketLike;
  now?: () => number;
}

const PING_INTERVAL_MS = 1000;
const RTT_SMOOTHING = 0.3;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 5000;
const SOCKET_OPEN = 1;

// Соединение с сервером: кодирует и декодирует сообщения, меряет задержку туда-обратно.
// Разрыв не по нашей воле — переподключение с удвоением паузы (до 5 с: выкладка сервера длится ~2 с) и повторный вход в ту же комнату;
// возврат вкладки или приложения на экран — попытка сразу. Ошибка от сервера — окончательна, без повторов.
export class NetClient {
  private socket: SocketLike | null = null;
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private attempt = 0;
  private isClosedByUs = false;
  private isFatal = false;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly now: () => number;
  rttMs = 0;
  serverTick = 0;

  constructor(
    private readonly url: string,
    private readonly handlers: NetHandlers,
    private readonly join: { roomCode: string; nickname: string; stats: Stats },
    options: NetOptions = {},
  ) {
    this.createSocket = options.createSocket ?? ((target): SocketLike => new WebSocket(target));
    this.now = options.now ?? ((): number => performance.now());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.reconnectTimer !== null) {
        window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.connect();
      }
    });
    this.connect();
  }

  get isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === SOCKET_OPEN;
  }

  sendInput(seq: number, action: Action): void {
    this.send(encode({ type: MessageType.Input, seq, action }));
  }

  close(): void {
    this.isClosedByUs = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this.socket?.close();
  }

  private connect(): void {
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = (): void => {
      this.attempt = 0;
      this.send(
        encode({
          type: MessageType.Join,
          protocolVersion: PROTOCOL_VERSION,
          roomCode: this.join.roomCode,
          nickname: this.join.nickname,
          stats: this.join.stats,
        }),
      );
      this.pingTimer = window.setInterval(() => {
        this.send(encode({ type: MessageType.Ping, clientTime: this.now() }));
      }, PING_INTERVAL_MS);
    };
    socket.onmessage = (event: MessageEvent<ArrayBuffer | string>): void => {
      if (typeof event.data === 'string') {
        return;
      }
      this.dispatch(decode(new Uint8Array(event.data)) as ServerMessage, this.now());
    };
    socket.onclose = (): void => {
      this.stopPing();
      if (this.isClosedByUs || this.isFatal) {
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.attempt++;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.attempt - 1));
    this.handlers.onDisconnect(delay);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private send(bytes: Uint8Array): void {
    if (this.socket !== null && this.socket.readyState === SOCKET_OPEN) {
      this.socket.send(bytes);
    }
  }

  private dispatch(message: ServerMessage, receivedAt: number): void {
    switch (message.type) {
      case MessageType.Welcome:
        this.handlers.onWelcome(message);
        break;
      case MessageType.RoomState:
        this.handlers.onRoomState(message);
        break;
      case MessageType.RoundStart:
        this.handlers.onRoundStart(message);
        break;
      case MessageType.Snapshot:
        this.handlers.onSnapshot(message, receivedAt);
        break;
      case MessageType.Pong: {
        const sample = receivedAt - message.clientTime;
        this.rttMs = this.rttMs === 0 ? sample : this.rttMs + (sample - this.rttMs) * RTT_SMOOTHING;
        this.serverTick = message.serverTick;
        break;
      }
      case MessageType.Error:
        this.isFatal = true;
        this.handlers.onError(message);
        break;
    }
  }
}

export function websocketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}
