import {
  DISTANCE_BUCKET_LABELS,
  HIDDEN_AIM_TARGETS,
  MOTION_KINDS,
  wilson,
  type Distribution,
  type MotionKind,
  type MovementMetrics,
  type ProfileMetrics,
  type ProfileRound,
  type Share,
  type WinCount,
} from '@tanks/analysis';
import type { BotLevel } from '@tanks/shared/protocol';
import {
  HIDDEN_AIM_NAMES,
  hiddenAimTargetsOf,
  PROFILE_WINDOWS,
  SIGHT_KEYS,
  SIGHT_NAMES,
  type TwinReference,
} from '../profile.js';
import type { InputCheck } from './calibrate.js';
import type { ExclusionCounts } from './match.js';

// Уровень, где у игрока меньше 10 раундов, метрика с n меньше 30 у игрока и доля события, которое у игрока случилось
// меньше 5 раз, печатаются без вердикта.
const MIN_REFERENCE_ROUNDS = 10;
const MIN_REFERENCE_SAMPLES = 30;
const MIN_REFERENCE_EVENTS = 5;
const PERCENT = 100;
// Граница интервала при 0 из n или n из n считается с погрешностью плавающей точки: 0 % выходит за 1e-15 %.
const BOUND_EPSILON = 1e-9;

export type Verdict = 'честно' | 'нарушение' | 'без вердикта';

export type Measure =
  | { kind: 'median'; value: Distribution | null }
  | { kind: 'share'; value: Share }
  | { kind: 'rate'; value: number | null };

// Метрики одного игрока для сверки: главное окно и движение (у телефона — в своём окне).
export interface PlayerMetrics {
  main: ProfileMetrics;
  movement: MovementMetrics;
}

interface OutcomeCheck {
  name: string;
  of: (metrics: PlayerMetrics) => Measure;
}

export interface LevelRow {
  level: BotLevel;
  twin: WinCount;
  dima: WinCount | null;
  verdict: Verdict;
}

export interface OutcomeRow {
  name: string;
  dima: Measure;
  twin: Measure;
  verdict: Verdict;
}

export interface Honesty {
  levels: LevelRow[];
  overall: { twinPct: number | null; dima: WinCount; verdict: Verdict };
  outcomes: OutcomeRow[];
  inputs: InputCheck[];
  isHonest: boolean;
}

// Причины «не играл» правила выборки; уровень бота, автоведение и старая лестница у двойника не встречаются.
const PLAY_REASONS = ['short', 'noShot', 'idle', 'silence'] as const;
type PlayReason = (typeof PLAY_REASONS)[number];
const PLAY_REASON_NAMES: Readonly<Record<PlayReason, string>> = {
  short: 'короткий бой',
  noShot: 'без выстрела',
  idle: 'без управления',
  silence: 'без связи',
};
const ROUND_ID_SEPARATOR = '#';
const MOTION_NAMES: Readonly<Record<MotionKind, string>> = {
  still: 'стоит',
  toward: 'к противнику',
  side: 'поперёк линии',
  away: 'от противника',
};

// Сыгранные стендом раунды и сколько из них отсекло правило выборки.
export interface StandCount {
  played: number;
  excluded: ExclusionCounts;
}

function share(value: Share | undefined): Measure {
  return { kind: 'share', value: value ?? { part: 0, total: 0, pct: null } };
}

function median(value: Distribution | null | undefined): Measure {
  return { kind: 'median', value: value ?? null };
}

function winShare(count: WinCount): Measure {
  return share({
    part: count.wins,
    total: count.rounds,
    pct: count.rounds === 0 ? null : (PERCENT * count.wins) / count.rounds,
  });
}

