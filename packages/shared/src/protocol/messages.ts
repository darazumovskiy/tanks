import type { Action, EndReason, Side, Stats } from '../engine/index.js';

export const PROTOCOL_VERSION = 1;

export const MessageType = {
  Join: 1,
  Input: 2,
  Ping: 3,
  Welcome: 10,
  RoomState: 11,
  RoundStart: 12,
  Snapshot: 13,
  Pong: 14,
  Error: 15,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const MESSAGE_TYPE_NAMES: Readonly<Record<MessageType, string>> = Object.fromEntries(
  Object.entries(MessageType).map(([name, value]) => [value, name]),
) as Record<MessageType, string>;

export interface JoinMessage {
  type: typeof MessageType.Join;
  protocolVersion: number;
  roomCode: string;
  nickname: string;
  stats: Stats;
}

export interface InputMessage {
  type: typeof MessageType.Input;
  seq: number;
  action: Action;
}

export interface PingMessage {
  type: typeof MessageType.Ping;
  clientTime: number;
}

export interface WelcomeMessage {
  type: typeof MessageType.Welcome;
  side: Side;
  roomCode: string;
}

export interface RoomSlot {
  isTaken: boolean;
  nickname: string;
}

export interface RoomStateMessage {
  type: typeof MessageType.RoomState;
  slots: [RoomSlot, RoomSlot];
}

export interface RoundTankInfo {
  nickname: string;
  stats: Stats;
}

export interface RoundStartMessage {
  type: typeof MessageType.RoundStart;
  roundIndex: number;
  mapIndex: number;
  countdownTicks: number;
  score: [number, number];
  tanks: [RoundTankInfo, RoundTankInfo];
}

export interface TankSnapshot {
  x: number;
  y: number;
  heading: number;
  turret: number;
  speed: number;
  hp: number;
  reloadLeft: number;
  isAlive: boolean;
}

export interface BulletSnapshot {
  id: number;
  owner: Side;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bouncesLeft: number;
  hasBounced: boolean;
  age: number;
}

export interface KitSnapshot {
  isActive: boolean;
  respawnIn: number;
}

export type SnapshotEventKind =
  | 'shot'
  | 'impact'
  | 'ricochet'
  | 'fizzle'
  | 'clash'
  | 'hit'
  | 'death'
  | 'bump'
  | 'kitSpawn'
  | 'pickup'
  | 'zoneStart'
  | 'roundOver';

export interface SnapshotEvent {
  kind: SnapshotEventKind;
  side: Side | null;
  x: number;
  y: number;
  value: number;
}

export interface SnapshotMessage {
  type: typeof MessageType.Snapshot;
  tick: number;
  ackSeq: number;
  isOver: boolean;
  winner: Side | null;
  endReason: EndReason | null;
  zoneRadius: number;
  tanks: [TankSnapshot, TankSnapshot];
  bullets: BulletSnapshot[];
  kits: KitSnapshot[];
  events: SnapshotEvent[];
}

export interface PongMessage {
  type: typeof MessageType.Pong;
  clientTime: number;
  serverTick: number;
}

export const ErrorCode = {
  BadProtocolVersion: 1,
  RoomFull: 2,
  BadMessage: 3,
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorMessage {
  type: typeof MessageType.Error;
  code: ErrorCode;
  text: string;
}

export type ClientMessage = JoinMessage | InputMessage | PingMessage;
export type ServerMessage =
  WelcomeMessage | RoomStateMessage | RoundStartMessage | SnapshotMessage | PongMessage | ErrorMessage;
export type Message = ClientMessage | ServerMessage;
