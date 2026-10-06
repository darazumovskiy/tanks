import {
  DEFAULT_STATS,
  STAT_KEYS,
  STAT_MAX,
  STAT_POINTS,
  TANK_RADIUS,
  TICK_RATE,
  checkStats,
  deriveStats,
  mapByIndex,
  normalizeAngle,
  type MapDef,
  type Side,
  type Stats,
} from '@tanks/shared/engine';
import type { BotLevel } from '@tanks/shared/protocol';
import { EVENT_KIND } from '../bullets.js';
import type { GameSummary, RoundSummary } from '../game.js';
import { isClear, leadPoint, wallClearance } from '../geometry.js';
import type { LoggedGame } from '../index.js';
import {
  FIGHT_PHASE,
  parseKeyValues,
  type ClientLine,
  type LogAction,
  type ParsedRound,
  type Tick,
} from '../logParser.js';
import {
  AXIS_BUCKETS,
  AXIS_TOUCH,
  axisBucket,
  CIRCLE_BEARING_PER_TICK,
  CIRCLE_RADIAL_PER_TICK,
  FULL_THROTTLE,
  KITE_SPEED,
  type AxisBucket,
} from '../movement.js';
import { toDegrees } from '../numbers.js';
import {
  AIM_DONE_RAD,
  AIM_LOST_RAD,
  distanceBucketOf,
  LEAD_SPAN_MIN_RAD,
  MIN_DISTANCE,
  MOVING_SPEED,
} from '../shots.js';
import { hasCoverWithin } from './cover.js';
import { upperMedian } from './stats.js';
import { counterfactualHit, fitBulletSpeed, replayRound, shotAngle, type ReplayOutcome } from './replay.js';

// Правило выборки профиля: отсекаются раунды, где игрок не играл, и раунды против старой лестницы ботов.
// Правила — по порядку, побеждает первое; победа над ботом уровня 3 и выше входит всегда.
const MIN_BOT_LEVEL = 3;
const MIN_FIGHT_TICKS = 5 * TICK_RATE;
const MIN_CONTROL_SHARE = 0.3;

export const EXCLUSION_REASONS = ['autoaim', 'weakBot', 'oldLadder', 'short', 'noShot', 'idle', 'silence'] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

// Период настроек — список игр по порядку их старта.
export interface ProfilePeriod {
  name: string;
  games: readonly string[];
}

// Выборка профиля: ник игрока, периоды настроек (null — все игры ника одним куском, по порядку файлов), игры
// против старой лестницы ботов и скорость снаряда ботов по уровню — запасная, когда по журналу она не
// восстанавливается.
export interface ProfileSelection {
  nick: string;
  periods: readonly ProfilePeriod[] | null;
  oldLadderGames: readonly string[];
  botBulletSpeeds: Readonly<Record<BotLevel, number>>;
}

// Билд, который не выводится из журнала однозначно или не собирается по правилам, в условия раунда не входит.
export type BuildIssue = 'incomplete' | 'invalid';

// Эпизод видимости начинается после 0,5 с без неё; выстрел ищется, пока видимость не пропала дольше 10 тиков.
const SIGHT_GAP_TICKS = 15;
const SIGHT_LOST_TICKS = 10;
// Скорость танка для езды прямо — смещение позы за 3 тика до выстрела бота.
const THREAT_VELOCITY_TICKS = 3;
// Реакция и фон — первая смена газа или поворота хотя бы на 0,5 в пределах 2 с; фон — от каждого третьего
// тика видимости.
const COMMAND_CHANGE = 0.5;
const COMMAND_CHANGE_HORIZON = 2 * TICK_RATE;
const BASELINE_STRIDE = 3;
// Первые 1,5 с боя — отдельный контекст огня; удержание предохранителем относится к паузе, если написано
// не раньше чем за 3 тика до её начала.
const EARLY_FIGHT_TICKS = 1.5 * TICK_RATE;
const GUARD_PAUSE_LEAD_TICKS = 3;
// Ход «к противнику» — угол между скоростью и направлением на него меньше 45°, «от него» — больше 135°.
const TOWARD_MAX_RAD = Math.PI / 4;
const AWAY_MIN_RAD = (3 * Math.PI) / 4;
// Сближение сменилось отдалением и наоборот — дистанция за тик пошла в другую сторону больше чем на 2.
const RADIAL_SWITCH_PER_TICK = 2;
// Отрезок хода поперёк линии в одну сторону переживает перерывы в ходе поперёк до 0,5 с; смена стороны
// закрывает его сразу.
const SIDE_RUN_GAP_TICKS = TICK_RATE / 2;
// В подгонку ошибки башни идут тики, где башня смотрит на цель хотя бы с точностью 30°.
const AIM_FIT_MAX_ERR_RAD = Math.PI / 6;
const HIT_MATCH_TICKS = 1;
// Строки клиента о настройках раунда приходят в первые 3 с после старта раунда.
const ROUND_CLIENT_WINDOW_TICKS = 3 * TICK_RATE;
const RECENT_DAMAGE_TICKS = 5 * TICK_RATE;
// Газ на прямой — модуль газа в тиках, где поворот меньше 0,3 и танк едет.
const STRAIGHT_TURN_MAX = 0.3;
const BOT_CLASS_EDGES = [8, 9, 10] as const;
const BOT_CLASSES = ['3–7', '8', '9', '10'] as const;
export type BotClass = (typeof BOT_CLASSES)[number];

const FLAGS_PREFIX = 'flags ';
const SETTINGS_PREFIX = 'settings ';
const GUARD_HOLD = 'guard hold';
const STATS_LINE_PREFIX = 'sec ';
const AUTOAIM_ON = 'autoaim=1';
const GUARD_ON = 'guard=1';
const BUILD_SEPARATOR = '/';
const UNKNOWN_STAT = '?';

