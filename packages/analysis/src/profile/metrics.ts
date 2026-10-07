import { TICK_RATE } from '@tanks/shared/engine';
import { AXIS_BUCKETS, TOUCHING_WALL, type AxisBucket } from '../movement.js';
import {
  AIM_GOOD_DEG,
  DISTANCE_BUCKETS,
  FAR_DISTANCE,
  LEAD_FRACTION_MAX,
  LEAD_FRACTION_MIN,
  COURSE_BAND_LABELS,
  courseBandOf,
  MID_DISTANCE_LABEL,
  MOVING_SPEED,
  type CourseBandLabel,
} from '../shots.js';
import { HIDDEN_AIM_TARGETS, type HiddenAimTarget } from './hiddenAim.js';
import { fitSwitchCoefficients, modeSamples, type Coefficients, type ModeSample } from './modeSwitch.js';
import { HOLD_STYLE_SHARE, positionMask, positionSegments, STILL_SPEED, type Segment } from './position.js';
import {
  type BuildIssue,
  type ClientSettings,
  type FightSample,
  type FireCell,
  type FirePause,
  type ProfileRound,
  type ProfileShot,
  type ProfileThreat,
  type AimSample,
  type KitSide,
  type MotionKind,
  type RoundDetail,
  KIT_SIDES,
  MOTION_KINDS,
} from './rounds.js';
import { distribution, share, type Distribution, type Share } from './stats.js';

const TICKS_PER_MINUTE = 60 * TICK_RATE;
const PERCENT = 100;
// Подгонка ошибки башни по ходу цели — не меньше чем по 3 с тиков.
const MIN_AIM_FIT_TICKS = 3 * TICK_RATE;
const BUCKET_LABELS = DISTANCE_BUCKETS.map((bucket) => bucket.label);
// Видимость держалась не меньше секунды до выстрела — прицел «устоялся».
const SETTLED_SIGHT_TICKS = TICK_RATE;
const READY_SLACK_TICKS = 1;
const QUICK_CHANGE_TICKS = TICK_RATE / 2;
const IMPACT_BUCKETS: readonly { label: string; low: number; high: number }[] = [
  { label: '<0,5 с', low: 0, high: TICK_RATE / 2 },
  { label: '0,5–1 с', low: TICK_RATE / 2, high: TICK_RATE },
  { label: '>1 с', low: TICK_RATE, high: Infinity },
];
const PAUSE_BUCKETS: readonly { label: string; low: number; high: number }[] = [
  { label: '<0,5 с', low: 0, high: TICK_RATE / 2 },
  { label: '0,5–1 с', low: TICK_RATE / 2, high: TICK_RATE },
  { label: '1–2 с', low: TICK_RATE, high: 2 * TICK_RATE },
  { label: '2–5 с', low: 2 * TICK_RATE, high: 5 * TICK_RATE },
  { label: '>5 с', low: 5 * TICK_RATE, high: Infinity },
];
const FIGHT_TIME_BUCKETS: readonly { label: string; low: number; high: number }[] = [
  { label: '<3 с', low: 0, high: 3 },
  { label: '3–8 с', low: 3, high: 8 },
  { label: '8–15 с', low: 8, high: 15 },
  { label: '≥15 с', low: 15, high: Infinity },
];
// Отрезок позиции 10–20 % боя — заметная позиция, но не стоячая манера.
const NOTABLE_POSITION_SHARE = 0.1;

// Контекст огня — видимость противника и корзина дистанции.
export const FIRE_CONTEXTS = [
  'visible|<300',
  'visible|300–600',
  'visible|>600',
  'hidden|<300',
  'hidden|300–600',
  'hidden|>600',
] as const;
export type FireContext = (typeof FIRE_CONTEXTS)[number];
export type GuardMode = 'guardOn' | 'guardOff';
// Длинная пауза огня посреди боя — от 2 с; короткие паузы без удержания предохранителем — «отпускания» пальца.
const LONG_PAUSE_TICKS = 2 * TICK_RATE;

export interface ReactionMetrics {
  aimTicks: Distribution | null;
  aimWithSightTicks: Distribution | null;
  sightEpisodes: number;
  firstShotTicks: Distribution | null;
  noShotEpisodes: Share;
  firstAfterReadyTicks: Distribution | null;
  firstAimedTicks: Distribution | null;
  noAimedEpisodes: Share;
  roundStartFirstShotTicks: Distribution | null;
}

export interface AimBucket {
  standingErrDeg: Distribution | null;
  movingErrCurDeg: Distribution | null;
  movingErrLeadDeg: Distribution | null;
  tankSizeDeg: Distribution | null;
  hitAll: Share;
  hitStanding: Share;
  hitMoving: Share;
}

// Подгонка ошибки башни по ходу цели: lagTicks — на сколько тиков башня идёт за пеленгом (с упреждением —
// меньше нуля), residualSameSideTicks — сколько тиков остаток ошибки после подгонки держится по одну сторону:
// память руки без хода цели.
export interface AimFit {
  n: number;
  lagTicks: number | null;
  residualSameSideTicks: Distribution | null;
}

export interface AimMetrics {
  standingErrDeg: Distribution | null;
  byBucket: Record<string, AimBucket>;
  settledMovingErrDeg: Distribution | null;
  movingKinds: { lead: number; current: number; neither: number };
  leadFraction: Distribution | null;
  aimFit: AimFit;
  sightErrorDeg: Distribution | null;
  sightErrorUnder5: Share;
  sameSideTicks: Distribution | null;
  shotDistance: Distribution | null;
  hiddenAim: Record<HiddenAimTarget, HiddenAimShare>;
  preAppear: Share;
}

// Башня без видимости в окне одной цели: доля тиков, доля случайной башни и превышение над ней в пунктах.
export interface HiddenAimShare {
  sole: Share;
  chancePct: number | null;
  excessPct: number | null;
}

// Ход к аптечке по тому, кому она ближе; поездки к аптечке в минуту езды без поездки, пока аптечка на поле, — по
// той же стороне; поездки, доведённые до подбора аптечки, из доведённых и брошенных; подобранные из появившихся,
// мои из подобранных, лечение в минуту боя.
export interface KitMetrics {
  toward: Record<KitSide, Share>;
  startsPerMinute: Record<KitSide, number | null>;
  followed: Share;
  picked: Share;
  mine: Share;
  healPerMinute: number | null;
}

export interface PauseBucket {
  count: Share;
  time: Share;
  sight: Share;
  ready: Share;
  distance: Distribution | null;
  errorDeg: Distribution | null;
  guarded: Share;
}

