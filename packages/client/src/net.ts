import type { Action, Stats } from '@tanks/shared/engine';
import {
  decode,
  encode,
  MessageType,
  PROTOCOL_VERSION,
  type ErrorMessage,
  type FfaBulletsMessage,
  type FfaMatchStartMessage,
  type FfaRosterMessage,
  type FfaScoreMessage,
  type FfaSnapshotMessage,
  type FfaStateMessage,
  type FfaWelcomeMessage,
  type RoomStateMessage,
  type RoundStartMessage,
  type ServerMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from '@tanks/shared/protocol';

// closed — сокет закрылся сам; silent — от сервера слишком долго ничего не было, сокет закрыли мы.
export type DisconnectReason = 'closed' | 'silent';

// Обработчики сообщений дуэли и толпы: режим задаёт только те, что ему приходят.
export interface NetHandlers {
  onWelcome?(message: WelcomeMessage): void;
  onRoomState?(message: RoomStateMessage): void;
  onRoundStart?(message: RoundStartMessage): void;
  onSnapshot?(message: SnapshotMessage, receivedAt: number): void;
  onFfaWelcome?(message: FfaWelcomeMessage): void;
  onFfaState?(message: FfaStateMessage, receivedAt: number): void;
  onFfaRoster?(message: FfaRosterMessage): void;
  onFfaMatchStart?(message: FfaMatchStartMessage): void;
  onFfaSnapshot?(message: FfaSnapshotMessage, receivedAt: number): void;
  onFfaScore?(message: FfaScoreMessage): void;
  onFfaBullets?(message: FfaBulletsMessage): void;
  onError(message: ErrorMessage): void;
  onDisconnect(retryInMs: number, reason: DisconnectReason): void;
}

// token — пропуск общей игры для возврата на своё место; пусто у нового игрока и в дуэли.
// gameId — номер общей игры из приглашения друга; пусто — любая игра и в дуэли.
export interface NetJoin {
  roomCode: string;
  nickname: string;
  stats: Stats;
  token: string;
  gameId: string;
}

// Подмножество WebSocket, которое нужно клиенту; в тестах заменяется поддельным сокетом.
export interface SocketLike {
  binaryType: BinaryType;
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null;
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
// Сервер отвечает на каждый пинг раз в секунду: живая связь столько не молчит.
const SILENCE_TIMEOUT_MS = 4000;
const SOCKET_OPEN = 1;

// Соединение с сервером: кодирует и декодирует сообщения, меряет задержку туда-обратно.
// Разрыв не по нашей воле — переподключение с удвоением паузы (до 5 с: выкладка сервера длится ~2 с) и повторный вход в ту же комнату;
// возврат вкладки или приложения на экран — попытка сразу. Ошибка от сервера — окончательна, без повторов.
// Тихий обрыв — сокет открыт, а от сервера ничего — закрываем сами и переподключаемся, не дожидаясь закрытия сокета.
// Пока вкладка скрыта, молчание обрывом не считается: браузер может будить таймеры фоновой вкладки раз в минуту.
// Вкладка вернулась — отсчёт молчания заново.
// Пропуск из приветствия общей игры уходит в каждый следующий вход.
export class NetClient {
  private socket: SocketLike | null = null;
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private silenceTimer: number | null = null;
  private heardAt = 0;
  private attempt = 0;
  private isClosedByUs = false;
  private isFatal = false;
  private token: string;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly now: () => number;
  rttMs = 0;
  serverTick = 0;

  constructor(
    private readonly url: string,
    private readonly handlers: NetHandlers,
    private readonly join: NetJoin,
    options: NetOptions = {},
  ) {
    this.token = join.token;
    this.createSocket = options.createSocket ?? ((target): SocketLike => new WebSocket(target));
    this.now = options.now ?? ((): number => performance.now());
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.connect();
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') {
      return;
    }
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.connect();
      return;
    }
    if (this.isConnected) {
      this.watchSilence();
    }
  };

  get isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === SOCKET_OPEN;
  }

  sendInput(seq: number, action: Action): void {
    this.send(encode({ type: MessageType.Input, seq, action }));
  }

  // Ушёл сам: сервер держит место короче, чем после обрыва. Байты, отправленные до закрытия, сокет дошлёт.
  leave(): void {
    this.send(encode({ type: MessageType.Leave }));
    this.close();
  }

  close(): void {
    this.isClosedByUs = true;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this.stopSilenceWatch();
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
          token: this.token,
          isBot: false,
          gameId: this.join.gameId,
        }),
      );
      this.pingTimer = window.setInterval(() => {
        this.send(encode({ type: MessageType.Ping, clientTime: this.now() }));
      }, PING_INTERVAL_MS);
      this.watchSilence();
    };
    socket.onmessage = (event: MessageEvent<ArrayBuffer>): void => {
      this.heardAt = Date.now();
      this.dispatch(decode(new Uint8Array(event.data)) as ServerMessage, this.now());
    };
    socket.onclose = (): void => {
      this.stopPing();
      this.stopSilenceWatch();
      if (this.isClosedByUs || this.isFatal) {
        return;
      }
      this.scheduleReconnect('closed');
    };
  }

  // Сообщения идут десятками в секунду, таймер на каждое не перезапускается: сообщение отмечает время,
  // один таймер досчитывает остаток.
  private watchSilence(): void {
    this.heardAt = Date.now();
    this.armSilence(SILENCE_TIMEOUT_MS);
  }

  private armSilence(delayMs: number): void {
    this.stopSilenceWatch();
    this.silenceTimer = window.setTimeout(() => {
      this.silenceTimer = null;
      const silentMs = Date.now() - this.heardAt;
      if (silentMs < SILENCE_TIMEOUT_MS) {
        this.armSilence(SILENCE_TIMEOUT_MS - silentMs);
      } else if (document.visibilityState !== 'hidden') {
        this.dropSilent();
      }
    }, delayMs);
  }

  private stopSilenceWatch(): void {
    if (this.silenceTimer !== null) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  // Закрытие оборванного сокета может идти долго: он отвязывается сразу, переподключение — без ожидания.
  private dropSilent(): void {
    const socket = this.socket;
    if (socket === null || this.isFatal || this.isClosedByUs) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.close();
    this.socket = null;
    this.stopPing();
    this.scheduleReconnect('silent');
  }

  private scheduleReconnect(reason: DisconnectReason): void {
    this.attempt++;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.attempt - 1));
    this.handlers.onDisconnect(delay, reason);
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
    const { handlers } = this;
    switch (message.type) {
      case MessageType.Welcome:
        handlers.onWelcome?.(message);
        break;
      case MessageType.RoomState:
        handlers.onRoomState?.(message);
        break;
      case MessageType.RoundStart:
        handlers.onRoundStart?.(message);
        break;
      case MessageType.Snapshot:
        handlers.onSnapshot?.(message, receivedAt);
        break;
      case MessageType.FfaWelcome:
        this.token = message.token;
        handlers.onFfaWelcome?.(message);
        break;
      case MessageType.FfaState:
        handlers.onFfaState?.(message, receivedAt);
        break;
      case MessageType.FfaRoster:
        handlers.onFfaRoster?.(message);
        break;
      case MessageType.FfaMatchStart:
        handlers.onFfaMatchStart?.(message);
        break;
      case MessageType.FfaSnapshot:
        handlers.onFfaSnapshot?.(message, receivedAt);
        break;
      case MessageType.FfaScore:
        handlers.onFfaScore?.(message);
        break;
      case MessageType.FfaBullets:
        handlers.onFfaBullets?.(message);
        break;
      case MessageType.Pong: {
        const sample = receivedAt - message.clientTime;
        this.rttMs = this.rttMs === 0 ? sample : this.rttMs + (sample - this.rttMs) * RTT_SMOOTHING;
        this.serverTick = message.serverTick;
        break;
      }
      case MessageType.Error:
        this.isFatal = true;
        this.stopSilenceWatch();
        handlers.onError(message);
        break;
    }
  }
}

export function websocketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}