export interface ClientSettings {
  pivotThrottle: number | null;
}

export interface RoundBuild {
  text: string;
  issue: BuildIssue | null;
}

export interface ProfileShot {
  gt: number;
  distance: number;
  bucket: string;
  isMoving: boolean;
  errCurDeg: number;
  errLeadDeg: number;
  leadFraction: number | null;
  sizeDeg: number;
  hasSight: boolean;
  sightRunTicks: number;
  outcome: ReplayOutcome | null;
}

export interface ProfileThreat {
  gt: number;
  isThreat: boolean;
  outcome: ReplayOutcome | null;
  distance: number;
  isCut: boolean;
  reactTicks: number | null;
  impactTicks: number | null;
  speed: number;
}

export interface SightEpisode {
  isRoundStart: boolean;
  firstShotTicks: number | null;
  firstAfterReadyTicks: number | null;
  aimedTicks: number | null;
  readyDelayTicks: number;
}

export interface AimRun {
  ticks: number;
  isWithSight: boolean;
}

export interface FirePause {
  startIndex: number;
  ticks: number;
  sightTicks: number;
  readyTicks: number;
  distance: number;
  errorDeg: number;
  isGuarded: boolean;
}

// Тик боя для движения, огня и позиции; первый тик раунда в счёт не идёт — у него нет предыдущей позы.
// courseDeg — угол между скоростью и направлением на противника от 0 до 180°; null — танк стоит.
export interface FightSample {
  gt: number;
  speed: number;
  courseDeg: number | null;
  distance: number;
  hasSight: boolean;
  isFiring: boolean;
  isTurretTurning: boolean;
  wallDistance: number;
}

export interface FireCell {
  hasSight: boolean;
  isReady: boolean;
  bucket: string;
  isEarly: boolean;
  isAfterStart: boolean;
  ticks: number;
  firing: number;
}

// Ход относительно противника: стоит, к нему, поперёк линии на него, от него.
export const MOTION_KINDS = ['still', 'toward', 'side', 'away'] as const;
export type MotionKind = (typeof MOTION_KINDS)[number];

export interface SightSplit {
  sight: number;
  hidden: number;
}

export interface MovementCounts {
  ticks: number;
  sightTicks: number;
  reverse: number;
  idle: number;
  full: number;
  kite: number;
  circle: number;
  flips: number;
  throttle: Record<AxisBucket, number>;
  turn: Record<AxisBucket, number>;
  motion: Record<MotionKind, SightSplit>;
}

// Тик подгонки ошибки башни по ходу цели e ≈ −lag·ω — огонь на виду по движущейся цели: error — ошибка башни
// со знаком, turn — поворот пеленга за тик ω от хода самой цели.
export interface AimSample {
  error: number;
  turn: number;
}

// Признаки выбора режима в начале секунды боя.
export interface ModeFeatures {
  botClass: BotClass;
  lossStreak: number;
  roundIndex: number;
  recentDamageShare: number;
  healthShare: number;
  exchangeShare: number;
  hasCover: boolean;
  fightSeconds: number;
  hasSight: boolean;
  distance: number;
}

export interface SecondSample {
  index: number;
  features: ModeFeatures;
}

export interface RoundDetail {
  shots: ProfileShot[];
  threats: ProfileThreat[];
  episodes: SightEpisode[];
  aims: AimRun[];
  sightErrorsDeg: number[];
  sameSideRuns: number[];
  aimSegments: AimSample[][];
  baselineTicks: (number | null)[];
  samples: FightSample[];
  straightThrottle: number[];
  movement: MovementCounts;
  radialRuns: number[];
  sideRuns: number[];
  startPauseTicks: number;
  fireCells: FireCell[];
  pauses: FirePause[];
  intervals: number[];
  reloadTicks: number;
  seconds: SecondSample[];
  damageDealt: number;
  damageTaken: number;
  enemyHits: number;
  selfHits: number;
  botShots: number;
  botHitsLog: number;
}

// order — место игры в периодах выборки, а без периодов — в порядке загрузки: по нему идёт последняя
// настройка клиента. Предохранитель — по строке `flags` на старте раунда или последней до него; до появления
// этих строк он выключен.
export interface ProfileRound {
  id: string;
  game: string;
  idx: number;
  order: number;
  level: BotLevel;
  botName: string;
  period: string | null;
  mapIndex: number;
  mapName: string;
  wallSlidePercent: number;
  build: RoundBuild;
  hasRicochetGuard: boolean;
  settings: ClientSettings | null;
  rttMs: number[];
  guardHolds: number;
  fightTicks: number;
  shotEvents: number;
  fireShare: number;
  isWon: boolean;
  isFinished: boolean;
  durationS: number;
  exclusion: ExclusionReason | null;
  detail: RoundDetail | null;
}

// missingGames — игры из периодов выборки, которых нет среди журналов ника.
export interface SelectedRounds {
  total: number;
  kept: ProfileRound[];
  excluded: Record<ExclusionReason, string[]>;
  missingGames: string[];
}

interface GameContext {
  game: LoggedGame;
  summary: GameSummary;
  human: Side;
  bot: Side;
  level: BotLevel;
  speeds: [number, number];
  reloadTicks: number;
  maxHp: number;
}

const GUN_LEVELS = Array.from({ length: STAT_MAX + 1 }, (_, gun) => gun);
const SPEED_CANDIDATES = GUN_LEVELS.map((gun) => deriveStats({ armor: 0, engine: 0, gun, reload: 0 }).bulletSpeed);
// Скорость, подобранная меньше чем по 10 совпадениям, ненадёжна — берётся оценка анализатора или запасная.
const SPEED_FIT_MIN_MATCHES = 10;
const DEFAULT_RELOAD_TICKS = Math.ceil(deriveStats(DEFAULT_STATS).reloadTime * TICK_RATE);
const DEFAULT_MAX_HP = deriveStats(DEFAULT_STATS).maxHp;

