import { DEFAULT_RULES, WALL_SLIDE_MAX_PERCENT, type Side } from '@tanks/shared/engine';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// У клиентских строк после таймкода идёт ещё `now=<мс>`; он отбрасывается.
const LINE_PATTERN = /^(\d\d):(\d\d):(\d\d)\.(\d{3}) (\S+) gt=(\d+) tc=\S+ (?:now=\S+ )?(.*)$/;
const KEY_VALUE_PATTERN = /(\w+)=(\S*)/g;
const CLIENT_SOURCE_PATTERN = /^C([01])$/;
const DEVICE_PATTERN = /^device ua=(.*) screen=\S* dpr=\S* touch=(\S*)/;
// Ник пишется в журнал как есть и может содержать пробелы: он тянется до следующего поля строки.
const GAME_START_NAMES_PATTERN = / p0=(.*?) p1=(.*?)(?: rules=\S*)?$/;
const LEAVE_NICK_PATTERN = / nick=(.*)$/;
const SERVER_SOURCE = 'S';
const LOG_EXTENSION = '.log';
const ROOM_LOG_PREFIX = 'room-';
const SERVER_LOG_FILE = 'server.log';
const NO_SIDE_MARK = '-';
const ACTION_FIELDS = 4;
const POSE_FIELDS = 4;
const TOUCH_ON = '1';
const SLOTS_SEPARATOR = '|';
const ROOM_SLOTS_PREFIX = 'net room slots=';
const DROPPED_INPUT_PREFIXES: readonly string[] = ['input stale', 'input limit', 'input overflow', 'input backlog'];
const USER_AGENT_LABEL_LENGTH = 40;
// Строка `device` берётся из журнала комнаты, только если она написана не дальше пяти минут от старта игры.
const DEVICE_ROOM_WINDOW_SEC = 300;
export const SECONDS_PER_DAY = 86_400;
const HALF_DAY_SEC = SECONDS_PER_DAY / 2;

export const SIDES: readonly Side[] = [0, 1];

export interface LogAction {
  throttle: number;
  turn: number;
  turretTurn: number;
  isFiring: boolean;
}

export interface Pose {
  x: number;
  y: number;
  heading: number;
  turret: number;
}

export interface Tick {
  gt: number;
  rt: number;
  phase: string;
  actions: [LogAction, LogAction];
  poses: [Pose, Pose];
  isSilent: [boolean, boolean];
  inputs: [number, number];
}

export interface GameEvent {
  gt: number;
  kind: string;
  side: Side | null;
  x: number;
  y: number;
  v: number;
}

export interface ParsedRound {
  idx: number;
  mapIndex: number;
  scoreBefore: string;
  startGt: number;
  ticks: Tick[];
  events: GameEvent[];
}

export interface ClientLine {
  gt: number;
  text: string;
}

export interface LeaveRecord {
  side: Side | null;
  nick: string;
}

// wallSlidePercent — байт `rules=` строки старта; в журналах до появления байта и при испорченном значении
// стены липкие, 0.
export interface ParsedGame {
  id: string;
  room: string;
  names: [string, string];
  startSec: number;
  wallSlidePercent: number;
  rounds: ParsedRound[];
  clientLines: [ClientLine[], ClientLine[]];
  droppedInputs: [number, number];
  leave: LeaveRecord | null;
}

export const FIGHT_PHASE = 'f';

interface ParsedLine {
  sec: number;
  source: string;
  gt: number;
  body: string;
}

export function parseLine(raw: string): ParsedLine | null {
  const match = LINE_PATTERN.exec(raw);
  if (match === null) {
    return null;
  }
  const sec =
    Number(group(match, 1)) * 3600 +
    Number(group(match, 2)) * 60 +
    Number(group(match, 3)) +
    Number(group(match, 4)) / 1000;
  return { sec, source: group(match, 5), gt: Number(group(match, 6)), body: group(match, 7) };
}

// Группа совпадения как строка: у этих шаблонов группы обязательные, пустая строка — на случай пропуска.
function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? '';
}

export function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of text.matchAll(KEY_VALUE_PATTERN)) {
    values.set(group(match, 1), group(match, 2));
  }
  return values;
}

// Значение поля `key=`; отсутствующее поле — пустая строка, Number('') даёт 0.
export function field(values: Map<string, string>, key: string): string {
  return values.get(key) ?? '';
}

function wallSlideOf(text: string): number {
  const value = Number(text);
  const isValid = text !== '' && Number.isInteger(value) && value >= 0 && value <= WALL_SLIDE_MAX_PERCENT;
  return isValid ? value : DEFAULT_RULES.wallSlidePercent;
}

export function parseAction(text: string): LogAction | null {
  const parts = text.split(',');
  if (parts.length !== ACTION_FIELDS) {
    return null;
  }
  return {
    throttle: Number(parts[0]),
    turn: Number(parts[1]),
    turretTurn: Number(parts[2]),
    isFiring: parts[3] === '1',
  };
}

