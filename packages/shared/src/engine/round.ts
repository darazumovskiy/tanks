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
  WALL_BUMP_MIN_DROP,
  WALL_BUMP_MIN_SPEED,
  WALL_HIT_SPEED_FACTOR,
  WALL_SLIDE_MAX_PERCENT,
  ZONE,
  ZONE_START_MARGIN,
} from './constants.js';
import { boundsHit, circleRect, clamp, normalizeAngle } from './geometry.js';
import { MAPS, mapByIndex, type BattleMap, type MapDef, type Spawn } from './maps.js';
import { shotCarry } from './shot.js';
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

// id — постоянный номер танка: в дуэли 0 и 1, в матче — номер игрока.
// shieldLeft — неуязвимость в секундах: пока больше нуля, урон не проходит.
// isBot — танк бота: догон компенсирует отставание взгляда человека, снаряды бота не догоняются.
export interface Tank {
  id: number;
  name: string;
  isBot: boolean;
  stats: DerivedStats;
  x: number;
  y: number;
  heading: number;
  turret: number;
  speed: number;
  hp: number;
  reloadLeft: number;
  shieldLeft: number;
  isAlive: boolean;
  tally: Tally;
}

export interface Bullet {
  id: number;
  owner: number;
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

export interface ZonePlan {
  startRadius: number;
  finalRadius: number;
  startShrink: number;
  endShrink: number;
}

export type EndReason = 'kill' | 'time';

// Настраиваемые правила движка; одинаковы на сервере, у бота и в предсказании клиента.
// wallSlidePercent — скольжение вдоль стен, целое 0–100: 0 — оригинал tank-arena, 100 — стены без трения.
// shotLeadTicks — догон: снаряд человека рождается на столько тиков полёта дальше, 0 — без догона.
// shotInheritPercent — какую долю скорости танка снаряд получает в момент выстрела, целое 0–100: 0 — только по стволу.
export interface RoundRules {
  wallSlidePercent: number;
  shotLeadTicks: number;
  shotInheritPercent: number;
}

export const DEFAULT_RULES: Readonly<RoundRules> = { wallSlidePercent: 0, shotLeadTicks: 0, shotInheritPercent: 0 };

// Поле боя с любым числом танков; tanks — танки на поле в порядке обработки.
export interface World<T extends Tank[] = Tank[]> {
  tick: number;
  time: number;
  map: BattleMap;
  rules: RoundRules;
  nextBulletId: number;
  tanks: T;
  bullets: Bullet[];
  kits: Kit[];
  zone: Zone;
  zonePlan: ZonePlan;
}

// Раунд дуэли: поле боя ровно с двумя танками и исход раунда.
export interface Round extends World<[Tank, Tank]> {
  mapIndex: number;
  map: MapDef;
  isOver: boolean;
  winner: Side | null;
  endReason: EndReason | null;
}

export type DamageCause = 'bullet' | 'self' | 'zone';

// События тика поля боя; конец раунда добавляет только дуэль.
export type WorldEvent =
  | { type: 'shot'; tank: number; x: number; y: number; angle: number }
  | { type: 'impact'; x: number; y: number; owner: number }
  | { type: 'ricochet'; x: number; y: number; owner: number; nx: number; ny: number }
  | { type: 'fizzle'; x: number; y: number; owner: number }
  | { type: 'clash'; x: number; y: number }
  | {
      type: 'hit';
      tank: number;
      x: number;
      y: number;
      damage: number;
      cause: DamageCause;
      by?: number;
      isRicochet?: boolean;
      bulletX?: number;
      bulletY?: number;
      dirX?: number;
      dirY?: number;
      isQuiet?: boolean;
    }
  | { type: 'shield'; tank: number; x: number; y: number; owner: number }
  | { type: 'death'; tank: number; x: number; y: number; cause: DamageCause; by: number | null; isRicochet: boolean }
  | { type: 'bump'; tank: number; x: number; y: number }
  | { type: 'kitSpawn'; x: number; y: number }
  | { type: 'pickup'; tank: number; x: number; y: number; healed: number }
  | { type: 'zoneStart' };

export type RoundEvent = WorldEvent | { type: 'roundOver'; winner: Side | null; reason: EndReason };

// Без isBot — человек.
export interface TankSetup {
  name: string;
  stats: unknown;
  isBot?: boolean;
}

export const DUEL_ZONE_PLAN: Readonly<ZonePlan> = {
  startRadius: Math.hypot(ARENA.width / 2, ARENA.height / 2) + ZONE_START_MARGIN,
  finalRadius: ZONE.finalRadius,
  startShrink: ZONE.startShrink,
  endShrink: ZONE.endShrink,
};

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

export function makeTank(setup: TankSetup, id: number, pose: Spawn): Tank {
  const stats = deriveStats(setup.stats);
  return {
    id,
    name: setup.name,
    isBot: setup.isBot === true,
    stats,
    x: pose.x,
    y: pose.y,
    heading: pose.heading,
    turret: pose.heading,
    speed: 0,
    hp: stats.maxHp,
    reloadLeft: 0,
    shieldLeft: 0,
    isAlive: true,
    tally: emptyTally(),
  };
}

export function createWorld<T extends Tank[]>(
  map: BattleMap,
  tanks: T,
  rules: Readonly<RoundRules>,
  zonePlan: Readonly<ZonePlan>,
): World<T> {
  return {
    tick: 0,
    time: 0,
    map,
    rules: {
      wallSlidePercent: rules.wallSlidePercent,
      shotLeadTicks: rules.shotLeadTicks,
      shotInheritPercent: rules.shotInheritPercent,
    },
    nextBulletId: 1,
    tanks,
    bullets: [],
    kits: map.kits.map((kit) => ({ x: kit.x, y: kit.y, isActive: false, respawnIn: KIT.firstSpawn })),
    zone: { x: map.width / 2, y: map.height / 2, radius: zonePlan.startRadius },
    zonePlan: { ...zonePlan },
  };
}

export function createRound(
  mapIndex: number,
  setups: [TankSetup, TankSetup],
  rules: Readonly<RoundRules> = DEFAULT_RULES,
): Round {
  const map = mapByIndex(mapIndex);
  const tanks: [Tank, Tank] = [makeTank(setups[0], 0, map.spawns[0]), makeTank(setups[1], 1, map.spawns[1])];
  return {
    ...createWorld(map, tanks, rules, DUEL_ZONE_PLAN),
    mapIndex: mapIndex % MAPS.length,
    map,
    isOver: false,
    winner: null,
    endReason: null,
  };
}

export function zoneRadiusAt(plan: Readonly<ZonePlan>, time: number): number {
  if (time <= plan.startShrink) {
    return plan.startRadius;
  }
  const k = clamp((time - plan.startShrink) / (plan.endShrink - plan.startShrink), 0, 1);
  return plan.startRadius + (plan.finalRadius - plan.startRadius) * k;
}

function tankById(world: World, id: number): Tank | undefined {
  return world.tanks.find((tank) => tank.id === id);
}

interface DamageInfo {
  cause: DamageCause;
  by?: number;
  isRicochet?: boolean;
  bulletX?: number;
  bulletY?: number;
  dirX?: number;
  dirY?: number;
  isQuiet?: boolean;
}

function damageTank(victim: Tank, amount: number, events: WorldEvent[], info: DamageInfo): void {
  if (!victim.isAlive || amount <= 0) {
    return;
  }
  const dealt = Math.min(victim.hp, amount);
  victim.hp -= amount;
  victim.tally.damageTaken += dealt;
  events.push({ type: 'hit', tank: victim.id, x: victim.x, y: victim.y, damage: dealt, ...info });
  if (victim.hp <= 0) {
    victim.hp = 0;
    victim.isAlive = false;
    victim.speed = 0;
    events.push({
      type: 'death',
      tank: victim.id,
      x: victim.x,
      y: victim.y,
      cause: info.cause,
      by: info.by ?? null,
      isRicochet: info.isRicochet === true,
    });
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

// Выталкивает танк из стен и краёв поля; facing — наибольший |n·h| по всем контактам тика (1 — лоб, 0 — вдоль),
// -1 — контактов не было.
function pushOutOfWalls(world: World, tank: Tank): number {
  const hx = Math.cos(tank.heading);
  const hy = Math.sin(tank.heading);
  let facing = -1;
  for (let pass = 0; pass < 2; pass++) {
    for (const wall of world.map.walls) {
      const contact = circleRect(tank.x, tank.y, TANK_RADIUS, wall);
      if (contact !== null) {
        tank.x += contact.nx * contact.depth;
        tank.y += contact.ny * contact.depth;
        facing = Math.max(facing, Math.abs(contact.nx * hx + contact.ny * hy));
      }
    }
    const nx = clamp(tank.x, TANK_RADIUS, world.map.width - TANK_RADIUS);
    const ny = clamp(tank.y, TANK_RADIUS, world.map.height - TANK_RADIUS);
    if (nx !== tank.x) {
      facing = Math.max(facing, Math.abs(hx));
    }
    if (ny !== tank.y) {
      facing = Math.max(facing, Math.abs(hy));
    }
    tank.x = nx;
    tank.y = ny;
  }
  return facing;
}

function resolveTankWalls(world: World, tank: Tank, events: WorldEvent[]): void {
  const facing = pushOutOfWalls(world, tank);
  if (facing < 0) {
    return;
  }
  const slide = world.rules.wallSlidePercent / WALL_SLIDE_MAX_PERCENT;
  if (slide === 0) {
    if (Math.abs(tank.speed) > WALL_BUMP_MIN_SPEED) {
      events.push({ type: 'bump', tank: tank.id, x: tank.x, y: tank.y });
    }
    tank.speed *= WALL_HIT_SPEED_FACTOR;
    return;
  }
  // headOn — насколько касание считается лобовым: при малом скольжении любое касание тормозит как лоб,
  // с ростом скольжения тормозит только настоящий лоб (куб косинуса угла встречи).
  // Звук удара — по потере скорости за тик: в установившемся скольжении касание отнимает ровно разгон тика,
  // меньше порога, и под любым углом молчит.
  const headOn = 1 - slide + slide * facing ** 3;
  const speedBefore = Math.abs(tank.speed);
  tank.speed *= 1 - (1 - WALL_HIT_SPEED_FACTOR) * (1 - slide) * headOn;
  if (speedBefore - Math.abs(tank.speed) > WALL_BUMP_MIN_DROP) {
    events.push({ type: 'bump', tank: tank.id, x: tank.x, y: tank.y });
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

// Пары по порядку массива: у двух танков — единственная пара, как в оригинале.
function resolveTanks(world: World): void {
  const tanks = world.tanks;
  for (let i = 0; i < tanks.length; i++) {
    for (let j = i + 1; j < tanks.length; j++) {
      const a = tanks[i];
      const b = tanks[j];
      if (a !== undefined && b !== undefined) {
        resolveTankTank(a, b);
      }
    }
  }
}

function fire(world: World, tank: Tank, events: WorldEvent[]): Bullet | null {
  const dx = Math.cos(tank.turret);
  const dy = Math.sin(tank.turret);
  const x = tank.x + dx * MUZZLE_OFFSET;
  const y = tank.y + dy * MUZZLE_OFFSET;
  tank.reloadLeft = tank.stats.reloadTime;
  tank.shieldLeft = 0;
  tank.tally.shots++;
  events.push({ type: 'shot', tank: tank.id, x, y, angle: tank.turret });
  const isBlocked =
    boundsHit(x, y, BULLET_RADIUS, world.map) !== null ||
    world.map.walls.some((wall) => circleRect(x, y, BULLET_RADIUS, wall) !== null);
  if (isBlocked) {
    events.push({ type: 'impact', x, y, owner: tank.id });
    return null;
  }
  let vx = dx * tank.stats.bulletSpeed;
  let vy = dy * tank.stats.bulletSpeed;
  if (world.rules.shotInheritPercent > 0) {
    const carry = shotCarry(tank, world.rules.shotInheritPercent);
    vx += carry.x;
    vy += carry.y;
  }
  const bullet: Bullet = {
    id: world.nextBulletId++,
    owner: tank.id,
    x,
    y,
    vx,
    vy,
    damage: tank.stats.damage,
    bouncesLeft: BULLET_BOUNCES,
    hasBounced: false,
    age: 0,
    isDead: false,
  };
  world.bullets.push(bullet);
  return bullet;
}

// Догон компенсирует отставание взгляда человека на чужие танки: снаряд проходит шаги полёта против танков
// и снарядов этого тика. Догон идёт после выстрелов всех танков тика, поэтому размен в упор не зависит
// от порядка танков.
function leadBullets(world: World, fired: readonly Bullet[], events: WorldEvent[]): void {
  for (const bullet of fired) {
    const leadTicks = tankById(world, bullet.owner)?.isBot === false ? world.rules.shotLeadTicks : 0;
    for (let step = 0; step < leadTicks && !bullet.isDead; step++) {
      stepBullet(world, bullet, events, true);
    }
  }
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

function hitTankWithBullet(world: World, bullet: Bullet, tank: Tank, speed: number, events: WorldEvent[]): void {
  bullet.isDead = true;
  if (tank.shieldLeft > 0) {
    events.push({ type: 'shield', tank: tank.id, x: bullet.x, y: bullet.y, owner: bullet.owner });
    return;
  }
  const shooter = tankById(world, bullet.owner);
  const isSelf = tank.id === bullet.owner;
  const dealt = Math.min(tank.hp, bullet.damage);
  if (shooter !== undefined && isSelf) {
    shooter.tally.selfDamage += dealt;
  } else if (shooter !== undefined) {
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

// isLead — догонный шаг: остальные снаряды поля стоят, поэтому перехват проверяется на каждом подшаге,
// а подшаг короче дистанции перехвата и встречный снаряд не проскочить.
function stepBullet(world: World, bullet: Bullet, events: WorldEvent[], isLead = false): void {
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
    let contact = boundsHit(bullet.x, bullet.y, BULLET_RADIUS, world.map);
    if (contact === null) {
      for (const wall of world.map.walls) {
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
    } else {
      hitTanks(world, bullet, speed, events);
    }
    if (isLead && !bullet.isDead) {
      clashWithField(world, bullet, events);
    }
  }
}

function hitTanks(world: World, bullet: Bullet, speed: number, events: WorldEvent[]): void {
  for (const tank of world.tanks) {
    if (!tank.isAlive) {
      continue;
    }
    if (tank.id === bullet.owner && !bullet.hasBounced) {
      continue;
    }
    if (Math.hypot(tank.x - bullet.x, tank.y - bullet.y) < TANK_RADIUS + BULLET_RADIUS) {
      hitTankWithBullet(world, bullet, tank, speed, events);
      return;
    }
  }
}

// Снаряды уничтожают друг друга: встречный выстрел можно сбить.
function clashPair(world: World, a: Bullet, b: Bullet, events: WorldEvent[]): boolean {
  if (Math.hypot(a.x - b.x, a.y - b.y) >= BULLET_RADIUS * 2 + 2) {
    return false;
  }
  a.isDead = true;
  b.isDead = true;
  if (a.owner !== b.owner) {
    // Перехват засчитывается тому, чей снаряд выпущен позже: это оборонительный выстрел.
    const later = a.id > b.id ? a : b;
    const defender = tankById(world, later.owner);
    if (defender !== undefined) {
      defender.tally.intercepts++;
    }
  }
  events.push({ type: 'clash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return true;
}

function clashWithField(world: World, bullet: Bullet, events: WorldEvent[]): void {
  for (const other of world.bullets) {
    if (other !== bullet && !other.isDead && clashPair(world, bullet, other, events)) {
      return;
    }
  }
}

function clashBullets(world: World, events: WorldEvent[]): void {
  const live = world.bullets.filter((bullet) => !bullet.isDead);
  for (const [i, a] of live.entries()) {
    for (const b of live.slice(i + 1)) {
      if (!a.isDead && !b.isDead) {
        clashPair(world, a, b, events);
      }
    }
  }
}

// Полёт снарядов на один тик без попаданий в танки и перехватов: так клиент ведёт снаряды между событиями сервера,
// а гибель от танка или встречного снаряда решает только сервер.
export function flyBullets(world: World): void {
  const events: WorldEvent[] = [];
  for (const bullet of world.bullets) {
    stepBullet(world, bullet, events);
  }
  world.bullets = world.bullets.filter((bullet) => !bullet.isDead);
  world.tick++;
  world.time = world.tick * DT;
}

function stepBullets(world: World, events: WorldEvent[]): void {
  for (const bullet of world.bullets) {
    if (bullet.isDead) {
      continue;
    }
    stepBullet(world, bullet, events);
  }
  clashBullets(world, events);
  world.bullets = world.bullets.filter((bullet) => !bullet.isDead);
}

function stepKits(world: World, events: WorldEvent[]): void {
  for (const kit of world.kits) {
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
    for (const tank of world.tanks) {
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
      events.push({ type: 'pickup', tank: best.id, x: kit.x, y: kit.y, healed });
    }
  }
}

function stepZone(world: World, events: WorldEvent[]): void {
  const previousRadius = world.zone.radius;
  world.zone.radius = zoneRadiusAt(world.zonePlan, world.time + DT);
  if (previousRadius === world.zonePlan.startRadius && world.zone.radius < previousRadius) {
    events.push({ type: 'zoneStart' });
  }
  for (const tank of world.tanks) {
    if (!tank.isAlive || tank.shieldLeft > 0) {
      continue;
    }
    if (Math.hypot(tank.x - world.zone.x, tank.y - world.zone.y) > world.zone.radius) {
      const damage = ZONE.damagePerSecond * DT;
      tank.tally.zoneDamage += Math.min(tank.hp, damage);
      damageTank(tank, damage, events, { cause: 'zone', isQuiet: true });
    }
  }
}

// Один тик физики поля боя. actions[i] — команда танка world.tanks[i].
export function stepWorld(world: World, actions: readonly unknown[]): WorldEvent[] {
  const events: WorldEvent[] = [];
  const acts = world.tanks.map((_, index) => sanitizeAction(actions[index]));

  for (const [index, tank] of world.tanks.entries()) {
    if (!tank.isAlive) {
      continue;
    }
    tank.reloadLeft = Math.max(0, tank.reloadLeft - DT);
    tank.shieldLeft = Math.max(0, tank.shieldLeft - DT);
    moveTank(tank, acts[index] ?? IDLE_ACTION);
  }
  for (const tank of world.tanks) {
    if (tank.isAlive) {
      resolveTankWalls(world, tank, events);
    }
  }
  resolveTanks(world);
  for (const tank of world.tanks) {
    if (tank.isAlive) {
      resolveTankWalls(world, tank, events);
    }
  }

  const fired: Bullet[] = [];
  for (const [index, tank] of world.tanks.entries()) {
    const isFiring = acts[index]?.isFiring === true;
    if (tank.isAlive && isFiring && tank.reloadLeft <= 0) {
      const bullet = fire(world, tank, events);
      if (bullet !== null) {
        fired.push(bullet);
      }
    }
  }
  leadBullets(world, fired, events);

  stepBullets(world, events);
  stepKits(world, events);
  stepZone(world, events);

  world.tick++;
  world.time = world.tick * DT;
  return events;
}

function finishIfOver(round: Round, events: DuelEvent[]): void {
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

// В дуэли неуязвимости нет: танки появляются только на старте раунда.
export type DuelEvent = Exclude<RoundEvent, { type: 'shield' }>;

function isDuelEvent(event: WorldEvent): event is Exclude<WorldEvent, { type: 'shield' }> {
  return event.type !== 'shield';
}

// Один тик дуэли. actions[side] — команда соответствующего танка.
export function stepRound(round: Round, actions: [unknown, unknown]): DuelEvent[] {
  if (round.isOver) {
    return [];
  }
  const events = stepWorld(round, actions).filter(isDuelEvent);
  finishIfOver(round, events);
  return events;
}
