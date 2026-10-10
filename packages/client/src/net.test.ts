import { DEFAULT_RULES, DEFAULT_STATS } from '@tanks/shared/engine';
import {
  decode,
  encode,
  ErrorCode,
  FfaInviteMiss,
  FfaPhase,
  MessageType,
  type ClientMessage,
} from '@tanks/shared/protocol';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { NetClient, RECONNECT_BASE_MS, RECONNECT_MAX_MS, type NetHandlers, type SocketLike } from './net.js';

class FakeSocket implements SocketLike {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
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

  drop(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }
}

const SILENCE_TIMEOUT_MS = 4000;

describe('NetClient', () => {
  const sockets: FakeSocket[] = [];
  let handlers: NetHandlers;
  let onDisconnect: Mock<NetHandlers['onDisconnect']>;
  let onError: Mock<NetHandlers['onError']>;
  let onWelcome: Mock<NonNullable<NetHandlers['onWelcome']>>;
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
    onWelcome = vi.fn<NonNullable<NetHandlers['onWelcome']>>();
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
      { roomCode: 'abc', nickname: 'Дима', stats: { ...DEFAULT_STATS }, token: '', gameId: '' },
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
    expect(onDisconnect).toHaveBeenLastCalledWith(RECONNECT_BASE_MS, 'closed');
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    expect(sockets).toHaveLength(2);
    latest().drop();
    expect(onDisconnect).toHaveBeenLastCalledWith(RECONNECT_BASE_MS * 2, 'closed');
    vi.advanceTimersByTime(RECONNECT_BASE_MS * 2);
    latest().drop();
    vi.advanceTimersByTime(RECONNECT_BASE_MS * 4);
    latest().drop();
    vi.advanceTimersByTime(RECONNECT_MAX_MS);
    latest().drop();
    expect(onDisconnect).toHaveBeenLastCalledWith(RECONNECT_MAX_MS, 'closed');
  });

  it('новый сокет снова входит в ту же комнату, пауза сбрасывается после удачного входа', () => {
    latest().open();
    latest().drop();
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    latest().open();
    expect(latest().sent[0]).toMatchObject({ type: MessageType.Join, roomCode: 'abc' });
    latest().drop();
    expect(onDisconnect).toHaveBeenLastCalledWith(RECONNECT_BASE_MS, 'closed');
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
    latest().receive(encode({ type: MessageType.Welcome, side: 1, roomCode: 'abc', hasNetSmoothing: false }));
    expect(onWelcome).toHaveBeenCalledWith(expect.objectContaining({ side: 1 }));
    latest().receive(encode({ type: MessageType.Pong, clientTime: 940, serverTick: 77 }));
    expect(client.rttMs).toBe(60);
    expect(client.serverTick).toBe(77);
    client.sendInput(5, { throttle: 1, turn: 0, turretTurn: 0, isFiring: false });
    expect(latest().sent.at(-1)).toMatchObject({ type: MessageType.Input, seq: 5 });
  });

  it('последние пять замеров задержки — без сглаживания, старые первыми', () => {
    latest().open();
    expect(client.recentRttMs).toEqual([]);
    for (const clientTime of [950, 940, 930, 920, 910, 900, 890]) {
      latest().receive(encode({ type: MessageType.Pong, clientTime, serverTick: 1 }));
    }
    expect(client.recentRttMs).toEqual([70, 80, 90, 100, 110]);
  });

  it('тихий обрыв: от сервера 4 с ничего — сокет закрыт нами, переподключение', () => {
    latest().open();
    vi.advanceTimersByTime(SILENCE_TIMEOUT_MS - 1);
    expect(latest().isClosedByClient).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sockets[0]?.isClosedByClient).toBe(true);
    expect(onDisconnect).toHaveBeenCalledWith(RECONNECT_BASE_MS, 'silent');
    expect(client.isConnected).toBe(false);
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    expect(sockets).toHaveLength(2);
    latest().open();
    expect(latest().sent[0]).toMatchObject({ type: MessageType.Join, roomCode: 'abc' });
  });

  it('понг раз в секунду держит соединение', () => {
    latest().open();
    for (let second = 0; second < 10; second++) {
      vi.advanceTimersByTime(1000);
      latest().receive(encode({ type: MessageType.Pong, clientTime: 1000, serverTick: second }));
    }
    expect(latest().isClosedByClient).toBe(false);
    expect(sockets).toHaveLength(1);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('поток сообщений не заводит таймер на каждое, молчание считается от последнего', () => {
    latest().open();
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    for (let frame = 0; frame < 120; frame++) {
      vi.advanceTimersByTime(16);
      latest().receive(encode({ type: MessageType.Pong, clientTime: 1000, serverTick: frame }));
    }
    expect(setTimeoutSpy.mock.calls.length).toBeLessThanOrEqual(2);
    vi.advanceTimersByTime(SILENCE_TIMEOUT_MS - 1);
    expect(latest().isClosedByClient).toBe(false);
    vi.advanceTimersByTime(1);
    expect(latest().isClosedByClient).toBe(true);
    expect(onDisconnect).toHaveBeenCalledWith(RECONNECT_BASE_MS, 'silent');
  });

  it('после ошибки сервера молчание не переподключает', () => {
    latest().open();
    latest().receive(encode({ type: MessageType.Error, code: ErrorCode.Idle, text: 'выкинуло' }));
    vi.advanceTimersByTime(SILENCE_TIMEOUT_MS * 3);
    expect(sockets).toHaveLength(1);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  describe('фоновая вкладка', () => {
    const setVisibility = (state: DocumentVisibilityState): void => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };

    afterEach(() => {
      setVisibility('visible');
    });

    it('скрытая вкладка молчит сколько угодно — сокет не закрывается; вернулась — отсчёт молчания заново', () => {
      latest().open();
      setVisibility('hidden');
      vi.advanceTimersByTime(SILENCE_TIMEOUT_MS * 15);
      expect(latest().isClosedByClient).toBe(false);
      expect(onDisconnect).not.toHaveBeenCalled();
      setVisibility('visible');
      vi.advanceTimersByTime(SILENCE_TIMEOUT_MS - 1);
      expect(latest().isClosedByClient).toBe(false);
      vi.advanceTimersByTime(1);
      expect(latest().isClosedByClient).toBe(true);
      expect(onDisconnect).toHaveBeenCalledWith(RECONNECT_BASE_MS, 'silent');
    });

    it('обрыв в скрытой вкладке — не входит, сколько бы ни ждал; вернулась на экран — вход сразу', () => {
      latest().open();
      setVisibility('hidden');
      latest().drop();
      expect(onDisconnect).toHaveBeenLastCalledWith(RECONNECT_BASE_MS, 'closed');
      vi.advanceTimersByTime(RECONNECT_MAX_MS * 20);
      expect(sockets).toHaveLength(1);
      setVisibility('visible');
      expect(sockets).toHaveLength(2);
      latest().open();
      expect(latest().sent[0]).toMatchObject({ type: MessageType.Join, roomCode: 'abc' });
    });

    it('вкладку скрыли, пока ждала паузу переподключения, — вход только после возврата на экран', () => {
      latest().open();
      latest().drop();
      setVisibility('hidden');
      vi.advanceTimersByTime(RECONNECT_BASE_MS * 10);
      expect(sockets).toHaveLength(1);
      setVisibility('visible');
      expect(sockets).toHaveLength(2);
      vi.advanceTimersByTime(RECONNECT_MAX_MS * 2);
      expect(sockets).toHaveLength(2);
    });

    it('браузер не сообщил о возврате на экран — отложенный вход не позже чем через 5 с', () => {
      latest().open();
      setVisibility('hidden');
      latest().drop();
      vi.advanceTimersByTime(RECONNECT_BASE_MS);
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      vi.advanceTimersByTime(RECONNECT_MAX_MS - 1);
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(2);
    });

    it('после отложенного входа новый сокет оборвался до открытия — следующая пауза вдвое длиннее', () => {
      latest().open();
      setVisibility('hidden');
      latest().drop();
      vi.advanceTimersByTime(RECONNECT_MAX_MS * 3);
      setVisibility('visible');
      expect(sockets).toHaveLength(2);
      latest().drop();
      expect(onDisconnect).toHaveBeenLastCalledWith(RECONNECT_BASE_MS * 2, 'closed');
      vi.advanceTimersByTime(RECONNECT_BASE_MS * 2);
      expect(sockets).toHaveLength(3);
    });

    it('закрыт нами, пока вход отложен, — не входит ни по возврату на экран, ни по таймеру', () => {
      latest().open();
      setVisibility('hidden');
      latest().drop();
      vi.advanceTimersByTime(RECONNECT_BASE_MS);
      client.close();
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      vi.advanceTimersByTime(RECONNECT_MAX_MS * 3);
      setVisibility('visible');
      expect(sockets).toHaveLength(1);
    });

    it('закрытие снимает свой обработчик смены видимости', () => {
      const added = vi.spyOn(document, 'addEventListener');
      const removed = vi.spyOn(document, 'removeEventListener');
      const other = new NetClient(
        'ws://test/ws',
        handlers,
        { roomCode: 'abc', nickname: 'Дима', stats: { ...DEFAULT_STATS }, token: '', gameId: '' },
        { createSocket: (): SocketLike => new FakeSocket() },
      );
      const listener = added.mock.calls.find(([type]) => type === 'visibilitychange')?.[1];
      expect(listener).toBeDefined();
      other.close();
      expect(removed).toHaveBeenCalledWith('visibilitychange', listener);
    });
  });
});

describe('NetClient в общем бою', () => {
  const sockets: FakeSocket[] = [];
  const mocks = {
    onFfaWelcome: vi.fn(),
    onFfaState: vi.fn(),
    onFfaRoster: vi.fn(),
    onFfaMatchStart: vi.fn(),
    onFfaSnapshot: vi.fn(),
    onFfaScore: vi.fn(),
    onFfaBullets: vi.fn(),
    onError: vi.fn(),
    onDisconnect: vi.fn(),
  };
  let client: NetClient;

  const latest = (): FakeSocket => {
    const socket = sockets[sockets.length - 1];
    if (socket === undefined) {
      throw new Error('нет сокета');
    }
    return socket;
  };

  const welcome = (token: string): Uint8Array =>
    encode({
      type: MessageType.FfaWelcome,
      playerId: 3,
      token,
      gameId: 'K7QX',
      size: 10,
      rules: DEFAULT_RULES,
      inviteMiss: FfaInviteMiss.None,
      hasNetSmoothing: false,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    const handlers: NetHandlers = { ...mocks };
    client = new NetClient(
      'ws://test/ws',
      handlers,
      { roomCode: 'ffa10', nickname: 'Дима', stats: { ...DEFAULT_STATS }, token: 'из-хранилища', gameId: 'ZZ9Q' },
      {
        createSocket: (): SocketLike => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        now: () => 500,
      },
    );
  });

  afterEach(() => {
    client.close();
    vi.useRealTimers();
  });

  it('первый вход несёт пропуск из хранилища и номер игры приглашения; после обрыва — пропуск из последнего приветствия и тот же номер', () => {
    latest().open();
    expect(latest().sent[0]).toMatchObject({
      type: MessageType.Join,
      roomCode: 'ffa10',
      token: 'из-хранилища',
      gameId: 'ZZ9Q',
    });
    latest().receive(welcome('новый-пропуск'));
    latest().drop();
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    latest().open();
    expect(latest().sent[0]).toMatchObject({
      type: MessageType.Join,
      token: 'новый-пропуск',
      isBot: false,
      gameId: 'ZZ9Q',
    });
  });

  it.each([ErrorCode.Idle, ErrorCode.Replaced])('ошибка %i — без переподключения', (code) => {
    latest().open();
    latest().receive(welcome('пропуск'));
    latest().receive(encode({ type: MessageType.Error, code, text: 'всё' }));
    latest().drop();
    vi.advanceTimersByTime(RECONNECT_MAX_MS * 2);
    expect(sockets).toHaveLength(1);
    expect(mocks.onError).toHaveBeenCalledWith(expect.objectContaining({ code }));
    expect(mocks.onDisconnect).not.toHaveBeenCalled();
  });

  it('сообщения толпы доходят до своих обработчиков, состояние и снимок — с моментом прихода', () => {
    latest().open();
    const socket = latest();
    socket.receive(welcome('пропуск'));
    socket.receive(
      encode({
        type: MessageType.FfaState,
        phase: FfaPhase.Lobby,
        ticksLeft: null,
        players: 1,
        capacity: 10,
        minimum: 7,
        matchIndex: 0,
      }),
    );
    socket.receive(encode({ type: MessageType.FfaRoster, players: [] }));
    socket.receive(
      encode({
        type: MessageType.FfaMatchStart,
        matchIndex: 1,
        durationSeconds: 120,
        zone: { startRadius: 1400, finalRadius: 380, startShrink: 45, endShrink: 105 },
        suddenDeathAt: 85,
      }),
    );
    socket.receive(
      encode({
        type: MessageType.FfaSnapshot,
        tick: 4,
        gameTick: 90,
        ackSeq: 0,
        hasSpareInput: false,
        self: { state: 'alive', ticksLeft: 0, killerId: null, idleTicksLeft: null, isOut: false },
        tanks: [],
        kits: [],
        events: [],
        births: [],
        bounces: [],
        deaths: [],
      }),
    );
    socket.receive(encode({ type: MessageType.FfaScore, rows: [] }));
    socket.receive(encode({ type: MessageType.FfaBullets, bullets: [] }));
    expect(mocks.onFfaWelcome).toHaveBeenCalledWith(expect.objectContaining({ playerId: 3, gameId: 'K7QX' }));
    expect(mocks.onFfaState).toHaveBeenCalledWith(expect.objectContaining({ minimum: 7 }), 500);
    expect(mocks.onFfaRoster).toHaveBeenCalledTimes(1);
    expect(mocks.onFfaMatchStart).toHaveBeenCalledWith(expect.objectContaining({ matchIndex: 1 }));
    expect(mocks.onFfaSnapshot).toHaveBeenCalledWith(expect.objectContaining({ tick: 4 }), 500);
    expect(mocks.onFfaScore).toHaveBeenCalledTimes(1);
    expect(mocks.onFfaBullets).toHaveBeenCalledTimes(1);
  });
});
