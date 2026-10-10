import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, DEFAULT_STATS, SHOT_INHERIT_MAX_PERCENT, SHOT_LEAD_MAX_TICKS } from '../engine/index.js';
import { decode, encode, formatJournalRules, isClientMessage, NO_ID, quantizeAction, rulesFromBytes } from './codec.js';
import { ffaRoomCode, ffaSizeOf, isFfaRoomCode } from './ffaRoom.js';
import {
  ErrorCode,
  FfaInviteMiss,
  FfaPhase,
  MESSAGE_TYPE_NAMES,
  MessageType,
  type FfaSnapshotMessage,
  type Message,
  type RoundStartMessage,
  type SnapshotMessage,
} from './messages.js';

const snapshot: SnapshotMessage = {
  type: MessageType.Snapshot,
  tick: 123456,
  gameTick: 654321,
  ackSeq: 77,
  hasSpareInput: true,
  isOver: true,
  winner: 1,
  endReason: 'time',
  zoneRadius: 977.6781,
  tanks: [
    { x: 140, y: 450, heading: 0, turret: 0.123456789, speed: 12.5, hp: 100, reloadLeft: 0.37, isAlive: true },
    { x: 1460, y: 450, heading: Math.PI, turret: -1.5, speed: -60.25, hp: 0, reloadLeft: 0, isAlive: false },
  ],
  bullets: [
    { id: 1, owner: 0, x: 200.5, y: 300.25, vx: 700, vy: 0, bouncesLeft: 1, hasBounced: false, age: 0.0333 },
    { id: 2, owner: 1, x: 1200, y: 100, vx: -300.1, vy: 400.2, bouncesLeft: 0, hasBounced: true, age: 2.5 },
  ],
  kits: [
    { isActive: false, respawnIn: 12.3 },
    { isActive: true, respawnIn: 0 },
  ],
  events: [
    { kind: 'shot', side: 0, x: 174, y: 450, value: 0, dx: 1, dy: 0, flags: 0 },
    { kind: 'hit', side: 1, x: 1460, y: 450, value: 43, dx: -0.5, dy: 0.25, flags: 2 },
    { kind: 'zoneStart', side: null, x: 0, y: 0, value: 0, dx: 0, dy: 0, flags: 0 },
    { kind: 'roundOver', side: 1, x: 0, y: 0, value: 0, dx: 0, dy: 0, flags: 8 },
  ],
};

const roundStart: RoundStartMessage = {
  type: MessageType.RoundStart,
  gameId: 'K7MF',
  roundIndex: 7,
  mapIndex: 3,
  countdownTicks: 90,
  score: [3, 4],
  rules: { wallSlidePercent: 0, shotLeadTicks: 0, shotInheritPercent: 0 },
  tanks: [
    { nickname: 'A', stats: { armor: 3, engine: 3, gun: 2, reload: 2 } },
    { nickname: 'B', stats: { armor: 5, engine: 5, gun: 0, reload: 0 } },
  ],
};

// Числа — в точности f32 там, где кодек пишет f32: туда-обратно без потерь.
const ffaSnapshot: FfaSnapshotMessage = {
  type: MessageType.FfaSnapshot,
  tick: 3599,
  gameTick: 99999,
  ackSeq: 4242,
  hasSpareInput: false,
  self: { state: 'wreck', ticksLeft: 45, killerId: 17, idleTicksLeft: null, isOut: false },
  tanks: [
    {
      id: 17,
      x: 3999.25,
      y: 12.125,
      heading: 1.234567891,
      turret: -2.5,
      speed: 176,
      hp: 175,
      reloadLeft: 0.3,
      isAlive: true,
      shieldLeft: 2.966666666,
    },
    { id: 65534, x: 1, y: 2, heading: 0, turret: 0, speed: 0, hp: 0, reloadLeft: 0, isAlive: false, shieldLeft: 0 },
  ],
  kits: [{ isActive: true, respawnIn: 0 }],
  events: [
    { kind: 'death', tank: 2, by: 17, x: 100.5, y: 200.25, value: 0, dx: 0, dy: 0, flags: 2 },
    { kind: 'suddenDeath', tank: null, by: null, x: 0, y: 0, value: 0, dx: 0, dy: 0, flags: 0 },
    { kind: 'shield', tank: 4, by: 9, x: 1, y: 2, value: 0, dx: 0.5, dy: -0.5, flags: 0 },
  ],
  births: [
    { id: 70000, owner: 17, x: 1.1, y: 2.2, vx: 550.0001, vy: -3.3, bouncesLeft: 1, hasBounced: false, age: 1 / 30 },
  ],
  bounces: [{ id: 69999, x: 5, y: 3999.75, vx: -1.5, vy: 2.25 }],
  deaths: [1, 4294967295],
};

