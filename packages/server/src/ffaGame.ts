import {
  createFfaMatch,
  FFA,
  ffaMap,
  ffaStandings,
  ffaViewCenter,
  IDLE_ACTION,
  isInFfaView,
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
  FFA_JOURNAL,
  FFA_LEAVE_IDLE,
  FFA_LEAVE_OFFLINE,
  FFA_LEAVE_YIELD,
  FfaInviteMiss,
  FfaPhase,
  formatJournalActions,
  formatJournalJoin,
  formatJournalRoster,
  formatJournalSum,
  gameTimecode,
  isJournalSumTick,
  MessageType,
  NO_ID,
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
import { CrowdBot } from './crowd/bot.js';
import { prepareCrowdMap } from './crowd/brain.js';
import { crowdNickname, crowdPyramid, type CrowdLevel } from './crowd/profile.js';
import { ServerBot } from './crowd/serverBot.js';
import { TargetBook } from './crowd/targets.js';
import { LOG_SOURCE_SERVER, type GameLog } from './gameLog.js';
import { clearInput, createInputChannel, hasSpareInput, offerInput, takeAction, type InputChannel } from './inputs.js';
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
  matchSeed: () => number;
  // Добирать игру с людьми серверными ботами до минимума.
  hasServerBots: boolean;
  botRandom: () => number;
}

const SEED_LIMIT = 2 ** 31;

export const DEFAULT_FFA_OPTIONS: FfaOptions = {
  countdownTicks: 3 * TICK_RATE,
  resultsTicks: 5 * TICK_RATE,
  lobbyQuietTicks: 10 * TICK_RATE,
  reconnectTicks: 15 * TICK_RATE,
  idleWarnTicks: 15 * TICK_RATE,
  idleKickTicks: 25 * TICK_RATE,
  matchSeconds: FFA.matchSeconds,
  maxInputsPerSecond: 90,
  minimum: { 10: 7, 30: 20, 50: 35 },
  mapFor: ffaMap,
  matchSeed: () => randomInt(SEED_LIMIT),
  hasServerBots: true,
  botRandom: Math.random,
};

// isBot — бот роя или серверный бот; serverBot — у серверного бота, его соединение внутри процесса.
interface GamePlayer {
  id: number;
  token: string;
  connection: FfaConnection | null;
  nickname: string;
  stats: Stats;
  isBot: boolean;
  serverBot: ServerBot | null;
  input: InputChannel;
  appliedAction: Action;
  idleTicks: number;
  offlineTicks: number;
}

type ServerBotPlayer = GamePlayer & { serverBot: ServerBot };

export interface FfaPlayerKinds {
  humans: number;
  serverBots: number;
  swarmBots: number;
}

function isServerBot(player: GamePlayer): player is ServerBotPlayer {
  return player.serverBot !== null;
}

// Уровни пирамиды на total ботов, которых не хватает к уровням current: k-й бот уровня нужен, если ботов этого
// уровня меньше k. Младшие — первыми.
function missingLevels(current: readonly CrowdLevel[], total: number): CrowdLevel[] {
  const pyramid = crowdPyramid(total);
  return pyramid.filter((level, index) => {
    const rank = pyramid.slice(0, index + 1).filter((other) => other === level).length;
    return rank > current.filter((other) => other === level).length;
  });
}

// Лишние count ботов из ordered (порядок ухода): сначала те, без кого оставшиеся совпадают с пирамидой total, затем
// остальные — по тому же порядку.
function surplusBots(ordered: readonly ServerBotPlayer[], total: number, count: number): ServerBotPlayer[] {
  const slots = new Map<CrowdLevel, number>();
  for (const level of crowdPyramid(total)) {
    slots.set(level, (slots.get(level) ?? 0) + 1);
  }
  const fitting = new Set<ServerBotPlayer>();
  for (const bot of [...ordered].reverse()) {
    const free = slots.get(bot.serverBot.level) ?? 0;
    if (free > 0) {
      slots.set(bot.serverBot.level, free - 1);
      fitting.add(bot);
    }
  }
  const beyond = ordered.filter((bot) => !fitting.has(bot));
  const inside = ordered.filter((bot) => fitting.has(bot));
  return [...beyond, ...inside].slice(0, count);
}

type Stage =
  | { phase: typeof FfaPhase.Lobby; quietTicks: number }
  | { phase: typeof FfaPhase.Countdown; match: FfaMatch; ticksLeft: number }
  | { phase: typeof FfaPhase.Fight; match: FfaMatch }
  | { phase: typeof FfaPhase.Results; match: FfaMatch; ticksLeft: number };