export interface FireMetrics {
  shots: number;
  shotsPerMinute: number | null;
  readyShots: Share;
  intervalExcessTicks: Distribution | null;
  noSightShots: Share;
  noSightHits: Share;
  noSightDirectHits: Share;
  selfHits: Share;
  returningShotsGuardOff: Share;
  hits: Share;
  guardHoldsPerMinute: number | null;
  held: Share;
  heldLate: Share;
  heldEarly: Share;
  heldByRound: Distribution | null;
  heldGuardOn: Share;
  heldGuardOff: Share;
  heldByContext: Record<FireContext, Share>;
  heldAfterStartByContext: Record<FireContext, Share>;
  readyNotFiringByContext: Record<FireContext, Share>;
  heldByGuard: Record<GuardMode, Record<FireContext, Share>>;
  noStartPause: Share;
  startPauseS: Distribution | null;
  startPauseSight: Share;
  midPauses: number;
  midPausesPerMinute: number | null;
  midPauseS: Distribution | null;
  pausesByLength: Record<string, PauseBucket>;
  releaseMeanS: number | null;
  longPausesPerMinute: number | null;
  longPauseS: Distribution | null;
}

export interface DodgeShare {
  dodged: Share;
  clashed: Share;
}

export interface DodgeMetrics {
  botShots: number;
  threatsOfBotShots: Share;
  dodge: DodgeShare;
  byDistance: Record<string, DodgeShare>;
  byImpact: Record<string, DodgeShare>;
  impactTicks: Distribution | null;
  reactTicks: Distribution | null;
  baselineTicks: Distribution | null;
  reactQuick: Share;
  baselineQuick: Share;
  reacted: DodgeShare;
  notReacted: DodgeShare;
  standing: DodgeShare;
  moving: DodgeShare;
  botHitsNotThreat: Share;
}

// Доля тиков на виду и доля тиков, когда противник не виден.
export interface SightShares {
  sight: Share;
  hidden: Share;
}

// Угол хода к линии на противника в тиках с газом — на виду и без видимости, по корзинам дистанции.
export type CourseBySight = Record<keyof SightShares, Record<string, Distribution | null>>;
export type CourseByBand = Record<keyof SightShares, Record<CourseBandLabel, Distribution | null>>;

export interface MovementMetrics {
  ticks: number;
  throttle: Record<AxisBucket, Share>;
  turn: Record<AxisBucket, Share>;
  fullThrottle: Share;
  reverse: Share;
  idle: Share;
  flipsPerMinute: number | null;
  speed: Distribution | null;
  kite: Share;
  circle: Share;
  motionBySight: Record<MotionKind, SightShares>;
  courseDeg: CourseBySight;
  courseByBandDeg: CourseByBand;
  courseAllDeg: Distribution | null;
  radialRunTicks: Distribution | null;
  sideRunTicks: Distribution | null;
  pathShift: Distribution | null;
  freeRunAhead: Distribution | null;
  distance: Distribution | null;
  sightDistance: Distribution | null;
  sight: Share;
  wallDistance: Distribution | null;
  nearWall: Share;
  straightThrottle: Distribution | null;
}

export interface StateMetrics {
  ticks: number;
  sight: Share;
  firing: Share;
  turretTurning: Share;
  distance: Distribution | null;
  wallDistance: Distribution | null;
  nearWall: Share;
  shotsPerMinute: number | null;
  noSightShots: Share;
  hits: Share;
  botShotsPerMinute: number | null;
  botHits: Share;
  dodged: Share;
}

export interface PositionMetrics {
  share: Share;
  holdStyleRounds: string[];
  notableRounds: number;
  byLevel: Record<string, Share>;
  byMap: Record<string, Share>;
  hold: StateMetrics;
  manoeuvre: StateMetrics;
  segments: number;
  segmentS: Distribution | null;
  segmentStartS: Distribution | null;
  firstHoldStyleStartS: Distribution | null;
  hiddenAtStart: Share;
  distanceAtStart: Distribution | null;
  approach: Distribution | null;
  segmentSight: Distribution | null;
  segmentTurret: Distribution | null;
  segmentFiring: Distribution | null;
  segmentSightRunsS: Distribution | null;
  sightRunsStartedStill: Share;
  peeksS: Distribution | null;
  enterRates: Record<string, Share>;
}

// Победы и раунды — источник вердикта; интервал Уилсона по ним считает функция wilson.
export interface WinCount {
  rounds: number;
  wins: number;
}

export interface LevelOutcome extends WinCount {
  botName: string;
  damagePerMinute: number | null;
  damageTakenPerMinute: number | null;
  durationS: Distribution | null;
  hits: Share;
  botHits: Share;
}

export interface OutcomeMetrics extends WinCount {
  damagePerMinute: number | null;
  damageTakenPerMinute: number | null;
  durationS: Distribution | null;
  hitsByBucket: Record<string, Share>;
  botHitsByBucket: Record<string, Share>;
  botShotsByBucket: Record<string, Share>;
  byLevel: Record<string, LevelOutcome>;
  holdStyle: WinCount;
  manoeuvreStyle: WinCount;
  firstHit: Share;
}

// Условия раунда — билд, скольжение и предохранитель; раунды с билдом, который в условия не входит, учтены
// в доле предохранителя уровня и в skippedBuilds.
export interface Condition {
  build: string;
  wallSlidePercent: number;
  hasRicochetGuard: boolean;
  rounds: number;
}

// gameRounds — длина каждой игры уровня в раундах журнала, по порядку игр.
export interface LevelConditions {
  guard: Share;
  conditions: Condition[];
  gameRounds: number[];
}

export interface SkippedBuild {
  level: number;
  build: string;
  issue: BuildIssue;
  rounds: number;
}

export interface ProfileMetrics {
  rounds: number;
  games: number;
  fightMinutes: number;
  reaction: ReactionMetrics;
  aim: AimMetrics;
  fire: FireMetrics;
  dodge: DodgeMetrics;
  movement: MovementMetrics;
  position: PositionMetrics;
  modeSwitch: { enter: Coefficients | null; leave: Coefficients | null; enterSamples: number; leaveSamples: number };
  kits: KitMetrics;
  outcomes: OutcomeMetrics;
  conditions: Record<string, LevelConditions>;
  skippedBuilds: SkippedBuild[];
  settings: ClientSettings | null;
  rttMs: Distribution | null;
}

interface RoundWithDetail extends ProfileRound {
  detail: RoundDetail;
}