// Исходы — только проверяются, в модель не входят. Свойство из справки (ошибка по стоящему) сверяется
// здесь же: между рукой и выстрелом стоит поворот башни.
function outcomeChecks(reference: TwinReference): OutcomeCheck[] {
  const levelKeys = Object.keys(reference.main.position.byLevel);
  const modelled = hiddenAimTargetsOf(reference.main.aim);
  return [
    { name: 'Ошибка по стоящему, °', of: (m) => median(m.main.aim.standingErrDeg) },
    ...DISTANCE_BUCKET_LABELS.map((band) => ({
      name: `Ошибка по стоящему ${band}, °`,
      of: (m: PlayerMetrics) => median(m.main.aim.byBucket[band]?.standingErrDeg),
    })),
    { name: 'Ошибка по движущемуся 300–600, °', of: (m) => median(m.main.aim.byBucket['300–600']?.movingErrCurDeg) },
    { name: 'Ошибка по движущемуся >600, °', of: (m) => median(m.main.aim.byBucket['>600']?.movingErrCurDeg) },
    { name: 'Время наведения, тиков', of: (m) => median(m.main.reaction.aimTicks) },
    { name: 'Ошибка башни при видимости, °', of: (m) => median(m.main.aim.sightErrorDeg) },
    { name: 'Тики с ошибкой меньше 5°', of: (m) => share(m.main.aim.sightErrorUnder5) },
    ...DISTANCE_BUCKET_LABELS.map((bucket) => ({
      name: `Попадания ${bucket}`,
      of: (m: PlayerMetrics) => share(m.main.outcomes.hitsByBucket[bucket]),
    })),
    { name: 'Выстрелов в минуту', of: (m) => ({ kind: 'rate', value: m.main.fire.shotsPerMinute }) },
    { name: 'Выстрел по готовности', of: (m) => share(m.main.fire.readyShots) },
    { name: 'Выстрелы без видимости', of: (m) => share(m.main.fire.noSightShots) },
    { name: 'Попадания без видимости', of: (m) => share(m.main.fire.noSightHits) },
    { name: 'Прямые попадания без видимости', of: (m) => share(m.main.fire.noSightDirectHits) },
    { name: 'Башня на точке появления за 0,5 с', of: (m) => share(m.main.aim.preAppear) },
    ...HIDDEN_AIM_TARGETS.filter((target) => !modelled.includes(target)).map((target) => ({
      name: `Башня без видимости на ${HIDDEN_AIM_NAMES[target]} сверх случайной, п.`,
      of: (m: PlayerMetrics): Measure => ({ kind: 'rate', value: m.main.aim.hiddenAim[target].excessPct }),
    })),
    { name: 'Самопопадания', of: (m) => share(m.main.fire.selfHits) },
    {
      name: 'Удержаний предохранителем в минуту',
      of: (m) => ({ kind: 'rate', value: m.main.fire.guardHoldsPerMinute }),
    },
    { name: 'Огонь зажат, с предохранителем', of: (m) => share(m.main.fire.heldGuardOn) },
    { name: 'Огонь зажат, без предохранителя', of: (m) => share(m.main.fire.heldGuardOff) },
    { name: 'Уклонение', of: (m) => share(m.main.dodge.dodge.dodged) },
    ...DISTANCE_BUCKET_LABELS.map((bucket) => ({
      name: `Попадания бота ${bucket}`,
      of: (m: PlayerMetrics) => share(m.main.outcomes.botHitsByBucket[bucket]),
    })),
    ...DISTANCE_BUCKET_LABELS.map((bucket) => ({
      name: `Выстрелы бота ${bucket}`,
      of: (m: PlayerMetrics) => share(m.main.outcomes.botShotsByBucket[bucket]),
    })),
    { name: 'Урон в минуту', of: (m) => ({ kind: 'rate', value: m.main.outcomes.damagePerMinute }) },
    { name: 'Урон бота в минуту', of: (m) => ({ kind: 'rate', value: m.main.outcomes.damageTakenPerMinute }) },
    { name: 'Первое попадание моё', of: (m) => share(m.main.outcomes.firstHit) },
    { name: 'Подобрано аптечек из появившихся', of: (m) => share(m.main.kits.picked) },
    { name: 'Аптечки мои из подобранных', of: (m) => share(m.main.kits.mine) },
    { name: 'Лечение в минуту', of: (m) => ({ kind: 'rate', value: m.main.kits.healPerMinute }) },
    { name: 'Отрезок сближения или отдаления, тиков', of: (m) => median(m.movement.radialRunTicks) },
    { name: 'Отрезок хода поперёк в одну сторону, тиков', of: (m) => median(m.movement.sideRunTicks) },
    { name: 'Кайтинг', of: (m) => share(m.movement.kite) },
    { name: 'Стартовая пауза, с', of: (m) => median(m.main.fire.startPauseS) },
    {
      name: 'Длинных пауз в минуту после старта',
      of: (m) => ({ kind: 'rate', value: m.main.fire.longPausesPerMinute }),
    },
    ...MOTION_KINDS.flatMap((kind) =>
      SIGHT_KEYS.map((key) => ({
        name: `Ход ${MOTION_NAMES[kind]} ${SIGHT_NAMES[key]}`,
        of: (m: PlayerMetrics) => share(m.movement.motionBySight[kind][key]),
      })),
    ),
    { name: 'Скорость', of: (m) => median(m.movement.speed) },
    { name: 'Дистанция по всем тикам', of: (m) => median(m.movement.distance) },
    { name: 'Видимость', of: (m) => share(m.movement.sight) },
    { name: 'У стены', of: (m) => share(m.movement.nearWall) },
    { name: 'Доля позиции', of: (m) => share(m.main.position.share) },
    ...levelKeys.map((level) => ({
      name: `Доля позиции, уровень ${level}`,
      of: (m: PlayerMetrics) => share(m.main.position.byLevel[level]),
    })),
    { name: 'Победы в раундах стоячей манеры', of: (m) => winShare(m.main.outcomes.holdStyle) },
    { name: 'Победы в раундах манёвра', of: (m) => winShare(m.main.outcomes.manoeuvreStyle) },
    { name: 'Длительность отрезка позиции, с', of: (m) => median(m.main.position.segmentS) },
    { name: 'Попадания в позиции', of: (m) => share(m.main.position.hold.hits) },
    { name: 'Попадания бота в позиции', of: (m) => share(m.main.position.hold.botHits) },
    { name: 'Попадания в манёвре', of: (m) => share(m.main.position.manoeuvre.hits) },
    { name: 'Попадания бота в манёвре', of: (m) => share(m.main.position.manoeuvre.botHits) },
  ];
}

