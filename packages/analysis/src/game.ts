import { mapByIndex, TICK_RATE, type Side, type Wall } from '@tanks/shared/engine';
import { BOT_LEVEL_INFO, BOT_LEVELS, botLevelOf, type BotLevel } from '@tanks/shared/protocol';
import { EVENT_KIND, trackRound, type Hit, type TrackedBullet, type TrackedRound } from './bullets.js';
import { inferBulletSpeed, inferStats, type InferredStats } from './inferStats.js';
import {
  deviceLabel,
  pickDevice,
  FIGHT_PHASE,
  SECONDS_PER_DAY,
  SIDES,
  type DeviceIndex,
  type DeviceSource,
  type LeaveRecord,
  type ParsedGame,
  type ParsedRound,
} from './logParser.js';
import {
  addDynamics,
  addMovement,
  analyzeClientInputs,
  analyzeDynamics,
  analyzeMovement,
  autofireChangesOf,
  AXES,
  clientSummary,
  emptyDynamics,
  emptyMovement,
  type Axis,
  type ClientInputs,
  type ClientSummary,
} from './movement.js';
import { count, median, pct, roundTo, sum } from './numbers.js';
import { DISTANCE_BUCKETS } from './ruler/bands.js';
import { analyzeSelfHits, type SelfHitRow } from './selfHits.js';
import {
  AIM_GOOD_DEG,
  analyzeAimTracking,
  analyzeShots,
  LEAD_FRACTION_MAX,
  LEAD_FRACTION_MIN,
  MOVING_SPEED,
  SHOT_KIND,
  type ShotRow,
} from './shots.js';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const DEFAULT_HUMAN_SIDE: Side = 1;

export type LevelSource = 'код' | 'имя';
export type RoundReason = 'kill' | 'time' | 'прервано';

export interface ShootingTotals {
  shots: number;
  hits: number;
  ricochet_hits: number;
  self_hits: number;
  self_damage: number;
  damage_dealt: number;
  damage_taken: number;
  zone_damage: number;
  kits: number;
  bumps: number;
  clashed: number;
  deaths: number;
}

export interface HitShare {
  shots: number;
  hits: number;
  pct: number | null;
}

export interface RoundSummary {
  idx: number;
  map: number;
  map_name: string;
  winner: Side | null;
  finished: boolean;
  reason: RoundReason;
  duration_s: number;
  score_before: string;
  human_shots: number;
  human_hits: number;
  bot_shots: number;
  bot_hits: number;
  human_damage_taken: number;
  bot_damage_taken: number;
  human_bumps: number;
  human_shot_distance_median: number | null;
  human_los_pct: number | null;
  human_lead_pct: number | null;
  human_first_hit_s: number | null;
  bot_first_hit_s: number | null;
  human_won: boolean | null;
  aim_err_median_deg: number | null;
}

export interface MovementSummary {
  fight_ticks: number;
  full_throttle_pct: number | null;
  reverse_pct: number | null;
  idle_pct: number | null;
  mean_speed: number | null;
  bumps: number;
  bumps_per_min: number | null;
  silent_ticks: number;
  batched_inputs: number;
  dropped_inputs: number;
}

export interface DynamicsSummary {
  throttle_flips_per_min: number | null;
  flip_settle_ticks_median: number | null;
  sharp_stops_per_min: number | null;
  turnarounds_per_min: number | null;
  turnaround_ticks_median: number | null;
  kite_pct: number | null;
  circle_pct: number | null;
  near_wall_pct: number | null;
  touching_wall_pct: number | null;
  reverse_speed_pct: number | null;
  mean_distance: number | null;
}

export interface SelfHitsSummary {
  count: number;
  pct_of_shots: number | null;
  damage: number;
  pct_of_damage_taken: number | null;
  kinds: Record<string, number>;
  autofire_on: number;
  toward_wall: number;
  standing: number;
  with_los: number;
  wall_distance_median: number | null;
  incidence_median_deg: number | null;
  flight_ticks_median: number | null;
}

