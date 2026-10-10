import { DT, MUZZLE_OFFSET, TICK_RATE, type Side } from '@tanks/shared/engine';
import { gameTimecode } from '@tanks/shared/protocol';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyzeLogLines, type LogFile } from './index.js';
import type { LogAction, Pose } from './logParser.js';
import { selectProfileRounds, type ProfileRound, type ProfileSelection } from './profile/index.js';

export type { LogAction, Pose } from './logParser.js';

// Сборка синтетических журналов в формате сервера и клиента для тестов анализатора.

const SECONDS_PER_DAY = 86_400;
const MS_PER_SECOND = 1000;

export const IDLE: LogAction = { throttle: 0, turn: 0, turretTurn: 0, isFiring: false };
const PHASE = { countdown: 'c', fight: 'f' } as const;

export function pose(x: number, y: number, heading = 0, turret = 0): Pose {
  return { x, y, heading, turret };
}

export function action(throttle: number, turn = 0, turretTurn = 0, isFiring = false): LogAction {
  return { throttle, turn, turretTurn, isFiring };
}

export function muzzleOf(tank: Pose): { x: number; y: number } {
  return { x: tank.x + Math.cos(tank.turret) * MUZZLE_OFFSET, y: tank.y + Math.sin(tank.turret) * MUZZLE_OFFSET };
}

export interface EventSpec {
  kind: string;
  side: Side | null;
  x?: number;
  y?: number;
  v?: number;
}

export interface Frame {
  phase: string;
  poses: [Pose, Pose];
  actions?: [LogAction, LogAction];
  inputs?: [number, number];
  isSilent?: [boolean, boolean];
  events?: EventSpec[];
}

export function fightFrame(poses: [Pose, Pose], extra: Omit<Frame, 'phase' | 'poses'> = {}): Frame {
  return { phase: PHASE.fight, poses, ...extra };
}

export function repeatFrames(count: number, frameOf: (index: number) => Frame): Frame[] {
  return Array.from({ length: count }, (_, index) => frameOf(index));
}

