import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeFfaLog, type FfaGameSummary } from './ffaGames.js';
import { analyzeGame, type GameAnalysis } from './game.js';
import { listGameIds, parseGameLog, readDeviceIndex } from './logParser.js';
import { buildReport, localSortKey } from './report.js';

export type { FfaGameSummary, FfaMatchSummary } from './ffaGames.js';
export type { GameAnalysis, GameSummary, RoundSummary } from './game.js';

const DEFAULT_TZ_HOURS = 3;
const DEFAULT_OUT_DIR_NAME = 'analysis';
const REPORT_FILE = 'report.md';
const JSON_FILE = 'games.json';
const JSON_INDENT = 1;

export interface AnalyzeOptions {
  outDir?: string;
  tzHours?: number;
  only?: readonly string[];
}

export interface AnalyzeResult {
  reportPath: string;
  jsonPath: string;
  games: GameAnalysis[];
  ffaGames: FfaGameSummary[];
  skipped: string[];
}

// Папка журналов → отчёт и JSON; бои толпы прогоняются движком; skipped — файлы без `game start` или без раундов.
export function analyzeLogs(logDir: string, options: AnalyzeOptions = {}): AnalyzeResult {
  const outDir = options.outDir ?? join(logDir, '..', DEFAULT_OUT_DIR_NAME);
  const tzHours = options.tzHours ?? DEFAULT_TZ_HOURS;
  const only = options.only === undefined ? null : new Set(options.only);
  mkdirSync(outDir, { recursive: true });
  const devices = readDeviceIndex(logDir);
  const games: GameAnalysis[] = [];
  const ffaGames: FfaGameSummary[] = [];
  const skipped: string[] = [];
  for (const id of listGameIds(logDir)) {
    if (only !== null && !only.has(id)) {
      continue;
    }
    const text = readFileSync(join(logDir, `${id}.log`), 'utf8');
    const ffa = analyzeFfaLog(id, text);
    if (ffa !== null) {
      ffaGames.push(ffa);
      continue;
    }
    const parsed = parseGameLog(id, text);
    if (parsed === null) {
      skipped.push(id);
      continue;
    }
    games.push(analyzeGame(parsed, devices, tzHours));
  }
  games.sort((a, b) => localSortKey(a.summary.start_sec_utc, tzHours) - localSortKey(b.summary.start_sec_utc, tzHours));
  const reportPath = join(outDir, REPORT_FILE);
  const jsonPath = join(outDir, JSON_FILE);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      games.map((game) => game.summary),
      null,
      JSON_INDENT,
    ),
  );
  writeFileSync(reportPath, buildReport(games, tzHours, ffaGames));
  return { reportPath, jsonPath, games, ffaGames, skipped };
}
