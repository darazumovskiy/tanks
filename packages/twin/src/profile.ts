import {
  COURSE_BANDS,
  DISTANCE_BUCKET_LABELS,
  distanceBucketOf,
  type Coefficients,
  type CourseBandLabel,
  type DistanceBucketLabel,
  HIDDEN_AIM_TARGETS,
  type Distribution,
  type FireContext,
  type HiddenAimTarget,
  type KitSide,
  type MovementMetrics,
  type ProfileMetrics,
  type ProfilePeriod,
  type ProfileSelection,
  type SelectedRounds,
} from '@tanks/analysis';
import { createBrain } from '@tanks/bots';
import { createParallax } from '@tanks/server/bots/ladder';
import { deriveStats, TICK_RATE } from '@tanks/shared/engine';
import { BOT_LEVELS, type BotLevel } from '@tanks/shared/protocol';

export const TWIN_PROFILE_NAMES = ['phone', 'pc'] as const;
export const TWIN_NICK = 'Двойник';
export type TwinProfileName = (typeof TWIN_PROFILE_NAMES)[number];

// Справка по журналам человека: числа раундов по правилам выборки, метрики главного окна профиля
// и движение в своём окне.
export interface TwinReference {
  profile: TwinProfileName;
  nick: string;
  rounds: {
    total: number;
    selected: number;
    mainWindow: number;
    excluded: SelectedRounds['excluded'];
    missingGames: string[];
  };
  main: ProfileMetrics;
  movement: MovementMetrics;
}

// Противник на виду или не виден: у решений манёвра свои распределения для каждого случая.
export const SIGHT_KEYS = ['sight', 'hidden'] as const;
export type SightKey = (typeof SIGHT_KEYS)[number];
export const SIGHT_NAMES: Readonly<Record<SightKey, string>> = { sight: 'на виду', hidden: 'без видимости' };

export const HIDDEN_AIM_NAMES: Readonly<Record<HiddenAimTarget, string>> = {
  bearing: 'пеленге',
  exit: 'точке выхода',
  ricochet: 'рикошете',
  lastSeen: 'месте, где видел последний раз',
};

