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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILE_WINDOWS, profileSelection, type TwinProfileName, type TwinReference } from './profile.js';

const JSON_INDENT = 1;
// Числа справки — с четырьмя знаками после запятой: точнее журнал не меряет.
const JSON_DIGITS = 4;
const ROUNDING = 10 ** JSON_DIGITS;

export type ReferenceResult = { reference: TwinReference } | { rounds: TwinReference['rounds'] };

function isInPeriods(round: ProfileRound, periods: readonly string[]): boolean {
  return round.period !== null && periods.includes(round.period);
}

export function buildReference(games: readonly LoggedGame[], name: TwinProfileName): ReferenceResult {
  const windows = PROFILE_WINDOWS[name];
  const selected = selectProfileRounds(games, profileSelection(name));
  const main = selected.kept.filter((round) => isInPeriods(round, windows.mainPeriods));
  const rounds = {
    total: selected.total,
    selected: selected.kept.length,
    mainWindow: main.length,
    excluded: selected.excluded,
    missingGames: selected.missingGames,
  };
  if (main.length === 0) {
    return { rounds };
  }
  return {
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

export function writeReference(reference: TwinReference, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${reference.profile}.json`);
  writeFileSync(path, `${JSON.stringify(reference, roundNumbers, JSON_INDENT)}\n`);
  return path;
}

export function loadPlayerGames(logDir: string, name: TwinProfileName): LoggedGame[] {
  const nick = PROFILE_WINDOWS[name].nick;
  return loadLoggedGames(logDir, { keep: (game) => game.summary.human_name === nick });
}