type LeaveReason = typeof FFA_LEAVE_OFFLINE | typeof FFA_LEAVE_IDLE | typeof FFA_LEAVE_YIELD;

const TOKEN_BYTES = 12;
// Вес признаков в порядке ухода серверного бота: живой на поле уходит позже обломков, обломки — позже бота без
// танка, видимый — позже невидимого.
const YIELD_RANK_ON_FIELD = 4;
const YIELD_RANK_WRECK = 2;
const YIELD_RANK_SEEN = 1;
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
  if (event.type === 'out') {
    return `out id=${String(event.tank)}`;
  }
  if (event.type === 'suddenDeath' || event.type === 'matchOver') {
    return event.type;
  }
  return null;
}

// Одна общая игра: игроки, фазы лобби → отсчёт → бой → итоги, матч на движке, серверные боты. Сокетов не знает —
// только FfaConnection; всё меняется внутри тика, кроме входа, обрыва, приёма команд и хода мозга ботов.
export class FfaGame {
  readonly id = randomGameId();
  private readonly map: FfaMap;
  private players: GamePlayer[] = [];
  private stage: Stage = { phase: FfaPhase.Lobby, quietTicks: 0 };
  private tick = 0;
  private matchIndex = 0;
  private nextPlayerId = 1;
  private readonly bullets = new BulletTracker();
  private readonly targetBook = new TargetBook();
  private hasDamageSinceScore = false;
  private ticksSinceScore = 0;
  private journalActions: ReadonlyMap<number, Action> = new Map();

  constructor(
    readonly size: FfaSize,
    private readonly options: FfaOptions,
    private readonly log: GameLog,
    private readonly dropCounter: InputDropCounter,
    private readonly rules: Readonly<RoundRules>,
  ) {
    this.map = options.mapFor(size);
    if (options.hasServerBots) {
      prepareCrowdMap(this.map);
    }
    this.writeLog(`game start mode=ffa size=${String(size)} rules=${String(rulesToByte(rules))}`);
  }

  // Участники — люди и боты роя: серверный бот своё место им уступает.
  get participantCount(): number {
    return this.players.length - this.players.filter(isServerBot).length;
  }

  // Номера не переиспользуются: когда они кончились, игра новых не берёт — подбор откроет следующую.
  get hasFreeSeat(): boolean {
    return this.participantCount < this.size && this.nextPlayerId < NO_ID;
  }

  get isEmpty(): boolean {
    return this.players.length === 0;
  }

  get playerKinds(): FfaPlayerKinds {
    const serverBots = this.players.filter(isServerBot).length;
    const humans = this.players.filter((player) => !player.isBot).length;
    return { humans, serverBots, swarmBots: this.players.length - humans - serverBots };
  }

  private get minimum(): number {
    return this.options.minimum[this.size];
  }

  // Человек или бот роя. Мест нет — в лобби серверный бот уходит сразу, в остальных фазах — в начале тика.
  join(
    connection: FfaConnection,
    nickname: string,
    stats: Stats,
    isBot: boolean,
    inviteMiss: FfaInviteMiss = FfaInviteMiss.None,
  ): Seat {
    const player = this.addPlayer(connection, nickname, stats, isBot, null, inviteMiss);
    if (this.stage.phase === FfaPhase.Lobby) {
      this.balanceBots();
      this.evictOverfull();
    }
    this.announce();
    this.sendMatchInfo(connection);
    return this.seatFor(player, connection);
  }

  // Ход мозга серверных ботов — вне тика: по снимкам, которые тик им разослал.
  thinkBots(): void {
    for (const bot of this.players.filter(isServerBot)) {
      bot.serverBot.think(this.tick);
    }
  }

  private addPlayer(
    connection: FfaConnection,
    nickname: string,
    stats: Stats,
    isBot: boolean,
    serverBot: ServerBot | null,
    inviteMiss: FfaInviteMiss,
  ): GamePlayer {
    const player: GamePlayer = {
      id: this.nextPlayerId++,
      token: randomBytes(TOKEN_BYTES).toString('base64url'),
      connection,
      nickname: sanitizeNickname(nickname),
      stats: sanitizeStats(stats),
      isBot,
      serverBot,
      input: createInputChannel(this.tick),
      appliedAction: { ...IDLE_ACTION },
      idleTicks: 0,
      offlineTicks: 0,
    };
    this.players.push(player);
    if (this.stage.phase === FfaPhase.Lobby) {
      this.stage.quietTicks = 0;
    }
    this.writeLog(`join id=${String(player.id)} nick=${player.nickname} bot=${isBot ? '1' : '0'}`);
    this.sendWelcome(player, connection, inviteMiss);
    return player;
  }