// Имена полей — контракт файла games.json.
export interface GameSummary {
  id: string;
  room: string;
  level: BotLevel | null;
  level_source: LevelSource | null;
  bot_name: string;
  human_name: string;
  human_side: Side;
  start_local: string;
  start_sec_utc: number;
  device: string;
  device_source: DeviceSource | null;
  client: ClientSummary;
  rounds: RoundSummary[];
  score_bot_human: [number, number];
  wins_human: number;
  wins_bot: number;
  human_stats: InferredStats;
  bot_stats: InferredStats;
  shooting_human: ShootingTotals;
  shooting_bot: ShootingTotals;
  hit_pct_human: number | null;
  hit_pct_bot: number | null;
  shot_kinds: Record<string, number>;
  shots_moving: HitShare;
  shots_standing: HitShare;
  shots_no_los: HitShare;
  shots_by_bucket: Record<string, HitShare>;
  lead_share_pct: number | null;
  lead_fraction_median: number | null;
  err_cur_median_deg: number | null;
  err_best_median_deg: number | null;
  shot_distance_median: number | null;
  aim_err_median_deg: number | null;
  aim_err_under5_pct: number | null;
  aim_time_ticks: number[];
  aim_time_median_ticks: number | null;
  movement: MovementSummary;
  hist: Record<Axis, Record<string, number>>;
  dynamics: DynamicsSummary;
  client_inputs: ClientInputs;
  self_hits: SelfHitsSummary;
  unknown_hits: number;
  lost_bullets: number;
  in_flight_bullets: number;
  leave: LeaveRecord | null;
}

export interface GameAnalysis {
  summary: GameSummary;
  shots: ShotRow[];
  selfHits: SelfHitRow[];
}

const BOT_NAMES = new Set(BOT_LEVELS.map((level) => BOT_LEVEL_INFO[level].name));

// Сторона человека — та, от которой есть строки клиента; если есть от обеих — та, чьё имя не из списка ботов.
function humanSideOf(game: ParsedGame): Side {
  const clientSides = SIDES.filter((side) => game.clientLines[side].length > 0);
  if (clientSides.length === 1) {
    return clientSides[0] ?? DEFAULT_HUMAN_SIDE;
  }
  return SIDES.find((side) => !BOT_NAMES.has(game.names[side])) ?? DEFAULT_HUMAN_SIDE;
}

function botLevelByName(name: string): BotLevel | null {
  return BOT_LEVELS.find((level) => BOT_LEVEL_INFO[level].name === name) ?? null;
}

function levelOf(room: string, botName: string): { level: BotLevel | null; source: LevelSource | null } {
  const byCode = botLevelOf(room);
  if (byCode !== null) {
    return { level: byCode, source: 'код' };
  }
  const byName = botLevelByName(botName);
  if (byName !== null) {
    return { level: byName, source: 'имя' };
  }
  return { level: null, source: null };
}

