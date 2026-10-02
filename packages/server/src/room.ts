import {
  checkStats,
  createRound,
  DEFAULT_STATS,
  roundPlan,
  stepRound,
  type Action,
  type Round,
  type RoundEvent,
  type Side,
  type Stats,
} from '@tanks/shared/engine';
import {
  encode,
  MessageType,
  type RoomStateMessage,
  type RoundStartMessage,
  type ServerMessage,
  type SnapshotEvent,
  type SnapshotMessage,
} from '@tanks/shared/protocol';

export interface Connection {
  send(bytes: Uint8Array): void;
  close(): void;
}

export interface RoomOptions {
  countdownTicks: number;
  roundEndTicks: number;
  maxInputsPerSecond: number;
}

export const DEFAULT_ROOM_OPTIONS: RoomOptions = { countdownTicks: 90, roundEndTicks: 90, maxInputsPerSecond: 90 };

type Phase = 'waiting' | 'countdown' | 'fight' | 'roundEnd';

interface Player {
  connection: Connection;
  nickname: string;
  stats: Stats;
  lastSeq: number;
  ackSeq: number;
  pending: { seq: number; action: Action } | null;
  lastAction: Action;
  inputsThisSecond: number;
  droppedInputs: number;
}

const IDLE: Action = { throttle: 0, turn: 0, turretTurn: 0, isFiring: false };
const NICKNAME_MAX = 16;

export function sanitizeNickname(raw: string): string {
  const trimmed = raw.trim().slice(0, NICKNAME_MAX);
  return trimmed === '' ? 'Игрок' : trimmed;
}

export function sanitizeStats(raw: Stats): Stats {
  return checkStats(raw).isOk ? raw : { ...DEFAULT_STATS };
}

function toSnapshotEvent(event: RoundEvent): SnapshotEvent {
  switch (event.type) {
    case 'shot':
      return { kind: 'shot', side: event.side, x: event.x, y: event.y, value: event.angle };
    case 'impact':
    case 'fizzle':
    case 'ricochet':
      return { kind: event.type, side: event.owner, x: event.x, y: event.y, value: 0 };
    case 'clash':
      return { kind: 'clash', side: null, x: event.x, y: event.y, value: 0 };
    case 'hit':
      return { kind: 'hit', side: event.side, x: event.x, y: event.y, value: event.damage };
    case 'death':
    case 'bump':
      return { kind: event.type, side: event.side, x: event.x, y: event.y, value: 0 };
    case 'kitSpawn':
      return { kind: 'kitSpawn', side: null, x: event.x, y: event.y, value: 0 };
    case 'pickup':
      return { kind: 'pickup', side: event.side, x: event.x, y: event.y, value: event.healed };
    case 'zoneStart':
      return { kind: 'zoneStart', side: null, x: 0, y: 0, value: 0 };
    case 'roundOver':
      return { kind: 'roundOver', side: event.winner, x: 0, y: 0, value: event.reason === 'kill' ? 0 : 1 };
  }
}

// Одна дуэль: два места, раунды по кругу карт, счёт. Сокетов не знает — только Connection.send.
export class Room {
  readonly code: string;
  private readonly options: RoomOptions;
  private readonly players: [Player | null, Player | null] = [null, null];
  private phase: Phase = 'waiting';
  private phaseTicksLeft = 0;
  private round: Round | null = null;
  private roundIndex = 0;
  private score: [number, number] = [0, 0];
  private tick = 0;

  constructor(code: string, options: RoomOptions = DEFAULT_ROOM_OPTIONS) {
    this.code = code;
    this.options = options;
  }

  get playerCount(): number {
    return this.players.filter((player) => player !== null).length;
  }

  get isEmpty(): boolean {
    return this.playerCount === 0;
  }

  join(connection: Connection, nickname: string, stats: Stats): Side | null {
    const side = this.freeSide();
    if (side === null) {
      return null;
    }
    this.players[side] = {
      connection,
      nickname: sanitizeNickname(nickname),
      stats: sanitizeStats(stats),
      lastSeq: 0,
      ackSeq: 0,
      pending: null,
      lastAction: { ...IDLE },
      inputsThisSecond: 0,
      droppedInputs: 0,
    };
    this.sendTo(side, { type: MessageType.Welcome, side, roomCode: this.code });
    this.broadcast(this.roomStateMessage());
    if (this.playerCount === 2) {
      this.startRound();
    }
    return side;
  }

  leave(connection: Connection): void {
    const side = this.sideOf(connection);
    if (side === null) {
      return;
    }
    this.players[side] = null;
    this.round = null;
    this.phase = 'waiting';
    this.broadcast(this.roomStateMessage());
  }

  private freeSide(): Side | null {
    if (this.players[0] === null) {
      return 0;
    }
    if (this.players[1] === null) {
      return 1;
    }
    return null;
  }

  sideOf(connection: Connection): Side | null {
    if (this.players[0]?.connection === connection) {
      return 0;
    }
    if (this.players[1]?.connection === connection) {
      return 1;
    }
    return null;
  }

  // Новое пересиливает старое: за тик применяется последняя пришедшая команда, остальные теряются.
  input(connection: Connection, seq: number, action: Action): void {
    const side = this.sideOf(connection);
    if (side === null) {
      return;
    }
    const player = this.players[side];
    if (player === null) {
      return;
    }
    player.inputsThisSecond++;
    if (seq <= player.lastSeq || player.inputsThisSecond > this.options.maxInputsPerSecond) {
      player.droppedInputs++;
      return;
    }
    player.lastSeq = seq;
    player.pending = { seq, action };
  }

