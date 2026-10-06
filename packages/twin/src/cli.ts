import { movementMetrics, profileMetrics } from '@tanks/analysis';
import type { BotLevel } from '@tanks/shared/protocol';
import { existsSync, statSync } from 'node:fs';
import { PROFILE_WINDOWS, TWIN_PROFILE_NAMES, twinProfile, type TwinProfileName } from './profile.js';
import {
  buildReference,
  loadCalibration,
  loadPlayerGames,
  loadReference,
  outcomeLine,
  outsideLines,
  roundLines,
  writeCalibration,
  writeReference,
} from './reference.js';
import { calibrate, checkInputs, inputSpread } from './stand/calibrate.js';
import { judge, type PlayerMetrics } from './stand/honesty.js';
import { checkPlan, DEFAULT_ROUNDS, ROUNDS_STEP, STAND_LEVELS } from './stand/plan.js';
import { calibrationReport, checkReport } from './stand/report.js';
import { runStand } from './stand/run.js';

const COMMANDS = ['reference', 'calibrate', 'check'] as const;
type Command = (typeof COMMANDS)[number];
const FLAGS = ['--profile', '--rounds', '--levels', '--seed', '--log-dir', '--threads'] as const;
type Flag = (typeof FLAGS)[number];
const COMMAND_FLAGS: Readonly<Record<Command, readonly Flag[]>> = {
  reference: ['--profile'],
  calibrate: ['--profile', '--seed', '--threads'],
  check: ['--profile', '--rounds', '--levels', '--seed', '--log-dir', '--threads'],
};
const EXIT_OK = 0;
const EXIT_DISHONEST = 1;
const EXIT_USAGE = 2;
const DEFAULT_SEED = 1;
const LEVEL_RANGE_SEPARATOR = '-';
const MS_PER_SECOND = 1000;
const PROFILE_CHOICE = TWIN_PROFILE_NAMES.join('|');

export const USAGE = [
  'Использование:',
  `  twin reference <папка журналов> --profile ${PROFILE_CHOICE}`,
  `  twin calibrate --profile ${PROFILE_CHOICE} [--seed 1] [--threads N]`,
  `  twin check --profile ${PROFILE_CHOICE} [--rounds 1000] [--levels 3-10] [--seed 1] [--log-dir <папка>] [--threads N]`,
].join('\n');

export type Invocation =
  | { command: 'reference'; logDir: string; profile: TwinProfileName }
  | { command: 'calibrate'; profile: TwinProfileName; seed: number; threads: number }
  | {
      command: 'check';
      profile: TwinProfileName;
      rounds: number;
      levels: BotLevel[];
      seed: number;
      logDir: string | null;
      threads: number;
    };

type CliParse = { invocation: Invocation } | { error: string };

export interface CliContext {
  print: (line: string) => void;
  referenceDir: string;
  threads: number;
  now: () => number;
}

function isCommand(value: string | undefined): value is Command {
  return (COMMANDS as readonly (string | undefined)[]).includes(value);
}

function isFlag(value: string): value is Flag {
  return (FLAGS as readonly string[]).includes(value);
}

function isProfileName(value: string): value is TwinProfileName {
  return (TWIN_PROFILE_NAMES as readonly string[]).includes(value);
}

function isStandLevel(value: number): value is BotLevel {
  return (STAND_LEVELS as readonly number[]).includes(value);
}

function wholeNumber(text: string, minimum: number): number | null {
  const value = Number(text);
  return text !== '' && Number.isInteger(value) && value >= minimum ? value : null;
}

function levelRange(text: string): BotLevel[] | null {
  const parts = text.split(LEVEL_RANGE_SEPARATOR).map(Number);
  const from = parts[0] ?? 0;
  const to = parts[1] ?? from;
  const isRange = parts.length <= 2 && isStandLevel(from) && isStandLevel(to) && from <= to;
  if (!isRange) {
    return null;
  }
  return STAND_LEVELS.filter((level) => level >= from && level <= to);
}

interface RawArgs {
  positional: string[];
  flags: Map<Flag, string>;
}

function splitArgs(command: Command, rest: readonly string[]): RawArgs | { error: string } {
  const positional: string[] = [];
  const flags = new Map<Flag, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (!isFlag(arg) || !COMMAND_FLAGS[command].includes(arg)) {
      return { error: `лишний аргумент: ${arg}` };
    }
    flags.set(arg, rest[i + 1] ?? '');
    i++;
  }
  return { positional, flags };
}

