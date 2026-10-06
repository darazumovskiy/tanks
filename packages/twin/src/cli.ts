import { existsSync, statSync } from 'node:fs';
import { PROFILE_WINDOWS, TWIN_PROFILE_NAMES, type TwinProfileName } from './profile.js';
import { buildReference, loadPlayerGames, outcomeLine, roundLines, writeReference } from './reference.js';

const REFERENCE_COMMAND = 'reference';
const PROFILE_FLAG = '--profile';
const EXIT_OK = 0;
const EXIT_USAGE = 2;

export const USAGE = `Использование: twin ${REFERENCE_COMMAND} <папка журналов> ${PROFILE_FLAG} ${TWIN_PROFILE_NAMES.join('|')}`;

interface ReferenceInvocation {
  logDir: string;
  profile: TwinProfileName;
}

type CliParse = { invocation: ReferenceInvocation } | { error: string };

function isProfileName(value: string): value is TwinProfileName {
  return (TWIN_PROFILE_NAMES as readonly string[]).includes(value);
}

export function parseCliArgs(argv: readonly string[]): CliParse {
  const [command, ...rest] = argv;
  if (command !== REFERENCE_COMMAND) {
    return { error: `неизвестная команда: ${command ?? '(нет)'}` };
  }
  let logDir: string | null = null;
  let profile: TwinProfileName | null = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (arg !== PROFILE_FLAG) {
      if (arg.startsWith('--') || logDir !== null) {
        return { error: `лишний аргумент: ${arg}` };
      }
      logDir = arg;
      continue;
    }
    const value = rest[i + 1] ?? '';
    i++;
    if (!isProfileName(value)) {
      return { error: `${PROFILE_FLAG}: ожидается ${TWIN_PROFILE_NAMES.join(' или ')}` };
    }
    profile = value;
  }
  if (logDir === null) {
    return { error: 'не указана папка с журналами' };
  }
  if (profile === null) {
    return { error: `не указан ${PROFILE_FLAG}` };
  }
  return { invocation: { logDir, profile } };
}

// referenceDir — папка справок пакета; тесты передают временную.
export function runCli(argv: readonly string[], print: (line: string) => void, referenceDir: string): number {
  const parsed = parseCliArgs(argv);
  if ('error' in parsed) {
    print(parsed.error);
    print(USAGE);
    return EXIT_USAGE;
  }
  const { logDir, profile } = parsed.invocation;
  const isDirectory = existsSync(logDir) && statSync(logDir).isDirectory();
  if (!isDirectory) {
    print(`нет папки журналов: ${logDir}`);
    print(USAGE);
    return EXIT_USAGE;
  }
  const result = buildReference(loadPlayerGames(logDir, profile), profile);
  if (!('reference' in result)) {
    roundLines(PROFILE_WINDOWS[profile].nick, result.rounds).forEach(print);
    print('Справка не записана: в главном окне профиля нет раундов');
    return EXIT_USAGE;
  }
  roundLines(result.reference.nick, result.reference.rounds).forEach(print);
  print(outcomeLine(result.reference.main.outcomes));
  print(writeReference(result.reference, referenceDir));
  return EXIT_OK;
}
