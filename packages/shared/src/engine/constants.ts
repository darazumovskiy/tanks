export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;
export const ARENA = { width: 1600, height: 900 } as const;
export const ROUND_SECONDS = 120;
export const TANK_RADIUS = 24;
export const BULLET_RADIUS = 5;
export const BULLET_LIFETIME = 4;
export const BULLET_BOUNCES = 1;
export const MUZZLE_OFFSET = TANK_RADIUS + 10;
export const TURRET_RATE = 2.8;
export const ACCEL = 420;
export const REVERSE_FACTOR = 0.6;
export const WALL_HIT_SPEED_FACTOR = 0.6;
export const WALL_BUMP_MIN_SPEED = 60;
export const WALL_SLIDE_MAX_PERCENT = 100;
export const WALL_BUMP_MIN_DROP = 25;
export const KIT = { radius: 16, heal: 50, firstSpawn: 15, respawn: 20 } as const;
export const ZONE = { startShrink: 60, endShrink: 100, finalRadius: 170, damagePerSecond: 20 } as const;
// Зона начинает сжиматься с круга, описанного вокруг поля, с запасом.
export const ZONE_START_MARGIN = 60;
// Сжатие зоны — доли длительности матча: при 120 с это 45–105 с. Окно обзора — прямоугольник вокруг своего
// танка: дальше него в бою толпы не видят ни камера, ни боты.
export const FFA = {
  viewWidth: 1600,
  viewHeight: 900,
  matchSeconds: 120,
  respawnSeconds: 4,
  wreckSeconds: 2,
  shieldSeconds: 3,
  zoneStartShare: 0.375,
  zoneEndShare: 0.875,
  finalRadiusPerRootPlayer: 120,
  suddenDeathShare: 0.5,
  spawnLookaheadSeconds: 5,
  efficiencyTankWeight: 150,
} as const;
export const SPAWN = {
  scoreCap: 1500,
  lineOfFirePenalty: 1000,
  nearBestShare: 0.8,
  placementTries: 24,
  tankGap: 8,
} as const;
export const STAT_POINTS = 10;
export const STAT_MAX = 5;
export const STAT_KEYS = ['armor', 'engine', 'gun', 'reload'] as const;
export const DEFAULT_STATS = { armor: 3, engine: 3, gun: 2, reload: 2 } as const;
