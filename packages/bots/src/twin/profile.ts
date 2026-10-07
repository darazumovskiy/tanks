import type {
  Coefficients,
  CourseBandLabel,
  DistanceBucketLabel,
  FireContext,
  HiddenAimTarget,
  KitSide,
} from '@tanks/analysis/ruler';
import type { Stats } from '@tanks/shared/engine';
import type { BotLevel } from '@tanks/shared/protocol';

export const TWIN_PROFILE_NAMES = ['phone', 'pc'] as const;
export type TwinProfileName = (typeof TWIN_PROFILE_NAMES)[number];

// Противник на виду или не виден: у решений манёвра свои распределения для каждого случая.
export const SIGHT_KEYS = ['sight', 'hidden'] as const;
export type SightKey = (typeof SIGHT_KEYS)[number];

// Параметры, которые подбираются калибровкой по своим метрикам-входам. hiddenAim — доли решений, на которых
// башня без видимости ведётся на цель; kitShare — доля решений манёвра, на которых танк едет к аптечке;
// kitFollowShare — доля начатых поездок к аптечке, которые танк доводит, пока аптечку не подберут.
export interface TwinCalibration {
  correlationTicks: number;
  lagTicks: number;
  holdShare: Record<FireContext, number>;
  decisionMeanS: number;
  courseReach: number;
  reverseChance: number;
  kitShare: Record<KitSide, number>;
  kitFollowShare: number;
  hiddenAim: Record<HiddenAimTarget, number>;
  coverHoldShare: number;
  returnAvoidShare: number;
}

export interface Band {
  near: number;
  far: number;
}

export interface TwinProfile {
  name: TwinProfileName;
  control: 'sticks' | 'mouseKeys';
  channel: { uplinkTicks: number; downlinkTicks: number; interpolationTicks: number };
  settings: { pivotThrottle: number };
  hand: { errorDecilesDeg: Record<DistanceBucketLabel, number[]>; leadShare: number };
  fire: {
    noStartPauseShare: number;
    startPauseDecilesS: number[];
    releaseMeanS: number;
    longPausePerMinute: number;
    longPauseDecilesS: number[];
  };
  manoeuvre: {
    stickDeciles: number[];
    courseDecilesDeg: Record<SightKey, Record<CourseBandLabel, number[]>>;
  };
  cover: { distanceBand: Band; wallDistanceBand: Band } | null;
  modeSwitch: { enter: Coefficients | null; leave: Coefficients | null };
  hiddenAimTargets: HiddenAimTarget[];
  calibration: TwinCalibration | null;
}

// Двойник-соперник в игре: профиль, характеристики и предохранитель рикошета игрока, уровень соперника для
// признака выбора режима.
export interface TwinRival {
  profile: TwinProfile;
  stats: Stats;
  hasRicochetGuard: boolean;
  opponentLevel: BotLevel;
}

// Файл профиля соперника пишет пакет двойника, его совпадение со справкой и калибровкой держит тест пакета;
// форма файла не проверяется.
export function parseTwinRival(text: string): TwinRival {
  return JSON.parse(text) as TwinRival;
}
