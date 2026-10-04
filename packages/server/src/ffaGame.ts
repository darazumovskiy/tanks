import {
  createFfaMatch,
  FFA,
  ffaMap,
  joinFfaMatch,
  leaveFfaMatch,
  stepFfaMatch,
  TICK_RATE,
  type Action,
  type FfaEvent,
  type FfaMap,
  type FfaMatch,
  type FfaPlayer,
  type FfaSize,
  type RoundRules,
  type Stats,
} from '@tanks/shared/engine';
import {
  BulletTracker,
  bulletSnapshot,
  encode,
  ErrorCode,
  FfaPhase,
  gameTimecode,
  MessageType,
  rulesToByte,
  toFfaSnapshotEvent,
  type BulletChanges,
  type FfaRosterMessage,
  type FfaScoreMessage,
  type FfaSelf,
  type FfaSnapshotEvent,
  type FfaStateMessage,
  type FfaTankSnapshot,
  type ServerMessage,
} from '@tanks/shared/protocol';
import { randomBytes, randomInt } from 'node:crypto';
import { LOG_SOURCE_SERVER, type GameLog } from './gameLog.js';
import { createInputChannel, offerInput, takeAction, type InputChannel } from './inputs.js';
import type { InputDropCounter } from './metrics.js';
import { randomGameId, sanitizeNickname, sanitizeStats, type Connection, type Seat } from './room.js';

// Игрока общей игры сервер может выгнать сам — за бездействие или при возврате с того же пропуска.
export interface FfaConnection extends Connection {
  close(): void;
}

export interface FfaOptions {
  countdownTicks: number;
  resultsTicks: number;
  lobbyQuietTicks: number;
  reconnectTicks: number;
  idleWarnTicks: number;
  idleKickTicks: number;
  matchSeconds: number;
  maxInputsPerSecond: number;
  minimum: Readonly<Record<FfaSize, number>>;
  mapFor: (size: FfaSize) => FfaMap;
}

export const DEFAULT_FFA_OPTIONS: FfaOptions = {
  countdownTicks: 3 * TICK_RATE,
  resultsTicks: 15 * TICK_RATE,
  lobbyQuietTicks: 10 * TICK_RATE,
  reconnectTicks: 15 * TICK_RATE,
  idleWarnTicks: 15 * TICK_RATE,
  idleKickTicks: 25 * TICK_RATE,
  matchSeconds: FFA.matchSeconds,
  maxInputsPerSecond: 90,
  minimum: { 10: 7, 30: 20, 50: 35 },
  mapFor: ffaMap,
};

interface GamePlayer {
  id: number;
  token: string;
  connection: FfaConnection | null;
  nickname: string;
  stats: Stats;
  isBot: boolean;
  input: InputChannel;
  appliedAction: Action;
  idleTicks: number;
  offlineTicks: number;
}

type Stage =
  | { phase: typeof FfaPhase.Lobby; quietTicks: number }
  | { phase: typeof FfaPhase.Countdown; match: FfaMatch; ticksLeft: number }
  | { phase: typeof FfaPhase.Fight; match: FfaMatch }
  | { phase: typeof FfaPhase.Results; match: FfaMatch; ticksLeft: number };

type LeaveReason = 'offline' | 'idle';

const TOKEN_BYTES = 12;
const SEED_LIMIT = 2 ** 31;
const SCORE_INTERVAL_TICKS = TICK_RATE;

function isSameAction(a: Action, b: Action): boolean {
  return a.throttle === b.throttle && a.turn === b.turn && a.turretTurn === b.turretTurn && a.isFiring === b.isFiring;
}

function tankSnapshot(tank: FfaMatch['world']['tanks'][number]): FfaTankSnapshot {
  return {
    id: tank.id,
    x: tank.x,
    y: tank.y,
    heading: tank.heading,
    turret: tank.turret,
    speed: tank.speed,
    hp: tank.hp,
    reloadLeft: tank.reloadLeft,
    isAlive: tank.isAlive,
    shieldLeft: tank.shieldLeft,
  };
}

function describeEvent(event: FfaEvent): string | null {
  if (event.type === 'death') {
    return `death id=${String(event.tank)} by=${String(event.by)} cause=${event.cause}`;
  }
  if (event.type === 'suddenDeath' || event.type === 'matchOver') {
    return event.type;
  }
  return null;
}

// Одна общая игра: игроки, фазы лобби → отсчёт → бой → итоги, матч на движке. Сокетов не знает — только
// FfaConnection; всё меняется внутри тика, кроме входа, обрыва и приёма команд.
export class FfaGame {
  readonly id = randomGameId();
  private readonly map: FfaMap;
  private players: GamePlayer[] = [];
  private stage: Stage = { phase: FfaPhase.Lobby, quietTicks: 0 };
  private tick = 0;
  private matchIndex = 0;
  private nextPlayerId = 1;
  private readonly bullets = new BulletTracker();
  private hasDamageSinceScore = false;
  private ticksSinceScore = 0;

