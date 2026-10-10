import {
  deriveStats,
  ffaViewCenter,
  isInFfaView,
  type BattleMap,
  type Bullet,
  type DerivedStats,
  type Kit,
  type Point,
} from '@tanks/shared/engine';
import type { FfaTankSnapshot } from '@tanks/shared/protocol';

export interface CrowdTank {
  id: number;
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
  shieldLeft: number;
  isAlive: boolean;
  stats: DerivedStats;
}

export interface CrowdBullet {
  id: number;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hasBounced: boolean;
}

// Поле одного снимка: все танки и снаряды, как их знает бот после этого снимка.
export interface Frame {
  tick: number;
  tanks: readonly CrowdTank[];
  bullets: readonly CrowdBullet[];
}

// Характеристики танка игрока, которого нет в составе (ушёл, а его обломки ещё на поле).
export const UNKNOWN_STATS = deriveStats(undefined);

// Снаряды копируются: поле живёт в истории бота, а снаряды движка меняются на месте следующим тиком.
export function crowdBullets(bullets: readonly Bullet[]): CrowdBullet[] {
  return bullets.map((bullet) => ({
    id: bullet.id,
    owner: bullet.owner,
    x: bullet.x,
    y: bullet.y,
    vx: bullet.vx,
    vy: bullet.vy,
    hasBounced: bullet.hasBounced,
  }));
}

export function crowdTank(tank: FfaTankSnapshot, stats: DerivedStats): CrowdTank {
  return {
    id: tank.id,
    x: tank.x,
    y: tank.y,
    heading: tank.heading,
    turret: tank.turret,
    speed: tank.speed,
    vx: Math.cos(tank.heading) * tank.speed,
    vy: Math.sin(tank.heading) * tank.speed,
    hp: tank.hp,
    maxHp: stats.maxHp,
    reloadLeft: tank.reloadLeft,
    shieldLeft: tank.shieldLeft,
    isAlive: tank.isAlive,
    stats,
  };
}

export interface CrowdZone extends Point {
  radius: number;
}

// Что видит мозг на своём ходу: свой танк, зона и аптечки — свежие; противники и снаряды — с задержкой реакции
// и только в окне обзора вокруг точки обзора своего танка. attackers — кто попал в бота на этом снимке.
// shotInheritPercent — правило игры: какую долю скорости танка получает снаряд в момент выстрела.
export interface CrowdView {
  tick: number;
  map: BattleMap;
  shotInheritPercent: number;
  me: CrowdTank;
  enemies: CrowdTank[];
  bullets: CrowdBullet[];
  kits: Kit[];
  zone: CrowdZone;
  attackers: number[];
}

export interface ViewSource {
  myId: number;
  fresh: Frame;
  delayed: Frame;
  map: BattleMap;
  shotInheritPercent: number;
  kits: Kit[];
  zone: CrowdZone;
  attackers: number[];
}

// null — своего живого танка на поле нет.
export function crowdView(source: ViewSource): CrowdView | null {
  const me = source.fresh.tanks.find((tank) => tank.id === source.myId);
  if (me?.isAlive !== true) {
    return null;
  }
  const center = ffaViewCenter(me);
  return {
    tick: source.fresh.tick,
    map: source.map,
    shotInheritPercent: source.shotInheritPercent,
    me,
    enemies: source.delayed.tanks.filter(
      (tank) => tank.id !== source.myId && tank.isAlive && isInFfaView(center, tank.x, tank.y),
    ),
    bullets: source.delayed.bullets.filter((bullet) => isInFfaView(center, bullet.x, bullet.y)),
    kits: source.kits,
    zone: source.zone,
    attackers: source.attackers,
  };
}