  private addServerBot(level: CrowdLevel): void {
    const bot = new CrowdBot({
      level,
      nickname: crowdNickname(level),
      size: this.size,
      random: this.options.botRandom,
      book: this.targetBook,
      phase: this.nextPlayerId,
      mapFor: () => this.map,
    });
    const serverBot = new ServerBot(bot, level);
    const join = bot.joinMessage();
    this.addPlayer(serverBot, join.nickname, join.stats, true, serverBot, FfaInviteMiss.None);
    this.sendMatchInfo(serverBot);
  }

  // Добор до минимума, пока в игре есть люди: недостающие боты входят, лишние — сверх пирамиды нужного числа —
  // уходят в лобби и на итогах сразу, в матче — когда танка бота нет на поле, ни живого, ни обломков. Людей нет —
  // уходят все.
  // true — состав изменился.
  private balanceBots(): boolean {
    if (!this.options.hasServerBots) {
      return false;
    }
    const bots = this.players.filter(isServerBot);
    const hasHumans = this.players.some((player) => !player.isBot);
    const needed = hasHumans ? Math.max(0, this.minimum - this.participantCount) : 0;
    if (bots.length < needed) {
      const levels = missingLevels(
        bots.map((bot) => bot.serverBot.level),
        needed,
      ).slice(0, Math.min(needed - bots.length, NO_ID - this.nextPlayerId));
      for (const level of levels) {
        this.addServerBot(level);
      }
      return levels.length > 0;
    }
    // Мест нет — уходит бот по порядку ухода (evictOverfull), а не лишний по пирамиде.
    if (this.players.length > this.size) {
      return false;
    }
    const leaving = surplusBots(this.yieldOrder(bots), needed, bots.length - needed).filter(
      (bot) => !hasHumans || this.canLeaveNow(bot),
    );
    for (const bot of leaving) {
      this.detachPlayer(bot, FFA_LEAVE_YIELD);
    }
    return leaving.length > 0;
  }

  // Мест нет: лишний бот уходит сразу, даже с поля. true — кто-то ушёл.
  private evictOverfull(): boolean {
    const excess = Math.max(0, this.players.length - this.size);
    const victims = this.yieldOrder(this.players.filter(isServerBot)).slice(0, excess);
    for (const victim of victims) {
      this.detachPlayer(victim, FFA_LEAVE_YIELD);
    }
    return victims.length > 0;
  }

  // Лишний бот на поле доигрывает, подбитый лежит обломками до конца: уходит, когда его танка на поле нет, или вне
  // матча.
  private canLeaveNow(bot: GamePlayer): boolean {
    const stage = this.stage;
    if (stage.phase === FfaPhase.Lobby || stage.phase === FfaPhase.Results) {
      return true;
    }
    return !stage.match.world.tanks.some((tank) => tank.id === bot.id);
  }

  // Первым уходит бот без танка на поле (ждёт, выбыл), затем в обломках, затем тот, кого не видит ни один человек с
  // танком на поле, затем — с самым низким местом в таблице матча. Без матча — вошедший последним.
  private yieldOrder(bots: readonly ServerBotPlayer[]): ServerBotPlayer[] {
    const stage = this.stage;
    if (stage.phase === FfaPhase.Lobby) {
      return [...bots].reverse();
    }
    const { match } = stage;
    const humanIds = new Set(this.players.filter((player) => !player.isBot).map((player) => player.id));
    const views = match.world.tanks.filter((tank) => humanIds.has(tank.id)).map((tank) => ffaViewCenter(tank));
    const places = ffaStandings(match.players).map((player) => player.id);
    const rank = (bot: ServerBotPlayer): number => {
      const tank = match.world.tanks.find((candidate) => candidate.id === bot.id);
      const isOnField = tank?.isAlive === true;
      const isWreck = tank?.isAlive === false;
      const isSeen = views.some((view) => tank !== undefined && isInFfaView(view, tank.x, tank.y));
      return (
        Number(isOnField) * YIELD_RANK_ON_FIELD + Number(isWreck) * YIELD_RANK_WRECK + Number(isSeen) * YIELD_RANK_SEEN
      );
    };
    return [...bots].sort((a, b) => rank(a) - rank(b) || places.indexOf(b.id) - places.indexOf(a.id));
  }

