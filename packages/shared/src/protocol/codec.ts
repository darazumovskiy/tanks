import { STAT_KEYS, type Action, type EndReason, type Side, type Stats } from '../engine/index.js';
import { ByteReader, ByteWriter } from './bytes.js';
import {
  ErrorCode,
  MESSAGE_TYPE_NAMES,
  MessageType,
  type BulletSnapshot,
  type ClientMessage,
  type KitSnapshot,
  type Message,
  type RoomSlot,
  type RoundTankInfo,
  type ServerMessage,
  type SnapshotEvent,
  type SnapshotEventKind,
  type TankSnapshot,
} from './messages.js';

const AXIS_SCALE = 127;
const NO_SIDE = 255;
const END_REASONS: readonly EndReason[] = ['kill', 'time'];
const EVENT_KINDS: readonly SnapshotEventKind[] = [
  'shot',
  'impact',
  'ricochet',
  'fizzle',
  'clash',
  'hit',
  'death',
  'bump',
  'kitSpawn',
  'pickup',
  'zoneStart',
  'roundOver',
];

function quantizeAxis(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return Math.round(clamped * AXIS_SCALE);
}

function dequantizeAxis(value: number): number {
  return value / AXIS_SCALE;
}

// Команда после прохода через кодек. Клиент предсказывает движение именно по ней, а не по сырому вводу,
// иначе его расчёт разойдётся с серверным на величину округления.
export function quantizeAction(action: Action): Action {
  return {
    throttle: dequantizeAxis(quantizeAxis(action.throttle)),
    turn: dequantizeAxis(quantizeAxis(action.turn)),
    turretTurn: dequantizeAxis(quantizeAxis(action.turretTurn)),
    isFiring: action.isFiring,
  };
}

function writeSide(writer: ByteWriter, side: Side | null): void {
  writer.u8(side ?? NO_SIDE);
}

function readSide(reader: ByteReader): Side {
  const value = reader.u8();
  if (value !== 0 && value !== 1) {
    throw new RangeError(`недопустимая сторона ${String(value)}`);
  }
  return value;
}

function readNullableSide(reader: ByteReader): Side | null {
  const value = reader.u8();
  if (value === NO_SIDE) {
    return null;
  }
  if (value !== 0 && value !== 1) {
    throw new RangeError(`недопустимая сторона ${String(value)}`);
  }
  return value;
}

function writeStats(writer: ByteWriter, stats: Stats): void {
  for (const key of STAT_KEYS) {
    writer.u8(stats[key]);
  }
}

function readStats(reader: ByteReader): Stats {
  return { armor: reader.u8(), engine: reader.u8(), gun: reader.u8(), reload: reader.u8() };
}

function writeAction(writer: ByteWriter, action: Action): void {
  writer.i8(quantizeAxis(action.throttle)).i8(quantizeAxis(action.turn)).i8(quantizeAxis(action.turretTurn));
  writer.bool(action.isFiring);
}

function readAction(reader: ByteReader): Action {
  return {
    throttle: dequantizeAxis(reader.i8()),
    turn: dequantizeAxis(reader.i8()),
    turretTurn: dequantizeAxis(reader.i8()),
    isFiring: reader.bool(),
  };
}

function writeTank(writer: ByteWriter, tank: TankSnapshot): void {
  writer.f64(tank.x).f64(tank.y).f64(tank.heading).f64(tank.turret).f64(tank.speed);
  writer.f64(tank.hp).f64(tank.reloadLeft).bool(tank.isAlive);
}

function readTank(reader: ByteReader): TankSnapshot {
  return {
    x: reader.f64(),
    y: reader.f64(),
    heading: reader.f64(),
    turret: reader.f64(),
    speed: reader.f64(),
    hp: reader.f64(),
    reloadLeft: reader.f64(),
    isAlive: reader.bool(),
  };
}

function writeBullet(writer: ByteWriter, bullet: BulletSnapshot): void {
  writer.u32(bullet.id).u8(bullet.owner);
  writer.f64(bullet.x).f64(bullet.y).f64(bullet.vx).f64(bullet.vy);
  writer.u8(bullet.bouncesLeft).bool(bullet.hasBounced).f64(bullet.age);
}

function readBullet(reader: ByteReader): BulletSnapshot {
  return {
    id: reader.u32(),
    owner: readSide(reader),
    x: reader.f64(),
    y: reader.f64(),
    vx: reader.f64(),
    vy: reader.f64(),
    bouncesLeft: reader.u8(),
    hasBounced: reader.bool(),
    age: reader.f64(),
  };
}

function writeKit(writer: ByteWriter, kit: KitSnapshot): void {
  writer.bool(kit.isActive).f64(kit.respawnIn);
}

function readKit(reader: ByteReader): KitSnapshot {
  return { isActive: reader.bool(), respawnIn: reader.f64() };
}

function writeEvent(writer: ByteWriter, event: SnapshotEvent): void {
  writer.u8(EVENT_KINDS.indexOf(event.kind));
  writeSide(writer, event.side);
  writer.f32(event.x).f32(event.y).f32(event.value);
}

function readEvent(reader: ByteReader): SnapshotEvent {
  const kind = EVENT_KINDS[reader.u8()];
  if (kind === undefined) {
    throw new RangeError('неизвестный тип события');
  }
  return { kind, side: readNullableSide(reader), x: reader.f32(), y: reader.f32(), value: reader.f32() };
}

function writeSlot(writer: ByteWriter, slot: RoomSlot): void {
  writer.bool(slot.isTaken).string(slot.nickname);
}

function readSlot(reader: ByteReader): RoomSlot {
  return { isTaken: reader.bool(), nickname: reader.string() };
}