function bucketLabel(value: number, buckets: readonly { label: string; low: number; high: number }[]): string {
  return buckets.find((bucket) => bucket.low <= value && value < bucket.high)?.label ?? '';
}

function sumOf<T>(items: readonly T[], valueOf: (item: T) => number): number {
  let total = 0;
  for (const item of items) {
    total += valueOf(item);
  }
  return total;
}

function countOf<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  return sumOf(items, (item) => (predicate(item) ? 1 : 0));
}

function perMinute(count: number, ticks: number): number | null {
  return ticks === 0 ? null : count / (ticks / TICKS_PER_MINUTE);
}

function isHit(outcome: string | null): boolean {
  return outcome === 'enemy';
}

function withDetail(rounds: readonly ProfileRound[]): RoundWithDetail[] {
  return rounds.filter((round): round is RoundWithDetail => round.detail !== null);
}

function contextOf(context: FireContext): { hasSight: boolean; bucket: string } {
  const [sight, bucket] = context.split('|');
  return { hasSight: sight === 'visible', bucket: bucket ?? '' };
}

function reactionMetrics(rounds: readonly RoundWithDetail[]): ReactionMetrics {
  const aims = rounds.flatMap((round) => round.detail.aims);
  const episodes = rounds.flatMap((round) => round.detail.episodes);
  const mid = episodes.filter((episode) => !episode.isRoundStart);
  const afterReady = mid
    .map((episode) => episode.firstAfterReadyTicks)
    .filter((value): value is number => value !== null && value >= 0);
  return {
    aimTicks: distribution(aims.map((aim) => aim.ticks)),
    aimWithSightTicks: distribution(aims.filter((aim) => aim.isWithSight).map((aim) => aim.ticks)),
    sightEpisodes: mid.length,
    firstShotTicks: distribution(mid.map((episode) => episode.firstShotTicks)),
    noShotEpisodes: share(
      countOf(mid, (episode) => episode.firstShotTicks === null),
      mid.length,
    ),
    firstAfterReadyTicks: distribution(afterReady),
    firstAimedTicks: distribution(mid.map((episode) => episode.aimedTicks)),
    noAimedEpisodes: share(
      countOf(mid, (episode) => episode.aimedTicks === null),
      mid.length,
    ),
    roundStartFirstShotTicks: distribution(
      episodes.filter((episode) => episode.isRoundStart).map((episode) => episode.firstShotTicks),
    ),
  };
}

// Отрезки остатка по одну сторону внутри отрезка подряд идущих тиков; первый и последний оборваны — не в счёт.
function residualRuns(segment: readonly AimSample[], lagTicks: number): number[] {
  const runs: number[] = [];
  let side = 0;
  let run = 0;
  let isOpen = false;
  for (const sample of segment) {
    const sign = sample.error + lagTicks * sample.turn >= 0 ? 1 : -1;
    if (run > 0 && sign !== side) {
      if (isOpen) {
        runs.push(run);
      }
      isOpen = true;
      run = 0;
    }
    side = sign;
    run++;
  }
  return runs;
}

// Наименьшие квадраты для e ≈ −lag·ω. Угол упреждения у ботов лестницы почти пропорционален ω — они кружат
// на ровной дистанции, — поэтому доля упреждения отдельно от отставания по этим тикам не различается.
function aimFitOf(rounds: readonly RoundWithDetail[]): AimFit {
  const segments = rounds.flatMap((round) => round.detail.aimSegments);
  const samples = segments.flat();
  const turnSquares = sumOf(samples, (sample) => sample.turn * sample.turn);
  if (samples.length < MIN_AIM_FIT_TICKS || turnSquares === 0) {
    return { n: samples.length, lagTicks: null, residualSameSideTicks: null };
  }
  const lagTicks = -sumOf(samples, (sample) => sample.error * sample.turn) / turnSquares;
  return {
    n: samples.length,
    lagTicks,
    residualSameSideTicks: distribution(segments.flatMap((segment) => residualRuns(segment, lagTicks))),
  };
}

function aimMetrics(rounds: readonly RoundWithDetail[]): AimMetrics {
  const shots = rounds.flatMap((round) => round.detail.shots);
  const sightShots = shots.filter((shot) => shot.hasSight);
  const byBucket: Record<string, AimBucket> = {};
  for (const label of BUCKET_LABELS) {
    const inBucket = sightShots.filter((shot) => shot.bucket === label);
    const standing = inBucket.filter((shot) => !shot.isMoving);
    const moving = inBucket.filter((shot) => shot.isMoving);
    const all = shots.filter((shot) => shot.bucket === label);
    byBucket[label] = {
      standingErrDeg: distribution(standing.map((shot) => shot.errCurDeg)),
      movingErrCurDeg: distribution(moving.map((shot) => shot.errCurDeg)),
      movingErrLeadDeg: distribution(moving.map((shot) => shot.errLeadDeg)),
      tankSizeDeg: distribution(inBucket.map((shot) => shot.sizeDeg)),
      hitAll: share(
        countOf(all, (shot) => isHit(shot.outcome)),
        all.length,
      ),
      hitStanding: share(
        countOf(standing, (shot) => isHit(shot.outcome)),
        standing.length,
      ),
      hitMoving: share(
        countOf(moving, (shot) => isHit(shot.outcome)),
        moving.length,
      ),
    };
  }
  const moving = sightShots.filter((shot) => shot.isMoving);
  const kinds = { lead: 0, current: 0, neither: 0 };
  for (const shot of moving) {
    const isOnHull = shot.errCurDeg < shot.sizeDeg;
    const isOnLead = shot.errLeadDeg < shot.sizeDeg;
    if (isOnHull && isOnLead) {
      kinds[shot.errLeadDeg < shot.errCurDeg ? 'lead' : 'current']++;
    } else if (isOnLead) {
      kinds.lead++;
    } else if (isOnHull) {
      kinds.current++;
    } else {
      kinds.neither++;
    }
  }
  const settled = sightShots.filter(
    (shot) => shot.sightRunTicks >= SETTLED_SIGHT_TICKS && shot.bucket === MID_DISTANCE_LABEL && shot.isMoving,
  );
  const sightErrors = rounds.flatMap((round) => round.detail.sightErrorsDeg);
  return {
    standingErrDeg: distribution(sightShots.filter((shot) => !shot.isMoving).map((shot) => shot.errCurDeg)),
    byBucket,
    settledMovingErrDeg: distribution(settled.map((shot) => Math.min(shot.errCurDeg, shot.errLeadDeg))),
    movingKinds: kinds,
    leadFraction: distribution(
      moving
        .map((shot) => shot.leadFraction)
        .filter((value): value is number => value !== null && value >= LEAD_FRACTION_MIN && value <= LEAD_FRACTION_MAX),
    ),
    aimFit: aimFitOf(rounds),
    sightErrorDeg: distribution(sightErrors),
    sightErrorUnder5: share(
      countOf(sightErrors, (error) => error < AIM_GOOD_DEG),
      sightErrors.length,
    ),
    sameSideTicks: distribution(rounds.flatMap((round) => round.detail.sameSideRuns)),
    shotDistance: distribution(shots.map((shot) => shot.distance)),
    hiddenAim: hiddenAimShares(rounds),
    preAppear: share(
      sumOf(rounds, (round) => round.detail.appear.onPoint),
      sumOf(rounds, (round) => round.detail.appear.appearances),
    ),
  };
}