  private announce(): void {
    this.broadcast(this.rosterMessage());
    this.broadcast(this.stateMessage());
  }

  // Возврат по пропуску: тот же игрок, номер и счёт; previous — соединение, которое игрок занимал до этого.
  // null — такого игрока в игре нет.
  rejoin(token: string, connection: FfaConnection): { seat: Seat; previous: FfaConnection | null } | null {
    const player = this.players.find((candidate) => candidate.token === token);
    if (player === undefined) {
      return null;
    }
    const previous = player.connection;
    if (previous !== null) {
      previous.send(
        encode({ type: MessageType.Error, code: ErrorCode.Replaced, text: 'место занято с другого устройства' }),
      );
    }
    player.connection = connection;
    player.offlineTicks = 0;
    // Новый клиент считает номера команд с единицы, недоигранная очередь старого ему не достаётся; бездействие до
    // обрыва не переносится.
    player.input = createInputChannel(this.tick);
    player.appliedAction = { ...IDLE_ACTION };
    player.idleTicks = 0;
    this.writeLog(`rejoin id=${String(player.id)}`);
    this.sendWelcome(player, connection, FfaInviteMiss.None);
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
    this.deliverBotInputs();
    this.expireOffline();
    const hasBalanced = this.balanceBots();
    // В бою лишних вытесняют после входа новичков в матч: вошедший в финал человек выбивает бота с поля, и уходит
    // именно он.
    const hasEvicted = this.stage.phase !== FfaPhase.Fight && this.evictOverfull();
    if (hasBalanced || hasEvicted) {
      this.announce();
    }
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

  private offer(player: GamePlayer, seq: number, action: Action): void {
    for (const drop of offerInput(player.input, seq, action, this.tick, this.options.maxInputsPerSecond)) {
      this.dropCounter.countDroppedInput(drop.reason);
      this.writeLog(`input ${drop.reason} id=${String(player.id)} seq=${String(drop.seq)}`);
    }
  }

  private deliverBotInputs(): void {
    for (const bot of this.players.filter(isServerBot)) {
      for (const input of bot.serverBot.takeDue(this.tick)) {
        this.offer(bot, input.seq, input.action);
      }
    }
  }

  private seatFor(player: GamePlayer, connection: FfaConnection): Seat {
    return {
      input: (seq, action) => {
        this.offer(player, seq, action);
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

  private sendWelcome(player: GamePlayer, connection: FfaConnection, inviteMiss: FfaInviteMiss): void {
    connection.send(
      encode({
        type: MessageType.FfaWelcome,
        playerId: player.id,
        token: player.token,
        gameId: this.id,
        size: this.size,
        rules: { wallSlidePercent: this.rules.wallSlidePercent },
        inviteMiss,
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
        this.removePlayer(player, FFA_LEAVE_OFFLINE);
      }
    }
  }

  private removePlayer(player: GamePlayer, reason: LeaveReason): void {
    this.detachPlayer(player, reason);
    this.announce();
  }

  private detachPlayer(player: GamePlayer, reason: LeaveReason): void {
    this.players = this.players.filter((candidate) => candidate !== player);
    const stage = this.stage;
    if (stage.phase !== FfaPhase.Lobby) {
      leaveFfaMatch(stage.match, player.id);
    }
    if (isServerBot(player)) {
      player.serverBot.close();
    }
    this.writeLog(`${FFA_JOURNAL.leave} id=${String(player.id)} reason=${reason}`);
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
    const seed = this.options.matchSeed();
    const setups = this.players.map((player) => ({
      id: player.id,
      name: player.nickname,
      stats: player.stats,
      isBot: player.isBot,
    }));
    const match = createFfaMatch(this.map, setups, seed, this.rules, this.options.matchSeconds);
    this.bullets.reset();
    for (const player of this.players) {
      player.idleTicks = 0;
      clearInput(player.input, this.tick);
    }
    this.stage = { phase: FfaPhase.Countdown, match, ticksLeft: this.options.countdownTicks };
    this.hasDamageSinceScore = false;
    this.ticksSinceScore = 0;
    this.journalActions = new Map();
    this.writeLog(
      `${FFA_JOURNAL.matchStart} idx=${String(this.matchIndex)} players=${String(setups.length)} seed=${String(seed)}` +
        ` dur=${String(this.options.matchSeconds)} roster=${formatJournalRoster(setups)}`,
    );
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
      this.writeLog(`${FFA_JOURNAL.fightStart} idx=${String(this.matchIndex)}`);
      this.broadcast(this.stateMessage());
    }
  }

  private stepFight(match: FfaMatch): void {
    let hasNewcomer = false;
    for (const player of this.players) {
      if (!match.players.some((candidate) => candidate.id === player.id)) {
        const setup = { id: player.id, name: player.nickname, stats: player.stats, isBot: player.isBot };
        this.writeLog(formatJournalJoin(setup));
        joinFfaMatch(match, setup);
        hasNewcomer = true;
      }
    }
    if (this.evictOverfull()) {
      this.announce();
    }
    const actions = new Map<number, Action>();
    for (const player of this.players) {
      const action = takeAction(player.input, this.tick);
      if (player.connection !== null) {
        actions.set(player.id, action);
      }
      this.trackIdle(player, action, match);
    }
    const actionsLine = formatJournalActions(this.journalActions, actions);
    if (actionsLine !== null) {
      this.writeLog(actionsLine);
    }
    this.journalActions = actions;
    const events = stepFfaMatch(match, actions);
    const changes = this.bullets.diff(match.world.bullets);
    for (const event of events) {
      const line = describeEvent(event);
      if (line !== null) {
        this.writeLog(line);
      }
    }
    if (isJournalSumTick(match)) {
      this.writeLog(formatJournalSum(match));
    }
    this.sendSnapshots(match, events.map(toFfaSnapshotEvent), changes);
    this.updateScore(match, events, hasNewcomer);
    this.kickIdle();
    if (match.isOver) {
      this.stage = { phase: FfaPhase.Results, match, ticksLeft: this.options.resultsTicks };
      this.writeLog(`${FFA_JOURNAL.matchOver} idx=${String(this.matchIndex)}`);
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
  // Серверного бота за бездействие не выкидывают.
  private trackIdle(player: GamePlayer, action: Action, match: FfaMatch): void {
    const isOnField = match.players.some((candidate) => candidate.id === player.id && candidate.state === 'alive');
    if (player.connection === null || !isOnField || isServerBot(player)) {
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
      this.removePlayer(player, FFA_LEAVE_IDLE);
      connection.close();
    }
  }

  private updateScore(match: FfaMatch, events: FfaEvent[], hasNewcomer: boolean): void {
    this.ticksSinceScore++;
    const hasDeath = events.some((event) => event.type === 'death');
    this.hasDamageSinceScore = this.hasDamageSinceScore || events.some((event) => event.type === 'hit');
    const isScoreDue = this.hasDamageSinceScore && this.ticksSinceScore >= SCORE_INTERVAL_TICKS;
    if (!hasDeath && !isScoreDue && !hasNewcomer) {
      return;
    }
    this.broadcast(this.scoreMessage(match));
    this.hasDamageSinceScore = false;
    this.ticksSinceScore = 0;
  }

  // Отсчёт бездействия показывается, только пока танк жив: у мёртвого и зрителя он стоит.
  private selfOf(player: GamePlayer, match: FfaMatch): FfaSelf {
    const inMatch: FfaPlayer | undefined = match.players.find((candidate) => candidate.id === player.id);
    if (inMatch === undefined) {
      return { state: 'waiting', ticksLeft: 0, killerId: null, idleTicksLeft: null, isOut: false };
    }
    const isWarned = inMatch.state === 'alive' && player.idleTicks >= this.options.idleWarnTicks;
    return {
      state: inMatch.state,
      ticksLeft: inMatch.ticksLeft,
      killerId: inMatch.killerId,
      idleTicksLeft: isWarned ? this.options.idleKickTicks - player.idleTicks : null,
      isOut: inMatch.isOut,
    };
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
          hasSpareInput: hasSpareInput(player.input, this.tick),
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
        return this.lobbyTicksLeft(stage.quietTicks);
      case FfaPhase.Fight:
        return Math.round(stage.match.durationSeconds * TICK_RATE) - stage.match.world.tick;
      case FfaPhase.Countdown:
      case FfaPhase.Results:
        return stage.ticksLeft;
    }
  }

  // Полная игра стартует на ближайшем тике; без минимума старт не назначен.
  private lobbyTicksLeft(quietTicks: number): number | null {
    if (this.players.length >= this.size) {
      return 0;
    }
    if (this.players.length < this.minimum) {
      return null;
    }
    return this.options.lobbyQuietTicks - quietTicks;
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
      rows: match.players
        .filter((player) => player.hasPlayed)
        .map((player) => ({
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
