import type { Stats } from '@tanks/shared/engine';

// patrol — случайные точки карты, к противнику не идёт; approach — сближение и удержание дистанции;
// circle — круг вокруг противника в перестрелке; dodge — круг плюс уход от видимых пуль.
export type Movement = 'patrol' | 'approach' | 'circle' | 'dodge';

// Профиль уровня: как бот стреляет и как ходит. Тело (путь по сетке, зона, аптечки) у всех уровней общее.
export interface BotProfile {
  stats: Stats;
  // Бот действует по снимку такой давности: модель времени реакции.
  reactionTicks: number;
  // Случайное отклонение прицела, пересэмплируется раз в полсекунды.
  aimNoiseRad: number;
  // Насколько точно надо навестись, чтобы нажать на спуск.
  fireWindowRad: number;
  // Вероятность выстрелить, когда готов и наведён; неудача — пауза перед новой попыткой.
  fireChance: number;
  // Монетка на каждый выстрел: целиться с упреждением или в текущее положение.
  leadChance: number;
  // Доля скорости цели, которую учитывает упреждение.
  leadQuality: number;
  movement: Movement;
  // Вероятность отреагировать на конкретную пулю в режиме dodge.
  dodgeChance: number;
  hasKits: boolean;
  throttleCap: number;
  // Патруль замирает на полсекунды с таким периодом; null — без пауз.
  pauseEverySec: number | null;
  // Шаг вбок, когда противник наведён и его перезарядка на исходе.
  hasReadyPose: boolean;
}

export type LadderLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

const SLOW_GUN: Stats = { armor: 3, engine: 3, gun: 1, reload: 2 };
const HUNTER: Stats = { armor: 3, engine: 3, gun: 2, reload: 2 };
const ACE: Stats = { armor: 0, engine: 0, gun: 5, reload: 5 };

const HUNTER_PROFILE: BotProfile = {
  stats: HUNTER,
  reactionTicks: 0,
  aimNoiseRad: 0,
  fireWindowRad: 0.07,
  fireChance: 1,
  leadChance: 1,
  leadQuality: 1,
  movement: 'dodge',
  dodgeChance: 1,
  hasKits: true,
  throttleCap: 1,
  pauseEverySec: null,
  hasReadyPose: false,
};

export const PROFILES: Readonly<Record<LadderLevel, BotProfile>> = {
  1: {
    stats: SLOW_GUN,
    reactionTicks: 12,
    aimNoiseRad: 0.35,
    fireWindowRad: 0.3,
    fireChance: 0.3,
    leadChance: 0,
    leadQuality: 0,
    movement: 'patrol',
    dodgeChance: 0,
    hasKits: false,
    throttleCap: 0.6,
    pauseEverySec: 4,
    hasReadyPose: false,
  },
  2: {
    stats: SLOW_GUN,
    reactionTicks: 11,
    aimNoiseRad: 0.25,
    fireWindowRad: 0.25,
    fireChance: 0.5,
    leadChance: 0,
    leadQuality: 0,
    movement: 'patrol',
    dodgeChance: 0,
    hasKits: false,
    throttleCap: 0.7,
    pauseEverySec: 6,
    hasReadyPose: false,
  },
  3: {
    stats: SLOW_GUN,
    reactionTicks: 9,
    aimNoiseRad: 0.1,
    fireWindowRad: 0.2,
    fireChance: 1,
    leadChance: 0,
    leadQuality: 0,
    movement: 'approach',
    dodgeChance: 0,
    hasKits: false,
    throttleCap: 0.85,
    pauseEverySec: null,
    hasReadyPose: false,
  },
  4: {
    stats: HUNTER,
    reactionTicks: 8,
    aimNoiseRad: 0.1,
    fireWindowRad: 0.16,
    fireChance: 1,
    leadChance: 0,
    leadQuality: 0,
    movement: 'approach',
    dodgeChance: 0,
    hasKits: true,
    throttleCap: 1,
    pauseEverySec: null,
    hasReadyPose: false,
  },
  5: {
    stats: HUNTER,
    reactionTicks: 5,
    aimNoiseRad: 0.05,
    fireWindowRad: 0.12,
    fireChance: 1,
    leadChance: 0.3,
    leadQuality: 0.6,
    movement: 'circle',
    dodgeChance: 0,
    hasKits: true,
    throttleCap: 1,
    pauseEverySec: null,
    hasReadyPose: false,
  },
  6: {
    stats: HUNTER,
    reactionTicks: 4,
    aimNoiseRad: 0.04,
    fireWindowRad: 0.1,
    fireChance: 1,
    leadChance: 0.55,
    leadQuality: 0.75,
    movement: 'circle',
    dodgeChance: 0,
    hasKits: true,
    throttleCap: 1,
    pauseEverySec: null,
    hasReadyPose: false,
  },
  7: {
    stats: HUNTER,
    reactionTicks: 3,
    aimNoiseRad: 0.03,
    fireWindowRad: 0.09,
    fireChance: 1,
    leadChance: 0.75,
    leadQuality: 0.9,
    movement: 'dodge',
    dodgeChance: 0.5,
    hasKits: true,
    throttleCap: 1,
    pauseEverySec: null,
    hasReadyPose: false,
  },
  8: HUNTER_PROFILE,
  9: { ...HUNTER_PROFILE, stats: ACE, fireWindowRad: 0.05, hasReadyPose: true },
};