function hiddenAimShares(rounds: readonly RoundWithDetail[]): Record<HiddenAimTarget, HiddenAimShare> {
  const samples = sumOf(rounds, (round) => round.detail.hiddenAims.samples);
  const result = {} as Record<HiddenAimTarget, HiddenAimShare>;
  for (const target of HIDDEN_AIM_TARGETS) {
    const sole = share(
      sumOf(rounds, (round) => round.detail.hiddenAims.sole[target]),
      samples,
    );
    const chancePct =
      samples === 0 ? null : (PERCENT * sumOf(rounds, (round) => round.detail.hiddenAims.chance[target])) / samples;
    result[target] = {
      sole,
      chancePct,
      excessPct: sole.pct === null || chancePct === null ? null : sole.pct - chancePct,
    };
  }
  return result;
}

function kitMetrics(rounds: readonly RoundWithDetail[], fightTicks: number): KitMetrics {
  const toward = {} as Record<KitSide, Share>;
  const startsPerMinute = {} as Record<KitSide, number | null>;
  for (const side of KIT_SIDES) {
    toward[side] = share(
      sumOf(rounds, (round) => round.detail.kits.toward[side].toward),
      sumOf(rounds, (round) => round.detail.kits.toward[side].total),
    );
    startsPerMinute[side] = perMinute(
      sumOf(rounds, (round) => round.detail.kits.starts[side]),
      sumOf(rounds, (round) => round.detail.kits.freeTicks[side]),
    );
  }
  const pickups = sumOf(rounds, (round) => round.detail.kits.pickups);
  const followed = sumOf(rounds, (round) => round.detail.kits.trips.followed);
  return {
    toward,
    startsPerMinute,
    followed: share(followed, followed + sumOf(rounds, (round) => round.detail.kits.trips.dropped)),
    picked: share(
      pickups,
      sumOf(rounds, (round) => round.detail.kits.spawns),
    ),
    mine: share(pickups, pickups + sumOf(rounds, (round) => round.detail.kits.botPickups)),
    healPerMinute: perMinute(
      sumOf(rounds, (round) => round.detail.kits.healed),
      fightTicks,
    ),
  };
}

function pauseBucket(pauses: readonly FirePause[], all: number, allTicks: number): PauseBucket {
  const ticks = sumOf(pauses, (pause) => pause.ticks);
  return {
    count: share(pauses.length, all),
    time: share(ticks, allTicks),
    sight: share(
      sumOf(pauses, (pause) => pause.sightTicks),
      ticks,
    ),
    ready: share(
      sumOf(pauses, (pause) => pause.readyTicks),
      ticks,
    ),
    distance: distribution(pauses.map((pause) => pause.distance)),
    errorDeg: distribution(pauses.map((pause) => pause.errorDeg)),
    guarded: share(
      countOf(pauses, (pause) => pause.isGuarded),
      pauses.length,
    ),
  };
}

function heldShare(rounds: readonly RoundWithDetail[], isEarly: boolean | null): Share {
  const cells = rounds
    .flatMap((round) => round.detail.fireCells)
    .filter((cell) => isEarly === null || cell.isEarly === isEarly);
  return share(
    sumOf(cells, (cell) => cell.firing),
    sumOf(cells, (cell) => cell.ticks),
  );
}

function isLateCell(cell: FireCell): boolean {
  return !cell.isEarly;
}

function isAfterStartCell(cell: FireCell): boolean {
  return cell.isAfterStart;
}

interface ContextShares {
  held: Record<FireContext, Share>;
  readyNotFiring: Record<FireContext, Share>;
}

// Огонь по контекстам — после первых 1,5 с боя или, для входа модели, после стартовой паузы.
function contextShares(rounds: readonly RoundWithDetail[], isCellCounted = isLateCell): ContextShares {
  const lateCells = rounds.flatMap((round) => round.detail.fireCells).filter(isCellCounted);
  const result: ContextShares = {
    held: {} as Record<FireContext, Share>,
    readyNotFiring: {} as Record<FireContext, Share>,
  };
  for (const context of FIRE_CONTEXTS) {
    const { hasSight, bucket } = contextOf(context);
    const cells = lateCells.filter((cell) => cell.hasSight === hasSight && cell.bucket === bucket);
    const ticks = sumOf(cells, (cell) => cell.ticks);
    const ready = cells.filter((cell) => cell.isReady);
    result.held[context] = share(
      sumOf(cells, (cell) => cell.firing),
      ticks,
    );
    result.readyNotFiring[context] = share(
      sumOf(ready, (cell) => cell.ticks - cell.firing),
      ticks,
    );
  }
  return result;
}

