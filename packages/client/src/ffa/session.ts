import {
  DEFAULT_RULES,
  DEFAULT_STATS,
  ffaStandings,
  TICK_RATE,
  type FfaSize,
  type RoundRules,
  type Stats,
  type ZonePlan,
} from '@tanks/shared/engine';
import {
  ErrorCode,
  EventFlag,
  FfaPhase,
  type FfaMatchStartMessage,
  type FfaRosterMessage,
  type FfaScoreMessage,
  type FfaSelf,
  type FfaSnapshotEvent,
  type FfaSnapshotMessage,
  type FfaStateMessage,
  type FfaWelcomeMessage,
} from '@tanks/shared/protocol';

export type FfaScreen =
  | 'connecting'
  | 'lobby'
  | 'countdown'
  | 'fight'
  | 'dead'
  | 'spectator'
  | 'results'
  | 'idle'
  | 'replaced'
  | 'update'
  | 'error';

type FatalScreen = Extract<FfaScreen, 'idle' | 'replaced' | 'update' | 'error'>;

// first — первое приветствие; returned — тот же игрок той же игры после обрыва; lost — место ушло, всё заново.
export type WelcomeOutcome = 'first' | 'returned' | 'lost';
// new — новый матч: всё матчевое с нуля; same — тот же матч (возврат), ничего не сбрасывается.
export type MatchStartOutcome = 'new' | 'same';

export interface FfaMatchInfo {
  index: number;
  durationSeconds: number;
  zone: ZonePlan;
  suddenDeathAt: number;
}

interface KnownPlayer {
  nickname: string;
  stats: Stats;
  isBot: boolean;
}

// total — строк в счёте матча: место считается среди тех, кто в нём играл.
export interface FfaScoreLine {
  place: number;
  total: number;
  kills: number;
  deaths: number;
}

export interface FfaLobbyLine {
  players: number;
  capacity: number;
  minimum: number;
  // Секунд до старта по местным часам; null — старт не назначен.
  startInS: number | null;
}

export interface FfaDeathLine {
  killerId: number | null;
  // Вид смерти по своему событию; null — своего события в этом соединении не было (вернулся по пропуску).
  cause: 'bullet' | 'ricochet' | 'self' | 'zone' | null;
}

const UNKNOWN_NAME = 'Неизвестный танкист';
const FINAL_EPSILON = 1e-9;
const MS_PER_S = 1000;

const FATAL_BY_CODE: Readonly<Record<ErrorCode, FatalScreen>> = {
  [ErrorCode.BadProtocolVersion]: 'update',
  [ErrorCode.RoomFull]: 'error',
  [ErrorCode.BadMessage]: 'error',
  [ErrorCode.Idle]: 'idle',
  [ErrorCode.Replaced]: 'replaced',
};

function hasFlag(event: FfaSnapshotEvent, flag: number): boolean {
  return (event.flags & flag) !== 0;
}

function deathCause(event: FfaSnapshotEvent): NonNullable<FfaDeathLine['cause']> {
  if (hasFlag(event, EventFlag.Zone)) {
    return 'zone';
  }
  if (hasFlag(event, EventFlag.Self)) {
    return 'self';
  }
  return hasFlag(event, EventFlag.Ricochet) ? 'ricochet' : 'bullet';
}

// Сессия общей игры без браузера: кто я, фаза и отсчёты по местным часам, состав и кэш имён, счёт, матч, своё
// состояние, лента. Отдаёт экран и модели для интерфейса, решает «новый матч / возврат / пропустить снимок».
export class FfaSession {
  playerId: number | null = null;
  gameId: string | null = null;
  rules: RoundRules = { ...DEFAULT_RULES };
  match: FfaMatchInfo | null = null;
  self: FfaSelf | null = null;
  tick = 0;
  isConnectionLost = false;
  private state: FfaStateMessage | null = null;
  private stateAt = 0;
  private readonly names = new Map<number, KnownPlayer>();
  private scoreRows: FfaScoreMessage['rows'] = [];
  private lastSnapshotTick: number | null = null;
  private ownDeath: FfaSnapshotEvent | null = null;
  private feedLines: string[] = [];
  private fatal: FatalScreen | null = null;

  constructor(readonly size: FfaSize) {}

  get phase(): FfaStateMessage['phase'] | null {
    return this.state?.phase ?? null;
  }

  get players(): number {
    return this.state?.players ?? 0;
  }

  get capacity(): number {
    return this.state?.capacity ?? this.size;
  }

  get minimum(): number {
    return this.state?.minimum ?? 0;
  }

  get stateMatchIndex(): number {
    return this.state?.matchIndex ?? 0;
  }

  get hasFatalError(): boolean {
    return this.fatal !== null;
  }

  get feed(): readonly string[] {
    return this.feedLines;
  }

  onWelcome(message: FfaWelcomeMessage): WelcomeOutcome {
    const isFirst = this.playerId === null;
    const isSame = message.playerId === this.playerId && message.gameId === this.gameId;
    this.isConnectionLost = false;
    this.ownDeath = null;
    this.playerId = message.playerId;
    this.gameId = message.gameId;
    this.rules = { ...message.rules };
    if (isFirst) {
      return 'first';
    }
    if (isSame) {
      return 'returned';
    }
    this.state = null;
    this.match = null;
    this.self = null;
    this.names.clear();
    this.forgetMatch();
    return 'lost';
  }

  onState(message: FfaStateMessage, receivedAt: number): void {
    this.state = message;
    this.stateAt = receivedAt;
  }

  // Ушедший из состава остаётся в кэше имён: его ник ещё нужен ленте и карточке «тебя подбил».
  onRoster(message: FfaRosterMessage): void {
    for (const player of message.players) {
      this.names.set(player.id, { nickname: player.nickname, stats: player.stats, isBot: player.isBot });
    }
  }

