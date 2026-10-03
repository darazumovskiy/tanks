import {
  checkStats,
  createRound,
  DEFAULT_STATS,
  roundPlan,
  stepRound,
  TICK_RATE,
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
  type SnapshotMessage,
} from '@tanks/shared/protocol';
import { toSnapshotEvent } from './events.js';

export interface Connection {
  send(bytes: Uint8Array): void;
}

// Место игрока в комнате: всё, что игрок может сделать после входа.
export interface Seat {
  input(seq: number, action: Action): void;
  ping(clientTime: number): void;
  leave(): void;
}

export interface RoomOptions {
  countdownTicks: number;
  roundEndTicks: number;
  maxInputsPerSecond: number;
}

export const DEFAULT_ROOM_OPTIONS: RoomOptions = { countdownTicks: 90, roundEndTicks: 90, maxInputsPerSecond: 90 };

type DuelPhase = 'countdown' | 'fight' | 'roundEnd';

interface Player {
  connection: Connection;
  nickname: string;
  stats: Stats;
  lastSeq: number;
  lastInputTick: number;
  ackSeq: number;
  pending: { seq: number; action: Action } | null;
  lastAction: Action;
  inputsThisSecond: number;
}

// Бой существует, только пока в комнате двое.
interface Duel {
  players: [Player, Player];
  round: Round;
  phase: DuelPhase;
  phaseTicksLeft: number;
}

const IDLE: Action = { throttle: 0, turn: 0, turretTurn: 0, isFiring: false };
// Клиент замолчал (ушёл в фон, завис) — его танк не должен ехать и стрелять по последней команде вечно.
export const INPUT_TIMEOUT_TICKS = 15;
const NICKNAME_MAX = 16;

export function sanitizeNickname(raw: string): string {
  const trimmed = raw.trim().slice(0, NICKNAME_MAX);
  return trimmed === '' ? 'Игрок' : trimmed;
}

export function sanitizeStats(raw: Stats): Stats {
  return checkStats(raw).isOk ? raw : { ...DEFAULT_STATS };
}

// Одна дуэль: два места, раунды по кругу карт, счёт. Сокетов не знает — только Connection.send.
export class Room {
  readonly code: string;
  private readonly options: RoomOptions;
  private readonly players: [Player | null, Player | null] = [null, null];
  private duel: Duel | null = null;
  private roundIndex = 0;
  private score: [number, number] = [0, 0];
  private tick = 0;

  constructor(code: string, options: RoomOptions = DEFAULT_ROOM_OPTIONS) {
    this.code = code;
    this.options = options;
  }

  get isEmpty(): boolean {
    return this.players.every((player) => player === null);
  }

  freeSide(): Side | null {
    if (this.players[0] === null) {
      return 0;
    }
    if (this.players[1] === null) {
      return 1;
    }
    return null;
  }

  join(side: Side, connection: Connection, nickname: string, stats: Stats): Seat {
    const player: Player = {
      connection,
      nickname: sanitizeNickname(nickname),
      stats: sanitizeStats(stats),
      lastSeq: 0,
      lastInputTick: 0,
      ackSeq: 0,
      pending: null,
      lastAction: { ...IDLE },
      inputsThisSecond: 0,
    };
    this.players[side] = player;
    this.sendTo(player, { type: MessageType.Welcome, side, roomCode: this.code });
    this.broadcast(this.roomStateMessage());
    const [a, b] = this.players;
    if (a !== null && b !== null) {
      this.startRound([a, b]);
    }
    return {
      input: (seq, action) => {
        this.acceptInput(player, seq, action);
      },
      ping: (clientTime) => {
        this.sendTo(player, { type: MessageType.Pong, clientTime, serverTick: this.tick });
      },
      leave: () => {
        this.players[side] = null;
        this.duel = null;
        this.broadcast(this.roomStateMessage());
      },
    };
  }

  // Новое пересиливает старое: за тик применяется последняя пришедшая команда, остальные теряются.
  private acceptInput(player: Player, seq: number, action: Action): void {
    player.inputsThisSecond++;
    if (seq <= player.lastSeq || player.inputsThisSecond > this.options.maxInputsPerSecond) {
      return;
    }
    player.lastSeq = seq;
    player.lastInputTick = this.tick;
    player.pending = { seq, action };
  }

  step(): void {
    this.tick++;
    if (this.tick % TICK_RATE === 0) {
      for (const player of this.presentPlayers()) {
        player.inputsThisSecond = 0;
      }
    }
    const duel = this.duel;
    if (duel === null) {
      return;
    }
    const actions = this.takeActions(duel.players);
    const events = duel.phase === 'fight' ? stepRound(duel.round, actions) : [];
    if (duel.phase !== 'fight') {
      duel.phaseTicksLeft--;
    }
    this.broadcastSnapshot(duel, events);
    if (duel.phase === 'countdown' && duel.phaseTicksLeft <= 0) {
      duel.phase = 'fight';
    } else if (duel.phase === 'fight' && duel.round.isOver) {
      if (duel.round.winner !== null) {
        this.score[duel.round.winner]++;
      }
      duel.phase = 'roundEnd';
      duel.phaseTicksLeft = this.options.roundEndTicks;
    } else if (duel.phase === 'roundEnd' && duel.phaseTicksLeft <= 0) {
      this.roundIndex++;
      this.startRound(duel.players);
    }
  }

  private presentPlayers(): Player[] {
    return this.players.filter((player): player is Player => player !== null);
  }

  private takeActions(players: [Player, Player]): [Action, Action] {
    const result: [Action, Action] = [IDLE, IDLE];
    for (const side of [0, 1] as const) {
      const player = players[side];
      if (player.pending !== null) {
        player.lastAction = player.pending.action;
        player.ackSeq = player.pending.seq;
        player.pending = null;
      }
      const isSilent = this.tick - player.lastInputTick > INPUT_TIMEOUT_TICKS;
      result[side] = isSilent ? IDLE : player.lastAction;
    }
    return result;
  }

  private startRound(players: [Player, Player]): void {
    const [a, b] = players;
    const plan = roundPlan(this.roundIndex);
    const round = createRound(plan.mapIndex, [
      { name: a.nickname, stats: a.stats },
      { name: b.nickname, stats: b.stats },
    ]);
    for (const player of players) {
      player.pending = null;
      player.lastAction = { ...IDLE };
    }
    this.duel = { players, round, phase: 'countdown', phaseTicksLeft: this.options.countdownTicks };
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

  private broadcastSnapshot(duel: Duel, events: RoundEvent[]): void {
    const round = duel.round;
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
    for (const player of duel.players) {
      this.sendTo(player, { ...base, ackSeq: player.ackSeq });
    }
  }

  private roomStateMessage(): RoomStateMessage {
    const slot = (player: Player | null): { isTaken: boolean; nickname: string } => ({
      isTaken: player !== null,
      nickname: player?.nickname ?? '',
    });
    return { type: MessageType.RoomState, slots: [slot(this.players[0]), slot(this.players[1])] };
  }

  private sendTo(player: Player, message: ServerMessage): void {
    player.connection.send(encode(message));
  }

  private broadcast(message: ServerMessage): void {
    const bytes = encode(message);
    for (const player of this.presentPlayers()) {
      player.connection.send(bytes);
    }
  }
}