const samples: Message[] = [
  {
    type: MessageType.Join,
    protocolVersion: 1,
    roomCode: 'abc123',
    nickname: 'Дима 🚀',
    stats: { armor: 0, engine: 0, gun: 5, reload: 5 },
    token: '',
    isBot: false,
    gameId: '',
  },
  {
    type: MessageType.Join,
    protocolVersion: 6,
    roomCode: 'ffa30',
    nickname: 'Бот',
    stats: DEFAULT_STATS,
    token: 'Xy7-_q',
    isBot: true,
    gameId: 'K7MF',
  },
  {
    type: MessageType.FfaWelcome,
    playerId: 65534,
    token: 'tok',
    gameId: 'K7MF',
    size: 30,
    rules: { wallSlidePercent: 30, shotLeadTicks: 2, shotInheritPercent: 50 },
    inviteMiss: FfaInviteMiss.Gone,
    hasNetSmoothing: false,
  },
  {
    type: MessageType.FfaWelcome,
    playerId: 1,
    token: '',
    gameId: 'K7MF',
    size: 10,
    rules: { wallSlidePercent: 0, shotLeadTicks: 0, shotInheritPercent: SHOT_INHERIT_MAX_PERCENT },
    inviteMiss: FfaInviteMiss.None,
    hasNetSmoothing: true,
  },
  {
    type: MessageType.FfaState,
    phase: FfaPhase.Lobby,
    ticksLeft: null,
    players: 3,
    capacity: 30,
    minimum: 20,
    matchIndex: 0,
  },
  {
    type: MessageType.FfaState,
    phase: FfaPhase.Results,
    ticksLeft: 450,
    players: 30,
    capacity: 30,
    minimum: 20,
    matchIndex: 7,
  },
  {
    type: MessageType.FfaRoster,
    players: [
      { id: 1, nickname: 'Дима', stats: DEFAULT_STATS, isBot: false },
      { id: 2, nickname: 'Бот 2', stats: { armor: 5, engine: 5, gun: 0, reload: 0 }, isBot: true },
    ],
  },
  {
    type: MessageType.FfaMatchStart,
    matchIndex: 3,
    durationSeconds: 120,
    zone: { startRadius: 2355.123, finalRadius: 657.27, startShrink: 45, endShrink: 105 },
    suddenDeathAt: 85.4321,
  },
  ffaSnapshot,
  { ...ffaSnapshot, self: { state: 'wreck', ticksLeft: 0, killerId: null, idleTicksLeft: 300, isOut: true } },
  {
    type: MessageType.FfaScore,
    rows: [
      { id: 1, kills: 3, deaths: 1, damageDealt: 412.5, damageTaken: 0.25 },
      { id: 2, kills: 0, deaths: 4, damageDealt: 0, damageTaken: 700 },
    ],
  },
  { type: MessageType.FfaBullets, bullets: ffaSnapshot.births },
  { type: MessageType.FfaBullets, bullets: [] },
  { type: MessageType.Error, code: ErrorCode.Idle, text: 'выкинуло за бездействие' },
  { type: MessageType.Error, code: ErrorCode.Replaced, text: 'место занято с другого устройства' },
  { type: MessageType.Input, seq: 4294967295, action: { throttle: 1, turn: -1, turretTurn: 0, isFiring: true } },
  { type: MessageType.Ping, clientTime: 1790899403123.456 },
  { type: MessageType.Leave },
  { type: MessageType.Welcome, side: 1, roomCode: 'xyz', hasNetSmoothing: false },
  { type: MessageType.Welcome, side: 0, roomCode: 'abc', hasNetSmoothing: true },
  {
    type: MessageType.RoomState,
    slots: [
      { isTaken: true, nickname: 'A' },
      { isTaken: false, nickname: '' },
    ],
  },
  roundStart,
  { ...roundStart, rules: { wallSlidePercent: 50, shotLeadTicks: 2, shotInheritPercent: 50 } },
  {
    ...roundStart,
    rules: { wallSlidePercent: 100, shotLeadTicks: SHOT_LEAD_MAX_TICKS, shotInheritPercent: SHOT_INHERIT_MAX_PERCENT },
  },
  snapshot,
  { type: MessageType.Pong, clientTime: 12.5, serverTick: 999 },
  { type: MessageType.Error, code: ErrorCode.RoomFull, text: 'комната занята' },
];