function parsePose(text: string): Pose | null {
  const parts = text.split(',');
  if (parts.length !== POSE_FIELDS) {
    return null;
  }
  return { x: Number(parts[0]), y: Number(parts[1]), heading: Number(parts[2]), turret: Number(parts[3]) };
}

function sideOf(value: string | undefined): Side | null {
  if (value === '0') {
    return 0;
  }
  if (value === '1') {
    return 1;
  }
  return null;
}

function clientSideOf(source: string): Side | null {
  const match = CLIENT_SOURCE_PATTERN.exec(source);
  return sideOf(match?.[1]);
}

function parseTick(gt: number, values: Map<string, string>): Tick | null {
  const a0 = parseAction(field(values, 'a0'));
  const a1 = parseAction(field(values, 'a1'));
  const p0 = parsePose(field(values, 'p0'));
  const p1 = parsePose(field(values, 'p1'));
  const rt = values.get('rt');
  const phase = values.get('ph');
  if (a0 === null || a1 === null || p0 === null || p1 === null || rt === undefined || phase === undefined) {
    return null;
  }
  return {
    gt,
    rt: Number(rt),
    phase,
    actions: [a0, a1],
    poses: [p0, p1],
    isSilent: [values.get('sil0') === '1', values.get('sil1') === '1'],
    inputs: [Number(field(values, 'in0')), Number(field(values, 'in1'))],
  };
}

function parseEvent(gt: number, values: Map<string, string>): GameEvent | null {
  const kind = values.get('kind');
  const side = values.get('side');
  if (kind === undefined || side === undefined) {
    return null;
  }
  return {
    gt,
    kind,
    side: side === NO_SIDE_MARK ? null : sideOf(side),
    x: Number(field(values, 'x')),
    y: Number(field(values, 'y')),
    v: Number(field(values, 'v')),
  };
}

// null — в файле нет строки `game start` или ни одного раунда: анализировать нечего.
export function parseGameLog(id: string, text: string): ParsedGame | null {
  let room: string | null = null;
  let names: [string, string] = ['', ''];
  let startSec: number | null = null;
  let wallSlidePercent = 0;
  const rounds: ParsedRound[] = [];
  const clientLines: [ClientLine[], ClientLine[]] = [[], []];
  const droppedInputs: [number, number] = [0, 0];
  let leave: LeaveRecord | null = null;
  let current: ParsedRound | null = null;
  for (const raw of text.split('\n')) {
    const line = parseLine(raw);
    if (line === null) {
      continue;
    }
    const { sec, source, gt, body } = line;
    if (source !== SERVER_SOURCE) {
      const side = clientSideOf(source);
      if (side !== null) {
        clientLines[side].push({ gt, text: body });
      }
      continue;
    }
    if (body.startsWith('tick ')) {
      const tick = current === null ? null : parseTick(gt, parseKeyValues(body));
      if (tick !== null && current !== null) {
        current.ticks.push(tick);
      }
      continue;
    }
    if (body.startsWith('ev ')) {
      const event = current === null ? null : parseEvent(gt, parseKeyValues(body));
      if (event !== null && current !== null) {
        current.events.push(event);
      }
      continue;
    }
    if (body.startsWith('round start')) {
      const values = parseKeyValues(body);
      current = {
        idx: Number(field(values, 'idx')),
        mapIndex: Number(field(values, 'map')),
        scoreBefore: field(values, 'score'),
        startGt: gt,
        ticks: [],
        events: [],
      };
      rounds.push(current);
      continue;
    }
    if (body.startsWith('game start')) {
      const values = parseKeyValues(body);
      room = field(values, 'room');
      const nameMatch = GAME_START_NAMES_PATTERN.exec(body);
      names = [nameMatch?.[1] ?? '', nameMatch?.[2] ?? ''];
      startSec = sec;
      wallSlidePercent = wallSlideOf(field(values, 'rules'));
      continue;
    }
    if (DROPPED_INPUT_PREFIXES.some((prefix) => body.startsWith(prefix))) {
      const side = sideOf(parseKeyValues(body).get('side'));
      if (side !== null) {
        droppedInputs[side]++;
      }
      continue;
    }
    if (body.startsWith('leave')) {
      const values = parseKeyValues(body);
      leave = { side: sideOf(values.get('side')), nick: LEAVE_NICK_PATTERN.exec(body)?.[1] ?? '' };
    }
  }
  if (room === null || startSec === null || rounds.length === 0) {
    return null;
  }
  return { id, room, names, startSec, wallSlidePercent, rounds, clientLines, droppedInputs, leave };
}

export interface DeviceEntry {
  sec: number;
  userAgent: string;
  isTouch: boolean;
}

export interface DeviceIndex {
  byRoomSide: Map<string, DeviceEntry[]>;
  byNick: Map<string, DeviceEntry[]>;
}

export type DeviceSource = 'комната' | 'ник';

export interface DevicePick {
  entry: DeviceEntry;
  source: DeviceSource;
}