  constructor(
    readonly size: FfaSize,
    private readonly options: FfaOptions,
    private readonly log: GameLog,
    private readonly dropCounter: InputDropCounter,
    private readonly rules: Readonly<RoundRules>,
  ) {
    this.map = options.mapFor(size);
    this.writeLog(`game start mode=ffa size=${String(size)} rules=${String(rulesToByte(rules))}`);
  }

  get playerCount(): number {
    return this.players.length;
  }

  get hasFreeSeat(): boolean {
    return this.players.length < this.size;
  }

  get isEmpty(): boolean {
    return this.players.length === 0;
  }

  private get minimum(): number {
    return this.options.minimum[this.size];
  }

  join(connection: FfaConnection, nickname: string, stats: Stats, isBot: boolean): Seat {
    const player: GamePlayer = {
      id: this.nextPlayerId++,
      token: randomBytes(TOKEN_BYTES).toString('base64url'),
      connection,
      nickname: sanitizeNickname(nickname),
      stats: sanitizeStats(stats),
      isBot,
      input: createInputChannel(),
      appliedAction: { throttle: 0, turn: 0, turretTurn: 0, isFiring: false },
      idleTicks: 0,
      offlineTicks: 0,
    };
    this.players.push(player);
    if (this.stage.phase === FfaPhase.Lobby) {
      this.stage.quietTicks = 0;
    }
    this.writeLog(`join id=${String(player.id)} nick=${player.nickname} bot=${isBot ? '1' : '0'}`);
    this.sendWelcome(player, connection);
    this.broadcast(this.rosterMessage());
    this.broadcast(this.stateMessage());
    this.sendMatchInfo(connection);
    return this.seatFor(player, connection);
  }

  // Возврат по пропуску: тот же игрок, номер и счёт; previous — соединение, которое игрок занимал до этого.
  // null — такого игрока в игре нет.
  rejoin(token: string, connection: FfaConnection): { seat: Seat; previous: FfaConnection | null } | null {
    const player = this.players.find((candidate) => candidate.token === token);
    if (player === undefined) {
      return null;
    }
    const previous = player.connection;
    player.connection = connection;
    player.offlineTicks = 0;
    this.writeLog(`rejoin id=${String(player.id)}`);
    this.sendWelcome(player, connection);
    connection.send(encode(this.rosterMessage()));
    connection.send(encode(this.stateMessage()));
    this.sendMatchInfo(connection);
    return { seat: this.seatFor(player, connection), previous };
  }

  step(): void {
    this.tick++;
    if (this.tick % TICK_RATE === 0) {
      for (const player of this.players) {
        player.input.inputsThisSecond = 0;
      }
    }
    this.expireOffline();
    const stage = this.stage;
    switch (stage.phase) {
      case FfaPhase.Lobby:
        this.stepLobby(stage);
        break;
      case FfaPhase.Countdown:
        this.stepCountdown(stage);
        break;
      case FfaPhase.Fight:
        this.stepFight(stage.match);
        break;
      case FfaPhase.Results:
        this.stepResults(stage);
        break;
    }
  }

  private seatFor(player: GamePlayer, connection: FfaConnection): Seat {
    return {
      input: (seq, action) => {
        const drop = offerInput(player.input, seq, action, this.tick, this.options.maxInputsPerSecond);
        if (drop !== null) {
          this.dropCounter.countDroppedInput(drop);
          this.writeLog(`input ${drop} id=${String(player.id)} seq=${String(seq)}`);
        }
      },
      ping: (clientTime) => {
        connection.send(encode({ type: MessageType.Pong, clientTime, serverTick: this.tick }));
      },
      leave: () => {
        if (!this.players.includes(player)) {
          return;
        }
        player.connection = null;
        player.offlineTicks = 0;
        this.writeLog(`offline id=${String(player.id)}`);
      },
    };
  }

  private sendWelcome(player: GamePlayer, connection: FfaConnection): void {
    connection.send(
      encode({
        type: MessageType.FfaWelcome,
        playerId: player.id,
        token: player.token,
        gameId: this.id,
        size: this.size,
        rules: { wallSlidePercent: this.rules.wallSlidePercent },
      }),
    );
  }

  private sendMatchInfo(connection: FfaConnection): void {
    const stage = this.stage;
    if (stage.phase === FfaPhase.Lobby) {
      return;
    }
    connection.send(encode(this.matchStartMessage(stage.match)));
    connection.send(encode({ type: MessageType.FfaBullets, bullets: stage.match.world.bullets.map(bulletSnapshot) }));
    connection.send(encode(this.scoreMessage(stage.match)));
  }

