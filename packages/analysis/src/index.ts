import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeFfaLog, type FfaGameSummary } from './ffaGames.js';
import { analyzeGame, type GameAnalysis } from './game.js';
import {
  deviceIndexOf,
  gameIdOf,
  isGameLogFile,
  isRoomLogFile,
  listGameIds,
  parseGameLog,
  readRoomLogs,
  type DeviceIndex,
  type ParsedGame,
} from './logParser.js';
import { buildReport, localSortKey } from './report.js';

export type { FfaGameSummary, FfaMatchSummary } from './ffaGames.js';
export type { GameAnalysis, GameSummary, RoundSummary } from './game.js';
export type { ParsedGame, ParsedRound, Pose, Tick } from './logParser.js';
export * from './profile/index.js';
export { wallClearance } from './geometry.js';
export {
  COURSE_BAND_LABELS,
  COURSE_BANDS,
  courseBandOf,
  DISTANCE_BUCKET_LABELS,
  distanceBucketOf,
  type CourseBandLabel,
  type DistanceBucketLabel,
} from './shots.js';

const DEFAULT_TZ_HOURS = 3;
const DEFAULT_OUT_DIR_NAME = 'analysis';
const REPORT_FILE = 'report.md';
const JSON_FILE = 'games.json';
const JSON_INDENT = 1;
const LINE_SEPARATOR = '\n';

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

// Журнал игры из памяти: имя файла (`<gameId>.log`, `room-<код>.log`) и строки.
export interface LogFile {
  name: string;
  lines: readonly string[];
}

// Разобранная дуэль: сводка анализатора и тики.
export interface LoggedGame {
  analysis: GameAnalysis;
  parsed: ParsedGame;
}

export interface LoadOptions {
  tzHours?: number;
  keep?: (game: GameAnalysis) => boolean;
}

interface GameSource {
  id: string;
  text: string;
}

type SourceResult = { duel: LoggedGame } | { ffa: FfaGameSummary } | { skipped: string };

function analyzeSource(source: GameSource, devices: DeviceIndex, tzHours: number): SourceResult {
  const ffa = analyzeFfaLog(source.id, source.text);
  if (ffa !== null) {
    return { ffa };
  }
  const parsed = parseGameLog(source.id, source.text);
  if (parsed === null) {
    return { skipped: source.id };
  }
  const analysis = analyzeGame(parsed, devices, tzHours);
  return { duel: { analysis, parsed } };
}

function* folderSources(logDir: string, ids: readonly string[]): Generator<GameSource> {
  for (const id of ids) {
    yield { id, text: readFileSync(join(logDir, `${id}.log`), 'utf8') };
  }
}

// Папка журналов → отчёт и JSON; бои толпы прогоняются движком; skipped — файлы без `game start` или без раундов.
export function analyzeLogs(logDir: string, options: AnalyzeOptions = {}): AnalyzeResult {
  const outDir = options.outDir ?? join(logDir, '..', DEFAULT_OUT_DIR_NAME);
  const tzHours = options.tzHours ?? DEFAULT_TZ_HOURS;
  const only = options.only === undefined ? null : new Set(options.only);
  mkdirSync(outDir, { recursive: true });
  const devices = deviceIndexOf(readRoomLogs(logDir));
  const games: GameAnalysis[] = [];
  const ffaGames: FfaGameSummary[] = [];
  const skipped: string[] = [];
  const ids = listGameIds(logDir).filter((id) => only === null || only.has(id));
  for (const source of folderSources(logDir, ids)) {
    const result = analyzeSource(source, devices, tzHours);
    if ('duel' in result) {
      games.push(result.duel.analysis);
    } else if ('ffa' in result) {
      ffaGames.push(result.ffa);
    } else {
      skipped.push(result.skipped);
    }
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

function collectDuels(sources: Iterable<GameSource>, devices: DeviceIndex, options: LoadOptions): LoggedGame[] {
  const tzHours = options.tzHours ?? DEFAULT_TZ_HOURS;
  const games: LoggedGame[] = [];
  for (const source of sources) {
    const result = analyzeSource(source, devices, tzHours);
    if (!('duel' in result)) {
      continue;
    }
    if (options.keep !== undefined && !options.keep(result.duel.analysis)) {
      continue;
    }
    games.push(result.duel);
  }
  return games;
}

// Дуэли папки с тиками в порядке имён файлов; keep отбирает игры до того, как их тики останутся в памяти.
export function loadLoggedGames(logDir: string, options: LoadOptions = {}): LoggedGame[] {
  const devices = deviceIndexOf(readRoomLogs(logDir));
  return collectDuels(folderSources(logDir, listGameIds(logDir)), devices, options);
}

// Те же дуэли из строк в памяти — журнал стенда разбирается тем же кодом, что файлы.
export function analyzeLogLines(files: readonly LogFile[], options: LoadOptions = {}): LoggedGame[] {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const devices = deviceIndexOf(sorted.filter((file) => isRoomLogFile(file.name)));
  const sources = sorted
    .filter((file) => isGameLogFile(file.name))
    .map((file) => ({ id: gameIdOf(file.name), text: file.lines.join(LINE_SEPARATOR) }));
  return collectDuels(sources, devices, options);
}
