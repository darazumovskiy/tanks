import {
  ACCEL,
  ARENA,
  BULLET_BOUNCES,
  BULLET_LIFETIME,
  BULLET_RADIUS,
  DT,
  KIT,
  MUZZLE_OFFSET,
  REVERSE_FACTOR,
  ROUND_SECONDS,
  TANK_RADIUS,
  ZONE,
} from './constants.js';
import { boundsHit, circleRect, clamp, normalizeAngle } from './geometry.js';
import { MAPS, mapByIndex, type MapDef } from './maps.js';
import { deriveStats, type DerivedStats } from './stats.js';

export type Side = 0 | 1;

export interface Action {
  throttle: number;
  turn: number;
  turretTurn: number;
  isFiring: boolean;
}

export const IDLE_ACTION: Readonly<Action> = { throttle: 0, turn: 0, turretTurn: 0, isFiring: false };

export interface Tally {
  shots: number;
  hits: number;
  damageDealt: number;
  damageTaken: number;
  selfDamage: number;
  ricochetHits: number;
  intercepts: number;
  kits: number;
  zoneDamage: number;
}

export interface Tank {
  side: Side;
  name: string;
  stats: DerivedStats;
  x: number;
  y: number;
  heading: number;
  turret: number;
  speed: number;
  hp: number;
  reloadLeft: number;
  isAlive: boolean;
  tally: Tally;
}

export interface Bullet {
  id: number;
  owner: Side;
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  bouncesLeft: number;
  hasBounced: boolean;
  age: number;
  isDead: boolean;
}

export interface Kit {
  x: number;
  y: number;
  isActive: boolean;
  respawnIn: number;
}

export interface Zone {
  x: number;
  y: number;
  radius: number;
}

export type EndReason = 'kill' | 'time';

export interface Round {
  tick: number;
  time: number;
  mapIndex: number;
  map: MapDef;
  nextBulletId: number;
  tanks: [Tank, Tank];
  bullets: Bullet[];
  kits: Kit[];
  zone: Zone;
  isOver: boolean;
  winner: Side | null;
  endReason: EndReason | null;
}

export type DamageCause = 'bullet' | 'self' | 'zone';

export type RoundEvent =
  | { type: 'shot'; side: Side; x: number; y: number; angle: number }
  | { type: 'impact'; x: number; y: number; owner: Side }
  | { type: 'ricochet'; x: number; y: number; owner: Side; nx: number; ny: number }
  | { type: 'fizzle'; x: number; y: number; owner: Side }
  | { type: 'clash'; x: number; y: number }
  | {
      type: 'hit';
      side: Side;
      x: number;
      y: number;
      damage: number;
      cause: DamageCause;
      by?: Side;
      isRicochet?: boolean;
      bulletX?: number;
      bulletY?: number;
      dirX?: number;
      dirY?: number;
      isQuiet?: boolean;
    }
  | { type: 'death'; side: Side; x: number; y: number; cause: DamageCause }
  | { type: 'bump'; side: Side; x: number; y: number }
  | { type: 'kitSpawn'; x: number; y: number }
  | { type: 'pickup'; side: Side; x: number; y: number; healed: number }
  | { type: 'zoneStart' }
  | { type: 'roundOver'; winner: Side | null; reason: EndReason };

export interface TankSetup {
  name: string;
  stats: unknown;
}

const W = ARENA.width;
const H = ARENA.height;
const ZONE_START_RADIUS = Math.hypot(W / 2, H / 2) + 60;

function emptyTally(): Tally {
  return {
    shots: 0,
    hits: 0,
    damageDealt: 0,
    damageTaken: 0,
    selfDamage: 0,
    ricochetHits: 0,
    intercepts: 0,
    kits: 0,
    zoneDamage: 0,
  };
}

function sanitizeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return clamp(value, -1, 1);
}

// Любой мусор от игрока или бота превращается в допустимую команду.
export function sanitizeAction(raw: unknown): Action {
  if (typeof raw !== 'object' || raw === null) {
    return { ...IDLE_ACTION };
  }
  const record = raw as Partial<Record<keyof Action, unknown>>;
  return {
    throttle: sanitizeNumber(record.throttle),
    turn: sanitizeNumber(record.turn),
    turretTurn: sanitizeNumber(record.turretTurn),
    isFiring: record.isFiring === true,
  };
}

