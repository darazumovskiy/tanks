import { FFA, type BattleMap, type DerivedStats, type Kit, type Point } from '@tanks/shared/engine';

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

export interface CrowdZone extends Point {
  radius: number;
}

// Что видит мозг на своём ходу: свой танк, зона и аптечки — свежие; противники и снаряды — с задержкой реакции
// и только в окне обзора. attackers — кто попал в бота на этом снимке.
export interface CrowdView {
  tick: number;
  map: BattleMap;
  me: CrowdTank;
  enemies: CrowdTank[];
  bullets: CrowdBullet[];
  kits: Kit[];
  zone: CrowdZone;
  attackers: number[];
}

export function isInView(me: Point, x: number, y: number): boolean {
  return Math.abs(x - me.x) <= FFA.viewWidth / 2 && Math.abs(y - me.y) <= FFA.viewHeight / 2;
}

export interface ViewSource {
  myId: number;
  fresh: Frame;
  delayed: Frame;
  map: BattleMap;
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
  return {
    tick: source.fresh.tick,
    map: source.map,
    me,
    enemies: source.delayed.tanks.filter(
      (tank) => tank.id !== source.myId && tank.isAlive && isInView(me, tank.x, tank.y),
    ),
    bullets: source.delayed.bullets.filter((bullet) => isInView(me, bullet.x, bullet.y)),
    kits: source.kits,
    zone: source.zone,
    attackers: source.attackers,
  };
}