function fireMetrics(rounds: readonly RoundWithDetail[], fightTicks: number): FireMetrics {
  const shots = rounds.flatMap((round) => round.detail.shots);
  const shotEvents = sumOf(rounds, (round) => round.shotEvents);
  const intervals = rounds.flatMap((round) =>
    round.detail.intervals.map((interval) => ({ interval, reload: round.detail.reloadTicks })),
  );
  const noSight = shots.filter((shot) => !shot.hasSight);
  const guardOn = rounds.filter((round) => round.hasRicochetGuard);
  const guardOff = rounds.filter((round) => !round.hasRicochetGuard);
  const guardOffShots = guardOff.flatMap((round) => round.detail.shots);
  const all = contextShares(rounds);
  const pauses = rounds.flatMap((round) => round.detail.pauses);
  const start = pauses.filter((pause) => pause.startIndex === 0);
  const afterStartTicks = sumOf(rounds, (round) => round.fightTicks - round.detail.startPauseTicks);
  const mid = pauses.filter((pause) => pause.startIndex > 0);
  const midTicks = sumOf(mid, (pause) => pause.ticks);
  const pausesByLength: Record<string, PauseBucket> = {};
  for (const bucket of PAUSE_BUCKETS) {
    const inBucket = mid.filter((pause) => bucket.low <= pause.ticks && pause.ticks < bucket.high);
    pausesByLength[bucket.label] = pauseBucket(inBucket, mid.length, midTicks);
  }
  const guardTicks = sumOf(guardOn, (round) => round.fightTicks);
  const releases = mid.filter((pause) => pause.ticks < LONG_PAUSE_TICKS && !pause.isGuarded);
  const longPauses = mid.filter((pause) => pause.ticks >= LONG_PAUSE_TICKS);
  return {
    shots: shotEvents,
    shotsPerMinute: perMinute(shotEvents, fightTicks),
    readyShots: share(
      countOf(intervals, (item) => item.interval <= item.reload + READY_SLACK_TICKS),
      intervals.length,
    ),
    intervalExcessTicks: distribution(intervals.map((item) => item.interval - item.reload)),
    noSightShots: share(noSight.length, shots.length),
    noSightHits: share(
      countOf(noSight, (shot) => isHit(shot.outcome)),
      noSight.length,
    ),
    noSightDirectHits: share(
      countOf(noSight, (shot) => shot.isDirectHit),
      noSight.length,
    ),
    selfHits: share(
      sumOf(rounds, (round) => round.detail.selfHits),
      shotEvents,
    ),
    returningShotsGuardOff: share(
      countOf(guardOffShots, (shot) => shot.isReturning),
      guardOffShots.length,
    ),
    hits: share(
      countOf(shots, (shot) => isHit(shot.outcome)),
      shots.length,
    ),
    guardHoldsPerMinute:
      guardTicks === 0
        ? null
        : perMinute(
            sumOf(guardOn, (round) => round.guardHolds),
            guardTicks,
          ),
    held: heldShare(rounds, null),
    heldLate: heldShare(rounds, false),
    heldEarly: heldShare(rounds, true),
    heldByRound: distribution(rounds.map((round) => round.fireShare)),
    heldGuardOn: heldShare(guardOn, null),
    heldGuardOff: heldShare(guardOff, null),
    heldByContext: all.held,
    heldAfterStartByContext: contextShares(rounds, isAfterStartCell).held,
    readyNotFiringByContext: all.readyNotFiring,
    heldByGuard: { guardOn: contextShares(guardOn).held, guardOff: contextShares(guardOff).held },
    noStartPause: share(
      countOf(rounds, (round) => round.detail.startPauseTicks === 0),
      rounds.length,
    ),
    startPauseS: distribution(start.map((pause) => pause.ticks / TICK_RATE)),
    startPauseSight: share(
      sumOf(start, (pause) => pause.sightTicks),
      sumOf(start, (pause) => pause.ticks),
    ),
    midPauses: mid.length,
    midPausesPerMinute: perMinute(mid.length, fightTicks),
    midPauseS: distribution(mid.map((pause) => pause.ticks / TICK_RATE)),
    pausesByLength,
    releaseMeanS: releases.length === 0 ? null : sumOf(releases, (pause) => pause.ticks) / releases.length / TICK_RATE,
    longPausesPerMinute: perMinute(longPauses.length, afterStartTicks),
    longPauseS: distribution(longPauses.map((pause) => pause.ticks / TICK_RATE)),
  };
}

function isEvaluatedThreat(threat: ProfileThreat): boolean {
  return threat.isThreat && !threat.isCut && threat.outcome !== null && threat.outcome !== 'open';
}

// Увернулся — угроза не попала; сбитые встречным в долю не входят.
function dodgeShare(threats: readonly ProfileThreat[]): DodgeShare {
  const hits = countOf(threats, (threat) => threat.outcome === 'enemy');
  const clashes = countOf(threats, (threat) => threat.outcome === 'clash');
  const dodged = threats.length - hits - clashes;
  return { dodged: share(dodged, dodged + hits), clashed: share(clashes, threats.length) };
}

function hasReacted(threat: ProfileThreat): boolean {
  return threat.reactTicks !== null && threat.impactTicks !== null && threat.reactTicks < threat.impactTicks;
}

function dodgeMetrics(rounds: readonly RoundWithDetail[]): DodgeMetrics {
  const all = rounds.flatMap((round) => round.detail.threats);
  const threats = all.filter((threat) => threat.isThreat);
  const evaluated = threats.filter(isEvaluatedThreat);
  const botHits = all.filter((threat) => threat.outcome === 'enemy');
  const baseline = rounds.flatMap((round) => round.detail.baselineTicks);
  const byDistance: Record<string, DodgeShare> = {};
  for (const label of BUCKET_LABELS) {
    byDistance[label] = dodgeShare(
      evaluated.filter((threat) => bucketLabel(threat.distance, DISTANCE_BUCKETS) === label),
    );
  }
  const byImpact: Record<string, DodgeShare> = {};
  for (const bucket of IMPACT_BUCKETS) {
    byImpact[bucket.label] = dodgeShare(
      evaluated.filter((threat) => bucketLabel(threat.impactTicks ?? 0, IMPACT_BUCKETS) === bucket.label),
    );
  }
  return {
    botShots: all.length,
    threatsOfBotShots: share(threats.length, all.length),
    dodge: dodgeShare(evaluated),
    byDistance,
    byImpact,
    impactTicks: distribution(evaluated.map((threat) => threat.impactTicks)),
    reactTicks: distribution(evaluated.map((threat) => threat.reactTicks)),
    baselineTicks: distribution(baseline),
    reactQuick: share(
      countOf(evaluated, (threat) => threat.reactTicks !== null && threat.reactTicks <= QUICK_CHANGE_TICKS),
      evaluated.length,
    ),
    baselineQuick: share(
      countOf(baseline, (ticks) => ticks !== null && ticks <= QUICK_CHANGE_TICKS),
      baseline.length,
    ),
    reacted: dodgeShare(evaluated.filter(hasReacted)),
    notReacted: dodgeShare(evaluated.filter((threat) => !hasReacted(threat))),
    standing: dodgeShare(evaluated.filter((threat) => threat.speed <= MOVING_SPEED)),
    moving: dodgeShare(evaluated.filter((threat) => threat.speed > MOVING_SPEED)),
    botHitsNotThreat: share(
      countOf(botHits, (threat) => !threat.isThreat),
      botHits.length,
    ),
  };
}

function axisShares(counts: Record<AxisBucket, number>, total: number): Record<AxisBucket, Share> {
  const result = {} as Record<AxisBucket, Share>;
  for (const bucket of AXIS_BUCKETS) {
    result[bucket] = share(counts[bucket], total);
  }
  return result;
}

