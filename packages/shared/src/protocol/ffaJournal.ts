import {
  checkStats,
  createFfaMatch,
  DEFAULT_STATS,
  ffaMap,
  FFA_SIZES,
  joinFfaMatch,
  leaveFfaMatch,
  STAT_KEYS,
  stepFfaMatch,
  TICK_RATE,
  worldDigest,
  type Action,
  type FfaEvent,
  type FfaMap,
  type FfaMatch,
  type FfaSize,
  type RoundRules,
  type Stats,
} from '../engine/index.js';
import { dequantizeAxis, quantizeAxis, rulesFromByte } from './codec.js';

// Журнал боя толпы без поз: бой повторяется прогоном движка по составу, сиду, входам, выходам и командам.
// Строки — договор между сервером, который их пишет, и разбором журналов, который прогоняет бой.
export const FFA_JOURNAL = {
  gameStart: 'game start',
  matchStart: 'match start',
  fightStart: 'fight start',
  join: 'mjoin',
  actions: 'ac',
  sum: 'sum',
  leave: 'leave',
  matchOver: 'match over',
} as const;

export const FFA_LEAVE_OFFLINE = 'offline';
export const FFA_LEAVE_IDLE = 'idle';

const NO_ACTION = '-';
const SERVER_LINE = /^\S+ S gt=(\d+) tc=\S+ (.*)$/;

export interface FfaJournalPlayer {
  id: number;
  stats: Stats;
}

export function formatJournalStats(stats: Stats): string {
  return STAT_KEYS.map((key) => String(stats[key])).join('');
}

export function formatJournalRoster(roster: readonly FfaJournalPlayer[]): string {
  return roster.map((entry) => `${String(entry.id)}:${formatJournalStats(entry.stats)}`).join(',');
}

function formatAction(action: Action): string {
  const axes = [action.throttle, action.turn, action.turretTurn].map((axis) => String(quantizeAxis(axis)));
  return `${axes.join(',')},${action.isFiring ? '1' : '0'}`;
}

function isSameAction(a: Action | undefined, b: Action | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.throttle === b.throttle && a.turn === b.turn && a.turretTurn === b.turretTurn && a.isFiring === b.isFiring;
}

// Строка команд тика: только изменившиеся с прошлого тика; null — ничего не изменилось.
export function formatJournalActions(
  previous: ReadonlyMap<number, Action>,
  current: ReadonlyMap<number, Action>,
): string | null {
  const parts: string[] = [];
  for (const [id, action] of current) {
    if (!isSameAction(previous.get(id), action)) {
      parts.push(`${String(id)}=${formatAction(action)}`);
    }
  }
  for (const id of previous.keys()) {
    if (!current.has(id)) {
      parts.push(`${String(id)}=${NO_ACTION}`);
    }
  }
  return parts.length === 0 ? null : `${FFA_JOURNAL.actions} ${parts.join(' ')}`;
}

export function isJournalSumTick(match: FfaMatch): boolean {
  return match.world.tick % TICK_RATE === 0 || match.isOver;
}

export function formatJournalSum(match: FfaMatch): string {
  return `${FFA_JOURNAL.sum} t=${String(match.world.tick)} h=${worldDigest(match.world)}`;
}

export interface FfaJournalMismatch {
  tick: number;
  expected: string;
  actual: string;
}

export interface FfaJournalMatch {
  index: number;
  seed: number;
  match: FfaMatch;
  ticks: number;
  sums: number;
  mismatches: FfaJournalMismatch[];
  isComplete: boolean;
}

export interface FfaJournalReplay {
  size: FfaSize | null;
  matches: FfaJournalMatch[];
}

// onTick — после каждого шага движка: состояние матча, тик игры и события шага.
export interface FfaJournalOptions {
  mapFor?: (size: FfaSize) => FfaMap;
  onTick?: (match: FfaMatch, gameTick: number, events: readonly FfaEvent[]) => void;
}

interface Entry {
  gameTick: number;
  text: string;
}

interface Running {
  result: FfaJournalMatch;
  actions: Map<number, Action>;
  // Тик игры, шаг которого сделан последним; null — идёт отсчёт.
  steppedTick: number | null;
}

function serverEntry(line: string): Entry | null {
  const parsed = SERVER_LINE.exec(line);
  if (parsed === null) {
    return null;
  }
  return { gameTick: Number(parsed[1]), text: parsed[2] ?? '' };
}

function field(text: string, key: string): string | null {
  const match = new RegExp(`(?:^| )${key}=(\\S+)`).exec(text);
  return match?.[1] ?? null;
}

