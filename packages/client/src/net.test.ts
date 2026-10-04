import { DEFAULT_STATS } from '@tanks/shared/engine';
import { AGENT_NOTICE, decode, encode, ErrorCode, MessageType, type ClientMessage } from '@tanks/shared/protocol';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { NetClient, RECONNECT_BASE_MS, RECONNECT_MAX_MS, type NetHandlers, type SocketLike } from './net.js';

class FakeSocket implements SocketLike {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<ArrayBuffer | string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: ClientMessage[] = [];
  isClosedByClient = false;

  send(data: Uint8Array): void {
    this.sent.push(decode(data) as ClientMessage);
  }

  close(): void {
    this.isClosedByClient = true;
    this.drop();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  receive(bytes: Uint8Array): void {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    this.onmessage?.(new MessageEvent('message', { data: buffer }));
  }

  receiveText(text: string): void {
    this.onmessage?.(new MessageEvent('message', { data: text }));
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }
}

describe('NetClient', () => {
  const sockets: FakeSocket[] = [];
  let handlers: NetHandlers;
  let onDisconnect: Mock<NetHandlers['onDisconnect']>;
  let onError: Mock<NetHandlers['onError']>;
  let onWelcome: Mock<NetHandlers['onWelcome']>;
  let client: NetClient;

  const latest = (): FakeSocket => {
    const socket = sockets[sockets.length - 1];
    if (socket === undefined) {
      throw new Error('нет сокета');
    }
    return socket;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    onDisconnect = vi.fn<NetHandlers['onDisconnect']>();
    onError = vi.fn<NetHandlers['onError']>();
    onWelcome = vi.fn<NetHandlers['onWelcome']>();
    handlers = {
      onWelcome,
      onRoomState: vi.fn(),
      onRoundStart: vi.fn(),
      onSnapshot: vi.fn(),
      onError,
      onDisconnect,
    };
    client = new NetClient(
      'ws://test/ws',
      handlers,
      { roomCode: 'abc', nickname: 'Дима', stats: { ...DEFAULT_STATS } },
      {
        createSocket: (): SocketLike => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        now: () => 1000,
      },
    );
  });

  afterEach(() => {
    client.close();
    vi.useRealTimers();
  });

  it('после открытия шлёт вход в комнату и раз в секунду пинг', () => {
    latest().open();
    expect(latest().sent[0]).toMatchObject({ type: MessageType.Join, roomCode: 'abc', nickname: 'Дима' });
    vi.advanceTimersByTime(1000);
    expect(latest().sent[1]).toMatchObject({ type: MessageType.Ping, clientTime: 1000 });
  });

  it('разрыв не по нашей воле — переподключение через 1, 2, 4 … с, не больше предела', () => {
    latest().open();
    latest().drop();
    expect(onDisconnect).toHaveBeenLastCalledWith(RECONNECT_BASE_MS);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    expect(sockets).toHaveLength(2);
    latest().drop();
    expect(onDisconnect).toHaveBeenLastCalledWith(RECONNECT_BASE_MS * 2);
    vi.advanceTimersByTime(RECONNECT_BASE_MS * 2);
    latest().drop();
    vi.advanceTimersByTime(RECONNECT_BASE_MS * 4);
    latest().drop();
    vi.advanceTimersByTime(RECONNECT_MAX_MS);
    latest().drop();
    expect(onDisconnect).toHaveBeenLastCalledWith(RECONNECT_MAX_MS);
  });

  it('новый сокет снова входит в ту же комнату, пауза сбрасывается после удачного входа', () => {
    latest().open();
    latest().drop();
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    latest().open();
    expect(latest().sent[0]).toMatchObject({ type: MessageType.Join, roomCode: 'abc' });
    latest().drop();
    expect(onDisconnect).toHaveBeenLastCalledWith(RECONNECT_BASE_MS);
  });

  it('пинг не шлётся в разорванный сокет', () => {
    latest().open();
    latest().drop();
    const sentBefore = latest().sent.length;
    vi.advanceTimersByTime(3000);
    expect(sockets[0]?.sent.length).toBe(sentBefore);
  });

  it('возврат на экран — попытка сразу, не дожидаясь паузы', () => {
    latest().open();
    latest().drop();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(RECONNECT_MAX_MS);
    expect(sockets).toHaveLength(2);
  });

  it('закрытие нами — без переподключения', () => {
    latest().open();
    client.close();
    vi.advanceTimersByTime(RECONNECT_MAX_MS * 2);
    expect(sockets).toHaveLength(1);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('ошибка от сервера окончательна: сокет закрылся — переподключения нет', () => {
    latest().open();
    latest().receive(encode({ type: MessageType.Error, code: ErrorCode.RoomFull, text: 'полна' }));
    latest().drop();
    expect(onError).toHaveBeenCalled();
    vi.advanceTimersByTime(RECONNECT_MAX_MS * 2);
    expect(sockets).toHaveLength(1);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('входящие сообщения раскладываются по обработчикам, понг меряет задержку', () => {
    latest().open();
    latest().receive(encode({ type: MessageType.Welcome, side: 1, roomCode: 'abc' }));
    expect(onWelcome).toHaveBeenCalledWith(expect.objectContaining({ side: 1 }));
    latest().receive(encode({ type: MessageType.Pong, clientTime: 940, serverTick: 77 }));
    expect(client.rttMs).toBe(60);
    expect(client.serverTick).toBe(77);
    client.sendInput(5, { throttle: 1, turn: 0, turretTurn: 0, isFiring: false });
    expect(latest().sent.at(-1)).toMatchObject({ type: MessageType.Input, seq: 5 });
  });

  it('текстовое сообщение сервера пропускается: обработчики молчат, следующий Welcome разобран', () => {
    latest().open();
    expect(() => {
      latest().receiveText(AGENT_NOTICE);
    }).not.toThrow();
    expect(onWelcome).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    latest().receive(encode({ type: MessageType.Welcome, side: 0, roomCode: 'abc' }));
    expect(onWelcome).toHaveBeenCalledWith(expect.objectContaining({ side: 0 }));
  });
});