export function movementMetrics(rounds: readonly ProfileRound[]): MovementMetrics {
  const detailed = withDetail(rounds);
  const throttle = Object.fromEntries(AXIS_BUCKETS.map((bucket) => [bucket, 0])) as Record<AxisBucket, number>;
  const turn = { ...throttle };
  for (const round of detailed) {
    for (const bucket of AXIS_BUCKETS) {
      throttle[bucket] += round.detail.movement.throttle[bucket];
      turn[bucket] += round.detail.movement.turn[bucket];
    }
  }
  const total = (key: 'ticks' | 'sightTicks' | 'reverse' | 'idle' | 'full' | 'kite' | 'circle' | 'flips'): number =>
    sumOf(detailed, (round) => round.detail.movement[key]);
  const ticks = total('ticks');
  const sightTicks = total('sightTicks');
  const bySight = (sight: number, all: number): SightShares => ({
    sight: share(sight, sightTicks),
    hidden: share(all - sight, ticks - sightTicks),
  });
  const motionBySight = {} as Record<MotionKind, SightShares>;
  for (const kind of MOTION_KINDS) {
    const sight = sumOf(detailed, (round) => round.detail.movement.motion[kind].sight);
    const hidden = sumOf(detailed, (round) => round.detail.movement.motion[kind].hidden);
    motionBySight[kind] = bySight(sight, sight + hidden);
  }
  const samples = detailed.flatMap((round) => round.detail.samples);
  const sightSamples = samples.filter((sample) => sample.hasSight);
  const courses = (hasSight: boolean, isInBand: (distance: number) => boolean): Distribution | null =>
    distribution(
      samples
        .filter((sample) => sample.hasSight === hasSight && isInBand(sample.distance))
        .flatMap((sample) => (sample.courseDeg === null ? [] : [sample.courseDeg])),
    );
  const courseOf = (hasSight: boolean): Record<string, Distribution | null> =>
    Object.fromEntries(
      BUCKET_LABELS.map((label) => [
        label,
        courses(hasSight, (distance) => bucketLabel(distance, DISTANCE_BUCKETS) === label),
      ]),
    );
  const courseByBandOf = (hasSight: boolean): Record<CourseBandLabel, Distribution | null> =>
    Object.fromEntries(
      COURSE_BAND_LABELS.map((label) => [label, courses(hasSight, (distance) => courseBandOf(distance) === label)]),
    ) as Record<CourseBandLabel, Distribution | null>;
  return {
    ticks,
    throttle: axisShares(throttle, ticks),
    turn: axisShares(turn, ticks),
    fullThrottle: share(total('full'), ticks),
    reverse: share(total('reverse'), ticks),
    idle: share(total('idle'), ticks),
    flipsPerMinute: perMinute(total('flips'), ticks),
    speed: distribution(samples.map((sample) => sample.speed)),
    kite: share(total('kite'), ticks),
    circle: share(total('circle'), ticks),
    motionBySight,
    courseDeg: { sight: courseOf(true), hidden: courseOf(false) },
    courseByBandDeg: { sight: courseByBandOf(true), hidden: courseByBandOf(false) },
    courseAllDeg: distribution(samples.flatMap((sample) => (sample.courseDeg === null ? [] : [sample.courseDeg]))),
    radialRunTicks: distribution(detailed.flatMap((round) => round.detail.radialRuns)),
    sideRunTicks: distribution(detailed.flatMap((round) => round.detail.sideRuns)),
    pathShift: distribution(detailed.flatMap((round) => round.detail.pathShifts)),
    freeRunAhead: distribution(detailed.flatMap((round) => round.detail.freeRuns)),
    distance: distribution(samples.map((sample) => sample.distance)),
    sightDistance: distribution(sightSamples.map((sample) => sample.distance)),
    sight: share(sightSamples.length, samples.length),
    wallDistance: distribution(samples.map((sample) => sample.wallDistance)),
    nearWall: share(
      countOf(samples, (sample) => sample.wallDistance < TOUCHING_WALL),
      samples.length,
    ),
    straightThrottle: distribution(detailed.flatMap((round) => round.detail.straightThrottle)),
  };
}

interface RoundPosition {
  round: RoundWithDetail;
  segments: Segment[];
  mask: boolean[];
}

function stateMetrics(positions: readonly RoundPosition[], isHold: boolean): StateMetrics {
  const samples = positions.flatMap((item) =>
    item.round.detail.samples.filter((_, index) => item.mask[index] === isHold),
  );
  const inState = (item: RoundPosition, gt: number): boolean => {
    const index = item.round.detail.samples.findIndex((sample) => sample.gt === gt);
    return index !== -1 && item.mask[index] === isHold;
  };
  const shots: ProfileShot[] = positions.flatMap((item) =>
    item.round.detail.shots.filter((shot) => inState(item, shot.gt)),
  );
  const botShots = positions.flatMap((item) => item.round.detail.threats.filter((threat) => inState(item, threat.gt)));
  const evaluated = botShots.filter((threat) => isEvaluatedThreat(threat) && threat.outcome !== 'clash');
  return {
    ticks: samples.length,
    sight: share(
      countOf(samples, (sample) => sample.hasSight),
      samples.length,
    ),
    firing: share(
      countOf(samples, (sample) => sample.isFiring),
      samples.length,
    ),
    turretTurning: share(
      countOf(samples, (sample) => sample.isTurretTurning),
      samples.length,
    ),
    distance: distribution(samples.map((sample) => sample.distance)),
    wallDistance: distribution(samples.map((sample) => sample.wallDistance)),
    nearWall: share(
      countOf(samples, (sample) => sample.wallDistance < TOUCHING_WALL),
      samples.length,
    ),
    shotsPerMinute: perMinute(shots.length, samples.length),
    noSightShots: share(
      countOf(shots, (shot) => !shot.hasSight),
      shots.length,
    ),
    hits: share(
      countOf(shots, (shot) => isHit(shot.outcome)),
      shots.length,
    ),
    botShotsPerMinute: perMinute(botShots.length, samples.length),
    botHits: share(
      countOf(botShots, (threat) => isHit(threat.outcome)),
      botShots.length,
    ),
    dodged: share(
      countOf(evaluated, (threat) => !isHit(threat.outcome)),
      evaluated.length,
    ),
  };
}

function rateShare(samples: readonly ModeSample[], predicate: (sample: ModeSample) => boolean): Share {
  const selected = samples.filter(predicate);
  return share(
    countOf(selected, (sample) => sample.hasSwitched),
    selected.length,
  );
}

