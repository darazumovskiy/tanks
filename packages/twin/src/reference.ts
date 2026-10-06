import {
  EXCLUSION_REASONS,
  loadLoggedGames,
  movementMetrics,
  profileMetrics,
  selectProfileRounds,
  wilson,
  type LoggedGame,
  type ProfileRound,
  type WinCount,
} from '@tanks/analysis';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROFILE_WINDOWS,
  profileSelection,
  type TwinCalibration,
  type TwinProfileName,
  type TwinReference,
} from './profile.js';
import { missingParams } from './stand/calibrate.js';

const JSON_INDENT = 1;
const REFERENCE_SUFFIX = '.json';
const CALIBRATION_SUFFIX = '.calibration.json';
// Числа справки — с четырьмя знаками после запятой: точнее журнал не меряет.
const JSON_DIGITS = 4;
const ROUNDING = 10 ** JSON_DIGITS;

// outsideGames — игры ника, которых нет ни в одном периоде: списки периодов закрыты, в справку такие игры не идут.
export type ReferenceResult = ({ reference: TwinReference } | { rounds: TwinReference['rounds'] }) & {
  outsideGames: string[];
};

function isInPeriods(round: ProfileRound, periods: readonly string[]): boolean {
  return round.period !== null && periods.includes(round.period);
}

function outsideGamesOf(games: readonly LoggedGame[], name: TwinProfileName): string[] {
  const windows = PROFILE_WINDOWS[name];
  const listed = new Set(windows.periods.flatMap((period) => period.games));
  return games
    .filter((game) => game.analysis.summary.human_name === windows.nick && !listed.has(game.parsed.id))
    .map((game) => game.parsed.id);
}

export function buildReference(games: readonly LoggedGame[], name: TwinProfileName): ReferenceResult {
  const windows = PROFILE_WINDOWS[name];
  const selected = selectProfileRounds(games, profileSelection(name));
  const outsideGames = outsideGamesOf(games, name);
  const main = selected.kept.filter((round) => isInPeriods(round, windows.mainPeriods));
  const rounds = {
    total: selected.total,
    selected: selected.kept.length,
    mainWindow: main.length,
    excluded: selected.excluded,
    missingGames: selected.missingGames,
  };
  if (main.length === 0) {
    return { rounds, outsideGames };
  }
  return {
    outsideGames,
    reference: {
      profile: name,
      nick: windows.nick,
      rounds,
      main: profileMetrics(main),
      movement: movementMetrics(selected.kept.filter((round) => isInPeriods(round, windows.movementPeriods))),
    },
  };
}

// Числа раундов по правилам выборки: всего, исключено каждым правилом, вошло в главное окно; игры из периодов
// выборки, которых нет в папке, — предупреждением.
export function roundLines(nick: string, rounds: TwinReference['rounds']): string[] {
  const lines = rounds.missingGames.map((game) => `Предупреждение: игры ${game} из выборки нет в папке журналов`);
  lines.push(`Раундов ${nick}: ${String(rounds.total)}, по правилам выборки — ${String(rounds.selected)}`);
  for (const reason of EXCLUSION_REASONS) {
    lines.push(`  исключено (${reason}): ${String(rounds.excluded[reason].length)}`);
  }
  lines.push(`В главном окне профиля: ${String(rounds.mainWindow)}`);
  return lines;
}

export function outsideLines(nick: string, outsideGames: readonly string[]): string[] {
  if (outsideGames.length === 0) {
    return [];
  }
  return [`Предупреждение: игры ${nick} вне периодов выборки, в справку не вошли: ${outsideGames.join(' ')}`];
}

// Победы главного окна с интервалом Уилсона 95 %, округлённым для печати.
export function outcomeLine(outcome: WinCount): string {
  const interval = wilson(outcome.wins, outcome.rounds);
  const range =
    interval === null ? '' : `, интервал ${String(Math.round(interval.low))}–${String(Math.round(interval.high))} %`;
  return `Победы в главном окне: ${String(outcome.wins)} из ${String(outcome.rounds)}${range}`;
}

function roundNumbers(_key: string, value: unknown): unknown {
  return typeof value === 'number' ? Math.round(value * ROUNDING) / ROUNDING : value;
}

function writeJson(dir: string, file: string, value: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, `${JSON.stringify(value, roundNumbers, JSON_INDENT)}\n`);
  return path;
}

function readJson(dir: string, file: string): unknown {
  const path = join(dir, file);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export function writeReference(reference: TwinReference, dir: string): string {
  return writeJson(dir, `${reference.profile}${REFERENCE_SUFFIX}`, reference);
}

export function writeCalibration(name: TwinProfileName, calibration: TwinCalibration, dir: string): string {
  return writeJson(dir, `${name}${CALIBRATION_SUFFIX}`, calibration);
}

// Справку пишет этот же модуль, её форма не проверяется; null — файла нет.
export function loadReference(name: TwinProfileName, dir: string): TwinReference | null {
  return readJson(dir, `${name}${REFERENCE_SUFFIX}`) as TwinReference | null;
}

export type CalibrationFile = { calibration: TwinCalibration } | { error: string } | null;

// Файл калибровки переживает смену модели: в старом файле может не быть нового параметра. Каждый параметр
// проверяется, кроме групп skippedGroups, которые сейчас перекалибруют; null — файла нет.
export function loadCalibration(
  name: TwinProfileName,
  dir: string,
  skippedGroups: readonly string[] = [],
): CalibrationFile {
  const raw = readJson(dir, `${name}${CALIBRATION_SUFFIX}`);
  if (raw === null) {
    return null;
  }
  const missing = missingParams(raw, skippedGroups);
  if (missing.length > 0) {
    return {
      error: `в калибровке ${name} нет параметров или они не числа: ${missing.join(', ')} — пересоберите twin calibrate`,
    };
  }
  return { calibration: raw as TwinCalibration };
}

export function loadPlayerGames(logDir: string, name: TwinProfileName): LoggedGame[] {
  const nick = PROFILE_WINDOWS[name].nick;
  return loadLoggedGames(logDir, { keep: (game) => game.summary.human_name === nick });
}
