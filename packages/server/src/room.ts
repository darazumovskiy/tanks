import {
  checkStats,
  createRound,
  DEFAULT_RULES,
  DEFAULT_STATS,
  roundPlan,
  stepRound,
  TICK_RATE,
  type Action,
  type Round,
  type RoundRules,
  type Side,
  type Stats,
} from '@tanks/shared/engine';
import {
  duelSide,
  encode,
  gameTimecode,
  MessageType,
  rulesToByte,
  toSnapshotEvent,
  type RoomStateMessage,
  type RoundStartMessage,
  type ServerMessage,
  type SnapshotEvent,
  type SnapshotMessage,
} from '@tanks/shared/protocol';
import { randomInt } from 'node:crypto';
import {
  clearInput,
  createInputChannel,
  hasSpareInput,
  isSilent,
  offerInput,
  takeAction,
  type InputChannel,
} from './inputs.js';
import { LOG_SOURCE_SERVER, NO_LOG, type GameLog } from './gameLog.js';
import { NO_DROP_COUNTER, type InputDropCounter } from './metrics.js';

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
  side: Side;
  connection: Connection;
  nickname: string;
  stats: Stats;
  input: InputChannel;
}

// Бой существует, только пока в комнате двое. id и startTick — идентификатор и начало отсчёта таймкода журнала.
interface Duel {
  id: string;
  startTick: number;
  players: [Player, Player];
  round: Round;
  phase: DuelPhase;
  phaseTicksLeft: number;
}

const NICKNAME_MAX = 16;
// Без похожих знаков (0/O, 1/I/L): идентификатор игрок читает с экрана и называет вслух.
const GAME_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const GAME_ID_LENGTH = 4;
const PHASE_MARKS: Readonly<Record<DuelPhase, string>> = { countdown: 'c', fight: 'f', roundEnd: 'e' };

export function randomGameId(): string {
  return Array.from({ length: GAME_ID_LENGTH }, () => GAME_ID_ALPHABET.charAt(randomInt(GAME_ID_ALPHABET.length))).join(
    '',
  );
}

function formatAction(action: Action): string {
  const fire = action.isFiring ? '1' : '0';
  return `${action.throttle.toFixed(2)},${action.turn.toFixed(2)},${action.turretTurn.toFixed(2)},${fire}`;
}