export function outcomeNames(reference: TwinReference): string[] {
  return outcomeChecks(reference).map((check) => check.name);
}

function isInside(pct: number | null, reference: WinCount): boolean {
  const interval = wilson(reference.wins, reference.rounds);
  return (
    pct !== null && interval !== null && pct >= interval.low - BOUND_EPSILON && pct <= interval.high + BOUND_EPSILON
  );
}

// Доля двойника тоже выборка: на редком событии или малом числе раундов её точка выходит за интервал игрока,
// хотя выборки не различаются. Поэтому сверяются интервалы.
function isOverlapping(twin: Share, dima: Share): boolean {
  const twinInterval = wilson(twin.part, twin.total);
  const dimaInterval = wilson(dima.part, dima.total);
  if (twinInterval === null || dimaInterval === null) {
    return false;
  }
  return twinInterval.low <= dimaInterval.high + BOUND_EPSILON && twinInterval.high >= dimaInterval.low - BOUND_EPSILON;
}

function outcomeVerdict(dima: Measure, twin: Measure): Verdict {
  if (dima.kind === 'median' && twin.kind === 'median') {
    if (dima.value === null || dima.value.n < MIN_REFERENCE_SAMPLES) {
      return 'без вердикта';
    }
    const value = twin.value?.median ?? null;
    return value !== null && value >= dima.value.q1 && value <= dima.value.q3 ? 'честно' : 'нарушение';
  }
  if (dima.kind === 'share' && twin.kind === 'share') {
    if (dima.value.total < MIN_REFERENCE_SAMPLES || dima.value.part < MIN_REFERENCE_EVENTS) {
      return 'без вердикта';
    }
    return isOverlapping(twin.value, dima.value) ? 'честно' : 'нарушение';
  }
  return 'без вердикта';
}

function shareOf(part: number, total: number): Share {
  return { part, total, pct: total === 0 ? null : (PERCENT * part) / total };
}