  ping(connection: Connection, clientTime: number): void {
    const side = this.sideOf(connection);
    if (side === null) {
      return;
    }
    this.sendTo(side, { type: MessageType.Pong, clientTime, serverTick: this.tick });
  }

  step(): void {
    this.tick++;
    if (this.tick % 30 === 0) {
      for (const player of this.players) {
        if (player !== null) {
          player.inputsThisSecond = 0;
        }
      }
    }
    if (this.phase === 'waiting' || this.round === null) {
      return;
    }
    const actions = this.takeActions();
    const events = this.phase === 'fight' ? stepRound(this.round, actions) : [];
    if (this.phase === 'countdown' || this.phase === 'roundEnd') {
      this.phaseTicksLeft--;
    }
    this.broadcastSnapshot(events);
    if (this.phase === 'countdown' && this.phaseTicksLeft <= 0) {
      this.phase = 'fight';
    } else if (this.phase === 'fight' && this.round.isOver) {
      if (this.round.winner !== null) {
        this.score[this.round.winner]++;
      }
      this.phase = 'roundEnd';
      this.phaseTicksLeft = this.options.roundEndTicks;
    } else if (this.phase === 'roundEnd' && this.phaseTicksLeft <= 0) {
      this.roundIndex++;
      this.startRound();
    }
  }

  private takeActions(): [Action, Action] {
    const result: [Action, Action] = [IDLE, IDLE];
    for (const side of [0, 1] as const) {
      const player = this.players[side];
      if (player === null) {
        continue;
      }
      if (player.pending !== null) {
        player.lastAction = player.pending.action;
        player.ackSeq = player.pending.seq;
        player.pending = null;
      }
      result[side] = player.lastAction;
    }
    return result;
  }

  private startRound(): void {
    const [a, b] = this.players;
    if (a === null || b === null) {
      return;
    }
    const plan = roundPlan(this.roundIndex);
    this.round = createRound(plan.mapIndex, [
      { name: a.nickname, stats: a.stats },
      { name: b.nickname, stats: b.stats },
    ]);
    for (const player of [a, b]) {
      player.pending = null;
      player.lastAction = { ...IDLE };
    }
    this.phase = 'countdown';
    this.phaseTicksLeft = this.options.countdownTicks;
    const message: RoundStartMessage = {
      type: MessageType.RoundStart,
      roundIndex: this.roundIndex,
      mapIndex: plan.mapIndex,
      countdownTicks: this.options.countdownTicks,
      score: [this.score[0], this.score[1]],
      tanks: [
        { nickname: a.nickname, stats: a.stats },
        { nickname: b.nickname, stats: b.stats },
      ],
    };
    this.broadcast(message);
  }

  private broadcastSnapshot(events: RoundEvent[]): void {
    const round = this.round;
    if (round === null) {
      return;
    }
    const base: Omit<SnapshotMessage, 'ackSeq'> = {
      type: MessageType.Snapshot,
      tick: round.tick,
      isOver: round.isOver,
      winner: round.winner,
      endReason: round.endReason,
      zoneRadius: round.zone.radius,
      tanks: [
        {
          x: round.tanks[0].x,
          y: round.tanks[0].y,
          heading: round.tanks[0].heading,
          turret: round.tanks[0].turret,
          speed: round.tanks[0].speed,
          hp: round.tanks[0].hp,
          reloadLeft: round.tanks[0].reloadLeft,
          isAlive: round.tanks[0].isAlive,
        },
        {
          x: round.tanks[1].x,
          y: round.tanks[1].y,
          heading: round.tanks[1].heading,
          turret: round.tanks[1].turret,
          speed: round.tanks[1].speed,
          hp: round.tanks[1].hp,
          reloadLeft: round.tanks[1].reloadLeft,
          isAlive: round.tanks[1].isAlive,
        },
      ],
      bullets: round.bullets.map((bullet) => ({
        id: bullet.id,
        owner: bullet.owner,
        x: bullet.x,
        y: bullet.y,
        vx: bullet.vx,
        vy: bullet.vy,
        bouncesLeft: bullet.bouncesLeft,
        hasBounced: bullet.hasBounced,
        age: bullet.age,
      })),
      kits: round.kits.map((kit) => ({ isActive: kit.isActive, respawnIn: kit.respawnIn })),
      events: events.map(toSnapshotEvent),
    };
    for (const side of [0, 1] as const) {
      const player = this.players[side];
      if (player !== null) {
        this.sendTo(side, { ...base, ackSeq: player.ackSeq });
      }
    }
  }

  private roomStateMessage(): RoomStateMessage {
    const slot = (player: Player | null): { isTaken: boolean; nickname: string } => ({
      isTaken: player !== null,
      nickname: player?.nickname ?? '',
    });
    return { type: MessageType.RoomState, slots: [slot(this.players[0]), slot(this.players[1])] };
  }

  private sendTo(side: Side, message: ServerMessage): void {
    this.players[side]?.connection.send(encode(message));
  }

  private broadcast(message: ServerMessage): void {
    const bytes = encode(message);
    for (const player of this.players) {
      player?.connection.send(bytes);
    }
  }
}