function numberField(text: string, key: string): number | null {
  const raw = field(text, key);
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseStats(raw: string): Stats {
  const stats = Object.fromEntries(STAT_KEYS.map((key, index) => [key, Number(raw.charAt(index))]));
  return checkStats(stats).isOk ? (stats as Stats) : { ...DEFAULT_STATS };
}

function parseRoster(raw: string): FfaJournalPlayer[] {
  return raw.split(',').map((item) => {
    const [id = '', stats = ''] = item.split(':');
    return { id: Number(id), stats: parseStats(stats) };
  });
}

function parseAction(raw: string): Action | null {
  if (raw === NO_ACTION) {
    return null;
  }
  const [throttle = 0, turn = 0, turretTurn = 0, fire = 0] = raw.split(',').map(Number);
  return {
    throttle: dequantizeAxis(throttle),
    turn: dequantizeAxis(turn),
    turretTurn: dequantizeAxis(turretTurn),
    isFiring: fire === 1,
  };
}

function isFfaSize(value: number): value is FfaSize {
  return (FFA_SIZES as readonly number[]).includes(value);
}

function startsWith(text: string, tag: string): boolean {
  return text === tag || text.startsWith(`${tag} `);
}

// Шаги без строк в журнале идут с теми же командами: журнал пишет команды только при смене.
function stepUntil(running: Running, gameTick: number, options: FfaJournalOptions): void {
  if (running.steppedTick === null) {
    return;
  }
  const { match } = running.result;
  while (running.steppedTick < gameTick && !match.isOver) {
    const events = stepFfaMatch(match, running.actions);
    running.steppedTick++;
    running.result.ticks++;
    options.onTick?.(match, running.steppedTick, events);
  }
}

function applyActions(running: Running, text: string): void {
  for (const token of text.slice(FFA_JOURNAL.actions.length + 1).split(' ')) {
    const [id = '', raw = ''] = token.split('=');
    const action = parseAction(raw);
    if (action === null) {
      running.actions.delete(Number(id));
      continue;
    }
    running.actions.set(Number(id), action);
  }
}

function leave(running: Running, text: string): void {
  const id = numberField(text, 'id');
  if (id === null || running.result.match.isOver) {
    return;
  }
  leaveFfaMatch(running.result.match, id);
  running.actions.delete(id);
}

function checkSum(running: Running, text: string): void {
  const { match } = running.result;
  running.result.sums++;
  const expected = `${field(text, 't') ?? ''}:${field(text, 'h') ?? ''}`;
  const actual = `${String(match.world.tick)}:${worldDigest(match.world)}`;
  if (expected !== actual) {
    running.result.mismatches.push({ tick: match.world.tick, expected, actual });
  }
}

// Строка журнала относится к тику игры: всё до шага движка (выход по обрыву, вход, команды) применяется перед
// шагом этого тика, всё после (события, сверка, выход за бездействие, конец) — после.
function applyFightEntry(running: Running, entry: Entry, options: FfaJournalOptions): void {
  const { text, gameTick } = entry;
  const isOfflineLeave = startsWith(text, FFA_JOURNAL.leave) && field(text, 'reason') === FFA_LEAVE_OFFLINE;
  const isBeforeStep = isOfflineLeave || startsWith(text, FFA_JOURNAL.join) || startsWith(text, FFA_JOURNAL.actions);
  stepUntil(running, isBeforeStep ? gameTick - 1 : gameTick, options);
  if (startsWith(text, FFA_JOURNAL.actions)) {
    applyActions(running, text);
    return;
  }
  if (startsWith(text, FFA_JOURNAL.join)) {
    const id = numberField(text, 'id');
    if (id !== null) {
      joinFfaMatch(running.result.match, { id, name: `#${String(id)}`, stats: parseStats(field(text, 'stats') ?? '') });
    }
    return;
  }
  if (startsWith(text, FFA_JOURNAL.leave)) {
    leave(running, text);
    return;
  }
  if (startsWith(text, FFA_JOURNAL.sum)) {
    checkSum(running, text);
    return;
  }
  if (startsWith(text, FFA_JOURNAL.matchOver)) {
    running.result.isComplete = true;
  }
}

function createRunning(text: string, size: FfaSize, rules: RoundRules, options: FfaJournalOptions): Running | null {
  const index = numberField(text, 'idx');
  const seed = numberField(text, 'seed');
  const duration = numberField(text, 'dur');
  const roster = field(text, 'roster');
  if (index === null || seed === null || duration === null || roster === null) {
    return null;
  }
  const map = (options.mapFor ?? ffaMap)(size);
  const setups = parseRoster(roster).map((entry) => ({ ...entry, name: `#${String(entry.id)}` }));
  const match = createFfaMatch(map, setups, seed, rules, duration);
  return {
    result: { index, seed, match, ticks: 0, sums: 0, mismatches: [], isComplete: false },
    actions: new Map(),
    steppedTick: null,
  };
}

// Строки файла журнала целиком: строки клиентов, дуэли и непонятные пропускаются.
export function replayFfaJournal(lines: readonly string[], options: FfaJournalOptions = {}): FfaJournalReplay {
  const replay: FfaJournalReplay = { size: null, matches: [] };
  let rules: RoundRules = rulesFromByte(0);
  let running: Running | null = null;
  for (const line of lines) {
    const entry = serverEntry(line);
    if (entry === null) {
      continue;
    }
    const { text } = entry;
    if (startsWith(text, FFA_JOURNAL.gameStart)) {
      const size = numberField(text, 'size');
      const isFfa = field(text, 'mode') === 'ffa' && size !== null && isFfaSize(size);
      replay.size = isFfa ? size : null;
      rules = rulesFromByte(numberField(text, 'rules') ?? 0);
      continue;
    }
    if (replay.size === null) {
      continue;
    }
    if (startsWith(text, FFA_JOURNAL.matchStart)) {
      running = createRunning(text, replay.size, rules, options);
      if (running !== null) {
        replay.matches.push(running.result);
      }
      continue;
    }
    if (running === null || running.result.isComplete) {
      continue;
    }
    if (startsWith(text, FFA_JOURNAL.fightStart)) {
      running.steppedTick = entry.gameTick;
      continue;
    }
    if (running.steppedTick === null) {
      if (startsWith(text, FFA_JOURNAL.leave)) {
        leave(running, text);
      }
      continue;
    }
    applyFightEntry(running, entry, options);
  }
  return replay;
}