function enterRates(samples: readonly ModeSample[]): Record<string, Share> {
  const enter = samples.filter((sample) => !sample.isInPosition);
  const rates: Record<string, Share> = { all: rateShare(enter, () => true) };
  for (const bucket of FIGHT_TIME_BUCKETS) {
    rates[`fight ${bucket.label}`] = rateShare(
      enter,
      (sample) => bucketLabel(sample.features.fightSeconds, FIGHT_TIME_BUCKETS) === bucket.label,
    );
  }
  rates.visible = rateShare(enter, (sample) => sample.features.hasSight);
  rates.hidden = rateShare(enter, (sample) => !sample.features.hasSight);
  rates['distance <600'] = rateShare(enter, (sample) => sample.features.distance < FAR_DISTANCE);
  rates['distance ≥600'] = rateShare(enter, (sample) => sample.features.distance >= FAR_DISTANCE);
  rates['no recent damage'] = rateShare(enter, (sample) => sample.features.recentDamageShare === 0);
  rates['recent damage'] = rateShare(enter, (sample) => sample.features.recentDamageShare > 0);
  rates['exchange +'] = rateShare(enter, (sample) => sample.features.exchangeShare > 0);
  rates['exchange 0'] = rateShare(enter, (sample) => sample.features.exchangeShare === 0);
  rates['exchange −'] = rateShare(enter, (sample) => sample.features.exchangeShare < 0);
  rates.cover = rateShare(enter, (sample) => sample.features.hasCover);
  rates['no cover'] = rateShare(enter, (sample) => !sample.features.hasCover);
  return rates;
}

function holdShareOf(positions: readonly RoundPosition[]): Share {
  return share(
    sumOf(positions, (item) => countOf(item.mask, (isHold) => isHold)),
    sumOf(positions, (item) => item.mask.length),
  );
}

function groupShares(
  positions: readonly RoundPosition[],
  keyOf: (round: ProfileRound) => string,
): Record<string, Share> {
  const groups = new Map<string, RoundPosition[]>();
  for (const item of positions) {
    const key = keyOf(item.round);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return Object.fromEntries([...groups].map(([key, items]) => [key, holdShareOf(items)]));
}

interface Run {
  ticks: number;
  isStartedStill: boolean;
}

// Подряд идущие тики, где условие выполнено; отрезок, оборванный концом окна, тоже в счёте.
function runsOf(window: readonly FightSample[], predicate: (sample: FightSample) => boolean): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;
  for (const sample of window) {
    if (!predicate(sample)) {
      current = null;
      continue;
    }
    if (current === null) {
      current = { ticks: 0, isStartedStill: sample.speed < STILL_SPEED };
      runs.push(current);
    }
    current.ticks++;
  }
  return runs;
}

function positionMetrics(positions: readonly RoundPosition[], samples: readonly ModeSample[]): PositionMetrics {
  const roundShare = (item: RoundPosition): number =>
    countOf(item.mask, (isHold) => isHold) / Math.max(1, item.mask.length);
  const holdStyle = positions.filter((item) => roundShare(item) >= HOLD_STYLE_SHARE);
  const segments = positions.flatMap((item) =>
    item.segments.map((segment) => ({ segment, samples: item.round.detail.samples })),
  );
  const window = (entry: (typeof segments)[number]): RoundDetail['samples'] =>
    entry.samples.slice(entry.segment.start, entry.segment.end);
  const sightRuns = segments.flatMap((entry) => runsOf(window(entry), (sample) => sample.hasSight));
  return {
    share: holdShareOf(positions),
    holdStyleRounds: holdStyle.map((item) => item.round.id),
    notableRounds: countOf(positions, (item) => {
      const value = roundShare(item);
      return value >= NOTABLE_POSITION_SHARE && value < HOLD_STYLE_SHARE;
    }),
    byLevel: groupShares(positions, (round) => String(round.level)),
    byMap: groupShares(positions, (round) => round.mapName),
    hold: stateMetrics(positions, true),
    manoeuvre: stateMetrics(positions, false),
    segments: segments.length,
    segmentS: distribution(segments.map((entry) => (entry.segment.end - entry.segment.start) / TICK_RATE)),
    segmentStartS: distribution(segments.map((entry) => entry.segment.start / TICK_RATE)),
    firstHoldStyleStartS: distribution(holdStyle.map((item) => (item.segments[0]?.start ?? 0) / TICK_RATE)),
    hiddenAtStart: share(
      countOf(segments, (entry) => entry.samples[entry.segment.start]?.hasSight === false),
      segments.length,
    ),
    distanceAtStart: distribution(segments.map((entry) => entry.samples[entry.segment.start]?.distance ?? null)),
    approach: distribution(
      segments.map((entry) => {
        const first = entry.samples[entry.segment.start];
        const last = entry.samples[entry.segment.end - 1];
        return first === undefined || last === undefined ? null : first.distance - last.distance;
      }),
    ),
    segmentSight: distribution(segments.map((entry) => shareOf(window(entry), (sample) => sample.hasSight))),
    segmentTurret: distribution(segments.map((entry) => shareOf(window(entry), (sample) => sample.isTurretTurning))),
    segmentFiring: distribution(segments.map((entry) => shareOf(window(entry), (sample) => sample.isFiring))),
    segmentSightRunsS: distribution(sightRuns.map((run) => run.ticks / TICK_RATE)),
    sightRunsStartedStill: share(
      countOf(sightRuns, (run) => run.isStartedStill),
      sightRuns.length,
    ),
    peeksS: distribution(
      segments.flatMap((entry) =>
        runsOf(window(entry), (sample) => sample.speed >= STILL_SPEED).map((run) => run.ticks / TICK_RATE),
      ),
    ),
    enterRates: enterRates(samples),
  };
}

function shareOf<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  return items.length === 0 ? 0 : countOf(items, predicate) / items.length;
}

function winsOf(rounds: readonly ProfileRound[]): WinCount {
  const finished = rounds.filter((round) => round.isFinished);
  return { rounds: finished.length, wins: countOf(finished, (round) => round.isWon) };
}

