import type { BotLevel } from '@tanks/shared/protocol';

// Выбор режима — два потока событий: «манёвр → позиция» и «позиция → манёвр». Вероятность перехода за
// секунду — логистическая функция признаков в начале секунды.
export const MODE_FEATURE_NAMES = [
  'class8',
  'class9',
  'class10',
  'lossStreak',
  'roundIndex',
  'recentDamageShare',
  'healthShare',
  'exchangeShare',
  'hasCover',
  'fightSeconds',
  'positionSeconds',
] as const;
export type ModeFeatureName = (typeof MODE_FEATURE_NAMES)[number];

export interface Coefficients {
  intercept: number;
  weights: Record<ModeFeatureName, number>;
}

const BOT_CLASS_EDGES = [8, 9, 10] as const;
const BOT_CLASSES = ['3–7', '8', '9', '10'] as const;
export type BotClass = (typeof BOT_CLASSES)[number];

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

export function botClassOf(level: BotLevel): BotClass {
  const index = BOT_CLASS_EDGES.findIndex((edge) => level === edge);
  return BOT_CLASSES[index + 1] ?? '3–7';
}

export function featureVector(features: ModeFeatures, positionSeconds: number): Record<ModeFeatureName, number> {
  return {
    class8: features.botClass === '8' ? 1 : 0,
    class9: features.botClass === '9' ? 1 : 0,
    class10: features.botClass === '10' ? 1 : 0,
    lossStreak: features.lossStreak,
    roundIndex: features.roundIndex,
    recentDamageShare: features.recentDamageShare,
    healthShare: features.healthShare,
    exchangeShare: features.exchangeShare,
    hasCover: features.hasCover ? 1 : 0,
    fightSeconds: features.fightSeconds,
    positionSeconds,
  };
}

// Вероятность перехода за секунду по коэффициентам — та же модель, по которой их подбирает модуль метрик.
export function switchProbability(coefficients: Coefficients, features: ModeFeatures, positionSeconds: number): number {
  const vector = featureVector(features, positionSeconds);
  const logit = MODE_FEATURE_NAMES.reduce(
    (total, name) => total + coefficients.weights[name] * vector[name],
    coefficients.intercept,
  );
  return 1 / (1 + Math.exp(-logit));
}
