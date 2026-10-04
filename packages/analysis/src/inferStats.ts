import {
  DEFAULT_STATS,
  deriveStats,
  DT,
  STAT_MAX,
  TICK_RATE,
  type DerivedStats,
  type Side,
  type StatKey,
  type Stats,
} from '@tanks/shared/engine';
import { EVENT_KIND } from './bullets.js';
import { FIGHT_PHASE, type GameEvent, type ParsedRound } from './logParser.js';
import { median, mostCommon, nearest } from './numbers.js';

// Скорость снаряда меряется по первому рикошету или удару о стену не позже трёх секунд после выстрела,
// лежащему на луче выстрела: не ближе 60 единиц и не дальше 12 единиц в сторону от луча.
const SPEED_ESTIMATE_WINDOW_TICKS = 3 * TICK_RATE;
const SPEED_ESTIMATE_MIN_ALONG = 60;
const SPEED_ESTIMATE_MAX_ACROSS = 12;
// Событие пишется в конце тика, выстрел — в его начале: полёт длится на полтика дольше разницы номеров.
const SPEED_ESTIMATE_HALF_TICK = 0.5;
const SPEED_ESTIMATES_MIN = 3;
// Установившаяся скорость — выше 100: разгон и торможение в счёт не идут.
const SETTLED_SPEED_MIN = 100;

export interface InferredStats {
  armor: number | null;
  engine: number | null;
  gun: number;
  reload: number | null;
  bulletSpeed: number;
  bulletSpeedRaw: number | null;
  maxSpeedObserved: number | null;
  minShotIntervalTicks: number | null;
  maxHpObserved: number | null;
  damage: number;
}

export interface BulletSpeedEstimate {
  speed: number;
  raw: number | null;
}

const STAT_LEVELS = Array.from({ length: STAT_MAX + 1 }, (_, level) => level);
// Остальные характеристики на нуле: сумма очков не превышает лимит ни при каком уровне одной из них.
const ZERO_STATS: Stats = { armor: 0, engine: 0, gun: 0, reload: 0 };

function derivedAt(key: StatKey, level: number): DerivedStats {
  return deriveStats({ ...ZERO_STATS, [key]: level });
}

// Уровень характеристики, при котором производная величина ближе всего к наблюдённой.
function nearestLevel(key: StatKey, derivedKey: keyof DerivedStats, observed: number): number {
  const candidates = STAT_LEVELS.map((level) => derivedAt(key, level)[derivedKey]);
  return candidates.indexOf(nearest(observed, candidates));
}

// Меньше трёх измерений — скорость снаряда не восстановить; берётся снаряд билда по умолчанию.
const DEFAULT_BULLET_SPEED = deriveStats(DEFAULT_STATS).bulletSpeed;

// Конец полёта по прямой — только свой рикошет или удар о стену: у попадания в журнале нет владельца снаряда,
// и самопопадание противника, стоящего на луче, выдало бы завышенную скорость.
function isFlightEnd(event: GameEvent, side: Side): boolean {
  return (event.kind === EVENT_KIND.ricochet || event.kind === EVENT_KIND.impact) && event.side === side;
}

export function inferBulletSpeed(rounds: readonly ParsedRound[], side: Side): BulletSpeedEstimate {
  const estimates: number[] = [];
  for (const round of rounds) {
    const events = round.events;
    for (let i = 0; i < events.length; i++) {
      const shot = events[i];
      if (shot?.kind !== EVENT_KIND.shot || shot.side !== side) {
        continue;
      }
      const dx = Math.cos(shot.v);
      const dy = Math.sin(shot.v);
      for (const other of events.slice(i + 1)) {
        if (other.gt - shot.gt > SPEED_ESTIMATE_WINDOW_TICKS) {
          break;
        }
        if (!isFlightEnd(other, side) || other.gt === shot.gt) {
          continue;
        }
        const along = (other.x - shot.x) * dx + (other.y - shot.y) * dy;
        const across = Math.abs(-(other.x - shot.x) * dy + (other.y - shot.y) * dx);
        if (along > SPEED_ESTIMATE_MIN_ALONG && across < SPEED_ESTIMATE_MAX_ACROSS) {
          estimates.push(along / ((other.gt - shot.gt + SPEED_ESTIMATE_HALF_TICK) * DT));
          break;
        }
      }
    }
  }
  const raw = median(estimates);
  if (raw === null || estimates.length < SPEED_ESTIMATES_MIN) {
    return { speed: DEFAULT_BULLET_SPEED, raw: null };
  }
  const candidates = STAT_LEVELS.map((level) => derivedAt('gun', level).bulletSpeed);
  return { speed: nearest(raw, candidates), raw };
}

function inferMaxSpeed(rounds: readonly ParsedRound[], side: Side): number | null {
  const speeds: number[] = [];
  for (const round of rounds) {
    for (let i = 1; i < round.ticks.length; i++) {
      const prev = round.ticks[i - 1];
      const cur = round.ticks[i];
      if (prev === undefined || cur?.phase !== FIGHT_PHASE) {
        continue;
      }
      const speed =
        Math.hypot(cur.poses[side].x - prev.poses[side].x, cur.poses[side].y - prev.poses[side].y) * TICK_RATE;
      if (speed > SETTLED_SPEED_MIN) {
        speeds.push(Math.round(speed));
      }
    }
  }
  return mostCommon(speeds);
}

function inferMinShotInterval(rounds: readonly ParsedRound[], side: Side): number | null {
  let best: number | null = null;
  for (const round of rounds) {
    const shots = round.events.filter((event) => event.kind === EVENT_KIND.shot && event.side === side);
    for (let i = 1; i < shots.length; i++) {
      const interval = (shots[i]?.gt ?? 0) - (shots[i - 1]?.gt ?? 0);
      if (best === null || interval < best) {
        best = interval;
      }
    }
  }
  return best;
}

// Характеристики стороны по журналу: строки старта их не пишут.
// damageTakenByDeathRound — урон минус лечение в каждом раунде, где сторона погибла: это её запас здоровья.
export function inferStats(
  rounds: readonly ParsedRound[],
  side: Side,
  damageTakenByDeathRound: readonly number[],
): InferredStats {
  const bullet = inferBulletSpeed(rounds, side);
  const gun = nearestLevel('gun', 'bulletSpeed', bullet.speed);
  const maxSpeed = inferMaxSpeed(rounds, side);
  const minInterval = inferMinShotInterval(rounds, side);
  const hpEstimates = damageTakenByDeathRound.filter((value) => value > 0).map((value) => Math.round(value));
  const maxHp = mostCommon(hpEstimates);
  return {
    armor: maxHp === null ? null : nearestLevel('armor', 'maxHp', maxHp),
    engine: maxSpeed === null ? null : nearestLevel('engine', 'maxSpeed', maxSpeed),
    gun,
    reload: minInterval === null ? null : nearestLevel('reload', 'reloadTime', minInterval * DT),
    bulletSpeed: bullet.speed,
    bulletSpeedRaw: bullet.raw,
    maxSpeedObserved: maxSpeed,
    minShotIntervalTicks: minInterval,
    maxHpObserved: maxHp,
    damage: derivedAt('gun', gun).damage,
  };
}