// Параметры, которые подбираются калибровкой по своим метрикам-входам. hiddenAim — доли решений, на которых
// башня без видимости ведётся на цель; kitShare — доля решений манёвра, на которых танк едет к аптечке.
export interface TwinCalibration {
  correlationTicks: number;
  lagTicks: number;
  holdShare: Record<FireContext, number>;
  decisionMeanS: number;
  courseReach: number;
  reverseChance: number;
  kitShare: Record<KitSide, number>;
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

// Выборка профиля: ник, периоды настроек списками игр, игры против старой лестницы ботов и окна счёта.
interface ProfileWindows {
  nick: string;
  control: TwinProfile['control'];
  periods: readonly ProfilePeriod[];
  oldLadderGames: readonly string[];
  mainPeriods: readonly string[];
  movementPeriods: readonly string[];
}

const MS_PER_SECOND = 1000;
// Чужой танк клиент рисует на два тика позже последнего снимка.
const INTERPOLATION_TICKS = 2;
const TICK_MS = MS_PER_SECOND / TICK_RATE;
const PERCENT = 100;

const GAME_ID_SEPARATOR = ' ';
// Упреждения как приёма у игрока нет на обоих устройствах: выстрелы по движущемуся ложатся на корпус не реже, чем
// на точку упреждения. Подгонкой по журналам доля не отделяется от отставания башни — значение из данных.
const LEAD_SHARE = 0;
// Меньше 25 выстрелов по стоящему в корзине дистанции — распределение корзины ненадёжно.
const MIN_BAND_SHOTS = 25;
// Угол хода в корзине — не меньше чем по 10 с с газом.
const MIN_BAND_COURSE_TICKS = 10 * TICK_RATE;
// Цель башни без видимости входит в модель, если башня человека на ней чаще случайной хотя бы на 2 пункта:
// корпус, которым башню не ведут, из-за геометрии коридоров даёт превышение до 1 пункта.
const MIN_HIDDEN_AIM_EXCESS_PCT = 2;

function gameIds(ids: string): string[] {
  return ids.split(GAME_ID_SEPARATOR);
}

// Архив журналов игрока до 5 октября включительно. A — до перенастройки управления утром 4 октября; B —
// автоведение башни; C1 — ручная башня с быстрым задним ходом; C2 — задний ход только броском. У компьютера мышь
// и клавиатура не менялись: A и C — одна выборка. Старая лестница — игры до её перенастройки около 04:30
// 4 октября.
export const PROFILE_WINDOWS: Readonly<Record<TwinProfileName, ProfileWindows>> = {
  phone: {
    nick: 'Mob',
    control: 'sticks',
    periods: [
      {
        name: 'A',
        games: gameIds('DNE5 KXBY P3TN D9P9 DA59 DF9T 39V9 QDR7 68JE 4KZM AXKR ZG6X GPB5 QGRV SWYD G79T ZMVU C875'),
      },
      { name: 'B', games: gameIds('7CU9 MWGZ') },
      {
        name: 'C1',
        games: gameIds('GNWZ JEKJ FCT5 X8BN K5FQ 6ZHK 7PSX 5BM7 5ZGY TFBK TQPT 37TP A4DY H4DX'),
      },
      {
        name: 'C2',
        games: gameIds('JUBW MFAK VF52 MYQQ 4P47 U5P6 HRZR CS3S XXQH ATC9 RHVT 2PT6 RTNN W8JW 4SFJ 8A29'),
      },
    ],
    oldLadderGames: gameIds('DNE5 KXBY P3TN D9P9 DA59 DF9T 39V9 QDR7'),
    mainPeriods: ['C1', 'C2'],
    movementPeriods: ['C2'],
  },
  pc: {
    nick: 'dd',
    control: 'mouseKeys',
    periods: [
      {
        name: 'A',
        games: gameIds(
          'MJTM 27UY TF86 RCYK VAUV 93XQ K3UX 9FTM EBBZ M2WZ JTDA B9S7 BEP3 94FS DK7S VTAV 5TCZ TUNR K9NM G7TW 6S9U 3HQQ 9KBY FTS9',
        ),
      },
      { name: 'C', games: gameIds('4RM5 CD4K GEFZ 4VW2 TKRX C2KN') },
    ],
    oldLadderGames: gameIds('MJTM 27UY TF86 RCYK'),
    mainPeriods: ['A', 'C'],
    movementPeriods: ['A', 'C'],
  },
};

// Характеристики бота от его случайности не зависят.
function noRandom(): number {
  return 0;
}

// Скорость снаряда ботов лестницы — запасная, когда по журналу игры её не восстановить.
function ladderBulletSpeeds(): Record<BotLevel, number> {
  const speeds = {} as Record<BotLevel, number>;
  for (const level of BOT_LEVELS) {
    speeds[level] = deriveStats(createBrain(level, noRandom, createParallax).stats).bulletSpeed;
  }
  return speeds;
}

export function profileSelection(name: TwinProfileName): ProfileSelection {
  const windows = PROFILE_WINDOWS[name];
  return {
    nick: windows.nick,
    periods: windows.periods,
    oldLadderGames: windows.oldLadderGames,
    botBulletSpeeds: ladderBulletSpeeds(),
  };
}

// Выборка журналов двойника: его ник и все его игры, без периодов и старой лестницы.
export function twinSelection(): ProfileSelection {
  return { nick: TWIN_NICK, periods: null, oldLadderGames: [], botBulletSpeeds: ladderBulletSpeeds() };
}

function required<T>(value: T | null, what: string): T {
  if (value === null) {
    throw new Error(`в справке нет данных: ${what}`);
  }
  return value;
}

function band(value: Distribution | null, what: string): Band {
  const known = required(value, what);
  return { near: known.q1, far: known.q3 };
}

function deciles(value: Distribution | null, what: string, scale = 1): number[] {
  return required(value, what).deciles.map((decile) => decile * scale);
}

// Ошибка руки — по корзинам дистанции, где у человека не меньше MIN_BAND_SHOTS выстрелов по стоящему; в
// остальных корзинах — общее распределение.
function handErrorDeciles(aim: ProfileMetrics['aim']): Record<DistanceBucketLabel, number[]> {
  const overall = deciles(aim.standingErrDeg, 'ошибка по стоящему');
  const result = {} as Record<DistanceBucketLabel, number[]>;
  for (const band of DISTANCE_BUCKET_LABELS) {
    const inBand = aim.byBucket[band]?.standingErrDeg ?? null;
    result[band] = inBand !== null && inBand.n >= MIN_BAND_SHOTS ? inBand.deciles.slice() : overall;
  }
  return result;
}

function hasCourseTicks(value: Distribution | null | undefined): value is Distribution {
  return value !== null && value !== undefined && value.n >= MIN_BAND_COURSE_TICKS;
}

// Угол хода к линии — по видимости и корзине дистанции по 100, где у человека не меньше MIN_BAND_COURSE_TICKS
// тиков с газом; иначе — по корзине огня, в которую она входит, а там, где и этого мало, — по всем тикам с газом.
function courseDeciles(movement: MovementMetrics): Record<SightKey, Record<CourseBandLabel, number[]>> {
  const overall = deciles(movement.courseAllDeg, 'угол хода к линии на противника');
  const result = {} as Record<SightKey, Record<CourseBandLabel, number[]>>;
  for (const key of SIGHT_KEYS) {
    result[key] = {} as Record<CourseBandLabel, number[]>;
    for (const band of COURSE_BANDS) {
      const inBand = movement.courseByBandDeg[key][band.label];
      const inBucket = movement.courseDeg[key][distanceBucketOf(band.low)];
      let chosen = overall;
      if (hasCourseTicks(inBand)) {
        chosen = inBand.deciles.slice();
      } else if (hasCourseTicks(inBucket)) {
        chosen = inBucket.deciles.slice();
      }
      result[key][band.label] = chosen;
    }
  }
  return result;
}

// Задержка сети туда и обратно делится поровну, с округлением до тика.
function halfTripTicks(rttMs: number): number {
  return Math.round(rttMs / 2 / TICK_MS);
}

// Без позиции в журналах человека режима «позиция» у двойника нет.
function coverOf(main: ProfileMetrics): TwinProfile['cover'] {
  const { distance, wallDistance } = main.position.hold;
  if (distance === null || wallDistance === null) {
    return null;
  }
  return {
    distanceBand: band(distance, 'дистанция в позиции'),
    wallDistanceBand: band(wallDistance, 'стена в позиции'),
  };
}

export function hiddenAimTargetsOf(aim: ProfileMetrics['aim']): HiddenAimTarget[] {
  return HIDDEN_AIM_TARGETS.filter((target) => (aim.hiddenAim[target].excessPct ?? 0) >= MIN_HIDDEN_AIM_EXCESS_PCT);
}

export function twinProfile(reference: TwinReference, calibration: TwinCalibration | null): TwinProfile {
  const main = reference.main;
  const settings = required(main.settings, 'настройки клиента');
  const rtt = required(main.rttMs, 'задержка сети').median;
  return {
    name: reference.profile,
    control: PROFILE_WINDOWS[reference.profile].control,
    channel: {
      uplinkTicks: halfTripTicks(rtt),
      downlinkTicks: halfTripTicks(rtt),
      interpolationTicks: INTERPOLATION_TICKS,
    },
    settings: { pivotThrottle: required(settings.pivotThrottle, 'газ разворота') },
    hand: { errorDecilesDeg: handErrorDeciles(main.aim), leadShare: LEAD_SHARE },
    fire: {
      noStartPauseShare: required(main.fire.noStartPause.pct, 'раунды без стартовой паузы') / PERCENT,
      startPauseDecilesS: deciles(main.fire.startPauseS, 'стартовая пауза'),
      releaseMeanS: required(main.fire.releaseMeanS, 'короткие паузы огня'),
      longPausePerMinute: required(main.fire.longPausesPerMinute, 'длинные паузы огня'),
      longPauseDecilesS: deciles(main.fire.longPauseS, 'длинные паузы огня'),
    },
    manoeuvre: {
      stickDeciles: deciles(reference.movement.straightThrottle, 'газ на прямой'),
      courseDecilesDeg: courseDeciles(reference.movement),
    },
    cover: coverOf(main),
    modeSwitch: { enter: main.modeSwitch.enter, leave: main.modeSwitch.leave },
    hiddenAimTargets: hiddenAimTargetsOf(main.aim),
    calibration,
  };
}