function formatTime(sec: number): string {
  const wrapped = ((sec % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const hh = String(Math.floor(wrapped / 3600)).padStart(2, '0');
  const mm = String(Math.floor((wrapped % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(wrapped % 60)).padStart(2, '0');
  const ms = String(Math.floor((wrapped * MS_PER_SECOND) % MS_PER_SECOND)).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatAction(a: LogAction): string {
  return `${a.throttle.toFixed(2)},${a.turn.toFixed(2)},${a.turretTurn.toFixed(2)},${a.isFiring ? '1' : '0'}`;
}

function formatPose(p: Pose): string {
  return `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.heading.toFixed(2)},${p.turret.toFixed(2)}`;
}

// Журнал одной игры: номер тика и время растут с каждым кадром, как на сервере.
export class LogBuilder {
  private readonly lines: string[] = [];
  private gt = 0;
  private roundTick = 0;
  private clientNow = 0;

  constructor(private sec: number) {}

  get gameTick(): number {
    return this.gt;
  }

  server(text: string): this {
    this.lines.push(`${formatTime(this.sec)} S gt=${String(this.gt)} tc=${gameTimecode(this.gt)} ${text}`);
    return this;
  }

  client(side: Side, text: string): this {
    this.clientNow += 1;
    this.lines.push(
      `${formatTime(this.sec)} C${String(side)} gt=${String(this.gt)} tc=${gameTimecode(this.gt)} now=${String(this.clientNow)} ${text}`,
    );
    return this;
  }

  gameStart(room: string, p0: string, p1: string): this {
    return this.server(`game start room=${room} p0=${p0} p1=${p1}`);
  }

  roundStart(idx: number, mapIndex: number, score = '0:0'): this {
    this.roundTick = 0;
    return this.server(`round start idx=${String(idx)} map=${String(mapIndex)} score=${score}`);
  }

  frame(frame: Frame): this {
    this.gt++;
    this.sec += DT;
    const actions = frame.actions ?? [IDLE, IDLE];
    const inputs = frame.inputs ?? [1, 1];
    const isSilent = frame.isSilent ?? [false, false];
    const parts = [`tick rt=${String(this.roundTick)} ph=${frame.phase} late=0.0`];
    for (const side of [0, 1] as const) {
      const s = String(side);
      parts.push(
        `a${s}=${formatAction(actions[side])} ack${s}=${String(this.gt)} in${s}=${String(inputs[side])}`,
        `sil${s}=${isSilent[side] ? '1' : '0'} p${s}=${formatPose(frame.poses[side])}`,
      );
    }
    parts.push('b=0');
    this.server(parts.join(' '));
    this.roundTick++;
    for (const event of frame.events ?? []) {
      this.event(event);
    }
    return this;
  }

  frames(frames: readonly Frame[]): this {
    for (const frame of frames) {
      this.frame(frame);
    }
    return this;
  }

  event(event: EventSpec): this {
    const side = event.side === null ? '-' : String(event.side);
    const x = (event.x ?? 0).toFixed(1);
    const y = (event.y ?? 0).toFixed(1);
    const v = (event.v ?? 0).toFixed(1);
    return this.server(`ev kind=${event.kind} side=${side} x=${x} y=${y} v=${v}`);
  }

  droppedInput(side: Side): this {
    return this.server(`input stale side=${String(side)} seq=1 last=2`);
  }

  leave(side: Side, nick: string): this {
    return this.server(`leave side=${String(side)} nick=${nick}`);
  }

  text(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

export const ANDROID_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 16; 2407FPN8EG Build/BP2A.250605.031.A3; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';
export const MAC_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

// dev — номер устройства в конце строки, как пишет клиент; tail — признаки боя толпы перед ним (` mode=ffa size=30`).
export function deviceLine(userAgent: string, isTouch: boolean, dev?: string, tail = ''): string {
  const device = dev === undefined ? '' : ` dev=${dev}`;
  return `device ua=${userAgent} screen=792x375 dpr=3 touch=${isTouch ? '1' : '0'}${tail}${device}`;
}

// Время суток `HH:MM:SS.mmm` внутри ISO-даты `ГГГГ-ММ-ДДTHH:MM:SS.mmmZ`.
const ISO_TIME_START = 11;
const ISO_TIME_END = 23;

// Строка файла визитов: `HH:MM:SS.mmm V {JSON}`, время строки — из `at`.
export function visitLine(fields: { at: string; dev: string } & Record<string, unknown>): string {
  return `${fields.at.slice(ISO_TIME_START, ISO_TIME_END)} V ${JSON.stringify(fields)}`;
}

// Журнал комнаты: строки клиента до первого раунда.
export function roomLog(sec: number, side: Side, lines: readonly string[]): string {
  const builder = new LogBuilder(sec);
  for (const line of lines) {
    builder.client(side, line);
  }
  return builder.text();
}

const createdDirs: string[] = [];

// subdir — вложенная папка журналов, когда тесту нужен выход по умолчанию рядом с ней.
export function makeLogDir(files: Record<string, string>, subdir?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'tanks-analysis-'));
  createdDirs.push(root);
  const dir = subdir === undefined ? root : join(root, subdir);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

export function removeLogDirs(): void {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DEFAULT_ROOM = 'bot05test';
const BOT_NAME = 'Ветеран';
const HUMAN_NAME = 'Дима';
export const HUMAN: Side = 1;
export const BOT: Side = 0;
export const START_SEC = 3600;
const COUNTDOWN_FRAMES = 3;
export const DEFAULT_BULLET_SPEED = 550;
export const DEFAULT_DAMAGE = 28;
// Верхняя полоса карты «Полигон»: между краями поля на ней нет стен.
export const LANE_Y = 100;

export interface DuelSpec {
  room?: string;
  names?: [string, string];
  startSec?: number;
  shotLeadTicks?: number;
}

// Начало журнала дуэли: строка старта игры и строка клиента человека, чтобы сторона человека определялась по ней.
export function startDuel(spec: DuelSpec = {}): LogBuilder {
  const builder = new LogBuilder(spec.startSec ?? START_SEC);
  const [p0, p1] = spec.names ?? [BOT_NAME, HUMAN_NAME];
  const rules = spec.shotLeadTicks === undefined ? '' : ` rules=0 lead=${String(spec.shotLeadTicks)}`;
  builder.gameStart(spec.room ?? DEFAULT_ROOM, p0, `${p1}${rules}`);
  builder.client(HUMAN, 'net roundstart game=TEST idx=0 map=0 score=0:0');
  return builder;
}

export function countdownFrames(poses: [Pose, Pose], count = COUNTDOWN_FRAMES): Frame[] {
  return repeatFrames(count, () => ({ phase: PHASE.countdown, poses }));
}

export function standingFrames(poses: [Pose, Pose], count: number): Frame[] {
  return repeatFrames(count, () => fightFrame(poses));
}

// Путь снаряда за n тиков от момента выстрела в единицах поля.
export function bulletTravel(ticks: number, speed = DEFAULT_BULLET_SPEED): number {
  return (speed / TICK_RATE) * ticks;
}

export function logFiles(files: Record<string, string>): LogFile[] {
  return Object.entries(files).map(([name, text]) => ({ name, lines: text.split('\n') }));
}

// Выборка профиля для синтетических журналов: ник человека из startDuel, все его игры, снаряд ботов по умолчанию.
export const FIXTURE_SELECTION: ProfileSelection = {
  nick: HUMAN_NAME,
  periods: null,
  oldLadderGames: [],
  botBulletSpeeds: { 1: 550, 2: 550, 3: 550, 4: 550, 5: 550, 6: 550, 7: 550, 8: 550, 9: 550, 10: 550 },
};

export function roundOver(winner: Side | null): EventSpec {
  return { kind: 'roundOver', side: winner };
}

// Раунды выборки синтетических журналов, разобранных из памяти.
export function profileRoundsOf(files: Record<string, string>): ProfileRound[] {
  return selectProfileRounds(analyzeLogLines(logFiles(files)), FIXTURE_SELECTION).kept;
}

export function shotEvent(side: Side, shooter: Pose): EventSpec {
  return { kind: 'shot', side, ...muzzleOf(shooter), v: shooter.turret };
}