function emptyAxisCounts(): Record<AxisBucket, number> {
  return Object.fromEntries(AXIS_BUCKETS.map((bucket) => [bucket, 0])) as Record<AxisBucket, number>;
}

function emptyMotionCounts(): Record<MotionKind, SightSplit> {
  return Object.fromEntries(MOTION_KINDS.map((kind) => [kind, { sight: 0, hidden: 0 }])) as Record<
    MotionKind,
    SightSplit
  >;
}

// courseToEnemy — модуль угла между скоростью и направлением на противника.
function motionOf(speed: number, courseToEnemy: number): MotionKind {
  if (speed <= KITE_SPEED) {
    return 'still';
  }
  if (courseToEnemy < TOWARD_MAX_RAD) {
    return 'toward';
  }
  return courseToEnemy > AWAY_MIN_RAD ? 'away' : 'side';
}

// Номер тика боя с первым намерением стрелять: огонь или удержание предохранителем; нет — длина боя.
function firstIntentIndex(
  ticks: readonly Tick[],
  fight: readonly number[],
  human: Side,
  guardGts: readonly number[],
): number {
  const fightStartGt = ticks[fight[0] ?? 0]?.gt ?? 0;
  const firstGuardGt = Math.min(...guardGts.filter((gt) => gt >= fightStartGt), Infinity);
  const found = fight.findIndex((index) => {
    const tick = ticks[index];
    return tick !== undefined && (tick.actions[human].isFiring || tick.gt >= firstGuardGt);
  });
  return found === -1 ? fight.length : found;
}

export function botClassOf(level: BotLevel): BotClass {
  const index = BOT_CLASS_EDGES.findIndex((edge) => level === edge);
  return BOT_CLASSES[index + 1] ?? '3–7';
}

function isControlled(action: LogAction): boolean {
  return (
    Math.abs(action.throttle) > AXIS_TOUCH ||
    Math.abs(action.turn) > AXIS_TOUCH ||
    Math.abs(action.turretTurn) > AXIS_TOUCH ||
    action.isFiring
  );
}

function isCommandChanged(from: LogAction, to: LogAction): boolean {
  return Math.abs(to.throttle - from.throttle) >= COMMAND_CHANGE || Math.abs(to.turn - from.turn) >= COMMAND_CHANGE;
}

function lastLineBefore(lines: readonly ClientLine[], prefix: string, gt: number): string | null {
  let found: string | null = null;
  for (const line of lines) {
    if (line.gt <= gt && line.text.startsWith(prefix)) {
      found = line.text.slice(prefix.length);
    }
  }
  return found;
}

function parseSettings(text: string | null): ClientSettings | null {
  if (text === null) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const pivot = (raw as Record<string, unknown>).pivotThrottle;
  return { pivotThrottle: typeof pivot === 'number' ? pivot : null };
}

function buildText(stats: Readonly<Record<keyof Stats, number | null>>): string {
  return STAT_KEYS.map((key) => {
    const value = stats[key];
    return value === null ? UNKNOWN_STAT : String(value);
  }).join(BUILD_SEPARATOR);
}

// Одна невыведенная характеристика — остаток бюджета очков; билд допустим, если собирается по правилам и тратит
// все очки: выбор игрока тратит их все, недобор — ошибка вывода по журналу.
function buildOf(summary: GameSummary): RoundBuild {
  const inferred = summary.human_stats;
  const known: Record<keyof Stats, number | null> = {
    armor: inferred.armor,
    engine: inferred.engine,
    gun: inferred.gun,
    reload: inferred.reload,
  };
  const missing = STAT_KEYS.filter((key) => known[key] === null);
  const [onlyMissing] = missing;
  if (missing.length > 1) {
    return { text: buildText(known), issue: 'incomplete' };
  }
  const spent = STAT_KEYS.reduce((total, key) => total + (known[key] ?? 0), 0);
  const filled = onlyMissing === undefined ? known : { ...known, [onlyMissing]: STAT_POINTS - spent };
  const total = STAT_KEYS.reduce((sum, key) => sum + (filled[key] ?? 0), 0);
  const isValid = checkStats(filled).isOk && total === STAT_POINTS;
  return isValid ? { text: buildText(filled), issue: null } : { text: buildText(known), issue: 'invalid' };
}

function gameContext(game: LoggedGame, level: BotLevel, selection: ProfileSelection): GameContext {
  const summary = game.analysis.summary;
  const human = summary.human_side;
  const bot: Side = human === 0 ? 1 : 0;
  const rounds = game.parsed.rounds;
  const fitHuman = fitBulletSpeed(rounds, human, SPEED_CANDIDATES);
  const fitBot = fitBulletSpeed(rounds, bot, SPEED_CANDIDATES);
  const fallbackHuman = summary.human_stats.bulletSpeed;
  const fallbackBot =
    summary.bot_stats.bulletSpeedRaw === null ? selection.botBulletSpeeds[level] : summary.bot_stats.bulletSpeed;
  const speeds: [number, number] = [0, 0];
  speeds[human] = fitHuman.matches >= SPEED_FIT_MIN_MATCHES && fitHuman.speed !== null ? fitHuman.speed : fallbackHuman;
  speeds[bot] = fitBot.matches >= SPEED_FIT_MIN_MATCHES && fitBot.speed !== null ? fitBot.speed : fallbackBot;
  return {
    game,
    summary,
    human,
    bot,
    level,
    speeds,
    reloadTicks: summary.human_stats.minShotIntervalTicks ?? DEFAULT_RELOAD_TICKS,
    maxHp: summary.human_stats.maxHpObserved ?? DEFAULT_MAX_HP,
  };
}