function outcomeMetrics(rounds: readonly RoundWithDetail[], holdStyleIds: ReadonlySet<string>): OutcomeMetrics {
  const finished = rounds.filter((round) => round.isFinished);
  const ticks = sumOf(finished, (round) => round.fightTicks);
  const shots = rounds.flatMap((round) => round.detail.shots);
  const threats = rounds.flatMap((round) => round.detail.threats);
  const hitsByBucket: Record<string, Share> = {};
  const botHitsByBucket: Record<string, Share> = {};
  const botShotsByBucket: Record<string, Share> = {};
  for (const label of BUCKET_LABELS) {
    const inBucket = shots.filter((shot) => shot.bucket === label);
    hitsByBucket[label] = share(
      countOf(inBucket, (shot) => isHit(shot.outcome)),
      inBucket.length,
    );
    const botInBucket = threats.filter((threat) => bucketLabel(threat.distance, DISTANCE_BUCKETS) === label);
    botHitsByBucket[label] = share(
      countOf(botInBucket, (threat) => isHit(threat.outcome)),
      botInBucket.length,
    );
    botShotsByBucket[label] = share(botInBucket.length, threats.length);
  }
  const byLevel: Record<string, LevelOutcome> = {};
  const levelKeys = [...new Set(finished.map((round) => `${String(round.level)} ${round.botName}`))].sort(
    (a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b),
  );
  for (const key of levelKeys) {
    const group = finished.filter((round) => `${String(round.level)} ${round.botName}` === key);
    const groupTicks = sumOf(group, (round) => round.fightTicks);
    byLevel[key] = {
      botName: group[0]?.botName ?? '',
      rounds: group.length,
      wins: countOf(group, (round) => round.isWon),
      damagePerMinute: perMinute(
        sumOf(group, (round) => round.detail.damageDealt),
        groupTicks,
      ),
      damageTakenPerMinute: perMinute(
        sumOf(group, (round) => round.detail.damageTaken),
        groupTicks,
      ),
      durationS: distribution(group.map((round) => round.durationS)),
      hits: share(
        sumOf(group, (round) => round.detail.enemyHits),
        sumOf(group, (round) => round.shotEvents),
      ),
      botHits: share(
        sumOf(group, (round) => round.detail.botHitsLog),
        sumOf(group, (round) => round.detail.botShots),
      ),
    };
  }
  const total = winsOf(finished);
  return {
    ...total,
    damagePerMinute: perMinute(
      sumOf(finished, (round) => round.detail.damageDealt),
      ticks,
    ),
    damageTakenPerMinute: perMinute(
      sumOf(finished, (round) => round.detail.damageTaken),
      ticks,
    ),
    durationS: distribution(finished.map((round) => round.durationS)),
    hitsByBucket,
    botHitsByBucket,
    botShotsByBucket,
    byLevel,
    holdStyle: winsOf(rounds.filter((round) => holdStyleIds.has(round.id))),
    manoeuvreStyle: winsOf(rounds.filter((round) => !holdStyleIds.has(round.id))),
    firstHit: share(
      countOf(rounds, (round) => round.detail.firstHit === 'mine'),
      countOf(rounds, (round) => round.detail.firstHit !== null),
    ),
  };
}

function conditionsOf(rounds: readonly ProfileRound[]): Record<string, LevelConditions> {
  const result: Record<string, LevelConditions> = {};
  const levels = [...new Set(rounds.map((round) => round.level))].sort((a, b) => a - b);
  for (const level of levels) {
    const group = rounds.filter((round) => round.level === level);
    const conditions: Condition[] = [];
    for (const round of group) {
      if (round.build.issue !== null) {
        continue;
      }
      const found = conditions.find(
        (condition) =>
          condition.build === round.build.text &&
          condition.wallSlidePercent === round.wallSlidePercent &&
          condition.hasRicochetGuard === round.hasRicochetGuard,
      );
      if (found !== undefined) {
        found.rounds++;
        continue;
      }
      conditions.push({
        build: round.build.text,
        wallSlidePercent: round.wallSlidePercent,
        hasRicochetGuard: round.hasRicochetGuard,
        rounds: 1,
      });
    }
    const gameRounds = new Map<string, number>();
    for (const round of group) {
      gameRounds.set(round.game, round.gameRounds);
    }
    result[String(level)] = {
      guard: share(
        countOf(group, (round) => round.hasRicochetGuard),
        group.length,
      ),
      conditions,
      gameRounds: [...gameRounds.values()],
    };
  }
  return result;
}

function skippedBuildsOf(rounds: readonly ProfileRound[]): SkippedBuild[] {
  const result: SkippedBuild[] = [];
  for (const round of rounds) {
    const issue = round.build.issue;
    if (issue === null) {
      continue;
    }
    const found = result.find((item) => item.level === round.level && item.build === round.build.text);
    if (found !== undefined) {
      found.rounds++;
      continue;
    }
    result.push({ level: round.level, build: round.build.text, issue, rounds: 1 });
  }
  return result;
}

function lastSettings(rounds: readonly ProfileRound[]): ClientSettings | null {
  const ordered = [...rounds].sort((a, b) => a.order - b.order || a.idx - b.idx);
  let settings: ClientSettings | null = null;
  for (const round of ordered) {
    settings = round.settings ?? settings;
  }
  return settings;
}

// Метрики профиля по раундам выборки: те же определения для журналов человека и двойника.
export function profileMetrics(rounds: readonly ProfileRound[]): ProfileMetrics {
  const detailed = withDetail(rounds);
  const fightTicks = sumOf(detailed, (round) => round.fightTicks);
  const positions: RoundPosition[] = detailed.map((round) => {
    const segments = positionSegments(round.detail.samples);
    return { round, segments, mask: positionMask(round.detail.samples.length, segments) };
  });
  const samples = modeSamples(detailed);
  const position = positionMetrics(positions, samples);
  const enter = samples.filter((sample) => !sample.isInPosition);
  const leave = samples.filter((sample) => sample.isInPosition);
  return {
    rounds: detailed.length,
    games: new Set(detailed.map((round) => round.game)).size,
    fightMinutes: fightTicks / TICKS_PER_MINUTE,
    reaction: reactionMetrics(detailed),
    aim: aimMetrics(detailed),
    fire: fireMetrics(detailed, fightTicks),
    dodge: dodgeMetrics(detailed),
    movement: movementMetrics(detailed),
    position,
    modeSwitch: {
      enter: fitSwitchCoefficients(enter),
      leave: fitSwitchCoefficients(leave),
      enterSamples: enter.length,
      leaveSamples: leave.length,
    },
    kits: kitMetrics(detailed, fightTicks),
    outcomes: outcomeMetrics(detailed, new Set(position.holdStyleRounds)),
    conditions: conditionsOf(detailed),
    skippedBuilds: skippedBuildsOf(detailed),
    settings: lastSettings(detailed),
    rttMs: distribution(detailed.flatMap((round) => round.rttMs)),
  };
}
