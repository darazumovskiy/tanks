import { analyzeLogs, type AnalyzeOptions } from './index.js';

const OUT_FLAG = '--out';
const TZ_FLAG = '--tz';
const ONLY_FLAG = '--only';
const ONLY_SEPARATOR = ',';
const EXIT_OK = 0;
const EXIT_USAGE = 2;

export const USAGE = `Использование: analyze-logs <папка с *.log> [${OUT_FLAG} <папка>] [${TZ_FLAG} <часы>] [${ONLY_FLAG} ID1,ID2]`;

export interface CliInvocation {
  logDir: string;
  options: AnalyzeOptions;
}

export type CliParse = { invocation: CliInvocation } | { error: string };

export function parseCliArgs(argv: readonly string[]): CliParse {
  let logDir: string | null = null;
  const options: AnalyzeOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const isFlag = arg === OUT_FLAG || arg === TZ_FLAG || arg === ONLY_FLAG;
    if (!isFlag) {
      if (arg.startsWith('--') || logDir !== null) {
        return { error: `лишний аргумент: ${arg}` };
      }
      logDir = arg;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      return { error: `${arg}: нет значения` };
    }
    i++;
    if (arg === OUT_FLAG) {
      options.outDir = value;
      continue;
    }
    if (arg === ONLY_FLAG) {
      options.only = value.split(ONLY_SEPARATOR).filter((id) => id !== '');
      continue;
    }
    const tz = Number(value);
    if (!Number.isFinite(tz)) {
      return { error: `${TZ_FLAG}: ожидается число, получено ${value}` };
    }
    options.tzHours = tz;
  }
  if (logDir === null) {
    return { error: 'не указана папка с журналами' };
  }
  return { invocation: { logDir, options } };
}

export function runCli(argv: readonly string[], print: (line: string) => void): number {
  const parsed = parseCliArgs(argv);
  if ('error' in parsed) {
    print(parsed.error);
    print(USAGE);
    return EXIT_USAGE;
  }
  const result = analyzeLogs(parsed.invocation.logDir, parsed.invocation.options);
  for (const id of result.skipped) {
    print(`${id}: нет game start или раундов — пропуск`);
  }
  print(`Игр разобрано: ${String(result.games.length)}`);
  if (result.ffaGames.length > 0) {
    print(`Боёв толпы прогнано: ${String(result.ffaGames.length)}`);
  }
  print(result.reportPath);
  return EXIT_OK;
}