function writeTankInfo(writer: ByteWriter, info: RoundTankInfo): void {
  writer.string(info.nickname);
  writeStats(writer, info.stats);
}

function readTankInfo(reader: ByteReader): RoundTankInfo {
  return { nickname: reader.string(), stats: readStats(reader) };
}

function readErrorCode(reader: ByteReader): ErrorCode {
  const value = reader.u8();
  if (value !== ErrorCode.BadProtocolVersion && value !== ErrorCode.RoomFull && value !== ErrorCode.BadMessage) {
    throw new RangeError('неизвестный код ошибки');
  }
  return value;
}

export function encode(message: Message): Uint8Array {
  const writer = new ByteWriter();
  writer.u8(message.type);
  switch (message.type) {
    case MessageType.Join:
      writer.u8(message.protocolVersion).string(message.roomCode).string(message.nickname);
      writeStats(writer, message.stats);
      break;
    case MessageType.Input:
      writer.u32(message.seq);
      writeAction(writer, message.action);
      break;
    case MessageType.Ping:
      writer.f64(message.clientTime);
      break;
    case MessageType.Welcome:
      writer.u8(message.side).string(message.roomCode);
      break;
    case MessageType.RoomState:
      writeSlot(writer, message.slots[0]);
      writeSlot(writer, message.slots[1]);
      break;
    case MessageType.RoundStart:
      writer.u16(message.roundIndex).u8(message.mapIndex).u16(message.countdownTicks);
      writer.u16(message.score[0]).u16(message.score[1]);
      writeTankInfo(writer, message.tanks[0]);
      writeTankInfo(writer, message.tanks[1]);
      break;
    case MessageType.Snapshot:
      writer.u32(message.tick).u32(message.ackSeq).bool(message.isOver);
      writeSide(writer, message.winner);
      writer.u8(message.endReason === null ? NO_SIDE : END_REASONS.indexOf(message.endReason));
      writer.f64(message.zoneRadius);
      writeTank(writer, message.tanks[0]);
      writeTank(writer, message.tanks[1]);
      writer.u16(message.bullets.length);
      for (const bullet of message.bullets) {
        writeBullet(writer, bullet);
      }
      writer.u8(message.kits.length);
      for (const kit of message.kits) {
        writeKit(writer, kit);
      }
      writer.u8(message.events.length);
      for (const event of message.events) {
        writeEvent(writer, event);
      }
      break;
    case MessageType.Pong:
      writer.f64(message.clientTime).u32(message.serverTick);
      break;
    case MessageType.Error:
      writer.u8(message.code).string(message.text);
      break;
  }
  return writer.bytes();
}

function readEndReason(reader: ByteReader): EndReason | null {
  const value = reader.u8();
  if (value === NO_SIDE) {
    return null;
  }
  const reason = END_REASONS[value];
  if (reason === undefined) {
    throw new RangeError('неизвестная причина конца раунда');
  }
  return reason;
}

function readSnapshot(reader: ByteReader): ServerMessage {
  const tick = reader.u32();
  const ackSeq = reader.u32();
  const isOver = reader.bool();
  const winner = readNullableSide(reader);
  const endReason = readEndReason(reader);
  const zoneRadius = reader.f64();
  const tanks: [TankSnapshot, TankSnapshot] = [readTank(reader), readTank(reader)];
  const bullets: BulletSnapshot[] = [];
  const bulletCount = reader.u16();
  for (let i = 0; i < bulletCount; i++) {
    bullets.push(readBullet(reader));
  }
  const kits: KitSnapshot[] = [];
  const kitCount = reader.u8();
  for (let i = 0; i < kitCount; i++) {
    kits.push(readKit(reader));
  }
  const events: SnapshotEvent[] = [];
  const eventCount = reader.u8();
  for (let i = 0; i < eventCount; i++) {
    events.push(readEvent(reader));
  }
  return {
    type: MessageType.Snapshot,
    tick,
    ackSeq,
    isOver,
    winner,
    endReason,
    zoneRadius,
    tanks,
    bullets,
    kits,
    events,
  };
}

function readMessageType(reader: ByteReader): MessageType {
  const value = reader.u8();
  if (!(value in MESSAGE_TYPE_NAMES)) {
    throw new RangeError(`неизвестный тип сообщения ${String(value)}`);
  }
  return value as MessageType;
}

export function decode(data: Uint8Array): Message {
  const reader = new ByteReader(data);
  const type = readMessageType(reader);
  switch (type) {
    case MessageType.Join:
      return {
        type,
        protocolVersion: reader.u8(),
        roomCode: reader.string(),
        nickname: reader.string(),
        stats: readStats(reader),
      };
    case MessageType.Input:
      return { type, seq: reader.u32(), action: readAction(reader) };
    case MessageType.Ping:
      return { type, clientTime: reader.f64() };
    case MessageType.Welcome:
      return { type, side: readSide(reader), roomCode: reader.string() };
    case MessageType.RoomState:
      return { type, slots: [readSlot(reader), readSlot(reader)] };
    case MessageType.RoundStart:
      return {
        type,
        roundIndex: reader.u16(),
        mapIndex: reader.u8(),
        countdownTicks: reader.u16(),
        score: [reader.u16(), reader.u16()],
        tanks: [readTankInfo(reader), readTankInfo(reader)],
      };
    case MessageType.Snapshot:
      return readSnapshot(reader);
    case MessageType.Pong:
      return { type, clientTime: reader.f64(), serverTick: reader.u32() };
    case MessageType.Error:
      return { type, code: readErrorCode(reader), text: reader.string() };
  }
}

export function isClientMessage(message: Message): message is ClientMessage {
  return message.type === MessageType.Join || message.type === MessageType.Input || message.type === MessageType.Ping;
}
