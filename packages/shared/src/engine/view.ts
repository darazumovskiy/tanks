import { DT, ROUND_SECONDS, ZONE } from './constants.js';
import type { Wall } from './geometry.js';
import type { Kit, Round, Side, Tank } from './round.js';
import type { DerivedStats } from './stats.js';

export interface TankView {
  x: number;
  y: number;
  heading: number;
  turret: number;
  speed: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  reloadLeft: number;
  isAlive: boolean;
  stats: DerivedStats;
}

export interface BulletView {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  isMine: boolean;
  bouncesLeft: number;
  damage: number;
  canHitOwner: boolean;
}

export interface ZoneView {
  x: number;
  y: number;
  radius: number;
  finalRadius: number;
  shrinkStart: number;
  shrinkEnd: number;
  damagePerSecond: number;
}

// shotInheritPercent — правило раунда: какую долю скорости танка получает снаряд в момент выстрела.
export interface BotView {
  tick: number;
  time: number;
  timeLeft: number;
  dt: number;
  side: Side;
  shotInheritPercent: number;
  arena: { width: number; height: number; mapName: string; walls: Wall[] };
  me: TankView;
  enemy: TankView;
  bullets: BulletView[];
  repairKits: Kit[];
  zone: ZoneView;
}

function tankView(tank: Tank): TankView {
  return {
    x: tank.x,
    y: tank.y,
    heading: tank.heading,
    turret: tank.turret,
    speed: tank.speed,
    vx: Math.cos(tank.heading) * tank.speed,
    vy: Math.sin(tank.heading) * tank.speed,
    hp: tank.hp,
    maxHp: tank.stats.maxHp,
    reloadLeft: tank.reloadLeft,
    isAlive: tank.isAlive,
    stats: { ...tank.stats },
  };
}

// Что видит участник на своём ходу. Всегда свежий объект: участник не может тронуть состояние движка.
export function botView(round: Round, side: Side): BotView {
  const enemySide: Side = side === 0 ? 1 : 0;
  return {
    tick: round.tick,
    time: round.time,
    timeLeft: Math.max(0, ROUND_SECONDS - round.time),
    dt: DT,
    side,
    shotInheritPercent: round.rules.shotInheritPercent,
    arena: {
      width: round.map.width,
      height: round.map.height,
      mapName: round.map.name,
      walls: round.map.walls.map((wall) => ({ ...wall })),
    },
    me: tankView(round.tanks[side]),
    enemy: tankView(round.tanks[enemySide]),
    bullets: round.bullets.map((bullet) => ({
      id: bullet.id,
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
      isMine: bullet.owner === side,
      bouncesLeft: bullet.bouncesLeft,
      damage: bullet.damage,
      canHitOwner: bullet.hasBounced,
    })),
    repairKits: round.kits.map((kit) => ({ ...kit })),
    zone: {
      x: round.zone.x,
      y: round.zone.y,
      radius: round.zone.radius,
      finalRadius: ZONE.finalRadius,
      shrinkStart: ZONE.startShrink,
      shrinkEnd: ZONE.endShrink,
      damagePerSecond: ZONE.damagePerSecond,
    },
  };
}