  private expireOffline(): void {
    for (const player of [...this.players]) {
      if (player.connection !== null) {
        continue;
      }
      player.offlineTicks++;
      if (player.offlineTicks >= this.options.reconnectTicks) {
        this.removePlayer(player, 'offline');
      }
    }
  }

  private removePlayer(player: GamePlayer, reason: LeaveReason): void {
    this.players = this.players.filter((candidate) => candidate !== player);
    const stage = this.stage;
    if (stage.phase !== FfaPhase.Lobby) {
      leaveFfaMatch(stage.match, player.id);
    }
    this.writeLog(`leave id=${String(player.id)} reason=${reason}`);
    this.broadcast(this.rosterMessage());
    this.broadcast(this.stateMessage());
  }

  private stepLobby(stage: Extract<Stage, { phase: typeof FfaPhase.Lobby }>): void {
    if (this.players.length >= this.size) {
      this.startCountdown();
      return;
    }
    if (this.players.length < this.minimum) {
      stage.quietTicks = 0;
      return;
    }
    stage.quietTicks++;
    if (stage.quietTicks >= this.options.lobbyQuietTicks) {
      this.startCountdown();
    }
  }

  private startCountdown(): void {
    this.matchIndex++;
    const seed = randomInt(SEED_LIMIT);
    const setups = this.players.map((player) => ({ id: player.id, name: player.nickname, stats: player.stats }));
    const match = createFfaMatch(this.map, setups, seed, this.rules, this.options.matchSeconds);
    this.bullets.reset();
    for (const player of this.players) {
      player.idleTicks = 0;
    }
    this.stage = { phase: FfaPhase.Countdown, match, ticksLeft: this.options.countdownTicks };
    this.hasDamageSinceScore = false;
    this.ticksSinceScore = 0;
    this.writeLog(`match start idx=${String(this.matchIndex)} players=${String(setups.length)} seed=${String(seed)}`);
    this.broadcast(this.stateMessage());
    this.broadcast(this.matchStartMessage(match));
    this.broadcast(this.scoreMessage(match));
  }

  // Отсчёт: танки стоят, команды подтверждаются, снимки идут. Вошедшие сейчас попадают в матч с началом боя.
  private stepCountdown(stage: Extract<Stage, { phase: typeof FfaPhase.Countdown }>): void {
    for (const player of this.players) {
      takeAction(player.input, this.tick);
    }
    stage.ticksLeft--;
    this.sendSnapshots(stage.match, [], { births: [], bounces: [], deaths: [] });
    if (stage.ticksLeft <= 0) {
      this.stage = { phase: FfaPhase.Fight, match: stage.match };
      this.broadcast(this.stateMessage());
    }
  }

  private stepFight(match: FfaMatch): void {
    for (const player of this.players) {
      if (!match.players.some((candidate) => candidate.id === player.id)) {
        joinFfaMatch(match, { id: player.id, name: player.nickname, stats: player.stats });
      }
    }
    const actions = new Map<number, Action>();
    for (const player of this.players) {
      const action = takeAction(player.input, this.tick);
      if (player.connection !== null) {
        actions.set(player.id, action);
      }
      this.trackIdle(player, action, match);
    }
    const events = stepFfaMatch(match, actions);
    const changes = this.bullets.diff(match.world.bullets);
    for (const event of events) {
      const line = describeEvent(event);
      if (line !== null) {
        this.writeLog(line);
      }
    }
    this.sendSnapshots(match, events.map(toFfaSnapshotEvent), changes);
    this.updateScore(match, events);
    this.kickIdle();
    if (match.isOver) {
      this.stage = { phase: FfaPhase.Results, match, ticksLeft: this.options.resultsTicks };
      this.writeLog(`match over idx=${String(this.matchIndex)}`);
      this.broadcast(this.scoreMessage(match));
      this.broadcast(this.stateMessage());
    }
  }

  private stepResults(stage: Extract<Stage, { phase: typeof FfaPhase.Results }>): void {
    stage.ticksLeft--;
    if (stage.ticksLeft > 0) {
      return;
    }
    if (this.players.length >= this.minimum) {
      this.startCountdown();
      return;
    }
    this.stage = { phase: FfaPhase.Lobby, quietTicks: 0 };
    this.broadcast(this.stateMessage());
  }

  // Бездействие копится, только пока танк игрока жив в бою; мёртвый и ждущий отсчёт не двигают и не сбрасывают.
  private trackIdle(player: GamePlayer, action: Action, match: FfaMatch): void {
    const isOnField = match.players.some((candidate) => candidate.id === player.id && candidate.state === 'alive');
    if (player.connection === null || !isOnField) {
      return;
    }
    if (isSameAction(action, player.appliedAction)) {
      player.idleTicks++;
      return;
    }
    player.appliedAction = action;
    player.idleTicks = 0;
  }