function roomSideKey(room: string, side: Side): string {
  return `${room}:${String(side)}`;
}

function push<K>(index: Map<K, DeviceEntry[]>, key: K, entry: DeviceEntry): void {
  const entries = index.get(key);
  if (entries === undefined) {
    index.set(key, [entry]);
    return;
  }
  entries.push(entry);
}

function listLogFiles(logDir: string): string[] {
  return readdirSync(logDir)
    .filter((name) => name.endsWith(LOG_EXTENSION))
    .sort();
}

export function isGameLogFile(name: string): boolean {
  return name.endsWith(LOG_EXTENSION) && !isRoomLogFile(name) && name !== SERVER_LOG_FILE;
}

export function isRoomLogFile(name: string): boolean {
  return name.startsWith(ROOM_LOG_PREFIX) && name.endsWith(LOG_EXTENSION);
}

export function gameIdOf(name: string): string {
  return name.slice(0, -LOG_EXTENSION.length);
}

export function listGameIds(logDir: string): string[] {
  return listLogFiles(logDir).filter(isGameLogFile).map(gameIdOf);
}

export interface RoomLog {
  name: string;
  lines: readonly string[];
}

export function readRoomLogs(logDir: string): RoomLog[] {
  return listLogFiles(logDir)
    .filter(isRoomLogFile)
    .map((name) => ({ name, lines: readFileSync(join(logDir, name), 'utf8').split('\n') }));
}

// Строки `device` из `room-<код>.log`; ник из `net room slots=` — запасной ключ, когда игра началась
// без новой строки `device` (игрок пришёл в комнату раньше, чем за пять минут до старта).
export function deviceIndexOf(rooms: readonly RoomLog[]): DeviceIndex {
  const index: DeviceIndex = { byRoomSide: new Map(), byNick: new Map() };
  for (const room of rooms) {
    const code = room.name.slice(ROOM_LOG_PREFIX.length, -LOG_EXTENSION.length);
    const lastDevice = new Map<Side, DeviceEntry>();
    for (const raw of room.lines) {
      const line = parseLine(raw);
      if (line === null) {
        continue;
      }
      const side = clientSideOf(line.source);
      if (side === null) {
        continue;
      }
      const device = DEVICE_PATTERN.exec(line.body);
      if (device !== null) {
        const entry: DeviceEntry = {
          sec: line.sec,
          userAgent: group(device, 1),
          isTouch: group(device, 2) === TOUCH_ON,
        };
        push(index.byRoomSide, roomSideKey(code, side), entry);
        lastDevice.set(side, entry);
        continue;
      }
      const known = lastDevice.get(side);
      if (!line.body.startsWith(ROOM_SLOTS_PREFIX) || known === undefined) {
        continue;
      }
      const nick = line.body.slice(ROOM_SLOTS_PREFIX.length).split(SLOTS_SEPARATOR)[side];
      if (nick !== undefined) {
        push(index.byNick, nick, known);
      }
    }
  }
  return index;
}

// Время в журнале — секунды суток, игра может перейти через полночь.
function timeDistance(a: number, b: number): number {
  const diff = Math.abs(a - b);
  return diff > HALF_DAY_SEC ? SECONDS_PER_DAY - diff : diff;
}

function nearestEntry(entries: readonly DeviceEntry[] | undefined, startSec: number): DeviceEntry | null {
  let best: DeviceEntry | null = null;
  let bestDistance = Infinity;
  for (const entry of entries ?? []) {
    const distance = timeDistance(entry.sec, startSec);
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best;
}

export function pickDevice(
  index: DeviceIndex,
  room: string,
  side: Side,
  nick: string,
  startSec: number,
): DevicePick | null {
  const byRoom = nearestEntry(index.byRoomSide.get(roomSideKey(room, side)), startSec);
  if (byRoom !== null && timeDistance(byRoom.sec, startSec) <= DEVICE_ROOM_WINDOW_SEC) {
    return { entry: byRoom, source: 'комната' };
  }
  const byNick = nearestEntry(index.byNick.get(nick), startSec);
  if (byNick !== null) {
    return { entry: byNick, source: 'ник' };
  }
  return null;
}

const ANDROID_MODEL_PATTERN = /Android [\d.]+; ([^;)]+)/;
const ANDROID_BUILD_SUFFIX = ' Build';

export function deviceLabel(entry: DeviceEntry): string {
  const ua = entry.userAgent;
  if (ua.includes('Android')) {
    const model = ANDROID_MODEL_PATTERN.exec(ua)?.[1]?.split(ANDROID_BUILD_SUFFIX)[0] ?? '?';
    return entry.isTouch ? `Android (${model}), касание` : 'Android';
  }
  if (ua.includes('Macintosh')) {
    return entry.isTouch ? 'Mac, Chrome' : 'Mac, Chrome, мышь';
  }
  return ua.slice(0, USER_AGENT_LABEL_LENGTH);
}
