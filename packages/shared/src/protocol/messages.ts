import type { Action, EndReason, FfaPlayerState, FfaSize, RoundRules, Side, Stats, ZonePlan } from '../engine/index.js';

export const PROTOCOL_VERSION = 6;

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
  FfaWelcome: 16,
  FfaState: 17,
  FfaRoster: 18,
  FfaMatchStart: 19,
  FfaSnapshot: 20,
  FfaScore: 21,
  FfaBullets: 22,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const MESSAGE_TYPE_NAMES: Readonly<Record<MessageType, string>> = Object.fromEntries(
  Object.entries(MessageType).map(([name, value]) => [value, name]),
) as Record<MessageType, string>;

// token — пропуск для возврата в общую игру после обрыва, пусто у нового игрока; isBot — честный бот.
export interface JoinMessage {
  type: typeof MessageType.Join;
  protocolVersion: number;
  roomCode: string;
  nickname: string;
  stats: Stats;
  token: string;
  isBot: boolean;
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

// gameId — идентификатор дуэли для журнала; один на все раунды, пока оба игрока в комнате.
// rules — правила движка этого раунда: клиент предсказывает по ним же, иначе разойдётся с сервером.
export interface RoundStartMessage {
  type: typeof MessageType.RoundStart;
  gameId: string;
  roundIndex: number;
  mapIndex: number;
  countdownTicks: number;
  score: [number, number];
  rules: RoundRules;
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

// Признаки события в байте flags.
export const EventFlag = {
  Self: 1,
  Ricochet: 2,
  Zone: 4,
  ByTime: 8,
} as const;

// value: угол выстрела, урон, лечение; dx, dy: направление снаряда при попадании или нормаль стены при рикошете.
export interface SnapshotEvent {
  kind: SnapshotEventKind;
  side: Side | null;
  x: number;
  y: number;
  value: number;
  dx: number;
  dy: number;
  flags: number;
}

// tick — тик раунда (с нуля каждый раунд); gameTick — тиков с создания дуэли, таймкод журнала.
export interface SnapshotMessage {
  type: typeof MessageType.Snapshot;
  tick: number;
  gameTick: number;
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
  Idle: 4,
  Replaced: 5,
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorMessage {
  type: typeof MessageType.Error;
  code: ErrorCode;
  text: string;
}

export const FfaPhase = {
  Lobby: 0,
  Countdown: 1,
  Fight: 2,
  Results: 3,
} as const;
export type FfaPhase = (typeof FfaPhase)[keyof typeof FfaPhase];

export interface FfaWelcomeMessage {
  type: typeof MessageType.FfaWelcome;
  playerId: number;
  token: string;
  gameId: string;
  size: FfaSize;
  rules: RoundRules;
}

// ticksLeft — тиков до конца фазы; в лобби — до старта, null — старт ещё не назначен.
export interface FfaStateMessage {
  type: typeof MessageType.FfaState;
  phase: FfaPhase;
  ticksLeft: number | null;
  players: number;
  capacity: number;
  minimum: number;
  matchIndex: number;
}

export interface FfaRosterEntry {
  id: number;
  nickname: string;
  stats: Stats;
  isBot: boolean;
}

export interface FfaRosterMessage {
  type: typeof MessageType.FfaRoster;
  players: FfaRosterEntry[];
}

export interface FfaMatchStartMessage {
  type: typeof MessageType.FfaMatchStart;
  matchIndex: number;
  durationSeconds: number;
  zone: ZonePlan;
  suddenDeathAt: number;
}

// Своё состояние игрока: ticksLeft — до перехода (подбит → ждёт → на поле), idleTicksLeft — до выхода
// по бездействию, null — отсчёта нет.
export interface FfaSelf {
  state: FfaPlayerState;
  ticksLeft: number;
  killerId: number | null;
  idleTicksLeft: number | null;
}

export interface FfaTankSnapshot extends TankSnapshot {
  id: number;
  shieldLeft: number;
}

export interface FfaBulletSnapshot {
  id: number;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  bouncesLeft: number;
  hasBounced: boolean;
  age: number;
}

export interface FfaBounce {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export type FfaEventKind =
  | 'shot'
  | 'impact'
  | 'ricochet'
  | 'fizzle'
  | 'clash'
  | 'hit'
  | 'shield'
  | 'death'
  | 'bump'
  | 'kitSpawn'
  | 'pickup'
  | 'zoneStart'
  | 'spawn'
  | 'suddenDeath'
  | 'matchOver';

// tank — о ком событие, by — стрелок или убийца; null — нет. Остальные поля — как у события дуэли.
export interface FfaSnapshotEvent {
  kind: FfaEventKind;
  tank: number | null;
  by: number | null;
  x: number;
  y: number;
  value: number;
  dx: number;
  dy: number;
  flags: number;
}

// tick — тик матча; gameTick — тиков с создания игры, таймкод журнала. births, bounces, deaths — снаряды
// всего поля: родились, отскочили, погибли на этом тике.
export interface FfaSnapshotMessage {
  type: typeof MessageType.FfaSnapshot;
  tick: number;
  gameTick: number;
  ackSeq: number;
  self: FfaSelf;
  tanks: FfaTankSnapshot[];
  kits: KitSnapshot[];
  events: FfaSnapshotEvent[];
  births: FfaBulletSnapshot[];
  bounces: FfaBounce[];
  deaths: number[];
}

export interface FfaScoreRow {
  id: number;
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
}

export interface FfaScoreMessage {
  type: typeof MessageType.FfaScore;
  rows: FfaScoreRow[];
}

export interface FfaBulletsMessage {
  type: typeof MessageType.FfaBullets;
  bullets: FfaBulletSnapshot[];
}

export type ClientMessage = JoinMessage | InputMessage | PingMessage;
export type ServerMessage =
  | WelcomeMessage
  | RoomStateMessage
  | RoundStartMessage
  | SnapshotMessage
  | PongMessage
  | ErrorMessage
  | FfaWelcomeMessage
  | FfaStateMessage
  | FfaRosterMessage
  | FfaMatchStartMessage
  | FfaSnapshotMessage
  | FfaScoreMessage
  | FfaBulletsMessage;
export type Message = ClientMessage | ServerMessage;