  private kickIdle(): void {
    for (const player of [...this.players]) {
      const connection = player.connection;
      if (connection === null || player.idleTicks < this.options.idleKickTicks) {
        continue;
      }
      connection.send(encode({ type: MessageType.Error, code: ErrorCode.Idle, text: 'выкинуло за бездействие' }));
      this.removePlayer(player, 'idle');
      connection.close();
    }
  }

  private updateScore(match: FfaMatch, events: FfaEvent[]): void {
    this.ticksSinceScore++;
    const hasDeath = events.some((event) => event.type === 'death');
    this.hasDamageSinceScore = this.hasDamageSinceScore || events.some((event) => event.type === 'hit');
    const isScoreDue = this.hasDamageSinceScore && this.ticksSinceScore >= SCORE_INTERVAL_TICKS;
    if (!hasDeath && !isScoreDue) {
      return;
    }
    this.broadcast(this.scoreMessage(match));
    this.hasDamageSinceScore = false;
    this.ticksSinceScore = 0;
  }

  private selfOf(player: GamePlayer, match: FfaMatch): FfaSelf {
    const idleTicksLeft =
      player.idleTicks >= this.options.idleWarnTicks ? this.options.idleKickTicks - player.idleTicks : null;
    const inMatch: FfaPlayer | undefined = match.players.find((candidate) => candidate.id === player.id);
    if (inMatch === undefined) {
      return { state: 'waiting', ticksLeft: 0, killerId: null, idleTicksLeft };
    }
    return { state: inMatch.state, ticksLeft: inMatch.ticksLeft, killerId: inMatch.killerId, idleTicksLeft };
  }

  private sendSnapshots(match: FfaMatch, events: FfaSnapshotEvent[], changes: BulletChanges): void {
    const tanks = match.world.tanks.map(tankSnapshot);
    const kits = match.world.kits.map((kit) => ({ isActive: kit.isActive, respawnIn: kit.respawnIn }));
    for (const player of this.players) {
      if (player.connection === null) {
        continue;
      }
      player.connection.send(
        encode({
          type: MessageType.FfaSnapshot,
          tick: match.world.tick,
          gameTick: this.tick,
          ackSeq: player.input.ackSeq,
          self: this.selfOf(player, match),
          tanks,
          kits,
          events,
          ...changes,
        }),
      );
    }
  }

  private stateMessage(): FfaStateMessage {
    return {
      type: MessageType.FfaState,
      phase: this.stage.phase,
      ticksLeft: this.stageTicksLeft(),
      players: this.players.length,
      capacity: this.size,
      minimum: this.minimum,
      matchIndex: this.matchIndex,
    };
  }

  private stageTicksLeft(): number | null {
    const stage = this.stage;
    switch (stage.phase) {
      case FfaPhase.Lobby:
        return this.players.length >= this.minimum ? this.options.lobbyQuietTicks - stage.quietTicks : null;
      case FfaPhase.Fight:
        return Math.round(stage.match.durationSeconds * TICK_RATE) - stage.match.world.tick;
      case FfaPhase.Countdown:
      case FfaPhase.Results:
        return stage.ticksLeft;
    }
  }

  private rosterMessage(): FfaRosterMessage {
    return {
      type: MessageType.FfaRoster,
      players: this.players.map((player) => ({
        id: player.id,
        nickname: player.nickname,
        stats: player.stats,
        isBot: player.isBot,
      })),
    };
  }

  private matchStartMessage(match: FfaMatch): ServerMessage {
    return {
      type: MessageType.FfaMatchStart,
      matchIndex: this.matchIndex,
      durationSeconds: match.durationSeconds,
      zone: { ...match.world.zonePlan },
      suddenDeathAt: match.suddenDeathAt,
    };
  }

  private scoreMessage(match: FfaMatch): FfaScoreMessage {
    return {
      type: MessageType.FfaScore,
      rows: match.players.map((player) => ({
        id: player.id,
        kills: player.kills,
        deaths: player.deaths,
        damageDealt: player.damageDealt,
        damageTaken: player.damageTaken,
      })),
    };
  }

  private broadcast(message: ServerMessage): void {
    const bytes = encode(message);
    for (const player of this.players) {
      player.connection?.send(bytes);
    }
  }

  private writeLog(text: string): void {
    this.log.write(this.id, LOG_SOURCE_SERVER, `gt=${String(this.tick)} tc=${gameTimecode(this.tick)} ${text}`);
  }
}
