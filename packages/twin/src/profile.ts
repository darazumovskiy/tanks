import type {
  Coefficients,
  Distribution,
  FireContext,
  MovementMetrics,
  ProfileMetrics,
  ProfilePeriod,
  ProfileSelection,
  SelectedRounds,
} from '@tanks/analysis';
import { deriveStats, TICK_RATE } from '@tanks/shared/engine';
import { BOT_LEVELS, type BotLevel } from '@tanks/shared/protocol';
import { createBrain } from '@tanks/server/bots/ladder';

export const TWIN_PROFILE_NAMES = ['phone', 'pc'] as const;
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

// Параметры, которые подбираются калибровкой по своим метрикам-входам.
export interface TwinCalibration {
  correlationTicks: number;
  lagTicks: number;
  leadShare: number;
  holdShare: Record<FireContext, number>;
  decisionScale: number;
  kiteChance: number;
  circleChance: number;
  reverseChance: number;
  coverHoldShare: number;
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
  hand: { errorDecilesDeg: number[] };
  fire: {
    noStartPauseShare: number;
    startPauseDecilesS: number[];
    releaseMeanS: number;
    longPausePerMinute: number;
    longPauseDecilesS: number[];
  };
  manoeuvre: { decisionDecilesS: number[]; stickDeciles: number[]; distanceBand: Band };
  cover: { distanceBand: Band; wallDistanceBand: Band } | null;
  modeSwitch: { enter: Coefficients | null; leave: Coefficients | null };
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

function gameIds(ids: string): string[] {
  return ids.split(GAME_ID_SEPARATOR);
}

// Архив журналов Димы до 5 октября включительно. A — до перенастройки управления утром 4 октября; B —
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
    speeds[level] = deriveStats(createBrain(level, noRandom).stats).bulletSpeed;
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
    hand: { errorDecilesDeg: deciles(main.aim.standingErrDeg, 'ошибка по стоящему') },
    fire: {
      noStartPauseShare: required(main.fire.noStartPause.pct, 'раунды без стартовой паузы') / PERCENT,
      startPauseDecilesS: deciles(main.fire.startPauseS, 'стартовая пауза'),
      releaseMeanS: required(main.fire.releaseMeanS, 'короткие паузы огня'),
      longPausePerMinute: required(main.fire.longPausesPerMinute, 'длинные паузы огня'),
      longPauseDecilesS: deciles(main.fire.longPauseS, 'длинные паузы огня'),
    },
    manoeuvre: {
      decisionDecilesS: deciles(main.dodge.baselineTicks, 'фоновая смена команды', 1 / TICK_RATE),
      stickDeciles: deciles(reference.movement.straightThrottle, 'газ на прямой'),
      distanceBand: band(reference.movement.sightDistance, 'дистанция при видимости'),
    },
    cover: coverOf(main),
    modeSwitch: { enter: main.modeSwitch.enter, leave: main.modeSwitch.leave },
    calibration,
  };
}
