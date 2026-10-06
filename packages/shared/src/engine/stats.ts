import {
  BULLET_SPEED_BASE,
  BULLET_SPEED_PER_GUN,
  DEFAULT_STATS,
  STAT_KEYS,
  STAT_MAX,
  STAT_POINTS,
  TURRET_RATE,
} from './constants.js';

export type StatKey = (typeof STAT_KEYS)[number];
export type Stats = Record<StatKey, number>;

export interface DerivedStats extends Stats {
  maxHp: number;
  maxSpeed: number;
  turnRate: number;
  turretRate: number;
  damage: number;
  bulletSpeed: number;
  reloadTime: number;
}

export type StatsCheck = { isOk: true; total: number } | { isOk: false; error: string };

export function checkStats(stats: unknown): StatsCheck {
  if (typeof stats !== 'object' || stats === null) {
    return { isOk: false, error: 'stats не заданы' };
  }
  const record = stats as Record<string, unknown>;
  let total = 0;
  for (const key of STAT_KEYS) {
    const value = record[key];
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > STAT_MAX) {
      return { isOk: false, error: `stats.${key} должно быть целым от 0 до ${String(STAT_MAX)}` };
    }
    total += value as number;
  }
  if (total > STAT_POINTS) {
    return { isOk: false, error: `сумма очков ${String(total)} больше ${String(STAT_POINTS)}` };
  }
  return { isOk: true, total };
}

export function deriveStats(stats: unknown): DerivedStats {
  const source: Stats = checkStats(stats).isOk ? (stats as Stats) : DEFAULT_STATS;
  return {
    armor: source.armor,
    engine: source.engine,
    gun: source.gun,
    reload: source.reload,
    maxHp: 100 + 25 * source.armor,
    maxSpeed: 110 + 22 * source.engine,
    turnRate: 1.8 + 0.25 * source.engine,
    turretRate: TURRET_RATE,
    damage: 18 + 5 * source.gun,
    bulletSpeed: BULLET_SPEED_BASE + BULLET_SPEED_PER_GUN * source.gun,
    reloadTime: Math.round((1.3 - 0.16 * source.reload) * 100) / 100,
  };
}
