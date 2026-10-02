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
  onClose(): void;
}

const PING_INTERVAL_MS = 1000;
const RTT_SMOOTHING = 0.3;

// Соединение с сервером: кодирует и декодирует сообщения, меряет задержку туда-обратно.
export class NetClient {
  private readonly socket: WebSocket;
  private pingTimer: number | null = null;
  rttMs = 0;
  serverTick = 0;

  constructor(
    url: string,
    private readonly handlers: NetHandlers,
    private readonly join: { roomCode: string; nickname: string; stats: Stats },
  ) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onopen = (): void => {
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
        this.send(encode({ type: MessageType.Ping, clientTime: performance.now() }));
      }, PING_INTERVAL_MS);
    };
    this.socket.onmessage = (event: MessageEvent<ArrayBuffer>): void => {
      this.dispatch(decode(new Uint8Array(event.data)) as ServerMessage, performance.now());
    };
    this.socket.onclose = (): void => {
      if (this.pingTimer !== null) {
        window.clearInterval(this.pingTimer);
      }
      this.handlers.onClose();
    };
  }

  sendInput(seq: number, action: Action): void {
    this.send(encode({ type: MessageType.Input, seq, action }));
  }

  close(): void {
    this.socket.close();
  }

  private send(bytes: Uint8Array): void {
    if (this.socket.readyState === WebSocket.OPEN) {
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
        this.handlers.onError(message);
        break;
    }
  }
}

export function websocketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}