export function parseCliArgs(argv: readonly string[], defaultThreads: number): CliParse {
  const [command, ...rest] = argv;
  if (!isCommand(command)) {
    return { error: `неизвестная команда: ${command ?? '(нет)'}` };
  }
  const split = splitArgs(command, rest);
  if ('error' in split) {
    return split;
  }
  const { positional, flags } = split;
  const profileText = flags.get('--profile');
  if (profileText === undefined) {
    return { error: 'не указан --profile' };
  }
  if (!isProfileName(profileText)) {
    return { error: `--profile: ожидается ${TWIN_PROFILE_NAMES.join(' или ')}` };
  }
  const profile = profileText;
  if (command === 'reference') {
    const [logDir, extra] = positional;
    if (logDir === undefined) {
      return { error: 'не указана папка с журналами' };
    }
    if (extra !== undefined) {
      return { error: `лишний аргумент: ${extra}` };
    }
    return { invocation: { command, logDir, profile } };
  }
  const [extra] = positional;
  if (extra !== undefined) {
    return { error: `лишний аргумент: ${extra}` };
  }
  const seed = wholeNumber(flags.get('--seed') ?? String(DEFAULT_SEED), 0);
  const threads = wholeNumber(flags.get('--threads') ?? String(defaultThreads), 1);
  if (seed === null) {
    return { error: '--seed: ожидается целое число от 0' };
  }
  if (threads === null) {
    return { error: '--threads: ожидается целое число от 1' };
  }
  if (command === 'calibrate') {
    return { invocation: { command, profile, seed, threads } };
  }
  const rounds = wholeNumber(flags.get('--rounds') ?? String(DEFAULT_ROUNDS), 1);
  const levels = levelRange(flags.get('--levels') ?? `${String(STAND_LEVELS[0])}-${String(STAND_LEVELS.at(-1))}`);
  if (rounds === null) {
    return { error: '--rounds: ожидается целое число от 1' };
  }
  if (levels === null) {
    return { error: '--levels: ожидается уровень или отрезок уровней, например 3-10' };
  }
  return { invocation: { command, profile, rounds, levels, seed, logDir: flags.get('--log-dir') ?? null, threads } };
}

function runReference(logDir: string, profile: TwinProfileName, context: CliContext): number {
  const { print } = context;
  const isDirectory = existsSync(logDir) && statSync(logDir).isDirectory();
  if (!isDirectory) {
    print(`нет папки журналов: ${logDir}`);
    print(USAGE);
    return EXIT_USAGE;
  }
  const nick = PROFILE_WINDOWS[profile].nick;
  const result = buildReference(loadPlayerGames(logDir, profile), profile);
  outsideLines(nick, result.outsideGames).forEach(print);
  if (!('reference' in result)) {
    roundLines(nick, result.rounds).forEach(print);
    print('Справка не записана: в главном окне профиля нет раундов');
    return EXIT_USAGE;
  }
  roundLines(nick, result.reference.rounds).forEach(print);
  print(outcomeLine(result.reference.main.outcomes));
  print(writeReference(result.reference, context.referenceDir));
  return EXIT_OK;
}

async function runCalibrate(
  invocation: Extract<Invocation, { command: 'calibrate' }>,
  context: CliContext,
): Promise<number> {
  const reference = loadReference(invocation.profile, context.referenceDir);
  if (reference === null) {
    context.print(`нет справки ${invocation.profile}: сначала twin reference`);
    return EXIT_USAGE;
  }
  const started = context.now();
  const result = await calibrate(reference, invocation.seed, invocation.threads);
  calibrationReport(result).forEach(context.print);
  context.print(timeLine(context.now() - started, invocation.threads));
  context.print(writeCalibration(invocation.profile, result.calibration, context.referenceDir));
  return EXIT_OK;
}

function timeLine(elapsedMs: number, threads: number, rounds: number | null = null): string {
  const perRound = rounds === null || rounds === 0 ? '' : ` · ${(elapsedMs / rounds).toFixed(1)} мс на раунд`;
  return `Время: ${(elapsedMs / MS_PER_SECOND).toFixed(1)} с${perRound} · потоков ${String(threads)}`;
}

async function runCheck(invocation: Extract<Invocation, { command: 'check' }>, context: CliContext): Promise<number> {
  const { print, referenceDir } = context;
  const reference = loadReference(invocation.profile, referenceDir);
  const calibration = loadCalibration(invocation.profile, referenceDir);
  if (reference === null || calibration === null) {
    print(`нет справки или калибровки ${invocation.profile}: сначала twin reference и twin calibrate`);
    return EXIT_USAGE;
  }
  const profile = twinProfile(reference, calibration);
  const rounds = Math.ceil(invocation.rounds / ROUNDS_STEP) * ROUNDS_STEP;
  const games = checkPlan(reference, invocation.levels, rounds, invocation.seed);
  const started = context.now();
  const result = await runStand({ profile, games, logDir: invocation.logDir }, invocation.threads);
  const elapsed = context.now() - started;
  const mix = result.rounds.filter((round) => round.detail !== null);
  const twin: PlayerMetrics = { main: profileMetrics(mix), movement: movementMetrics(mix) };
  const inputs = checkInputs(reference, profile, calibration, (input) => input.measure(twin), inputSpread(mix));
  const honesty = judge(reference, invocation.levels, result.rounds, result, twin, inputs);
  print(`Профиль ${invocation.profile} · раундов на уровень ${String(rounds)} · сид ${String(invocation.seed)}`);
  checkReport(honesty, result.print).forEach(print);
  print(timeLine(elapsed, invocation.threads, result.played));
  return honesty.isHonest ? EXIT_OK : EXIT_DISHONEST;
}

export async function runCli(argv: readonly string[], context: CliContext): Promise<number> {
  const parsed = parseCliArgs(argv, context.threads);
  if ('error' in parsed) {
    context.print(parsed.error);
    context.print(USAGE);
    return EXIT_USAGE;
  }
  const invocation = parsed.invocation;
  if (invocation.command === 'reference') {
    return runReference(invocation.logDir, invocation.profile, context);
  }
  if (invocation.command === 'calibrate') {
    return runCalibrate(invocation, context);
  }
  return runCheck(invocation, context);
}