// Доли раундов вне выборки по причинам «не играл» — тоже исход: короткие раунды без выстрела значат гибель
// на старте. У игрока — игры главного окна; доля — от раундов, прошедших правила уровня, автоведения и лестницы.
function exclusionRows(reference: TwinReference, stand: StandCount): OutcomeRow[] {
  const windows = PROFILE_WINDOWS[reference.profile];
  const mainGames = new Set(
    windows.periods.filter((period) => windows.mainPeriods.includes(period.name)).flatMap((period) => period.games),
  );
  const isMain = (id: string): boolean => mainGames.has(id.split(ROUND_ID_SEPARATOR)[0] ?? '');
  const dimaCounts = Object.fromEntries(
    PLAY_REASONS.map((reason) => [reason, reference.rounds.excluded[reason].filter(isMain).length]),
  ) as Record<PlayReason, number>;
  const dimaExcluded = PLAY_REASONS.reduce((total, reason) => total + dimaCounts[reason], 0);
  const dimaTotal = reference.rounds.mainWindow + dimaExcluded;
  const twinExcluded = PLAY_REASONS.reduce((total, reason) => total + stand.excluded[reason], 0);
  const row = (name: string, dimaPart: number, twinPart: number): OutcomeRow => {
    const dima = share(shareOf(dimaPart, dimaTotal));
    const twin = share(shareOf(twinPart, stand.played));
    return { name, dima, twin, verdict: outcomeVerdict(dima, twin) };
  };
  return [
    row('Вне выборки: не играл', dimaExcluded, twinExcluded),
    ...PLAY_REASONS.map((reason) =>
      row(`Вне выборки: ${PLAY_REASON_NAMES[reason]}`, dimaCounts[reason], stand.excluded[reason]),
    ),
  ];
}

function levelCount(rounds: readonly ProfileRound[], level: BotLevel): WinCount {
  const finished = rounds.filter((round) => round.level === level && round.isFinished);
  return { rounds: finished.length, wins: finished.filter((round) => round.isWon).length };
}

function dimaLevel(reference: TwinReference, level: BotLevel): WinCount | null {
  const entry = Object.entries(reference.main.outcomes.byLevel).find(([key]) => parseInt(key, 10) === level);
  return entry === undefined ? null : { rounds: entry[1].rounds, wins: entry[1].wins };
}

function pctOf(count: WinCount): number | null {
  return count.rounds === 0 ? null : (PERCENT * count.wins) / count.rounds;
}

// Критерии честности: винрейт по уровням и сводный — в интервале Уилсона игрока (без округления), исходы
// поведения — медиана в квартилях игрока, доля — интервал двойника пересекается с интервалом игрока, входы — в допуске,
// и ни один параметр не на краю своего физического диапазона.
export function judge(
  reference: TwinReference,
  levels: readonly BotLevel[],
  rounds: readonly ProfileRound[],
  stand: StandCount,
  twin: PlayerMetrics,
  inputs: readonly InputCheck[],
): Honesty {
  const levelRows: LevelRow[] = levels.map((level) => {
    const twinCount = levelCount(rounds, level);
    const dima = dimaLevel(reference, level);
    let verdict: Verdict = 'без вердикта';
    if (dima !== null && dima.rounds >= MIN_REFERENCE_ROUNDS) {
      verdict = isInside(pctOf(twinCount), dima) ? 'честно' : 'нарушение';
    }
    return { level, twin: twinCount, dima, verdict };
  });
  const weighted = levelRows.filter((row) => row.dima !== null && row.twin.rounds > 0);
  const weight = weighted.reduce((total, row) => total + (row.dima?.rounds ?? 0), 0);
  const twinPct =
    weight === 0
      ? null
      : weighted.reduce((total, row) => total + (pctOf(row.twin) ?? 0) * (row.dima?.rounds ?? 0), 0) / weight;
  const dimaOverall = { rounds: reference.main.outcomes.rounds, wins: reference.main.outcomes.wins };
  const overall = {
    twinPct,
    dima: dimaOverall,
    verdict: isInside(twinPct, dimaOverall) ? 'честно' : 'нарушение',
  } as const;
  const dimaMetrics: PlayerMetrics = { main: reference.main, movement: reference.movement };
  const outcomes = [
    ...outcomeChecks(reference).map((check) => {
      const dima = check.of(dimaMetrics);
      const value = check.of(twin);
      return { name: check.name, dima, twin: value, verdict: outcomeVerdict(dima, value) };
    }),
    ...exclusionRows(reference, stand),
  ];
  const verdicts = [
    ...levelRows.map((row) => row.verdict),
    overall.verdict,
    ...outcomes.map((row) => row.verdict),
    ...inputs.map((input) => input.verdict),
  ];
  return {
    levels: levelRows,
    overall,
    outcomes,
    inputs: [...inputs],
    isHonest: !verdicts.includes('нарушение'),
  };
}