export function createRound(mapIndex: number, setups: [TankSetup, TankSetup]): Round {
  const map = mapByIndex(mapIndex);
  const makeTank = (setup: TankSetup, side: Side): Tank => {
    const stats = deriveStats(setup.stats);
    const spawn = map.spawns[side];
    return {
      side,
      name: setup.name,
      stats,
      x: spawn.x,
      y: spawn.y,
      heading: spawn.heading,
      turret: spawn.heading,
      speed: 0,
      hp: stats.maxHp,
      reloadLeft: 0,
      isAlive: true,
      tally: emptyTally(),
    };
  };
  return {
    tick: 0,
    time: 0,
    mapIndex: mapIndex % MAPS.length,
    map,
    nextBulletId: 1,
    tanks: [makeTank(setups[0], 0), makeTank(setups[1], 1)],
    bullets: [],
    kits: map.kits.map((kit) => ({ x: kit.x, y: kit.y, isActive: false, respawnIn: KIT.firstSpawn })),
    zone: { x: W / 2, y: H / 2, radius: ZONE_START_RADIUS },
    isOver: false,
    winner: null,
    endReason: null,
  };
}

export function zoneRadiusAt(time: number): number {
  if (time <= ZONE.startShrink) {
    return ZONE_START_RADIUS;
  }
  const k = clamp((time - ZONE.startShrink) / (ZONE.endShrink - ZONE.startShrink), 0, 1);
  return ZONE_START_RADIUS + (ZONE.finalRadius - ZONE_START_RADIUS) * k;
}

interface DamageInfo {
  cause: DamageCause;
  by?: Side;
  isRicochet?: boolean;
  bulletX?: number;
  bulletY?: number;
  dirX?: number;
  dirY?: number;
  isQuiet?: boolean;
}

function damageTank(victim: Tank, amount: number, events: RoundEvent[], info: DamageInfo): void {
  if (!victim.isAlive || amount <= 0) {
    return;
  }
  const dealt = Math.min(victim.hp, amount);
  victim.hp -= amount;
  victim.tally.damageTaken += dealt;
  events.push({ type: 'hit', side: victim.side, x: victim.x, y: victim.y, damage: dealt, ...info });
  if (victim.hp <= 0) {
    victim.hp = 0;
    victim.isAlive = false;
    victim.speed = 0;
    events.push({ type: 'death', side: victim.side, x: victim.x, y: victim.y, cause: info.cause });
  }
}

function moveTank(tank: Tank, action: Action): void {
  const stats = tank.stats;
  tank.heading = normalizeAngle(tank.heading + action.turn * stats.turnRate * DT);
  tank.turret = normalizeAngle(tank.turret + action.turretTurn * stats.turretRate * DT);
  const target =
    action.throttle >= 0 ? action.throttle * stats.maxSpeed : action.throttle * stats.maxSpeed * REVERSE_FACTOR;
  const dv = clamp(target - tank.speed, -ACCEL * DT, ACCEL * DT);
  tank.speed += dv;
  tank.x += Math.cos(tank.heading) * tank.speed * DT;
  tank.y += Math.sin(tank.heading) * tank.speed * DT;
}

function resolveTankWalls(round: Round, tank: Tank, events: RoundEvent[]): void {
  let hasBumped = false;
  for (let pass = 0; pass < 2; pass++) {
    for (const wall of round.map.walls) {
      const contact = circleRect(tank.x, tank.y, TANK_RADIUS, wall);
      if (contact !== null) {
        tank.x += contact.nx * contact.depth;
        tank.y += contact.ny * contact.depth;
        hasBumped = true;
      }
    }
    const nx = clamp(tank.x, TANK_RADIUS, W - TANK_RADIUS);
    const ny = clamp(tank.y, TANK_RADIUS, H - TANK_RADIUS);
    if (nx !== tank.x || ny !== tank.y) {
      hasBumped = true;
    }
    tank.x = nx;
    tank.y = ny;
  }
  if (hasBumped && Math.abs(tank.speed) > 60) {
    events.push({ type: 'bump', side: tank.side, x: tank.x, y: tank.y });
  }
  if (hasBumped) {
    tank.speed *= 0.6;
  }
}

