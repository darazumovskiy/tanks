import { botView, createRound, DEFAULT_STATS, type BulletView, type Kit, type Side } from '@tanks/shared/engine';
import type { TwinView } from './brain/brain.js';
import { COURSE_BAND_LABELS, type CourseBandLabel, type DistanceBucketLabel } from '@tanks/analysis';
import type { SightKey, TwinCalibration, TwinProfile } from './profile.js';

// Крафтовые виды и профили для тестов мозга, игрока и стенда.

const UNIFORM_DECILES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const ZERO_DECILES = UNIFORM_DECILES.map(() => 0);
const ALWAYS_HELD = 1;
const HALF_TURN_DEG = 180;
// Угол хода к линии на противника равномерно от 0 до 180° в любой видимости и на любой дистанции.
const UNIFORM_COURSE_DEG = UNIFORM_DECILES.map((value) => (value * HALF_TURN_DEG) / 10);
const DECISION_MEAN_S = 0.5;
const COURSE_REACH = 150;

export function byBand<T>(value: T): Record<DistanceBucketLabel, T> {
  return { '<300': value, '300–600': value, '>600': value };
}

export function byCourseBand<T>(value: T): Record<CourseBandLabel, T> {
  return Object.fromEntries(COURSE_BAND_LABELS.map((label) => [label, value])) as Record<CourseBandLabel, T>;
}

export function courseWith(deciles: number[]): Record<SightKey, Record<CourseBandLabel, number[]>> {
  return { sight: byCourseBand(deciles), hidden: byCourseBand(deciles) };
}

export function calibrationWith(overrides: Partial<TwinCalibration> = {}): TwinCalibration {
  return {
    correlationTicks: 1,
    lagTicks: 0,
    holdShare: {
      'visible|<300': ALWAYS_HELD,
      'visible|300–600': ALWAYS_HELD,
      'visible|>600': ALWAYS_HELD,
      'hidden|<300': ALWAYS_HELD,
      'hidden|300–600': ALWAYS_HELD,
      'hidden|>600': ALWAYS_HELD,
    },
    decisionMeanS: DECISION_MEAN_S,
    courseReach: COURSE_REACH,
    reverseChance: 0,
    kitShare: { closer: 0, farther: 0 },
    kitFollowShare: 0,
    hiddenAim: { bearing: 0, exit: 0, ricochet: 0, lastSeen: 0 },
    coverHoldShare: ALWAYS_HELD,
    returnAvoidShare: 0,
    ...overrides,
  };
}

// Профиль без ошибки руки, с огнём с первого тика и без длинных пауз; отдельные блоки подменяет тест.
export function profileWith(overrides: Partial<TwinProfile> = {}): TwinProfile {
  return {
    name: 'phone',
    control: 'sticks',
    channel: { uplinkTicks: 0, downlinkTicks: 0, interpolationTicks: 0 },
    settings: { pivotThrottle: 0.6 },
    hand: { errorDecilesDeg: byBand(ZERO_DECILES), leadShare: 0 },
    fire: {
      noStartPauseShare: 1,
      startPauseDecilesS: UNIFORM_DECILES,
      releaseMeanS: 0.5,
      longPausePerMinute: 0,
      longPauseDecilesS: UNIFORM_DECILES,
    },
    manoeuvre: {
      stickDeciles: UNIFORM_DECILES.map(() => 1),
      courseDecilesDeg: courseWith(UNIFORM_COURSE_DEG),
    },
    cover: null,
    modeSwitch: { enter: null, leave: null },
    hiddenAimTargets: [],
    calibration: calibrationWith(),
    ...overrides,
  };
}

export interface TankSpec {
  x: number;
  y: number;
  heading?: number;
  turret?: number;
  speed?: number;
}

export interface ViewSpec {
  mapIndex?: number;
  side?: Side;
  me: TankSpec;
  enemy: TankSpec;
  tick?: number;
  bullets?: BulletView[];
  zoneRadius?: number;
  kits?: Kit[];
}

export function craftView(spec: ViewSpec): TwinView {
  const side = spec.side ?? 1;
  const round = createRound(spec.mapIndex ?? 0, [
    { name: 'a', stats: DEFAULT_STATS },
    { name: 'b', stats: DEFAULT_STATS },
  ]);
  const place = (target: Side, tank: TankSpec): void => {
    const placed = round.tanks[target];
    placed.x = tank.x;
    placed.y = tank.y;
    placed.heading = tank.heading ?? 0;
    placed.turret = tank.turret ?? tank.heading ?? 0;
    placed.speed = tank.speed ?? 0;
  };
  place(side, spec.me);
  place(side === 0 ? 1 : 0, spec.enemy);
  round.tick = spec.tick ?? 1;
  if (spec.zoneRadius !== undefined) {
    round.zone.radius = spec.zoneRadius;
  }
  if (spec.kits !== undefined) {
    round.kits = spec.kits.map((kit) => ({ ...kit }));
  }
  const view = botView(round, side);
  return { ...view, bullets: spec.bullets ?? [], hits: [] };
}
