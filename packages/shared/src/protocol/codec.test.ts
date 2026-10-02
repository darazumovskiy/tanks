import { describe, expect, it } from 'vitest';
import { DEFAULT_STATS } from '../engine/index.js';
import { decode, encode, quantizeAction } from './codec.js';
import { ErrorCode, MESSAGE_TYPE_NAMES, MessageType, type Message, type SnapshotMessage } from './messages.js';

const snapshot: SnapshotMessage = {
  type: MessageType.Snapshot,
  tick: 123456,
  ackSeq: 77,
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

const samples: Message[] = [
  {
    type: MessageType.Join,
    protocolVersion: 1,
    roomCode: 'abc123',
    nickname: 'Дима 🚀',
    stats: { armor: 0, engine: 0, gun: 5, reload: 5 },
  },
  { type: MessageType.Input, seq: 4294967295, action: { throttle: 1, turn: -1, turretTurn: 0, isFiring: true } },
  { type: MessageType.Ping, clientTime: 1790899403123.456 },
  { type: MessageType.Welcome, side: 1, roomCode: 'xyz' },
  {
    type: MessageType.RoomState,
    slots: [
      { isTaken: true, nickname: 'A' },
      { isTaken: false, nickname: '' },
    ],
  },
  {
    type: MessageType.RoundStart,
    roundIndex: 7,
    mapIndex: 3,
    countdownTicks: 90,
    score: [3, 4],
    tanks: [
      { nickname: 'A', stats: { armor: 3, engine: 3, gun: 2, reload: 2 } },
      { nickname: 'B', stats: { armor: 5, engine: 5, gun: 0, reload: 0 } },
    ],
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

  it('снимок пустого боя помещается в 140 байт', () => {
    const empty: SnapshotMessage = { ...snapshot, bullets: [], kits: [], events: [] };
    expect(encode(empty).byteLength).toBeLessThanOrEqual(140);
  });

  it('отвергает неизвестный тип и обрывок', () => {
    expect(() => decode(new Uint8Array([200]))).toThrow(RangeError);
    expect(() => decode(encode(snapshot).subarray(0, 20))).toThrow(RangeError);
  });

  it('отвергает испорченные значения полей', () => {
    const welcome = encode({ type: MessageType.Welcome, side: 0, roomCode: 'x' });
    welcome[1] = 7;
    expect(() => decode(welcome)).toThrow(RangeError);

    const error = encode({ type: MessageType.Error, code: ErrorCode.BadMessage, text: 'x' });
    error[1] = 99;
    expect(() => decode(error)).toThrow(RangeError);

    const badWinner = encode(snapshot);
    badWinner[10] = 7;
    expect(() => decode(badWinner)).toThrow(RangeError);

    const badReason = encode(snapshot);
    badReason[11] = 9;
    expect(() => decode(badReason)).toThrow(RangeError);

    const headerBytes = 1 + 4 + 4 + 1 + 1 + 1 + 8 + 2 * 57;
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

  it('длинные строки обрезаются до 255 байт, большие сообщения растят буфер', () => {
    const longName = 'я'.repeat(300);
    const decoded = decode(
      encode({ type: MessageType.Join, protocolVersion: 1, roomCode: 'r', nickname: longName, stats: DEFAULT_STATS }),
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