function resolveTankTank(a: Tank, b: Tank): void {
  if (!a.isAlive && !b.isAlive) {
    return;
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const min = TANK_RADIUS * 2;
  if (d >= min || d < 1e-6) {
    return;
  }
  const push = (min - d) / 2;
  const nx = dx / d;
  const ny = dy / d;
  // Подбитый танк не сдвигается: весь толчок достаётся живому.
  const isBothAlive = a.isAlive && b.isAlive;
  const singlePush = isBothAlive ? push : push * 2;
  const pushA = a.isAlive ? singlePush : 0;
  const pushB = b.isAlive ? singlePush : 0;
  a.x -= nx * pushA;
  a.y -= ny * pushA;
  b.x += nx * pushB;
  b.y += ny * pushB;
}

function fire(round: Round, tank: Tank, events: RoundEvent[]): void {
  const dx = Math.cos(tank.turret);
  const dy = Math.sin(tank.turret);
  const x = tank.x + dx * MUZZLE_OFFSET;
  const y = tank.y + dy * MUZZLE_OFFSET;
  tank.reloadLeft = tank.stats.reloadTime;
  tank.tally.shots++;
  events.push({ type: 'shot', side: tank.side, x, y, angle: tank.turret });
  const isBlocked =
    boundsHit(x, y, BULLET_RADIUS) !== null ||
    round.map.walls.some((wall) => circleRect(x, y, BULLET_RADIUS, wall) !== null);
  if (isBlocked) {
    events.push({ type: 'impact', x, y, owner: tank.side });
    return;
  }
  round.bullets.push({
    id: round.nextBulletId++,
    owner: tank.side,
    x,
    y,
    vx: dx * tank.stats.bulletSpeed,
    vy: dy * tank.stats.bulletSpeed,
    damage: tank.stats.damage,
    bouncesLeft: BULLET_BOUNCES,
    hasBounced: false,
    age: 0,
    isDead: false,
  });
}

function bounceBullet(bullet: Bullet, contact: { nx: number; ny: number; depth: number }): void {
  bullet.bouncesLeft--;
  bullet.hasBounced = true;
  bullet.x += contact.nx * contact.depth;
  bullet.y += contact.ny * contact.depth;
  const dot = bullet.vx * contact.nx + bullet.vy * contact.ny;
  bullet.vx -= 2 * dot * contact.nx;
  bullet.vy -= 2 * dot * contact.ny;
}

function hitTankWithBullet(round: Round, bullet: Bullet, tank: Tank, speed: number, events: RoundEvent[]): void {
  bullet.isDead = true;
  const shooter = round.tanks[bullet.owner];
  const isSelf = tank.side === bullet.owner;
  const dealt = Math.min(tank.hp, bullet.damage);
  if (isSelf) {
    shooter.tally.selfDamage += dealt;
  } else {
    shooter.tally.hits++;
    shooter.tally.damageDealt += dealt;
    if (bullet.hasBounced) {
      shooter.tally.ricochetHits++;
    }
  }
  damageTank(tank, bullet.damage, events, {
    cause: isSelf ? 'self' : 'bullet',
    by: bullet.owner,
    isRicochet: bullet.hasBounced,
    bulletX: bullet.x,
    bulletY: bullet.y,
    dirX: bullet.vx / speed,
    dirY: bullet.vy / speed,
  });
}

function stepBullet(round: Round, bullet: Bullet, events: RoundEvent[]): void {
  bullet.age += DT;
  if (bullet.age > BULLET_LIFETIME) {
    bullet.isDead = true;
    events.push({ type: 'fizzle', x: bullet.x, y: bullet.y, owner: bullet.owner });
    return;
  }
  const speed = Math.hypot(bullet.vx, bullet.vy);
  const steps = Math.max(1, Math.ceil((speed * DT) / 6));
  const sdt = DT / steps;
  for (let s = 0; s < steps && !bullet.isDead; s++) {
    bullet.x += bullet.vx * sdt;
    bullet.y += bullet.vy * sdt;
    let contact = boundsHit(bullet.x, bullet.y, BULLET_RADIUS);
    if (contact === null) {
      for (const wall of round.map.walls) {
        contact = circleRect(bullet.x, bullet.y, BULLET_RADIUS, wall);
        if (contact !== null) {
          break;
        }
      }
    }
    if (contact !== null) {
      if (bullet.bouncesLeft > 0) {
        bounceBullet(bullet, contact);
        events.push({
          type: 'ricochet',
          x: bullet.x,
          y: bullet.y,
          owner: bullet.owner,
          nx: contact.nx,
          ny: contact.ny,
        });
      } else {
        bullet.isDead = true;
        events.push({ type: 'impact', x: bullet.x, y: bullet.y, owner: bullet.owner });
      }
      continue;
    }
    for (const tank of round.tanks) {
      if (!tank.isAlive) {
        continue;
      }
      if (tank.side === bullet.owner && !bullet.hasBounced) {
        continue;
      }
      if (Math.hypot(tank.x - bullet.x, tank.y - bullet.y) < TANK_RADIUS + BULLET_RADIUS) {
        hitTankWithBullet(round, bullet, tank, speed, events);
        break;
      }
    }
  }
}

// Снаряды уничтожают друг друга: встречный выстрел можно сбить.
function clashBullets(round: Round, events: RoundEvent[]): void {
  const live = round.bullets.filter((bullet) => !bullet.isDead);
  for (const [i, a] of live.entries()) {
    for (const b of live.slice(i + 1)) {
      if (a.isDead || b.isDead) {
        continue;
      }
      if (Math.hypot(a.x - b.x, a.y - b.y) < BULLET_RADIUS * 2 + 2) {
        a.isDead = true;
        b.isDead = true;
        if (a.owner !== b.owner) {
          // Перехват засчитывается тому, чей снаряд выпущен позже: это оборонительный выстрел.
          const later = a.id > b.id ? a : b;
          round.tanks[later.owner].tally.intercepts++;
        }
        events.push({ type: 'clash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      }
    }
  }
}

function stepBullets(round: Round, events: RoundEvent[]): void {
  for (const bullet of round.bullets) {
    if (bullet.isDead) {
      continue;
    }
    stepBullet(round, bullet, events);
  }
  clashBullets(round, events);
  round.bullets = round.bullets.filter((bullet) => !bullet.isDead);
}

function stepKits(round: Round, events: RoundEvent[]): void {
  for (const kit of round.kits) {
    if (!kit.isActive) {
      kit.respawnIn = Math.max(0, kit.respawnIn - DT);
      if (kit.respawnIn === 0) {
        kit.isActive = true;
        events.push({ type: 'kitSpawn', x: kit.x, y: kit.y });
      }
      continue;
    }
    let best: Tank | null = null;
    let bestDistance = Infinity;
    let isTie = false;
    for (const tank of round.tanks) {
      if (!tank.isAlive) {
        continue;
      }
      const distance = Math.hypot(tank.x - kit.x, tank.y - kit.y);
      if (distance > TANK_RADIUS + KIT.radius) {
        continue;
      }
      if (Math.abs(distance - bestDistance) < 1e-9) {
        isTie = true;
      } else if (distance < bestDistance) {
        best = tank;
        bestDistance = distance;
        isTie = false;
      }
    }
    if (best !== null && !isTie) {
      const healed = Math.min(KIT.heal, best.stats.maxHp - best.hp);
      best.hp += healed;
      best.tally.kits++;
      kit.isActive = false;
      kit.respawnIn = KIT.respawn;
      events.push({ type: 'pickup', side: best.side, x: kit.x, y: kit.y, healed });
    }
  }
}

function stepZone(round: Round, events: RoundEvent[]): void {
  const previousRadius = round.zone.radius;
  round.zone.radius = zoneRadiusAt(round.time + DT);
  if (previousRadius === ZONE_START_RADIUS && round.zone.radius < previousRadius) {
    events.push({ type: 'zoneStart' });
  }
  for (const tank of round.tanks) {
    if (!tank.isAlive) {
      continue;
    }
    if (Math.hypot(tank.x - round.zone.x, tank.y - round.zone.y) > round.zone.radius) {
      const damage = ZONE.damagePerSecond * DT;
      tank.tally.zoneDamage += Math.min(tank.hp, damage);
      damageTank(tank, damage, events, { cause: 'zone', isQuiet: true });
    }
  }
}

function finishIfOver(round: Round, events: RoundEvent[]): void {
  const [a, b] = round.tanks;
  if (!a.isAlive || !b.isAlive) {
    round.isOver = true;
    round.endReason = 'kill';
    if (!a.isAlive && !b.isAlive) {
      round.winner = null;
    } else {
      round.winner = a.isAlive ? 0 : 1;
    }
  } else if (round.time >= ROUND_SECONDS - 1e-9) {
    round.isOver = true;
    round.endReason = 'time';
    const fractionA = a.hp / a.stats.maxHp;
    const fractionB = b.hp / b.stats.maxHp;
    if (Math.abs(fractionA - fractionB) < 1e-9) {
      round.winner = null;
    } else {
      round.winner = fractionA > fractionB ? 0 : 1;
    }
  }
  if (round.isOver && round.endReason !== null) {
    events.push({ type: 'roundOver', winner: round.winner, reason: round.endReason });
  }
}

// Один тик симуляции. actions[side] — команда соответствующего танка.
export function stepRound(round: Round, actions: [unknown, unknown]): RoundEvent[] {
  if (round.isOver) {
    return [];
  }
  const events: RoundEvent[] = [];
  const acts: [Action, Action] = [sanitizeAction(actions[0]), sanitizeAction(actions[1])];

  for (const tank of round.tanks) {
    if (!tank.isAlive) {
      continue;
    }
    tank.reloadLeft = Math.max(0, tank.reloadLeft - DT);
    moveTank(tank, acts[tank.side]);
  }
  for (const tank of round.tanks) {
    if (tank.isAlive) {
      resolveTankWalls(round, tank, events);
    }
  }
  resolveTankTank(round.tanks[0], round.tanks[1]);
  for (const tank of round.tanks) {
    if (tank.isAlive) {
      resolveTankWalls(round, tank, events);
    }
  }

  for (const tank of round.tanks) {
    if (tank.isAlive && acts[tank.side].isFiring && tank.reloadLeft <= 0) {
      fire(round, tank, events);
    }
  }

  stepBullets(round, events);
  stepKits(round, events);
  stepZone(round, events);

  round.tick++;
  round.time = round.tick * DT;

  finishIfOver(round, events);
  return events;
}