  onMatchStart(message: FfaMatchStartMessage): MatchStartOutcome {
    if (this.match !== null && message.matchIndex <= this.match.index) {
      return 'same';
    }
    this.match = {
      index: message.matchIndex,
      durationSeconds: message.durationSeconds,
      zone: { ...message.zone },
      suddenDeathAt: message.suddenDeathAt,
    };
    this.self = null;
    this.tick = 0;
    this.forgetMatch();
    return 'new';
  }

  onScore(message: FfaScoreMessage): void {
    this.scoreRows = message.rows;
  }

  // false — снимок старше уже принятого в этом матче: его пропускают целиком.
  acceptSnapshot(message: FfaSnapshotMessage): boolean {
    if (this.match === null) {
      return false;
    }
    if (this.lastSnapshotTick !== null && message.tick < this.lastSnapshotTick) {
      return false;
    }
    this.lastSnapshotTick = message.tick;
    this.tick = message.tick;
    this.self = message.self;
    for (const event of message.events) {
      if (event.kind !== 'death') {
        continue;
      }
      this.feedLines.push(this.feedLine(event));
      if (event.tank === this.playerId) {
        this.ownDeath = event;
      }
    }
    return true;
  }

  onError(code: ErrorCode): void {
    this.fatal = FATAL_BY_CODE[code];
  }

  onDisconnect(): void {
    this.isConnectionLost = true;
  }

  screen(): FfaScreen {
    if (this.fatal !== null) {
      return this.fatal;
    }
    const state = this.state;
    if (this.playerId === null || state === null) {
      return 'connecting';
    }
    switch (state.phase) {
      case FfaPhase.Lobby:
        return 'lobby';
      case FfaPhase.Countdown:
        return this.countdownScreen(state.matchIndex);
      case FfaPhase.Fight:
        return this.fightScreen();
      case FfaPhase.Results:
        return 'results';
    }
  }

  // Финал — то же условие, что у движка: по нему клиент знает о финале и после возврата.
  get isFinal(): boolean {
    return this.match !== null && this.tick / TICK_RATE >= this.match.suddenDeathAt - FINAL_EPSILON;
  }

  // Секунд до конца матча по тику снимка, с округлением вверх.
  get timeLeftS(): number | null {
    if (this.match === null) {
      return null;
    }
    const ticksLeft = Math.round(this.match.durationSeconds * TICK_RATE) - this.tick;
    return Math.max(0, Math.ceil(ticksLeft / TICK_RATE));
  }

  // Секунд до конца фазы по местным часам с момента прихода состояния; null — отсчёта нет.
  phaseLeftS(now: number): number | null {
    const ticksLeft = this.state?.ticksLeft ?? null;
    if (ticksLeft === null) {
      return null;
    }
    return Math.max(0, ticksLeft / TICK_RATE - (now - this.stateAt) / MS_PER_S);
  }

  lobby(now: number): FfaLobbyLine {
    return { players: this.players, capacity: this.capacity, minimum: this.minimum, startInS: this.phaseLeftS(now) };
  }

  nameOf(id: number): string {
    return this.names.get(id)?.nickname ?? UNKNOWN_NAME;
  }

  isBot(id: number): boolean {
    return this.names.get(id)?.isBot === true;
  }

  statsOf(id: number): Stats {
    return this.names.get(id)?.stats ?? { ...DEFAULT_STATS };
  }

  score(): FfaScoreLine | null {
    const standings = ffaStandings(this.scoreRows);
    const index = standings.findIndex((row) => row.id === this.playerId);
    const row = standings[index];
    if (row === undefined) {
      return null;
    }
    return { place: index + 1, total: standings.length, kills: row.kills, deaths: row.deaths };
  }

  death(): FfaDeathLine {
    const killerId = this.self?.killerId ?? null;
    return { killerId, cause: this.ownDeath === null ? null : deathCause(this.ownDeath) };
  }

  // Цель зрителя: убийца, если его танк жив на поле, иначе лидер таблицы среди живых; живых нет — null.
  spectatorTarget(aliveIds: readonly number[]): number | null {
    const killerId = this.self?.killerId ?? null;
    if (killerId !== null && aliveIds.includes(killerId)) {
      return killerId;
    }
    const leader = ffaStandings(this.scoreRows).find((row) => aliveIds.includes(row.id));
    return leader?.id ?? aliveIds[0] ?? null;
  }

  private countdownScreen(matchIndex: number): FfaScreen {
    if (this.match?.index === matchIndex) {
      return 'countdown';
    }
    return this.match === null ? 'connecting' : 'results';
  }

  private fightScreen(): FfaScreen {
    switch (this.self?.state) {
      case 'alive':
        return 'fight';
      case 'wreck':
      case 'waiting':
        return 'dead';
      case 'spectator':
        return 'spectator';
      case undefined:
        return 'connecting';
    }
  }

  private feedLine(event: FfaSnapshotEvent): string {
    const victim = event.tank === null ? UNKNOWN_NAME : this.nameOf(event.tank);
    switch (deathCause(event)) {
      case 'zone':
        return `${victim} ◎ сгорел в зоне`;
      case 'self':
        return `${victim} ↺ сам себя`;
      case 'ricochet':
        return `${this.killerName(event)} ↺ ${victim}`;
      case 'bullet':
        return `${this.killerName(event)} ✕ ${victim}`;
    }
  }

  private killerName(event: FfaSnapshotEvent): string {
    return event.by === null ? UNKNOWN_NAME : this.nameOf(event.by);
  }

  private forgetMatch(): void {
    this.scoreRows = [];
    this.feedLines = [];
    this.lastSnapshotTick = null;
    this.ownDeath = null;
  }
}