function exclusionOf(
  level: BotLevel,
  isAutoaim: boolean,
  isOldLadder: boolean,
  isWon: boolean,
  fightTicks: number,
  shots: number,
  controlShare: number,
  silentTicks: number,
): ExclusionReason | null {
  if (isAutoaim) {
    return 'autoaim';
  }
  if (level < MIN_BOT_LEVEL) {
    return 'weakBot';
  }
  if (isOldLadder) {
    return 'oldLadder';
  }
  if (isWon) {
    return null;
  }
  if (fightTicks < MIN_FIGHT_TICKS) {
    return 'short';
  }
  if (shots === 0) {
    return 'noShot';
  }
  if (controlShare < MIN_CONTROL_SHARE) {
    return 'idle';
  }
  if (silentTicks > 0) {
    return 'silence';
  }
  return null;
}

function bearing(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function lossStreaks(rounds: readonly RoundSummary[], bot: Side): Map<number, number> {
  const streaks = new Map<number, number>();
  let streak = 0;
  for (const round of rounds) {
    streaks.set(round.idx, streak);
    streak = round.winner === bot ? streak + 1 : 0;
  }
  return streaks;
}

interface SimHits {
  outcomes: Map<string, ReplayOutcome>;
  damage: [number, number];
  enemyHits: number;
  selfHits: number;
}

function shotKey(gt: number, owner: Side): string {
  return `${String(gt)}:${String(owner)}`;
}

// Попадание симуляции засчитывается, только если в журнале есть попадание по той же стороне в пределах тика.
function matchSimHits(round: ParsedRound, context: GameContext): SimHits {
  const bullets = replayRound(round, context.speeds);
  const logHits = round.events.filter((event) => event.kind === EVENT_KIND.hit);
  const used = new Set<number>();
  const damage: [number, number] = [0, 0];
  const outcomes = new Map<string, ReplayOutcome>();
  let enemyHits = 0;
  let selfHits = 0;
  for (const bullet of bullets) {
    const isHit = bullet.outcome === 'enemy' || bullet.outcome === 'self';
    if (isHit) {
      const victim = bullet.outcome === 'enemy' ? 1 - bullet.owner : bullet.owner;
      const index = logHits.findIndex(
        (event, j) =>
          !used.has(j) && event.side === victim && Math.abs(event.gt - (bullet.endGt ?? 0)) <= HIT_MATCH_TICKS,
      );
      if (index === -1) {
        bullet.outcome = 'unmatched';
      } else {
        used.add(index);
        if (bullet.outcome === 'enemy') {
          damage[bullet.owner] += logHits[index]?.v ?? 0;
        }
      }
    }
    const isHuman = bullet.owner === context.human;
    enemyHits += isHuman && bullet.outcome === 'enemy' ? 1 : 0;
    selfHits += isHuman && bullet.outcome === 'self' ? 1 : 0;
    outcomes.set(shotKey(bullet.shotGt, bullet.owner), bullet.outcome);
  }
  return { outcomes, damage, enemyHits, selfHits };
}

function firstCommandChange(actions: readonly LogAction[], from: number): number | null {
  const start = actions[from];
  if (start === undefined) {
    return null;
  }
  for (let k = 1; k <= COMMAND_CHANGE_HORIZON; k++) {
    const next = actions[from + k];
    if (next === undefined) {
      return null;
    }
    if (isCommandChanged(start, next)) {
      return k;
    }
  }
  return null;
}

function roundDetail(
  round: ParsedRound,
  summaryRound: RoundSummary | undefined,
  context: GameContext,
  guardGts: readonly number[],
  lossStreak: number,
): RoundDetail {
  const { human, bot, speeds, reloadTicks } = context;
  const map = mapByIndex(round.mapIndex);
  const walls = map.walls;
  const ticks = round.ticks;
  const actions = ticks.map((tick) => tick.actions[human]);
  const fight = ticks.flatMap((tick, index) => (tick.phase === FIGHT_PHASE ? [index] : []));
  const indexOfGt = new Map(ticks.map((tick, index) => [tick.gt, index]));
  const sight = new Map<number, boolean>();
  const sightRun = new Map<number, number>();
  let run = 0;
  for (const index of fight) {
    const poses = ticks[index]?.poses;
    const hasSight = poses !== undefined && isClear(walls, poses[human].x, poses[human].y, poses[bot].x, poses[bot].y);
    sight.set(index, hasSight);
    run = hasSight ? run + 1 : 0;
    sightRun.set(index, run);
  }
  const sim = matchSimHits(round, context);
  const humanShots = round.events.filter((event) => event.kind === EVENT_KIND.shot && event.side === human);
  const shotGts = humanShots.map((event) => event.gt);
  const shotGtSet = new Set(shotGts);

  const shots: ProfileShot[] = [];
  for (const event of humanShots) {
    const index = indexOfGt.get(event.gt);
    const tick = index === undefined ? undefined : ticks[index];
    const previous = index === undefined ? undefined : ticks[index - 1];
    if (index === undefined || index === 0 || tick === undefined || previous === undefined) {
      continue;
    }
    const me = tick.poses[human];
    const enemy = tick.poses[bot];
    const velocity = {
      x: (enemy.x - previous.poses[bot].x) * TICK_RATE,
      y: (enemy.y - previous.poses[bot].y) * TICK_RATE,
    };
    const enemySpeed = Math.hypot(velocity.x, velocity.y);
    const distance = Math.hypot(enemy.x - me.x, enemy.y - me.y);
    const toHull = bearing(me, enemy);
    const toLead = bearing(me, leadPoint(me, enemy, velocity, speeds[human]));
    const turret = shotAngle(event, me);
    const span = normalizeAngle(toLead - toHull);
    shots.push({
      gt: event.gt,
      distance,
      bucket: distanceBucketOf(distance),
      isMoving: enemySpeed > MOVING_SPEED,
      errCurDeg: toDegrees(Math.abs(normalizeAngle(turret - toHull))),
      errLeadDeg: toDegrees(Math.abs(normalizeAngle(turret - toLead))),
      leadFraction: Math.abs(span) > LEAD_SPAN_MIN_RAD ? normalizeAngle(turret - toHull) / span : null,
      sizeDeg: toDegrees(Math.atan(TANK_RADIUS / Math.max(distance, MIN_DISTANCE))),
      hasSight: isClear(walls, me.x, me.y, enemy.x, enemy.y),
      sightRunTicks: sightRun.get(index) ?? 0,
      outcome: sim.outcomes.get(shotKey(event.gt, human)) ?? null,
    });
  }
  const shotByGt = new Map(shots.map((shot) => [shot.gt, shot]));
  const intervals = shotGts.slice(1).map((gt, k) => gt - (shotGts[k] ?? gt));

  const aims: AimRun[] = [];
  const sightErrorsDeg: number[] = [];
  const sameSideRuns: number[] = [];
  const aimSegments: AimSample[][] = [];
  let aimSegment: AimSample[] = [];
  let seekingGt: number | null = null;
  let isSeekingWithSight = false;
  let sideRun = 0;
  let side = 0;
  let isSideRunOpen = false;
  for (const index of fight) {
    const tick = ticks[index];
    const previous = ticks[index - 1];
    if (tick === undefined || previous === undefined) {
      continue;
    }
    const me = tick.poses[human];
    const enemy = tick.poses[bot];
    const toHull = bearing(me, enemy);
    const signed = normalizeAngle(me.turret - toHull);
    const error = Math.abs(signed);
    const hasSight = sight.get(index) === true;
    const velocity = {
      x: (enemy.x - previous.poses[bot].x) * TICK_RATE,
      y: (enemy.y - previous.poses[bot].y) * TICK_RATE,
    };
    const isEnemyMoving = Math.hypot(velocity.x, velocity.y) > MOVING_SPEED;
    if (hasSight && isEnemyMoving && tick.actions[human].isFiring && error < AIM_FIT_MAX_ERR_RAD) {
      aimSegment.push({ error: signed, turn: normalizeAngle(toHull - bearing(me, previous.poses[bot])) });
    } else if (aimSegment.length > 0) {
      aimSegments.push(aimSegment);
      aimSegment = [];
    }
    if (hasSight) {
      sightErrorsDeg.push(toDegrees(error));
      const sign = signed >= 0 ? 1 : -1;
      if (sideRun > 0 && sign !== side) {
        if (isSideRunOpen) {
          sameSideRuns.push(sideRun);
        }
        isSideRunOpen = true;
        sideRun = 0;
      }
      side = sign;
      sideRun++;
    } else {
      sideRun = 0;
      isSideRunOpen = false;
    }
    if (error > AIM_LOST_RAD && seekingGt === null) {
      seekingGt = tick.gt;
      isSeekingWithSight = hasSight;
    }
    if (seekingGt !== null && error < AIM_DONE_RAD) {
      aims.push({ ticks: tick.gt - seekingGt, isWithSight: isSeekingWithSight && hasSight });
      seekingGt = null;
    }
  }

  if (aimSegment.length > 0) {
    aimSegments.push(aimSegment);
  }

  const episodes: SightEpisode[] = [];
  let noSightRun = Infinity;
  for (const index of fight) {
    if (sight.get(index) !== true) {
      noSightRun++;
      continue;
    }
    const isRoundStart = noSightRun === Infinity;
    const isEpisodeStart = noSightRun >= SIGHT_GAP_TICKS;
    noSightRun = 0;
    if (!isEpisodeStart) {
      continue;
    }
    const startTick = ticks[index];
    if (startTick === undefined) {
      continue;
    }
    const gt0 = startTick.gt;
    const before = shotGts.filter((gt) => gt < gt0);
    const lastBefore = before[before.length - 1];
    const readyGt = lastBefore === undefined ? gt0 : Math.max(gt0, lastBefore + reloadTicks);
    let gap = 0;
    let first: number | null = null;
    let aimed: number | null = null;
    for (let j = index; ticks[j]?.phase === FIGHT_PHASE; j++) {
      if (sight.get(j) === true) {
        gap = 0;
      } else {
        gap++;
        if (gap > SIGHT_LOST_TICKS) {
          break;
        }
      }
      const gtj = ticks[j]?.gt ?? 0;
      if (!shotGtSet.has(gtj)) {
        continue;
      }
      first ??= gtj;
      const shot = shotByGt.get(gtj);
      if (shot !== undefined && Math.min(shot.errCurDeg, shot.errLeadDeg) < shot.sizeDeg) {
        aimed = gtj;
        break;
      }
    }
    episodes.push({
      isRoundStart,
      firstShotTicks: first === null ? null : first - gt0,
      firstAfterReadyTicks: first === null ? null : first - readyGt,
      aimedTicks: aimed === null ? null : aimed - gt0,
      readyDelayTicks: readyGt - gt0,
    });
  }

  const deathGt = Math.min(
    ...round.events.filter((event) => event.kind === EVENT_KIND.death).map((event) => event.gt),
    Infinity,
  );
  const threats: ProfileThreat[] = [];
  for (const event of round.events) {
    if (event.kind !== EVENT_KIND.shot || event.side !== bot) {
      continue;
    }
    const index = indexOfGt.get(event.gt);
    const tick = index === undefined ? undefined : ticks[index];
    const earlier = index === undefined ? undefined : ticks[index - THREAT_VELOCITY_TICKS];
    if (index === undefined || tick === undefined || earlier === undefined) {
      continue;
    }
    const me = tick.poses[human];
    const velocity = {
      x: (me.x - earlier.poses[human].x) / THREAT_VELOCITY_TICKS,
      y: (me.y - earlier.poses[human].y) / THREAT_VELOCITY_TICKS,
    };
    const impact = counterfactualHit({
      round,
      tickIndex: index,
      shot: event,
      bot,
      human,
      speed: speeds[bot],
      velocity,
    });
    const enemy = tick.poses[bot];
    const base = {
      gt: event.gt,
      outcome: sim.outcomes.get(shotKey(event.gt, bot)) ?? null,
      distance: Math.hypot(enemy.x - me.x, enemy.y - me.y),
      speed: Math.hypot(velocity.x, velocity.y) * TICK_RATE,
    };
    if (impact === null) {
      threats.push({ ...base, isThreat: false, isCut: false, reactTicks: null, impactTicks: null });
      continue;
    }
    threats.push({
      ...base,
      isThreat: true,
      isCut: event.gt + impact > deathGt,
      reactTicks: firstCommandChange(actions, index),
      impactTicks: impact,
    });
  }

  const sightFight = fight.filter((index) => sight.get(index) === true);
  const baselineTicks = sightFight
    .filter((_, k) => k % BASELINE_STRIDE === 0)
    .map((index) => firstCommandChange(actions, index));

  const movement: MovementCounts = {
    ticks: 0,
    sightTicks: 0,
    reverse: 0,
    idle: 0,
    full: 0,
    kite: 0,
    circle: 0,
    flips: 0,
    throttle: emptyAxisCounts(),
    turn: emptyAxisCounts(),
    motion: emptyMotionCounts(),
  };
  const samples: FightSample[] = [];
  const straightThrottle: number[] = [];
  const radialRuns: number[] = [];
  const sideRuns: number[] = [];
  let lateral: { sign: number; ticks: number; gap: number } | null = null;
  let radialSign = 0;
  let radialRun = 0;
  let isRadialRunOpen = false;
  let lastSign = 0;
  let previousDistance: number | null = null;
  let previousBearing = 0;
  for (const index of fight) {
    const tick = ticks[index];
    const previous = ticks[index - 1];
    if (index === 0 || tick === undefined || previous === undefined) {
      continue;
    }
    const action = tick.actions[human];
    const me = tick.poses[human];
    const enemy = tick.poses[bot];
    const vx = (me.x - previous.poses[human].x) * TICK_RATE;
    const vy = (me.y - previous.poses[human].y) * TICK_RATE;
    const speed = Math.hypot(vx, vy);
    movement.ticks++;
    movement.reverse += action.throttle < -AXIS_TOUCH ? 1 : 0;
    movement.idle += action.throttle === 0 && action.turn === 0 ? 1 : 0;
    movement.full += Math.abs(action.throttle) > FULL_THROTTLE ? 1 : 0;
    movement.throttle[axisBucket(action.throttle)]++;
    movement.turn[axisBucket(action.turn)]++;
    if (Math.abs(action.turn) < STRAIGHT_TURN_MAX && Math.abs(action.throttle) > AXIS_TOUCH) {
      straightThrottle.push(Math.abs(action.throttle));
    }
    let sign = 0;
    if (action.throttle > AXIS_TOUCH) {
      sign = 1;
    } else if (action.throttle < -AXIS_TOUCH) {
      sign = -1;
    }
    if (sign !== 0 && lastSign !== 0 && sign !== lastSign) {
      movement.flips++;
    }
    if (sign !== 0) {
      lastSign = sign;
    }
    const distance = Math.hypot(enemy.x - me.x, enemy.y - me.y);
    const toEnemy = bearing(me, enemy);
    const hasSight = sight.get(index) === true;
    movement.sightTicks += hasSight ? 1 : 0;
    const course = Math.atan2(vy, vx);
    if (speed > KITE_SPEED) {
      const isTurretBack = Math.abs(normalizeAngle(me.turret - course)) > Math.PI / 2;
      const isEnemyBack = Math.abs(normalizeAngle(toEnemy - course)) > Math.PI / 2;
      movement.kite += isTurretBack && isEnemyBack ? 1 : 0;
      const isCircling =
        previousDistance !== null &&
        Math.abs(distance - previousDistance) < CIRCLE_RADIAL_PER_TICK &&
        Math.abs(normalizeAngle(toEnemy - previousBearing)) > CIRCLE_BEARING_PER_TICK;
      movement.circle += isCircling ? 1 : 0;
    }
    const courseToEnemy = normalizeAngle(course - toEnemy);
    const kind = motionOf(speed, Math.abs(courseToEnemy));
    movement.motion[kind][hasSight ? 'sight' : 'hidden']++;
    const sideSign = kind === 'side' ? Math.sign(courseToEnemy) : 0;
    if (lateral !== null && (lateral.gap > SIDE_RUN_GAP_TICKS || (sideSign !== 0 && sideSign !== lateral.sign))) {
      sideRuns.push(lateral.ticks);
      lateral = null;
    }
    if (sideSign !== 0) {
      lateral ??= { sign: sideSign, ticks: 0, gap: 0 };
      lateral.ticks++;
      lateral.gap = 0;
    } else if (lateral !== null) {
      lateral.gap++;
    }
    // Отрезок сближения или отдаления: знак меняется, только когда дистанция пошла в другую сторону быстрее
    // порога. Первый отрезок раунда начат до счёта, последний оборван концом — оба не в счёт.
    const radial = previousDistance === null ? 0 : distance - previousDistance;
    const nextRadialSign = Math.abs(radial) > RADIAL_SWITCH_PER_TICK ? Math.sign(radial) : radialSign;
    if (nextRadialSign !== radialSign) {
      if (isRadialRunOpen) {
        radialRuns.push(radialRun);
      }
      isRadialRunOpen = radialSign !== 0;
      radialSign = nextRadialSign;
      radialRun = 0;
    }
    radialRun++;
    previousDistance = distance;
    previousBearing = toEnemy;
    samples.push({
      gt: tick.gt,
      speed,
      courseDeg: speed > KITE_SPEED ? toDegrees(Math.abs(courseToEnemy)) : null,
      distance,
      hasSight,
      isFiring: action.isFiring,
      isTurretTurning: Math.abs(action.turretTurn) > AXIS_TOUCH,
      wallDistance: wallClearance(walls, me.x, me.y),
    });
  }
  if (lateral !== null) {
    sideRuns.push(lateral.ticks);
  }

  const intentIndex = firstIntentIndex(ticks, fight, human, guardGts);
  const cells = new Map<string, FireCell>();
  const pauses: FirePause[] = [];
  let lastShot: number | null = null;
  let pause: (FirePause & { startGt: number; distances: number[]; errors: number[] }) | null = null;
  const closePause = (): void => {
    if (pause === null) {
      return;
    }
    if (pause.ticks === 0) {
      pause = null;
      return;
    }
    const startGt = pause.startGt;
    const isGuarded = guardGts.some(
      (gt) => startGt - GUARD_PAUSE_LEAD_TICKS <= gt && gt <= startGt + (pause?.ticks ?? 0),
    );
    pauses.push({
      startIndex: pause.startIndex,
      ticks: pause.ticks,
      sightTicks: pause.sightTicks,
      readyTicks: pause.readyTicks,
      distance: upperMedian(pause.distances),
      errorDeg: upperMedian(pause.errors),
      isGuarded,
    });
    pause = null;
  };
  fight.forEach((index, n) => {
    const tick = ticks[index];
    if (tick === undefined) {
      return;
    }
    const me = tick.poses[human];
    const enemy = tick.poses[bot];
    const isFiring = tick.actions[human].isFiring;
    const isReady = lastShot === null || tick.gt - lastShot >= reloadTicks;
    const distance = Math.hypot(enemy.x - me.x, enemy.y - me.y);
    const hasSight = sight.get(index) === true;
    const isEarly = n < EARLY_FIGHT_TICKS;
    const isAfterStart = n >= intentIndex;
    const bucket = distanceBucketOf(distance);
    const key = `${String(hasSight)}|${String(isReady)}|${bucket}|${String(isEarly)}|${String(isAfterStart)}`;
    const cell = cells.get(key) ?? { hasSight, isReady, bucket, isEarly, isAfterStart, ticks: 0, firing: 0 };
    cell.ticks++;
    cell.firing += isFiring ? 1 : 0;
    cells.set(key, cell);
    if (isFiring) {
      closePause();
    } else {
      pause ??= {
        startIndex: n,
        startGt: tick.gt,
        ticks: 0,
        sightTicks: 0,
        readyTicks: 0,
        distance: 0,
        errorDeg: 0,
        isGuarded: false,
        distances: [],
        errors: [],
      };
      // Стартовая пауза кончается на первом намерении стрелять; отрезок от него до огня — не пауза.
      const isStartPauseOver = pause.startIndex === 0 && isAfterStart;
      if (!isStartPauseOver) {
        pause.ticks++;
        pause.sightTicks += hasSight ? 1 : 0;
        pause.readyTicks += isReady ? 1 : 0;
        pause.distances.push(distance);
        pause.errors.push(toDegrees(Math.abs(normalizeAngle(me.turret - bearing(me, enemy)))));
      }
    }
    if (shotGtSet.has(tick.gt)) {
      lastShot = tick.gt;
    }
  });
  closePause();

  const seconds = secondSamples(round, context, samples, lossStreak, map);
  return {
    shots,
    threats,
    episodes,
    aims,
    sightErrorsDeg,
    sameSideRuns,
    aimSegments,
    baselineTicks,
    samples,
    straightThrottle,
    movement,
    radialRuns,
    sideRuns,
    startPauseTicks: Math.min(intentIndex, fight.length),
    fireCells: [...cells.values()],
    pauses,
    intervals,
    reloadTicks,
    seconds,
    damageDealt: sim.damage[human],
    damageTaken: sim.damage[bot],
    enemyHits: sim.enemyHits,
    selfHits: sim.selfHits,
    botShots: round.events.filter((event) => event.kind === EVENT_KIND.shot && event.side === bot).length,
    botHitsLog: summaryRound?.bot_hits ?? 0,
  };
}

// Признаки в начале каждой полной секунды боя: последняя неполная секунда раунда в обучение не идёт.
function secondSamples(
  round: ParsedRound,
  context: GameContext,
  samples: readonly FightSample[],
  lossStreak: number,
  map: MapDef,
): SecondSample[] {
  const { human, bot, maxHp } = context;
  const hits = round.events.filter((event) => event.kind === EVENT_KIND.hit);
  const pickups = round.events.filter((event) => event.kind === EVENT_KIND.pickup && event.side === human);
  const tickByGt = new Map(round.ticks.map((tick) => [tick.gt, tick]));
  const result: SecondSample[] = [];
  for (let index = 0; index < samples.length - TICK_RATE; index += TICK_RATE) {
    const sample = samples[index];
    const tick = sample === undefined ? undefined : tickByGt.get(sample.gt);
    if (sample === undefined || tick === undefined) {
      continue;
    }
    const gt = sample.gt;
    const taken = sumDamage(hits, human, (hitGt) => hitGt < gt);
    const recent = sumDamage(hits, human, (hitGt) => gt - RECENT_DAMAGE_TICKS <= hitGt && hitGt < gt);
    const dealt = sumDamage(hits, bot, (hitGt) => hitGt < gt);
    const healed = pickups.filter((event) => event.gt < gt).reduce((total, event) => total + event.v, 0);
    result.push({
      index,
      features: {
        botClass: botClassOf(context.level),
        lossStreak,
        roundIndex: round.idx,
        recentDamageShare: recent / maxHp,
        healthShare: Math.min(1, Math.max(0, (maxHp - taken + healed) / maxHp)),
        exchangeShare: (dealt - taken) / maxHp,
        hasCover: hasCoverWithin(map, tick.poses[human], tick.poses[bot]),
        fightSeconds: index / TICK_RATE,
        hasSight: sample.hasSight,
        distance: sample.distance,
      },
    });
  }
  return result;
}

function sumDamage(
  hits: readonly { gt: number; side: Side | null; v: number }[],
  victim: Side,
  isInWindow: (gt: number) => boolean,
): number {
  return hits.filter((hit) => hit.side === victim && isInWindow(hit.gt)).reduce((total, hit) => total + hit.v, 0);
}

function clientLinesOfRound(lines: readonly ClientLine[], fromGt: number, toGt: number): ClientLine[] {
  return lines.filter((line) => fromGt <= line.gt && line.gt < toGt);
}

// Задержка 0 — клиент ещё не измерил её: в первую секунду после входа.
function rttOf(lines: readonly ClientLine[]): number[] {
  return lines.flatMap((line) => {
    if (!line.text.startsWith(STATS_LINE_PREFIX)) {
      return [];
    }
    const rtt = Number(parseKeyValues(line.text).get('rtt'));
    return rtt > 0 ? [rtt] : [];
  });
}

function emptyExclusions(): Record<ExclusionReason, string[]> {
  return { autoaim: [], weakBot: [], oldLadder: [], short: [], noShot: [], idle: [], silence: [] };
}

interface GamePlace {
  period: string | null;
  order: number;
}

function placesOf(periods: readonly ProfilePeriod[]): Map<string, GamePlace> {
  const places = new Map<string, GamePlace>();
  for (const period of periods) {
    for (const game of period.games) {
      places.set(game, { period: period.name, order: places.size });
    }
  }
  return places;
}

// Раунды игрока по правилу выборки; с периодами — только игры из их списков. Разбор тиков — только у вошедших
// в выборку.
export function selectProfileRounds(games: readonly LoggedGame[], selection: ProfileSelection): SelectedRounds {
  const result: SelectedRounds = { total: 0, kept: [], excluded: emptyExclusions(), missingGames: [] };
  const places = selection.periods === null ? null : placesOf(selection.periods);
  const oldLadder = new Set(selection.oldLadderGames);
  const seen = new Set<string>();
  games.forEach((game, gameIndex) => {
    const summary = game.analysis.summary;
    const level = summary.level;
    const place = places === null ? { period: null, order: gameIndex } : places.get(game.parsed.id);
    if (summary.human_name !== selection.nick || level === null || place === undefined) {
      return;
    }
    seen.add(game.parsed.id);
    const human = summary.human_side;
    const bot: Side = human === 0 ? 1 : 0;
    const lines = game.parsed.clientLines[human];
    const rounds = game.parsed.rounds;
    const streaks = lossStreaks(summary.rounds, bot);
    let context: GameContext | null = null;
    rounds.forEach((round, k) => {
      result.total++;
      const nextStart = rounds[k + 1]?.startGt ?? Infinity;
      const roundLines = clientLinesOfRound(lines, round.startGt, nextStart);
      const clientWindow = round.startGt + ROUND_CLIENT_WINDOW_TICKS;
      const flags = lastLineBefore(lines, FLAGS_PREFIX, clientWindow);
      const summaryRound = summary.rounds.find((candidate) => candidate.idx === round.idx);
      const fight = round.ticks.filter((tick) => tick.phase === FIGHT_PHASE);
      const humanActions = fight.map((tick) => tick.actions[human]);
      const shotEvents = round.events.filter((event) => event.kind === EVENT_KIND.shot && event.side === human);
      const fightTicks = fight.length;
      const isWon = summaryRound?.human_won === true;
      const exclusion = exclusionOf(
        level,
        flags?.includes(AUTOAIM_ON) === true,
        oldLadder.has(game.parsed.id),
        isWon,
        fightTicks,
        shotEvents.length,
        fightTicks === 0 ? 0 : humanActions.filter(isControlled).length / fightTicks,
        fight.filter((tick) => tick.isSilent[human]).length,
      );
      const id = `${game.parsed.id}#${String(round.idx)}`;
      const profileRound: ProfileRound = {
        id,
        game: game.parsed.id,
        idx: round.idx,
        order: place.order,
        level,
        botName: summary.bot_name,
        period: place.period,
        mapIndex: round.mapIndex,
        mapName: mapByIndex(round.mapIndex).name,
        wallSlidePercent: game.parsed.wallSlidePercent,
        build: buildOf(summary),
        hasRicochetGuard: flags?.includes(GUARD_ON) === true,
        settings: parseSettings(lastLineBefore(lines, SETTINGS_PREFIX, clientWindow)),
        rttMs: rttOf(roundLines),
        guardHolds: roundLines.filter((line) => line.text.trim() === GUARD_HOLD).length,
        fightTicks,
        shotEvents: shotEvents.length,
        fireShare: fightTicks === 0 ? 0 : humanActions.filter((action) => action.isFiring).length / fightTicks,
        isWon,
        isFinished: summaryRound?.finished === true,
        durationS: summaryRound?.duration_s ?? 0,
        exclusion,
        detail: null,
      };
      if (exclusion !== null) {
        result.excluded[exclusion].push(id);
        return;
      }
      context ??= gameContext(game, level, selection);
      const guardGts = roundLines.filter((line) => line.text.trim() === GUARD_HOLD).map((line) => line.gt);
      profileRound.detail = roundDetail(round, summaryRound, context, guardGts, streaks.get(round.idx) ?? 0);
      result.kept.push(profileRound);
    });
  });
  result.missingGames = [...(places?.keys() ?? [])].filter((game) => !seen.has(game));
  return result;
}