function localTime(sec: number, tzHours: number): string {
  const local = (sec + tzHours * SECONDS_PER_HOUR) % SECONDS_PER_DAY;
  const hours = String(Math.floor(local / SECONDS_PER_HOUR)).padStart(2, '0');
  const minutes = String(Math.floor((local % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function emptyShooting(): ShootingTotals {
  return {
    shots: 0,
    hits: 0,
    ricochet_hits: 0,
    self_hits: 0,
    self_damage: 0,
    damage_dealt: 0,
    damage_taken: 0,
    zone_damage: 0,
    kits: 0,
    bumps: 0,
    clashed: 0,
    deaths: 0,
  };
}

function hitShare(rows: readonly ShotRow[]): HitShare {
  const hits = count(rows, (row) => row.isHit);
  return { shots: rows.length, hits, pct: pct(hits, rows.length) };
}

function tally<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function isDamageTaken(hit: Hit, side: Side): boolean {
  return hit.victim === side;
}

function isDealtBy(hit: Hit, side: Side): boolean {
  return hit.cause === 'bullet' && hit.by === side;
}

function isSelfHitOf(hit: Hit, side: Side): boolean {
  return hit.cause === 'self' && hit.victim === side;
}

function addShooting(totals: ShootingTotals, round: ParsedRound, tracked: TrackedRound, side: Side): void {
  const { bullets, hits } = tracked;
  const mine = bullets.filter((bullet) => bullet.owner === side);
  totals.shots += mine.length;
  totals.hits += count(hits, (hit) => isDealtBy(hit, side));
  totals.ricochet_hits += count(hits, (hit) => isDealtBy(hit, side) && hit.isRicochet);
  totals.self_hits += count(hits, (hit) => isSelfHitOf(hit, side));
  totals.self_damage += sum(hits.filter((hit) => isSelfHitOf(hit, side)).map((hit) => hit.damage));
  totals.damage_dealt += sum(hits.filter((hit) => isDealtBy(hit, side)).map((hit) => hit.damage));
  totals.damage_taken += sum(hits.filter((hit) => isDamageTaken(hit, side)).map((hit) => hit.damage));
  totals.zone_damage += sum(hits.filter((hit) => hit.victim === side && hit.cause === 'zone').map((hit) => hit.damage));
  totals.kits += count(round.events, (event) => event.kind === EVENT_KIND.pickup && event.side === side);
  totals.bumps += count(round.events, (event) => event.kind === EVENT_KIND.bump && event.side === side);
  totals.clashed += count(mine, (bullet) => bullet.outcome === 'clash');
  totals.deaths += count(round.events, (event) => event.kind === EVENT_KIND.death && event.side === side);
}

function roundSummary(round: ParsedRound): RoundSummary {
  const over = round.events.find((event) => event.kind === EVENT_KIND.roundOver);
  const hasDeath = round.events.some((event) => event.kind === EVENT_KIND.death);
  const fightTicks = round.ticks.filter((tick) => tick.phase === FIGHT_PHASE);
  const lastFightTick = fightTicks[fightTicks.length - 1];
  let reason: RoundReason = 'прервано';
  if (over !== undefined) {
    reason = hasDeath ? 'kill' : 'time';
  }
  return {
    idx: round.idx,
    map: round.mapIndex,
    map_name: mapByIndex(round.mapIndex).name,
    winner: over?.side ?? null,
    finished: over !== undefined,
    reason,
    duration_s: roundTo(lastFightTick === undefined ? 0 : lastFightTick.rt / TICK_RATE, 1),
    score_before: round.scoreBefore,
    human_shots: 0,
    human_hits: 0,
    bot_shots: 0,
    bot_hits: 0,
    human_damage_taken: 0,
    bot_damage_taken: 0,
    human_bumps: 0,
    human_shot_distance_median: null,
    human_los_pct: null,
    human_lead_pct: null,
    human_first_hit_s: null,
    bot_first_hit_s: null,
    human_won: null,
    aim_err_median_deg: null,
  };
}

function secondsFromFightStart(round: ParsedRound, gt: number | undefined): number | null {
  if (gt === undefined) {
    return null;
  }
  const fightStartGt = round.ticks.find((tick) => tick.phase === FIGHT_PHASE)?.gt ?? round.startGt;
  return roundTo((gt - fightStartGt) / TICK_RATE, 1);
}

// Запас здоровья виден только в раундах, где сторона погибла: полученный урон минус лечение.
function damageTakenByDeathRound(
  rounds: readonly ParsedRound[],
  tracked: readonly TrackedRound[],
  side: Side,
): number[] {
  const sums: number[] = [];
  rounds.forEach((round, index) => {
    const hasDied = round.events.some((event) => event.kind === EVENT_KIND.death && event.side === side);
    if (!hasDied) {
      return;
    }
    const healed = sum(
      round.events.filter((event) => event.kind === EVENT_KIND.pickup && event.side === side).map((event) => event.v),
    );
    const hits = tracked[index]?.hits ?? [];
    sums.push(sum(hits.filter((hit) => isDamageTaken(hit, side)).map((hit) => hit.damage)) - healed);
  });
  return sums;
}

function histogramRecord(histogram: Map<string, number>): Record<string, number> {
  return Object.fromEntries(histogram);
}

export function analyzeGame(game: ParsedGame, devices: DeviceIndex, tzHours: number): GameAnalysis {
  const human = humanSideOf(game);
  const bot: Side = human === 0 ? 1 : 0;
  const botName = game.names[bot];
  const { level, source: levelSource } = levelOf(game.room, botName);
  const wallsOf = (round: ParsedRound): Wall[] => mapByIndex(round.mapIndex).walls;

  // Скорости снарядов нужны до прослеживания, здоровье — после: оно считается по разобранным попаданиям.
  const speeds: [number, number] = [inferBulletSpeed(game.rounds, 0).speed, inferBulletSpeed(game.rounds, 1).speed];
  const tracked = game.rounds.map((round) => trackRound(round, speeds, wallsOf(round)));
  const stats: [InferredStats, InferredStats] = [
    inferStats(game.rounds, 0, damageTakenByDeathRound(game.rounds, tracked, 0)),
    inferStats(game.rounds, 1, damageTakenByDeathRound(game.rounds, tracked, 1)),
  ];

  const rounds: RoundSummary[] = [];
  const shooting: [ShootingTotals, ShootingTotals] = [emptyShooting(), emptyShooting()];
  const shotRows: ShotRow[] = [];
  const selfHitRows: SelfHitRow[] = [];
  const aimErrors: number[] = [];
  const aimTimes: number[] = [];
  const movement = emptyMovement();
  const dynamics = emptyDynamics();
  let unknownHits = 0;
  const autofireChanges = autofireChangesOf(game.clientLines[human]);

  game.rounds.forEach((round, index) => {
    const trackedRound = tracked[index] ?? { bullets: [], hits: [] };
    const { bullets, hits } = trackedRound;
    const walls = wallsOf(round);
    const summary = roundSummary(round);
    selfHitRows.push(...analyzeSelfHits(round, bullets, hits, human, bot, walls, autofireChanges));
    addDynamics(dynamics, analyzeDynamics(round, human, bot, walls));
    for (const side of SIDES) {
      addShooting(shooting[side], round, trackedRound, side);
    }
    unknownHits += count(hits, (hit) => hit.cause === 'unknown');

    const humanRows = analyzeShots(round, bullets, human, bot, speeds[human], walls);
    shotRows.push(...humanRows);
    summary.human_shots = humanRows.length;
    summary.human_hits = count(humanRows, (row) => row.isHit);
    summary.bot_shots = count(bullets, (bullet: TrackedBullet) => bullet.owner === bot);
    summary.bot_hits = count(hits, (hit) => isDealtBy(hit, bot));
    summary.human_damage_taken = roundTo(sum(hits.filter((hit) => hit.victim === human).map((hit) => hit.damage)), 1);
    summary.bot_damage_taken = roundTo(sum(hits.filter((hit) => hit.victim === bot).map((hit) => hit.damage)), 1);
    summary.human_bumps = count(round.events, (event) => event.kind === EVENT_KIND.bump && event.side === human);
    const distanceMedian = median(humanRows.map((row) => row.distance));
    summary.human_shot_distance_median = distanceMedian === null ? null : roundTo(distanceMedian, 0);
    summary.human_los_pct = pct(
      count(humanRows, (row) => row.hasLineOfSight),
      humanRows.length,
    );
    summary.human_lead_pct = pct(
      count(humanRows, (row) => row.kind === SHOT_KIND.lead),
      count(humanRows, (row) => row.isMoving),
    );
    summary.human_first_hit_s = secondsFromFightStart(round, hits.find((hit) => isDealtBy(hit, human))?.gt);
    summary.bot_first_hit_s = secondsFromFightStart(round, hits.find((hit) => isDealtBy(hit, bot))?.gt);
    summary.human_won = summary.finished ? summary.winner === human : null;
    const aim = analyzeAimTracking(round, human, bot, walls);
    aimErrors.push(...aim.errorsWithSightDeg);
    aimTimes.push(...aim.aimTimesTicks);
    const aimMedian = median(aim.errorsWithSightDeg);
    summary.aim_err_median_deg = aimMedian === null ? null : roundTo(aimMedian, 1);
    addMovement(movement, analyzeMovement(round, human));
    rounds.push(summary);
  });

  const shotKinds = tally(shotRows, (row) => row.kind);
  const movingRows = shotRows.filter((row) => row.isMoving);
  const leadFractions = movingRows
    .map((row) => row.leadFraction)
    .filter((value): value is number => value !== null && value >= LEAD_FRACTION_MIN && value <= LEAD_FRACTION_MAX);
  const finished = rounds.filter((round) => round.finished);
  const score: [number, number] = [
    count(finished, (round) => round.winner === 0),
    count(finished, (round) => round.winner === 1),
  ];
  const device = pickDevice(devices, game.room, human, game.names[human], game.startSec);
  const fightTicks = movement.fightTicks;
  const fightMinutes = fightTicks / TICK_RATE / SECONDS_PER_MINUTE;
  const perMinute = (value: number): number | null => (fightMinutes === 0 ? null : roundTo(value / fightMinutes, 1));
  const dynTicks = dynamics.ticks;
  const selfHitDamage = sum(selfHitRows.map((row) => row.damage));
  const humanShooting = shooting[human];
  const errBest = median(shotRows.map((row) => Math.min(row.errCurDeg, row.errLeadDeg)));
  const errCur = median(shotRows.map((row) => row.errCurDeg));
  const shotDistance = median(shotRows.map((row) => row.distance));
  const aimErrMedian = median(aimErrors);
  const leadFractionMedian = median(leadFractions);
  const meanDistance = dynTicks === 0 ? null : roundTo(dynamics.distanceSum / dynTicks, 0);
  const histogram = {} as Record<Axis, Record<string, number>>;
  for (const axis of AXES) {
    histogram[axis] = histogramRecord(movement.histogram[axis]);
  }

  const summary: GameSummary = {
    id: game.id,
    room: game.room,
    level,
    level_source: levelSource,
    bot_name: botName,
    human_name: game.names[human],
    human_side: human,
    start_local: localTime(game.startSec, tzHours),
    start_sec_utc: game.startSec,
    device: device === null ? `? (ник ${game.names[human]})` : deviceLabel(device.entry),
    device_source: device === null ? null : device.source,
    client: clientSummary(game.clientLines[human]),
    rounds,
    score_bot_human: score,
    wins_human: score[human],
    wins_bot: score[bot],
    human_stats: stats[human],
    bot_stats: stats[bot],
    shooting_human: humanShooting,
    shooting_bot: shooting[bot],
    hit_pct_human: pct(humanShooting.hits, humanShooting.shots),
    hit_pct_bot: pct(shooting[bot].hits, shooting[bot].shots),
    shot_kinds: shotKinds,
    shots_moving: hitShare(movingRows),
    shots_standing: hitShare(shotRows.filter((row) => !row.isMoving)),
    shots_no_los: hitShare(shotRows.filter((row) => !row.hasLineOfSight)),
    shots_by_bucket: Object.fromEntries(
      DISTANCE_BUCKETS.map((bucket) => [bucket.label, hitShare(shotRows.filter((row) => row.bucket === bucket.label))]),
    ),
    lead_share_pct: pct(shotKinds[SHOT_KIND.lead] ?? 0, movingRows.length),
    lead_fraction_median: leadFractionMedian === null ? null : roundTo(leadFractionMedian, 2),
    err_cur_median_deg: errCur === null ? null : roundTo(errCur, 1),
    err_best_median_deg: errBest === null ? null : roundTo(errBest, 1),
    shot_distance_median: shotDistance === null ? null : roundTo(shotDistance, 0),
    aim_err_median_deg: aimErrMedian === null ? null : roundTo(aimErrMedian, 1),
    aim_err_under5_pct: pct(
      count(aimErrors, (error) => error < AIM_GOOD_DEG),
      aimErrors.length,
    ),
    aim_time_ticks: aimTimes,
    aim_time_median_ticks: median(aimTimes),
    movement: {
      fight_ticks: fightTicks,
      full_throttle_pct: pct(movement.fullThrottleTicks, fightTicks),
      reverse_pct: pct(movement.reverseTicks, fightTicks),
      idle_pct: pct(movement.idleTicks, fightTicks),
      mean_speed: movement.speedSamples === 0 ? null : roundTo(movement.speedSum / movement.speedSamples, 1),
      bumps: humanShooting.bumps,
      bumps_per_min: perMinute(humanShooting.bumps),
      silent_ticks: movement.silentTicks,
      batched_inputs: movement.batchedInputs,
      dropped_inputs: game.droppedInputs[human],
    },
    hist: histogram,
    dynamics: {
      throttle_flips_per_min: perMinute(dynamics.throttleFlips),
      flip_settle_ticks_median: median(dynamics.flipSettleTicks),
      sharp_stops_per_min: perMinute(dynamics.sharpStops),
      turnarounds_per_min: perMinute(dynamics.turnarounds),
      turnaround_ticks_median: median(dynamics.turnaroundTicks),
      kite_pct: pct(dynamics.kiteTicks, dynTicks),
      circle_pct: pct(dynamics.circleTicks, dynTicks),
      near_wall_pct: pct(dynamics.nearWallTicks, dynTicks),
      touching_wall_pct: pct(dynamics.touchingWallTicks, dynTicks),
      reverse_speed_pct: pct(dynamics.reverseSpeedTicks, dynTicks),
      mean_distance: meanDistance,
    },
    client_inputs: analyzeClientInputs(game.clientLines[human]),
    self_hits: {
      count: selfHitRows.length,
      pct_of_shots: pct(selfHitRows.length, humanShooting.shots),
      damage: selfHitDamage,
      pct_of_damage_taken: pct(selfHitDamage, humanShooting.damage_taken),
      kinds: tally(selfHitRows, (row) => row.kind),
      autofire_on: count(selfHitRows, (row) => row.isAutofireOn),
      toward_wall: count(selfHitRows, (row) => row.isTowardWall),
      standing: count(selfHitRows, (row) => row.speed <= MOVING_SPEED),
      with_los: count(selfHitRows, (row) => row.hasLineOfSight),
      wall_distance_median: median(selfHitRows.map((row) => row.wallDistance)),
      incidence_median_deg: median(selfHitRows.map((row) => row.incidenceDeg)),
      flight_ticks_median: median(selfHitRows.map((row) => row.flightTicks)),
    },
    unknown_hits: unknownHits,
    lost_bullets: count(
      tracked.flatMap((round) => round.bullets),
      (bullet) => bullet.outcome === 'lost',
    ),
    in_flight_bullets: count(
      tracked.flatMap((round) => round.bullets),
      (bullet) => bullet.outcome === 'in_flight',
    ),
    leave: game.leave,
  };
  return { summary, shots: shotRows, selfHits: selfHitRows };
}
