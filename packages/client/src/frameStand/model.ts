import {
  createRound,
  DEFAULT_STATS,
  deriveStats,
  MUZZLE_OFFSET,
  zoneRadiusAt,
  type Round,
  type Side,
} from '@tanks/shared/engine';
import type { SnapshotEvent, SnapshotEventKind, TankSnapshot } from '@tanks/shared/protocol';
import type { InterpolatedBullet, InterpolatedTank, WorldView } from '../prediction.js';
import type { RoundEndInfo } from '../roundEnd.js';
import type { Settings } from '../settings.js';
import type { StickRole } from '../touch.js';

// Кадр дуэли для эталона: мир в момент снимка, события с возрастом и интерфейс. История до снимка выводится из
// него же: событие моложе момента ещё не случилось — танк до попадания целее, до гибели жив, аптечка до подбора
// лежит, снаряд до выстрела не летит.

export type FrameScreenId = 'phone' | 'desktop';
// Кадр холста отдаёт пиксели холста; кадр страницы рисуется поверх страницы боя и снимается окном.
export type FrameKind = 'canvas' | 'page';
type FramePhase = 'countdown' | 'fight' | 'over';

export interface TankPose {
  x: number;
  y: number;
  heading: number;
  turret: number;
  hp?: number;
  isAlive?: boolean;
}

interface FrameBullet {
  owner: Side;
  x: number;
  y: number;
  angle: number;
  ageS: number;
}

interface FrameKit {
  isActive: boolean;
  respawnIn: number;
}

export interface TimedEvent {
  ageS: number;
  event: SnapshotEvent;
}

// Танк ехал вперёд по своему курсу `durationS` секунд и встал в точке кадра за `stopAgeS` до снимка.
interface TankDrive {
  side: Side;
  durationS: number;
  stopAgeS: number;
}

interface StickPose {
  role: StickRole;
  dx: number;
  dy: number;
  isFiring: boolean;
}

// `focus` — половина экрана вокруг точки поля, как в лаборатории; `screen` — доли экрана.
export type FrameCrop =
  | { kind: 'focus'; x: number; y: number }
  | { kind: 'screen'; left: number; top: number; right: number; bottom: number };

interface RoundEndFrame {
  info: RoundEndInfo;
  ageS: number;
}

export interface DuelFrame {
  id: string;
  title: string;
  kind: FrameKind;
  screens: readonly FrameScreenId[];
  mapIndex: number;
  mySide: Side;
  phase: FramePhase;
  roundTimeS: number;
  roundIndex: number;
  score: [number, number];
  tanks: [TankPose, TankPose];
  bullets: readonly FrameBullet[];
  // `null` — аптечки как в начале раунда.
  kits: readonly FrameKit[] | null;
  events: readonly TimedEvent[];
  drives: readonly TankDrive[];
  sticks: readonly StickPose[];
  isShotGuarded: boolean;
  isReversing: boolean;
  countdownLeftS: number | null;
  settings: Partial<Settings>;
  crop: FrameCrop | null;
  roundEnd: RoundEndFrame | null;
}

export const NAMES: [string, string] = ['Дима', 'Бублик'];
export const DEFAULT_TANK_STATS = deriveStats(DEFAULT_STATS);
const DRIVE_SPEED = 120;

function snapshotEvent(
  kind: SnapshotEventKind,
  side: Side | null,
  x: number,
  y: number,
  details: Partial<Pick<SnapshotEvent, 'value' | 'dx' | 'dy' | 'flags'>> = {},
): SnapshotEvent {
  return { kind, side, x, y, value: 0, dx: 0, dy: 0, flags: 0, ...details };
}

export function muzzleOf(pose: TankPose): { x: number; y: number } {
  return { x: pose.x + Math.cos(pose.turret) * MUZZLE_OFFSET, y: pose.y + Math.sin(pose.turret) * MUZZLE_OFFSET };
}

export function shotEvent(side: Side, pose: TankPose): SnapshotEvent {
  const muzzle = muzzleOf(pose);
  return snapshotEvent('shot', side, muzzle.x, muzzle.y, {
    value: pose.turret,
    dx: Math.cos(pose.turret),
    dy: Math.sin(pose.turret),
  });
}

// Точка — где снаряд вошёл в танк; урон зоной приходит в точке танка без направления.
export function hitEvent(
  side: Side,
  at: { x: number; y: number },
  angle: number | null,
  damage: number,
  flags = 0,
): SnapshotEvent {
  const direction = angle === null ? { dx: 0, dy: 0 } : { dx: Math.cos(angle), dy: Math.sin(angle) };
  return snapshotEvent('hit', side, at.x, at.y, { value: damage, ...direction, flags });
}

export function deathEvent(side: Side, pose: TankPose): SnapshotEvent {
  return snapshotEvent('death', side, pose.x, pose.y);
}

export function pointEvent(
  kind: 'impact' | 'fizzle' | 'clash' | 'bump' | 'kitSpawn',
  side: Side | null,
  x: number,
  y: number,
): SnapshotEvent {
  return snapshotEvent(kind, side, x, y);
}

export function ricochetEvent(side: Side, x: number, y: number, nx: number, ny: number): SnapshotEvent {
  return snapshotEvent('ricochet', side, x, y, { dx: nx, dy: ny });
}

export function pickupEvent(side: Side, x: number, y: number, healed: number): SnapshotEvent {
  return snapshotEvent('pickup', side, x, y, { value: healed });
}

