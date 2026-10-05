import type { Stats } from '@tanks/shared/engine';

// patrol — случайные точки внутри зоны, к цели не идёт; approach — сближение и удержание дистанции;
// circle — круг вокруг цели в перестрелке.
export type CrowdMovement = 'patrol' | 'approach' | 'circle';

export type CrowdLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7;

// Профиль уровня толпы: как бот стреляет и ходит. Тело мозга у всех уровней общее.
export interface CrowdProfile {
  name: string;
  stats: Stats;
  // Чужие танки и снаряды бот видит снимком такой давности: модель времени реакции.
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
  movement: CrowdMovement;
  // Вероятность заметить чужой опасный снаряд и уйти от него.
  dodgeChance: number;
  hasKits: boolean;
  throttleCap: number;
  // Патруль замирает на полсекунды с таким периодом; null — без пауз.
  pauseEverySec: number | null;
  // Вероятность на выстрел не проверить, вернётся ли снаряд рикошетом, и не уйти от своего вернувшегося.
  carelessness: number;
}

const SLOW_GUN: Stats = { armor: 3, engine: 3, gun: 1, reload: 2 };
const HUNTER: Stats = { armor: 3, engine: 3, gun: 2, reload: 2 };

export const CROWD_PROFILES: Readonly<Record<CrowdLevel, CrowdProfile>> = {
  1: {
    name: 'Манекен',
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
    carelessness: 0.7,
  },
  2: {
    name: 'Прогульщик',
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
    carelessness: 0.5,
  },
  3: {
    name: 'Новобранец',
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
    carelessness: 0.3,
  },
  4: {
    name: 'Сержант',
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
    carelessness: 0,
  },
  5: {
    name: 'Ветеран',
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
    carelessness: 0,
  },
  6: {
    name: 'Снайпер',
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
    carelessness: 0,
  },
  7: {
    name: 'Призрак',
    stats: HUNTER,
    reactionTicks: 3,
    aimNoiseRad: 0.03,
    fireWindowRad: 0.09,
    fireChance: 1,
    leadChance: 0.75,
    leadQuality: 0.9,
    movement: 'circle',
    dodgeChance: 0.5,
    hasKits: true,
    throttleCap: 1,
    pauseEverySec: null,
    carelessness: 0,
  },
};

const TOP_LEVEL: CrowdLevel = 7;
// Чем ниже уровень, тем ботов больше; уровень 7 — один на весь состав.
const PYRAMID_WEIGHTS: readonly (readonly [CrowdLevel, number])[] = [
  [1, 7],
  [2, 6],
  [3, 5],
  [4, 4],
  [5, 3],
  [6, 2],
];

// Уровни состава по возрастанию: один бот уровня 7 (если ботов больше одного), остальные — по весам пирамиды
// с округлением по наибольшему остатку; при равных остатках добавка достаётся младшему уровню.
export function crowdPyramid(count: number): CrowdLevel[] {
  if (count <= 0) {
    return [];
  }
  if (count === 1) {
    return [1];
  }
  const rest = count - 1;
  const totalWeight = PYRAMID_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  const shares = PYRAMID_WEIGHTS.map(([level, weight]) => {
    const exact = (rest * weight) / totalWeight;
    return { level, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let missing = rest - shares.reduce((sum, share) => sum + share.count, 0);
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder || a.level - b.level)) {
    if (missing <= 0) {
      break;
    }
    share.count++;
    missing--;
  }
  const levels = shares.flatMap((share) => Array.from({ length: share.count }, () => share.level));
  return [...levels, TOP_LEVEL];
}