function formatPose(tank: Round['tanks'][number]): string {
  return `${tank.x.toFixed(1)},${tank.y.toFixed(1)},${tank.heading.toFixed(2)},${tank.turret.toFixed(2)}`;
}

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
  private readonly log: GameLog;
  private readonly dropCounter: InputDropCounter;
  private readonly rules: Readonly<RoundRules>;

  constructor(
    code: string,
    options: RoomOptions = DEFAULT_ROOM_OPTIONS,
    log: GameLog = NO_LOG,
    dropCounter: InputDropCounter = NO_DROP_COUNTER,
    rules: Readonly<RoundRules> = DEFAULT_RULES,
  ) {
    this.code = code;
    this.options = options;
    this.log = log;
    this.dropCounter = dropCounter;
    this.rules = rules;
  }

  get isEmpty(): boolean {
    return this.players.every((player) => player === null);
  }

  get playerCount(): number {
    return this.players.filter((player) => player !== null).length;
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
      side,
      connection,
      nickname: sanitizeNickname(nickname),
      stats: sanitizeStats(stats),
      input: createInputChannel(this.tick),
    };
    this.players[side] = player;
    this.sendTo(player, { type: MessageType.Welcome, side, roomCode: this.code });
    this.broadcast(this.roomStateMessage());
    const [a, b] = this.players;
    if (a !== null && b !== null) {
      this.startDuel([a, b]);
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
        this.writeLog(`leave side=${String(side)} nick=${player.nickname}`);
        this.duel = null;
        this.broadcast(this.roomStateMessage());
      },
    };
  }

  private acceptInput(player: Player, seq: number, action: Action): void {
    for (const drop of offerInput(player.input, seq, action, this.tick, this.options.maxInputsPerSecond)) {
      this.dropCounter.countDroppedInput(drop.reason);
      const last = drop.reason === 'stale' ? ` last=${String(player.input.lastSeq)}` : '';
      this.writeLog(`input ${drop.reason} side=${String(player.side)} seq=${String(drop.seq)}${last}`);
    }
  }

  // lateMs — на сколько тик начался позже расписания; попадает в журнал, на игру не влияет.
  step(lateMs = 0): void {
    this.tick++;
    if (this.tick % TICK_RATE === 0) {
      for (const player of this.presentPlayers()) {
        player.input.inputsThisSecond = 0;
      }
    }
    const duel = this.duel;
    if (duel === null) {
      return;
    }
    const actions = this.takeActions(duel.players);
    const events = duel.phase === 'fight' ? stepRound(duel.round, actions).map(toSnapshotEvent) : [];
    if (duel.phase !== 'fight') {
      duel.phaseTicksLeft--;
    }
    this.broadcastSnapshot(duel, events);
    this.logTick(duel, actions, lateMs);
    for (const event of events) {
      const side = event.side === null ? '-' : String(event.side);
      this.writeLog(
        `ev kind=${event.kind} side=${side} x=${event.x.toFixed(1)} y=${event.y.toFixed(1)} v=${event.value.toFixed(1)}`,
      );
    }
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
      this.startRound(duel);
    }
  }

  private gameTick(duel: Duel): number {
    return this.tick - duel.startTick;
  }

  private writeLog(text: string): void {
    const duel = this.duel;
    if (duel === null) {
      return;
    }
    const gameTick = this.gameTick(duel);
    this.log.write(duel.id, LOG_SOURCE_SERVER, `gt=${String(gameTick)} tc=${gameTimecode(gameTick)} ${text}`);
  }

  private logTick(duel: Duel, actions: [Action, Action], lateMs: number): void {
    const parts: string[] = [
      `tick rt=${String(duel.round.tick)} ph=${PHASE_MARKS[duel.phase]} late=${lateMs.toFixed(1)}`,
    ];
    for (const side of [0, 1] as const) {
      const player = duel.players[side];
      const s = String(side);
      const silent = isSilent(player.input, this.tick) ? '1' : '0';
      parts.push(
        `a${s}=${formatAction(actions[side])} ack${s}=${String(player.input.ackSeq)} in${s}=${String(player.input.inputsThisTick)}`,
        `sil${s}=${silent} p${s}=${formatPose(duel.round.tanks[side])}`,
      );
      player.input.inputsThisTick = 0;
    }
    parts.push(`b=${String(duel.round.bullets.length)}`);
    this.writeLog(parts.join(' '));
  }

  private presentPlayers(): Player[] {
    return this.players.filter((player): player is Player => player !== null);
  }

  private takeActions(players: [Player, Player]): [Action, Action] {
    return [takeAction(players[0].input, this.tick), takeAction(players[1].input, this.tick)];
  }

  private roundFor(mapIndex: number, players: [Player, Player]): Round {
    const [a, b] = players;
    return createRound(
      mapIndex,
      [
        { name: a.nickname, stats: a.stats },
        { name: b.nickname, stats: b.stats },
      ],
      this.rules,
    );
  }

  private startDuel(players: [Player, Player]): void {
    const [a, b] = players;
    const duel: Duel = {
      id: randomGameId(),
      startTick: this.tick,
      players,
      round: this.roundFor(roundPlan(this.roundIndex).mapIndex, players),
      phase: 'countdown',
      phaseTicksLeft: this.options.countdownTicks,
    };
    this.duel = duel;
    this.writeLog(
      `game start room=${this.code} p0=${a.nickname} p1=${b.nickname} rules=${String(rulesToByte(this.rules))}`,
    );
    this.startRound(duel);
  }

  private startRound(duel: Duel): void {
    const [a, b] = duel.players;
    const plan = roundPlan(this.roundIndex);
    duel.round = this.roundFor(plan.mapIndex, duel.players);
    duel.phase = 'countdown';
    duel.phaseTicksLeft = this.options.countdownTicks;
    for (const player of duel.players) {
      clearInput(player.input, this.tick);
    }
    this.writeLog(
      `round start idx=${String(this.roundIndex)} map=${String(plan.mapIndex)} score=${String(this.score[0])}:${String(this.score[1])}`,
    );
    const message: RoundStartMessage = {
      type: MessageType.RoundStart,
      gameId: duel.id,
      roundIndex: this.roundIndex,
      mapIndex: plan.mapIndex,
      countdownTicks: this.options.countdownTicks,
      score: [this.score[0], this.score[1]],
      rules: { wallSlidePercent: this.rules.wallSlidePercent },
      tanks: [
        { nickname: a.nickname, stats: a.stats },
        { nickname: b.nickname, stats: b.stats },
      ],
    };
    this.broadcast(message);
  }

  private broadcastSnapshot(duel: Duel, events: SnapshotEvent[]): void {
    const round = duel.round;
    const base: Omit<SnapshotMessage, 'ackSeq' | 'hasSpareInput'> = {
      type: MessageType.Snapshot,
      tick: round.tick,
      gameTick: this.gameTick(duel),
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
        owner: duelSide(bullet.owner),
        x: bullet.x,
        y: bullet.y,
        vx: bullet.vx,
        vy: bullet.vy,
        bouncesLeft: bullet.bouncesLeft,
        hasBounced: bullet.hasBounced,
        age: bullet.age,
      })),
      kits: round.kits.map((kit) => ({ isActive: kit.isActive, respawnIn: kit.respawnIn })),
      events,
    };
    for (const player of duel.players) {
      this.sendTo(player, {
        ...base,
        ackSeq: player.input.ackSeq,
        hasSpareInput: hasSpareInput(player.input, this.tick),
      });
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