export function zoneStartEvent(): SnapshotEvent {
  return snapshotEvent('zoneStart', null, 0, 0);
}

// Снаряд, `ageS` секунд назад вылетевший из точки `origin` (дуло, место отскока) под углом `angle`.
export function bulletFrom(owner: Side, origin: { x: number; y: number }, angle: number, ageS: number): FrameBullet {
  const distance = DEFAULT_TANK_STATS.bulletSpeed * ageS;
  return {
    owner,
    x: origin.x + Math.cos(angle) * distance,
    y: origin.y + Math.sin(angle) * distance,
    angle,
    ageS,
  };
}

// События, которые к моменту `t` (секунды до снимка, отрицательные) ещё не случились.
function eventsAfter(frame: DuelFrame, t: number): TimedEvent[] {
  return frame.events.filter((timed) => -timed.ageS > t);
}

function placeTank(round: Round, frame: DuelFrame, side: Side, t: number, later: readonly TimedEvent[]): void {
  const tank = round.tanks[side];
  const pose = frame.tanks[side];
  const drive = frame.drives.find((candidate) => candidate.side === side);
  const sinceStopS = drive === undefined ? 0 : -t - drive.stopAgeS;
  const aheadS = drive === undefined ? 0 : Math.min(Math.max(sinceStopS, 0), drive.durationS);
  const isDriving = drive !== undefined && sinceStopS > 0 && sinceStopS < drive.durationS;
  tank.x = pose.x - Math.cos(pose.heading) * DRIVE_SPEED * aheadS;
  tank.y = pose.y - Math.sin(pose.heading) * DRIVE_SPEED * aheadS;
  tank.speed = isDriving ? DRIVE_SPEED : 0;
  tank.heading = pose.heading;
  tank.turret = pose.turret;
  tank.hp = pose.hp ?? tank.stats.maxHp;
  tank.isAlive = pose.isAlive ?? true;
  for (const { event } of later) {
    if (event.side !== side) {
      continue;
    }
    if (event.kind === 'hit') {
      tank.hp += event.value;
    } else if (event.kind === 'pickup') {
      tank.hp -= event.value;
    } else if (event.kind === 'death') {
      tank.isAlive = true;
    }
  }
}

function placeKits(round: Round, frame: DuelFrame, later: readonly TimedEvent[], t: number): void {
  for (const [index, kit] of round.kits.entries()) {
    const pose = frame.kits?.[index];
    if (pose !== undefined) {
      kit.isActive = pose.isActive;
      kit.respawnIn = pose.respawnIn;
    }
    for (const { ageS, event } of later) {
      const isHere = event.x === kit.x && event.y === kit.y;
      if (!isHere) {
        continue;
      }
      if (event.kind === 'pickup') {
        kit.isActive = true;
      } else if (event.kind === 'kitSpawn') {
        kit.isActive = false;
        kit.respawnIn = -ageS - t;
      }
    }
  }
}

function roundAt(frame: DuelFrame, t: number): Round {
  const round = createRound(frame.mapIndex, [
    { name: NAMES[0], stats: { ...DEFAULT_STATS } },
    { name: NAMES[1], stats: { ...DEFAULT_STATS } },
  ]);
  round.time = Math.max(0, frame.roundTimeS + t);
  round.zone.radius = zoneRadiusAt(round.zonePlan, round.time);
  round.isOver = frame.phase === 'over';
  const later = eventsAfter(frame, t);
  placeTank(round, frame, 0, t, later);
  placeTank(round, frame, 1, t, later);
  placeKits(round, frame, later, t);
  return round;
}

function tankView(round: Round, side: Side): InterpolatedTank {
  const tank = round.tanks[side];
  return {
    x: tank.x,
    y: tank.y,
    heading: tank.heading,
    turret: tank.turret,
    speed: tank.speed,
    hp: tank.hp,
    maxHp: tank.stats.maxHp,
    isAlive: tank.isAlive,
  };
}

function bulletsAt(frame: DuelFrame, t: number): InterpolatedBullet[] {
  return frame.bullets.flatMap((bullet, index) => {
    const backS = -t;
    if (backS > bullet.ageS) {
      return [];
    }
    const back = DEFAULT_TANK_STATS.bulletSpeed * backS;
    return [
      {
        id: index + 1,
        owner: bullet.owner,
        x: bullet.x - Math.cos(bullet.angle) * back,
        y: bullet.y - Math.sin(bullet.angle) * back,
      },
    ];
  });
}

export function viewAt(frame: DuelFrame, t: number): WorldView {
  const round = roundAt(frame, t);
  return { round, tanks: [tankView(round, 0), tankView(round, 1)], bullets: bulletsAt(frame, t) };
}

// Сколько секунд до снимка начинается история кадра: самое старое событие, снаряд или поездка.
export function historyS(frame: DuelFrame): number {
  return Math.max(
    0,
    ...frame.events.map((timed) => timed.ageS),
    ...frame.bullets.map((bullet) => bullet.ageS),
    ...frame.drives.map((drive) => drive.stopAgeS + drive.durationS),
  );
}

function tankSnapshot(tank: InterpolatedTank): TankSnapshot {
  return {
    x: tank.x,
    y: tank.y,
    heading: tank.heading,
    turret: tank.turret,
    speed: tank.speed,
    hp: tank.hp,
    reloadLeft: 0,
    isAlive: tank.isAlive,
  };
}

export function tanksSnapshot(view: WorldView): TankSnapshot[] {
  return view.tanks.map(tankSnapshot);
}