describe('кодек протокола', () => {
  it.each(samples.map((message) => [MESSAGE_TYPE_NAMES[message.type], message] as const))(
    '%s проходит туда-обратно',
    (_name, message) => {
      const decoded = decode(encode(message));
      if (message.type === MessageType.Input) {
        expect(decoded).toEqual({ ...message, action: quantizeAction(message.action) });
        return;
      }
      if (message.type === MessageType.Snapshot) {
        const decodedSnapshot = decoded as SnapshotMessage;
        expect({ ...decodedSnapshot, events: [] }).toEqual({ ...message, events: [] });
        expect(decodedSnapshot.events.map((event) => [event.kind, event.side, event.flags])).toEqual(
          message.events.map((event) => [event.kind, event.side, event.flags]),
        );
        for (const [index, event] of decodedSnapshot.events.entries()) {
          const expected = message.events[index];
          expect(event.x).toBeCloseTo(expected?.x ?? NaN, 3);
          expect(event.value).toBeCloseTo(expected?.value ?? NaN, 3);
          expect(event.dx).toBeCloseTo(expected?.dx ?? NaN, 3);
          expect(event.dy).toBeCloseTo(expected?.dy ?? NaN, 3);
        }
        return;
      }
      expect(decoded).toEqual(message);
    },
  );

  it('сообщения клиента — вход, команда, пинг, выход; ответы сервера — нет', () => {
    const fromClient = samples.filter(isClientMessage).map((message) => message.type);
    expect(new Set(fromClient)).toEqual(
      new Set([MessageType.Join, MessageType.Input, MessageType.Ping, MessageType.Leave]),
    );
  });

  it('правила — байты скольжения, догона и наследования, лишнее срезается до предела; в журнале — rules, lead и inherit', () => {
    expect(rulesFromBytes(0, 0, 0)).toEqual({ wallSlidePercent: 0, shotLeadTicks: 0, shotInheritPercent: 0 });
    expect(rulesFromBytes(100, 2, 50)).toEqual({ wallSlidePercent: 100, shotLeadTicks: 2, shotInheritPercent: 50 });
    expect(rulesFromBytes(0xfe, 0xff, 0xff)).toEqual({
      wallSlidePercent: 100,
      shotLeadTicks: SHOT_LEAD_MAX_TICKS,
      shotInheritPercent: SHOT_INHERIT_MAX_PERCENT,
    });
    const bytes = encode({ ...roundStart, rules: { wallSlidePercent: 0, shotLeadTicks: 0, shotInheritPercent: 0 } });
    const rulesAt = bytes.length - 2 * (1 + 1 + 4) - 3;
    bytes[rulesAt] = 0xfe;
    bytes[rulesAt + 1] = 0xff;
    bytes[rulesAt + 2] = 0xff;
    expect((decode(bytes) as RoundStartMessage).rules).toEqual({
      wallSlidePercent: 100,
      shotLeadTicks: SHOT_LEAD_MAX_TICKS,
      shotInheritPercent: SHOT_INHERIT_MAX_PERCENT,
    });
    expect(formatJournalRules({ wallSlidePercent: 30, shotLeadTicks: 2, shotInheritPercent: 100 })).toBe(
      'rules=30 lead=2 inherit=100',
    );
  });

  it('квантует оси в 1/127 и сохраняет знак', () => {
    const action = quantizeAction({ throttle: 0.5, turn: -0.3333, turretTurn: 0.003, isFiring: false });
    expect(action.throttle).toBeCloseTo(0.5, 2);
    expect(action.turn).toBeCloseTo(-0.3333, 2);
    expect(action.turretTurn).toBe(0);
    expect(quantizeAction(quantizeAction(action))).toEqual(action);
  });

  it('обрезает оси вне диапазона', () => {
    const decoded = decode(
      encode({ type: MessageType.Input, seq: 1, action: { throttle: 9, turn: -9, turretTurn: 2, isFiring: false } }),
    );
    expect(decoded).toEqual({
      type: MessageType.Input,
      seq: 1,
      action: { throttle: 1, turn: -1, turretTurn: 1, isFiring: false },
    });
  });

  it('снимок пустого боя помещается в 144 байта', () => {
    const empty: SnapshotMessage = { ...snapshot, bullets: [], kits: [], events: [] };
    expect(encode(empty).byteLength).toBeLessThanOrEqual(144);
  });

  it('отвергает неизвестный тип и обрывок', () => {
    expect(() => decode(new Uint8Array([200]))).toThrow(RangeError);
    expect(() => decode(encode(snapshot).subarray(0, 20))).toThrow(RangeError);
  });

  it('отвергает испорченные значения полей', () => {
    const welcome = encode({ type: MessageType.Welcome, side: 0, roomCode: 'x', hasNetSmoothing: false });
    welcome[1] = 7;
    expect(() => decode(welcome)).toThrow(RangeError);

    const error = encode({ type: MessageType.Error, code: ErrorCode.BadMessage, text: 'x' });
    error[1] = 99;
    expect(() => decode(error)).toThrow(RangeError);

    const badWinner = encode(snapshot);
    badWinner[15] = 7;
    expect(() => decode(badWinner)).toThrow(RangeError);

    const badReason = encode(snapshot);
    badReason[16] = 9;
    expect(() => decode(badReason)).toThrow(RangeError);

    const headerBytes = 1 + 4 + 4 + 4 + 1 + 1 + 1 + 1 + 8 + 2 * 57;
    const badBulletOwner = encode({ ...snapshot, kits: [], events: [] });
    badBulletOwner[headerBytes + 2 + 4] = 5;
    expect(() => decode(badBulletOwner)).toThrow(RangeError);

    const badEventKind = encode({ ...snapshot, bullets: [], kits: [] });
    badEventKind[headerBytes + 2 + 1 + 1] = 200;
    expect(() => decode(badEventKind)).toThrow(RangeError);

    const badEventSide = encode({ ...snapshot, bullets: [], kits: [] });
    badEventSide[headerBytes + 2 + 1 + 1 + 1] = 9;
    expect(() => decode(badEventSide)).toThrow(RangeError);
  });

  it('общая игра: порченые фаза, размер, состояние игрока и вид события отвергаются', () => {
    const state = encode({
      type: MessageType.FfaState,
      phase: FfaPhase.Fight,
      ticksLeft: 1,
      players: 1,
      capacity: 10,
      minimum: 7,
      matchIndex: 0,
    });
    state[1] = 9;
    expect(() => decode(state)).toThrow(RangeError);

    const welcome = encode({
      type: MessageType.FfaWelcome,
      playerId: 1,
      token: '',
      gameId: '',
      size: 10,
      rules: { ...DEFAULT_RULES },
      inviteMiss: FfaInviteMiss.None,
      hasNetSmoothing: false,
    });
    const badMiss = welcome.slice();
    welcome[1 + 2 + 1 + 1] = 11;
    expect(() => decode(welcome)).toThrow(RangeError);
    badMiss[1 + 2 + 1 + 1 + 1 + 3] = 3;
    expect(() => decode(badMiss)).toThrow(RangeError);

    const selfOffset = 1 + 4 + 4 + 4 + 1;
    const badState = encode(ffaSnapshot);
    badState[selfOffset] = 9;
    expect(() => decode(badState)).toThrow(RangeError);

    const eventOffset = selfOffset + 7 + 2 + 2 + 2;
    const badKind = encode({ ...ffaSnapshot, tanks: [], kits: [] });
    badKind[eventOffset] = 200;
    expect(() => decode(badKind)).toThrow(RangeError);
  });

  it('номер «нет» — 0xFFFF', () => {
    expect(NO_ID).toBe(0xffff);
    const decoded = decode(encode({ ...ffaSnapshot, self: { ...ffaSnapshot.self, killerId: null } }));
    expect(decoded.type === MessageType.FfaSnapshot && decoded.self.killerId).toBeNull();
  });

  it('коды общей игры: ffa10, ffa30, ffa50; другие — не размер', () => {
    expect(ffaRoomCode(30)).toBe('ffa30');
    expect(ffaSizeOf('ffa10')).toBe(10);
    expect(ffaSizeOf('ffa50')).toBe(50);
    expect(ffaSizeOf('ffa11')).toBeNull();
    expect(ffaSizeOf('ffa')).toBeNull();
    expect(ffaSizeOf('abc30')).toBeNull();
    expect(isFfaRoomCode('ffa11')).toBe(true);
    expect(isFfaRoomCode('ffa')).toBe(true);
    expect(isFfaRoomCode('ffaxyz')).toBe(false);
    expect(isFfaRoomCode('abc')).toBe(false);
  });

  it('длинные строки обрезаются до 255 байт, большие сообщения растят буфер', () => {
    const longName = 'я'.repeat(300);
    const decoded = decode(
      encode({
        type: MessageType.Join,
        protocolVersion: 1,
        roomCode: 'r',
        nickname: longName,
        stats: DEFAULT_STATS,
        token: '',
        isBot: false,
        gameId: '',
      }),
    );
    expect(decoded.type).toBe(MessageType.Join);
    if (decoded.type === MessageType.Join) {
      expect(new TextEncoder().encode(decoded.nickname).byteLength).toBeLessThanOrEqual(255);
      expect(decoded.nickname.length).toBeGreaterThan(100);
    }

    const template = snapshot.bullets[0] ?? {
      id: 0,
      owner: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      bouncesLeft: 0,
      hasBounced: false,
      age: 0,
    };
    const bullets = Array.from({ length: 300 }, (_, index) => ({ ...template, id: index }));
    const big = decode(encode({ ...snapshot, bullets, events: [] })) as SnapshotMessage;
    expect(big.bullets).toHaveLength(300);
    expect(big.bullets[299]?.id).toBe(299);
  });
});
