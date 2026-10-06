import {
  DEFAULT_RULES,
  DEFAULT_STATS,
  FFA_RESPAWN_WAIT_TICKS,
  ffaEfficiency,
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
  FfaInviteMiss,
  FfaPhase,
  type FfaMatchStartMessage,
  type FfaRosterEntry,
  type FfaRosterMessage,
  type FfaScoreMessage,
  type FfaScoreRow,
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

export type DeathCause = 'bullet' | 'ricochet' | 'self' | 'zone' | 'out';

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

export interface FfaRosterNick {
  id: number;
  name: string;
  isBot: boolean;
  isMe: boolean;
}

export interface FfaLobbyModel {
  players: number;
  capacity: number;
  minimum: number;
  // Секунд до старта по местным часам; null — старт не назначен.
  startInS: number | null;
  isFull: boolean;
  // Свой ник первым: в облаке он виден всегда.
  roster: FfaRosterNick[];
}

// value — цифра отсчёта, null — «В БОЙ!»; isLanding — своего танка в матче ещё нет, высадка с началом боя.
export interface FfaCountdownModel {
  value: number | null;
  isLanding: boolean;
}

export interface FfaLeader {
  name: string;
  kills: number;
  isMe: boolean;
}

export interface FfaScoreboardModel {
  timeLeftS: number;
  isFinal: boolean;
  score: FfaScoreLine | null;
  leader: FfaLeader | null;
}

// Запись ленты: кто, кого, как и когда пришла по местным часам.
interface FeedEntry {
  key: number;
  killerId: number | null;
  victimId: number | null;
  cause: DeathCause;
  at: number;
}

export interface FfaFeedRow {
  key: number;
  killer: string;
  victim: string;
  cause: DeathCause;
  isMyKill: boolean;
  isMyDeath: boolean;
  ageMs: number;
}

// killed — подбит чужим снарядом или вернулся подбитым без своего события; out — выбыл в финале; late — вошёл в
// финал зрителем. respawnInS — секунд до появления, не меньше 1.
export type FfaDeathModel =
  | {
      kind: 'killed';
      killerName: string | null;
      isKillerBot: boolean;
      isRicochet: boolean;
      respawnInS: number;
    }
  | { kind: 'self'; respawnInS: number }
  | { kind: 'zone'; respawnInS: number }
  | { kind: 'out' }
  | { kind: 'late' };

export interface FfaSpectatorModel {
  name: string;
  isBot: boolean;
}

// hasBots — в матче есть невыбывший бот: в финале первыми выбывают боты, подбитый человек пока возвращается.
export type FfaFinalModel =
  { kind: 'soon'; secondsLeft: number; hasBots: boolean } | { kind: 'started'; hasBots: boolean };

export type FfaResultsTitle = 'champion' | 'podium' | 'solid' | 'nextTime' | 'notPlayed';

export interface FfaResultRow {
  place: number;
  name: string;
  isBot: boolean;
  isMe: boolean;
  kills: number;
  deaths: number;
  efficiency: number | null;
  // Перед строкой пропущены места: своя строка с соседями ниже лучших.
  isAfterGap: boolean;
}

export interface FfaResultsModel {
  title: FfaResultsTitle;
  place: number | null;
  total: number;
  rows: FfaResultRow[];
  // Секунд до следующего матча по местным часам; null — игроков меньше минимума, ждём сбора.
  nextMatchInS: number | null;
}

// lost — связь пропала; returned — вернулись на своё место; late — место ушло, вход заново.
export type FfaConnectionNotice = 'lost' | 'returned' | 'late';
// Вошёл по приглашению, а попал не к другу: full — там нет мест, gone — той игры нет.
export type FfaInviteNotice = 'full' | 'gone';

export interface FfaHudLayout {
  feedRows: number;
  resultsTop: number;
}

export interface FfaHudModel {
  screen: FfaScreen;
  lobby: FfaLobbyModel | null;
  countdown: FfaCountdownModel | null;
  scoreboard: FfaScoreboardModel | null;
  feed: FfaFeedRow[];
  death: FfaDeathModel | null;
  spectator: FfaSpectatorModel | null;
  final: FfaFinalModel | null;
  idleInS: number | null;
  results: FfaResultsModel | null;
  connection: FfaConnectionNotice | null;
  invite: FfaInviteNotice | null;
}

const UNKNOWN_NAME = 'Неизвестный танкист';
const FINAL_EPSILON = 1e-9;
const MS_PER_S = 1000;
export const FEED_LIFETIME_MS = 5000;
const FINAL_WARNING_S = 5;
const FINAL_NOTICE_MS = 2000;
const GO_HOLD_MS = 900;
const SPECTATOR_CARD_MS = 4000;
const CONNECTION_NOTICE_MS = 2000;
const INVITE_NOTICE_MS = 8000;
const INVITE_NOTICES: Readonly<Record<FfaInviteMiss, FfaInviteNotice | null>> = {
  [FfaInviteMiss.None]: null,
  [FfaInviteMiss.Full]: 'full',
  [FfaInviteMiss.Gone]: 'gone',
};
// «НА ПЬЕДЕСТАЛЕ» — второе и третье место, когда в матче не меньше шести игроков.
const PODIUM_LAST_PLACE = 3;
const PODIUM_MIN_PLAYERS = 6;

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

function deathCause(event: FfaSnapshotEvent): DeathCause {
  if (hasFlag(event, EventFlag.Out)) {
    return 'out';
  }
  if (hasFlag(event, EventFlag.Zone)) {
    return 'zone';
  }
  if (hasFlag(event, EventFlag.Self)) {
    return 'self';
  }
  return hasFlag(event, EventFlag.Ricochet) ? 'ricochet' : 'bullet';
}

function secondsUp(ticks: number): number {
  return Math.max(1, Math.ceil(ticks / TICK_RATE));
}

// Строка ленты текстом — как на экране, значки символами.
export function feedText(row: FfaFeedRow): string {
  switch (row.cause) {
    case 'zone':
      return `${row.victim} ◎ сгорел в зоне`;
    case 'out':
      return `${row.victim} ⊘ выбыл`;
    case 'self':
      return `${row.victim} ↺ сам себя`;
    case 'ricochet':
      return `${row.killer} ↺ ${row.victim}`;
    case 'bullet':
      return `${row.killer} ✕ ${row.victim}`;
  }
}

// Сессия общей игры без браузера: кто я, фаза и отсчёты по местным часам, текущий состав и кэш имён, счёт, матч,
// своё состояние, лента, цель зрителя. Отдаёт экран и модели интерфейса, решает «новый матч / возврат / пропустить
// снимок».
export class FfaSession {
  playerId: number | null = null;
  gameId: string | null = null;
  rules: RoundRules = { ...DEFAULT_RULES };
  match: FfaMatchInfo | null = null;
  self: FfaSelf | null = null;
  tick = 0;
  isConnectionLost = false;
  private state: FfaStateMessage | null = null;
  private phaseBefore: FfaStateMessage['phase'] | null = null;
  private stateAt = 0;
  private fightStartedAt: number | null = null;
  private roster: FfaRosterEntry[] = [];
  private readonly names = new Map<number, KnownPlayer>();
  private scoreRows: FfaScoreRow[] = [];
  private lastSnapshotTick: number | null = null;
  private ownDeath: FfaSnapshotEvent | null = null;
  private feedEntries: FeedEntry[] = [];
  private nextFeedKey = 1;
  private suddenDeathNoticeAt: number | null = null;
  // Боты, выбывшие в финале этого матча; null — финал ещё не начался или не учтён.
  private outBotIds: Set<number> | null = null;
  private spectatorSince: number | null = null;
  private spectatorId: number | null = null;
  private welcomeNotice: { kind: 'returned' | 'late'; at: number } | null = null;
  private inviteNotice: { kind: FfaInviteNotice; at: number } | null = null;
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

  get spectating(): number | null {
    return this.spectatorId;
  }

  onWelcome(message: FfaWelcomeMessage, receivedAt: number): WelcomeOutcome {
    const isFirst = this.playerId === null;
    const isSame = message.playerId === this.playerId && message.gameId === this.gameId;
    this.isConnectionLost = false;
    this.ownDeath = null;
    this.playerId = message.playerId;
    this.gameId = message.gameId;
    this.rules = { ...message.rules };
    const invite = INVITE_NOTICES[message.inviteMiss];
    this.inviteNotice = invite === null ? null : { kind: invite, at: receivedAt };
    if (isFirst) {
      return 'first';
    }
    if (isSame) {
      this.welcomeNotice = { kind: 'returned', at: receivedAt };
      return 'returned';
    }
    this.welcomeNotice = { kind: 'late', at: receivedAt };
    this.state = null;
    this.phaseBefore = null;
    this.match = null;
    this.self = null;
    this.roster = [];
    this.names.clear();
    this.forgetMatch();
    return 'lost';
  }

  onState(message: FfaStateMessage, receivedAt: number): void {
    const isFightStart =
      this.state?.phase === FfaPhase.Countdown &&
      message.phase === FfaPhase.Fight &&
      this.match?.index === message.matchIndex;
    if (isFightStart) {
      this.fightStartedAt = receivedAt;
    }
    if (this.state !== null && this.state.phase !== message.phase) {
      this.phaseBefore = this.state.phase;
    }
    this.state = message;
    this.stateAt = receivedAt;
  }

  // Ушедший из состава остаётся в кэше имён: его ник ещё нужен ленте и карточке «тебя подбил».
  onRoster(message: FfaRosterMessage): void {
    this.roster = message.players;
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
  acceptSnapshot(message: FfaSnapshotMessage, receivedAt: number): boolean {
    if (this.match === null) {
      return false;
    }
    if (this.lastSnapshotTick !== null && message.tick < this.lastSnapshotTick) {
      return false;
    }
    const isNewSpectator = message.self.state === 'spectator' && this.self?.state !== 'spectator';
    if (isNewSpectator) {
      this.spectatorSince = receivedAt;
    }
    this.lastSnapshotTick = message.tick;
    this.tick = message.tick;
    this.self = message.self;
    this.noteFinalBots(message);
    for (const event of message.events) {
      if (event.kind === 'suddenDeath') {
        this.suddenDeathNoticeAt = receivedAt;
      }
      if (event.kind === 'death') {
        this.noteDeath(event, receivedAt);
      }
    }
    return true;
  }

  onError(code: ErrorCode): void {
    this.fatal = FATAL_BY_CODE[code];
  }

  onDisconnect(): void {
    this.isConnectionLost = true;
    this.welcomeNotice = null;
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
    return this.match !== null && this.matchTimeS >= this.match.suddenDeathAt - FINAL_EPSILON;
  }

  // Секунд до конца матча по тику снимка, с округлением вверх.
  get timeLeftS(): number | null {
    if (this.match === null) {
      return null;
    }
    const ticksLeft = Math.round(this.match.durationSeconds * TICK_RATE) - this.tick;
    return Math.max(0, Math.ceil(ticksLeft / TICK_RATE));
  }

  private get matchTimeS(): number {
    return this.tick / TICK_RATE;
  }

  // Секунд до конца фазы по местным часам с момента прихода состояния; null — отсчёта нет.
  phaseLeftS(now: number): number | null {
    const ticksLeft = this.state?.ticksLeft ?? null;
    if (ticksLeft === null) {
      return null;
    }
    return Math.max(0, ticksLeft / TICK_RATE - (now - this.stateAt) / MS_PER_S);
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

  // Цель зрителя держится, пока её танк жив. Первая — убийца на поле, иначе лидер среди живых; цель погибла или
  // ушла — следующий живой по таблице после неё; живых нет — никого.
  followSpectator(aliveIds: readonly number[]): number | null {
    const current = this.spectatorId;
    if (current !== null && aliveIds.includes(current)) {
      return current;
    }
    this.spectatorId = current === null ? this.firstSpectatorTarget(aliveIds) : this.targetAfter(current, aliveIds);
    return this.spectatorId;
  }

  // Касание или клик по полю: следующий живой по таблице.
  nextSpectator(aliveIds: readonly number[]): number | null {
    const order = this.tableOrder(aliveIds);
    const index = this.spectatorId === null ? -1 : order.indexOf(this.spectatorId);
    this.spectatorId = order[(index + 1) % order.length] ?? null;
    return this.spectatorId;
  }

  hud(now: number, layout: FfaHudLayout): FfaHudModel {
    const screen = this.screen();
    const isInFight = screen === 'fight' || screen === 'dead' || screen === 'spectator';
    const countdown = this.countdown(now, screen);
    const death = this.deathCard(now, screen);
    return {
      screen,
      lobby: screen === 'lobby' ? this.lobby(now) : null,
      countdown,
      // «В БОЙ!» стоит в верхней полосе на месте таймера: табло появляется после него.
      scoreboard: isInFight && countdown === null ? this.scoreboard() : null,
      feed: isInFight ? this.feed(now, layout.feedRows) : [],
      death,
      // Карточка и плашка зрителя делят низ экрана: плашка — после карточки.
      spectator: screen === 'spectator' && death === null ? this.spectatorModel() : null,
      final: screen === 'fight' ? this.final(now) : null,
      idleInS: screen === 'fight' ? this.idleInS() : null,
      results: screen === 'results' ? this.results(now, layout.resultsTop) : null,
      connection: this.fatal === null ? this.connection(now) : null,
      invite: this.fatal === null ? this.invite(now) : null,
    };
  }

  private lobby(now: number): FfaLobbyModel {
    const startInS = this.phaseLeftS(now);
    const mine = this.roster.filter((player) => player.id === this.playerId);
    const others = this.roster.filter((player) => player.id !== this.playerId);
    return {
      players: this.players,
      capacity: this.capacity,
      minimum: this.minimum,
      startInS,
      isFull: this.state?.ticksLeft === 0,
      roster: [...mine, ...others].map((player) => ({
        id: player.id,
        name: player.nickname,
        isBot: player.isBot,
        isMe: player.id === this.playerId,
      })),
    };
  }

  // Своё событие гибели в этом соединении даёт вид смерти; вернулся подбитым без него — убийца из своего
  // состояния. Выбыл (решает сервер) — «ты выбыл» без отсчёта; подбитый в финале без этого признака — обычная
  // карточка: за него выбыл бот. Ни разу не погибал — карточки нет.
  private death(): FfaDeathModel | null {
    const self = this.self;
    if (self === null || !this.hasDied()) {
      return null;
    }
    if (self.state === 'wreck' && self.isOut) {
      return { kind: 'out' };
    }
    const waitTicks = self.state === 'wreck' ? self.ticksLeft + FFA_RESPAWN_WAIT_TICKS : self.ticksLeft;
    const respawnInS = secondsUp(waitTicks);
    const cause = this.ownDeath === null ? null : deathCause(this.ownDeath);
    if (cause === 'self' || cause === 'zone') {
      return { kind: cause, respawnInS };
    }
    const killerId = self.killerId;
    return {
      kind: 'killed',
      killerName: killerId === null ? null : this.nameOf(killerId),
      isKillerBot: killerId !== null && this.isBot(killerId),
      isRicochet: cause === 'ricochet',
      respawnInS,
    };
  }

  private results(now: number, topCount: number): FfaResultsModel {
    const standings = ffaStandings(this.scoreRows);
    const ownIndex = standings.findIndex((row) => row.id === this.playerId);
    const place = ownIndex === -1 ? null : ownIndex + 1;
    const shown = new Set(standings.slice(0, topCount).map((_, index) => index));
    if (ownIndex >= topCount) {
      for (const index of [ownIndex - 1, ownIndex, ownIndex + 1]) {
        if (index < standings.length) {
          shown.add(index);
        }
      }
    }
    const rows: FfaResultRow[] = [];
    let previous = -1;
    for (const [index, row] of standings.entries()) {
      if (!shown.has(index)) {
        continue;
      }
      rows.push({
        place: index + 1,
        name: this.nameOf(row.id),
        isBot: this.isBot(row.id),
        isMe: row.id === this.playerId,
        kills: row.kills,
        deaths: row.deaths,
        efficiency: ffaEfficiency(row),
        isAfterGap: index > previous + 1,
      });
      previous = index;
    }
    const startInS = this.phaseLeftS(now);
    const hasEnoughPlayers = this.players >= this.minimum;
    return {
      title: resultsTitle(place, standings.length),
      place,
      total: standings.length,
      rows,
      nextMatchInS: hasEnoughPlayers && startInS !== null ? Math.ceil(startInS) : null,
    };
  }

  private countdown(now: number, screen: FfaScreen): FfaCountdownModel | null {
    const isLanding = this.self?.state === 'waiting';
    if (screen === 'countdown') {
      const secondsLeft = Math.ceil(this.phaseLeftS(now) ?? 0);
      return { value: secondsLeft >= 1 ? secondsLeft : null, isLanding };
    }
    const isGoShown = this.fightStartedAt !== null && now - this.fightStartedAt < GO_HOLD_MS;
    if (screen === 'fight' && isGoShown) {
      return { value: null, isLanding: false };
    }
    return null;
  }

  // Пока никто никого не подбил, лидера нет: первое место по номеру ничего не значит.
  private scoreboard(): FfaScoreboardModel {
    const leaderRow = ffaStandings(this.scoreRows)[0];
    const hasLeader = leaderRow !== undefined && leaderRow.kills > 0;
    return {
      timeLeftS: this.timeLeftS ?? 0,
      isFinal: this.isFinal,
      score: this.score(),
      leader: hasLeader
        ? { name: this.nameOf(leaderRow.id), kills: leaderRow.kills, isMe: leaderRow.id === this.playerId }
        : null,
    };
  }

  private feed(now: number, limit: number): FfaFeedRow[] {
    const rows: FfaFeedRow[] = [];
    for (let index = this.feedEntries.length - 1; index >= 0 && rows.length < limit; index--) {
      const entry = this.feedEntries[index];
      if (entry === undefined || now - entry.at >= FEED_LIFETIME_MS) {
        break;
      }
      rows.push({
        key: entry.key,
        killer: entry.killerId === null ? UNKNOWN_NAME : this.nameOf(entry.killerId),
        victim: entry.victimId === null ? UNKNOWN_NAME : this.nameOf(entry.victimId),
        cause: entry.cause,
        isMyKill: entry.killerId !== null && entry.killerId === this.playerId && entry.victimId !== this.playerId,
        isMyDeath: entry.victimId !== null && entry.victimId === this.playerId,
        ageMs: Math.max(0, now - entry.at),
      });
    }
    return rows;
  }

  private deathCard(now: number, screen: FfaScreen): FfaDeathModel | null {
    if (screen === 'dead') {
      return this.death();
    }
    const isIntroShown = this.spectatorSince !== null && now - this.spectatorSince < SPECTATOR_CARD_MS;
    if (screen !== 'spectator' || !isIntroShown) {
      return null;
    }
    return this.hasDied() ? { kind: 'out' } : { kind: 'late' };
  }

  private spectatorModel(): FfaSpectatorModel | null {
    const id = this.spectatorId;
    if (id === null) {
      return null;
    }
    return { name: this.nameOf(id), isBot: this.isBot(id) };
  }

  private final(now: number): FfaFinalModel | null {
    const match = this.match;
    if (match === null) {
      return null;
    }
    const isNoticeShown = this.suddenDeathNoticeAt !== null && now - this.suddenDeathNoticeAt < FINAL_NOTICE_MS;
    const hasBots = this.hasBotsInMatch();
    if (isNoticeShown) {
      return { kind: 'started', hasBots };
    }
    const untilFinalS = match.suddenDeathAt - this.matchTimeS;
    if (this.isFinal || untilFinalS > FINAL_WARNING_S) {
      return null;
    }
    return { kind: 'soon', secondsLeft: Math.max(1, Math.ceil(untilFinalS - FINAL_EPSILON)), hasBots };
  }

  private idleInS(): number | null {
    const idleTicksLeft = this.self?.idleTicksLeft ?? null;
    return idleTicksLeft === null ? null : Math.ceil(idleTicksLeft / TICK_RATE);
  }

  private connection(now: number): FfaConnectionNotice | null {
    if (this.isConnectionLost) {
      return 'lost';
    }
    const notice = this.welcomeNotice;
    if (notice === null || now - notice.at >= CONNECTION_NOTICE_MS) {
      return null;
    }
    return notice.kind;
  }

  private invite(now: number): FfaInviteNotice | null {
    const notice = this.inviteNotice;
    if (notice === null || now - notice.at >= INVITE_NOTICE_MS) {
      return null;
    }
    return notice.kind;
  }

  private hasDied(): boolean {
    const ownRow = this.scoreRows.find((row) => row.id === this.playerId);
    const hasDeathInScore = ownRow !== undefined && ownRow.deaths > 0;
    const hasKiller = (this.self?.killerId ?? null) !== null;
    return this.ownDeath !== null || hasKiller || hasDeathInScore;
  }

  private firstSpectatorTarget(aliveIds: readonly number[]): number | null {
    const killerId = this.self?.killerId ?? null;
    if (killerId !== null && aliveIds.includes(killerId)) {
      return killerId;
    }
    return this.tableOrder(aliveIds)[0] ?? null;
  }

  private targetAfter(lostId: number, aliveIds: readonly number[]): number | null {
    const standings = ffaStandings(this.scoreRows).map((row) => row.id);
    const lostIndex = standings.indexOf(lostId);
    if (lostIndex === -1) {
      return this.tableOrder(aliveIds)[0] ?? null;
    }
    const after = [...standings.slice(lostIndex + 1), ...standings.slice(0, lostIndex)];
    return after.find((id) => aliveIds.includes(id)) ?? this.tableOrder(aliveIds)[0] ?? null;
  }

  // Живые по порядку общей таблицы; живые без строки счёта — в конце по номеру.
  private tableOrder(aliveIds: readonly number[]): number[] {
    const ranked = ffaStandings(this.scoreRows)
      .map((row) => row.id)
      .filter((id) => aliveIds.includes(id));
    const unranked = aliveIds.filter((id) => !ranked.includes(id)).sort((a, b) => a - b);
    return [...ranked, ...unranked];
  }

  // В финале подбитый бот всегда выбывает: выбывшие — боты без живого танка на первом снимке финала и погибшие
  // после.
  private noteFinalBots(message: FfaSnapshotMessage): void {
    if (!this.isFinal) {
      return;
    }
    if (this.outBotIds === null) {
      const aliveIds = new Set(message.tanks.filter((tank) => tank.isAlive).map((tank) => tank.id));
      this.outBotIds = new Set(
        this.roster.filter((player) => player.isBot && !aliveIds.has(player.id)).map((player) => player.id),
      );
    }
    for (const event of message.events) {
      if (event.kind === 'death' && event.tank !== null && this.isBot(event.tank)) {
        this.outBotIds.add(event.tank);
      }
    }
  }

  private hasBotsInMatch(): boolean {
    return this.roster.some((player) => player.isBot && this.outBotIds?.has(player.id) !== true);
  }

  private noteDeath(event: FfaSnapshotEvent, receivedAt: number): void {
    this.feedEntries.push({
      key: this.nextFeedKey++,
      killerId: event.by,
      victimId: event.tank,
      cause: deathCause(event),
      at: receivedAt,
    });
    if (event.tank === this.playerId) {
      this.ownDeath = event;
    }
  }

  // Отсчёт матча, о котором ещё нет FfaMatchStart: держится экран прошлой фазы.
  private countdownScreen(matchIndex: number): FfaScreen {
    if (this.match?.index === matchIndex) {
      return 'countdown';
    }
    switch (this.phaseBefore) {
      case FfaPhase.Results:
        return 'results';
      case null:
        return 'connecting';
      default:
        return 'lobby';
    }
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

  private forgetMatch(): void {
    this.scoreRows = [];
    this.feedEntries = [];
    this.lastSnapshotTick = null;
    this.ownDeath = null;
    this.outBotIds = null;
    this.fightStartedAt = null;
    this.suddenDeathNoticeAt = null;
    this.spectatorSince = null;
    this.spectatorId = null;
  }
}

// Заголовок итогов — первое подходящее правило; не играл в матче — следующий его.
function resultsTitle(place: number | null, total: number): FfaResultsTitle {
  if (place === null) {
    return 'notPlayed';
  }
  if (place === 1) {
    return 'champion';
  }
  if (place === total) {
    return 'nextTime';
  }
  if (place <= PODIUM_LAST_PLACE && total >= PODIUM_MIN_PLAYERS) {
    return 'podium';
  }
  return place <= total / 2 ? 'solid' : 'nextTime';
}
