import { describe, expect, it } from 'vitest';
import { BULLET_LIFETIME, DEFAULT_STATS, DT, MUZZLE_OFFSET, REVERSE_FACTOR } from './constants.js';
import type { Wall } from './geometry.js';
import { leadShot } from './lead.js';
import type { BattleMap, Point } from './maps.js';
import {
  createWorld,
  DEFAULT_RULES,
  IDLE_ACTION,
  makeTank,
  stepWorld,
  type Action,
  type Bullet,
  type Tank,
  type World,
  type WorldEvent,
  type ZonePlan,
} from './round.js';
import { NO_CARRY, shotCarry, shotFlight } from './shot.js';
import { deriveStats } from './stats.js';
import { isSegmentWithin, isShotReturning, traceShot } from './trajectory.js';

const FULL = 100;
const HALF = 50;
const STILL_ZONE: ZonePlan = { startRadius: 9000, finalRadius: 9000, startShrink: 1000, endShrink: 1001 };
const STATS = deriveStats(DEFAULT_STATS);
const SHOOTER = 1;
const TARGET = 2;
const GAS: Action = { ...IDLE_ACTION, throttle: 1 };
const GAS_FIRE: Action = { ...GAS, isFiring: true };
const TRACKED_TICKS = 15;
// Снаряд движка летит подшагами до 6 единиц: отскок выталкивает его по нормали стены, поэтому после отскока
// он идёт параллельно непрерывному пути со сдвигом меньше подшага.
const SUBSTEP = 6;
const HIT_WINDOW_TICKS = 90;

interface ShooterSetup {
  x?: number;
  y?: number;
  heading?: number;
  turret?: number;
  speed?: number;
  isBot?: boolean;
}

function openMap(walls: Wall[] = []): BattleMap {
  return { name: 'Проба', width: 2000, height: 1200, walls, kits: [] };
}

function shooterTank(setup: ShooterSetup = {}): Tank {
  const tank = makeTank({ name: 'Стрелок', stats: DEFAULT_STATS, isBot: setup.isBot === true }, SHOOTER, {
    x: setup.x ?? 400,
    y: setup.y ?? 600,
    heading: setup.heading ?? 0,
  });
  tank.turret = setup.turret ?? Math.PI / 2;
  tank.speed = setup.speed ?? STATS.maxSpeed;
  return tank;
}

function worldOf(inheritPercent: number, tanks: Tank[], walls: Wall[] = [], shotLeadTicks = 0): World {
  return createWorld(
    openMap(walls),
    tanks,
    { ...DEFAULT_RULES, shotLeadTicks, shotInheritPercent: inheritPercent },
    STILL_ZONE,
  );
}

function shooterOf(world: World): Tank {
  const tank = world.tanks.find((candidate) => candidate.id === SHOOTER);
  if (tank === undefined) {
    throw new Error('нет стрелка');
  }
  return tank;
}

function onlyBullet(world: World): Bullet {
  const [bullet] = world.bullets;
  if (bullet === undefined) {
    throw new Error('нет снаряда');
  }
  return bullet;
}

function step(world: World, shooterAction: Action): WorldEvent[] {
  return stepWorld(
    world,
    world.tanks.map((tank) => (tank.id === SHOOTER ? shooterAction : IDLE_ACTION)),
  );
}

// Положение снаряда относительно стрелка: вдоль ствола и поперёк — по курсу танка.
function relative(world: World): { along: number; across: number } {
  const tank = shooterOf(world);
  const bullet = onlyBullet(world);
  const dx = bullet.x - tank.x;
  const dy = bullet.y - tank.y;
  return {
    along: dx * Math.cos(tank.turret) + dy * Math.sin(tank.turret),
    across: dx * Math.cos(tank.heading) + dy * Math.sin(tank.heading),
  };
}

describe('снаряд со скоростью танка', () => {
  it('при 100 % снаряд едущего танка идёт по линии ствола: сдвиг по ходу — один тик хода и не растёт', () => {
    const world = worldOf(FULL, [shooterTank()]);
    step(world, GAS_FIRE);
    const tickTravel = STATS.maxSpeed * DT;
    for (let tick = 0; tick <= TRACKED_TICKS; tick++) {
      const { along, across } = relative(world);
      expect(across).toBeCloseTo(tickTravel, 9);
      expect(along).toBeCloseTo(MUZZLE_OFFSET + STATS.bulletSpeed * DT * (tick + 1), 9);
      step(world, GAS);
    }
  });

  it('при 0 % снаряд отстаёт от линии ствола на ход танка за каждый тик', () => {
    const world = worldOf(0, [shooterTank()]);
    step(world, GAS_FIRE);
    const tickTravel = STATS.maxSpeed * DT;
    for (let tick = 0; tick <= TRACKED_TICKS; tick++) {
      expect(relative(world).across).toBeCloseTo(-tickTravel * tick, 9);
      step(world, GAS);
    }
  });

  it('при 50 % снаряд получает половину скорости танка', () => {
    const world = worldOf(HALF, [shooterTank()]);
    step(world, GAS_FIRE);
    const bullet = onlyBullet(world);
    expect(bullet.vx).toBeCloseTo(STATS.maxSpeed / 2, 9);
    expect(bullet.vy).toBeCloseTo(STATS.bulletSpeed, 9);
  });

  it('задний ход сносит снаряд назад', () => {
    const reverse = -STATS.maxSpeed * REVERSE_FACTOR;
    const world = worldOf(FULL, [shooterTank({ speed: reverse })]);
    step(world, { ...IDLE_ACTION, throttle: -1, isFiring: true });
    const bullet = onlyBullet(world);
    expect(bullet.vx).toBeCloseTo(reverse, 9);
    expect(bullet.vy).toBeCloseTo(STATS.bulletSpeed, 9);
  });

  it('стоящий танк при 100 % стреляет побитово как без правила', () => {
    const plain = worldOf(0, [shooterTank({ speed: 0 })]);
    const carried = worldOf(FULL, [shooterTank({ speed: 0 })]);
    step(plain, { ...IDLE_ACTION, isFiring: true });
    step(carried, { ...IDLE_ACTION, isFiring: true });
    expect(carried.bullets).toEqual(plain.bullets);
  });

  it('снаряд бота тоже получает скорость танка', () => {
    const world = worldOf(FULL, [shooterTank({ isBot: true })]);
    step(world, GAS_FIRE);
    expect(onlyBullet(world).vx).toBeCloseTo(STATS.maxSpeed, 9);
  });

  it('догон 2 и 100 %: снаряд в тике выстрела — там же, где без догона через 2 тика; возраст 3 тика', () => {
    const plain = worldOf(FULL, [shooterTank()]);
    const lead = worldOf(FULL, [shooterTank()], [], 2);
    step(plain, GAS_FIRE);
    step(plain, GAS);
    step(plain, GAS);
    step(lead, GAS_FIRE);
    expect(lead.bullets).toEqual(plain.bullets);
    expect(onlyBullet(lead).age).toBeCloseTo(3 * DT, 12);
    expect(onlyBullet(lead).vx).toBeCloseTo(STATS.maxSpeed, 9);
  });

  it('рикошет: отскок там, где его ждёт путь со сносом, скорость после — отражение полной скорости', () => {
    const wall: Wall = { x: 300, y: 200, w: 1400, h: 40 };
    const world = worldOf(FULL, [shooterTank({ turret: -Math.PI / 3 })], [wall]);
    step(world, GAS_FIRE);
    const tank = shooterOf(world);
    const trace = traceShot(world.map, tank, tank.turret, STATS.bulletSpeed, shotCarry(tank, FULL));
    const before = { ...onlyBullet(world) };
    let ricochet: Extract<WorldEvent, { type: 'ricochet' }> | undefined;
    for (let tick = 0; tick < HIT_WINDOW_TICKS && ricochet === undefined; tick++) {
      ricochet = step(world, GAS).find((event) => event.type === 'ricochet');
    }
    const bounce = trace.segments[0];
    expect(ricochet).toBeDefined();
    expect(Math.hypot((ricochet?.x ?? 0) - (bounce?.x2 ?? 0), (ricochet?.y ?? 0) - (bounce?.y2 ?? 0))).toBeLessThan(
      SUBSTEP,
    );
    expect(onlyBullet(world).vx).toBeCloseTo(before.vx, 9);
    expect(onlyBullet(world).vy).toBeCloseTo(-before.vy, 9);
  });

  it('свой рикошет: выстрел в стену поперёк хода при 100 % возвращается в едущий танк, при 0 % — мимо', () => {
    const wall: Wall = { x: 0, y: 100, w: 2000, h: 40 };
    const selfHits = (inheritPercent: number): number => {
      const world = worldOf(inheritPercent, [shooterTank({ x: 300, y: 400, turret: -Math.PI / 2 })], [wall]);
      step(world, GAS_FIRE);
      let hits = 0;
      for (let tick = 0; tick < HIT_WINDOW_TICKS; tick++) {
        hits += step(world, GAS).filter((event) => event.type === 'hit' && event.cause === 'self').length;
      }
      return hits;
    };
    expect(selfHits(FULL)).toBe(1);
    expect(selfHits(0)).toBe(0);
    const tank = shooterTank({ x: 300, y: 400, turret: -Math.PI / 2 });
    const field = openMap([wall]);
    expect(isShotReturning(field, tank, tank.turret, STATS.bulletSpeed, shotCarry(tank, FULL), null)).toBe(true);
  });

  it('путь без сноса — по стволу со скоростью орудия', () => {
    const flight = shotFlight(0.7, STATS.bulletSpeed, NO_CARRY);
    expect(flight).toEqual({ dirX: Math.cos(0.7), dirY: Math.sin(0.7), speed: STATS.bulletSpeed });
    expect(shotCarry(shooterTank(), 0)).toEqual(NO_CARRY);
  });

  it('путь со сносом на открытом поле — по стволу плюс снос, длина — скорость на срок жизни', () => {
    const carry = { x: 176, y: 0 };
    const vast: BattleMap = { name: 'Простор', width: 10000, height: 10000, walls: [], kits: [] };
    const trace = traceShot(vast, { x: 5000, y: 5000 }, Math.PI / 2, STATS.bulletSpeed, carry);
    const [segment] = trace.segments;
    const speed = Math.hypot(STATS.bulletSpeed, carry.x);
    expect(trace.speed).toBeCloseTo(speed, 9);
    expect(segment).toBeDefined();
    const dx = (segment?.x2 ?? 0) - (segment?.x1 ?? 0);
    const dy = (segment?.y2 ?? 0) - (segment?.y1 ?? 0);
    expect(Math.atan2(dy, dx)).toBeCloseTo(Math.atan2(STATS.bulletSpeed, carry.x), 9);
    expect(Math.hypot(dx, dy)).toBeCloseTo(speed * BULLET_LIFETIME, 6);
  });

  it.each([FULL, HALF])('при %i %% снаряд движка идёт по пути traceShot, с отскоком', (inheritPercent) => {
    const walls: Wall[] = [
      { x: 300, y: 200, w: 1400, h: 40 },
      { x: 1500, y: 300, w: 40, h: 700 },
    ];
    const world = worldOf(inheritPercent, [shooterTank({ turret: -Math.PI / 3 })], walls);
    step(world, GAS_FIRE);
    const tank = shooterOf(world);
    const carry = shotCarry(tank, inheritPercent);
    const trace = traceShot(world.map, tank, tank.turret, STATS.bulletSpeed, carry);
    expect(trace.segments).toHaveLength(2);
    let checked = 0;
    while (world.bullets.length > 0) {
      const bullet = onlyBullet(world);
      const isOnPath = trace.segments.some((segment) => isSegmentWithin(segment, bullet, SUBSTEP));
      expect(isOnPath, `тик ${String(world.tick)}: (${bullet.x.toFixed(1)}, ${bullet.y.toFixed(1)})`).toBe(true);
      checked++;
      step(world, GAS);
    }
    expect(checked).toBeGreaterThan(30);
  });
});

describe('упреждение со сносом на движке', () => {
  // Танки сначала едут, потом стреляют: ствол наводится по местам после хода тика выстрела.
  function afterMove(tank: Tank): Point {
    return {
      x: tank.x + Math.cos(tank.heading) * tank.speed * DT,
      y: tank.y + Math.sin(tank.heading) * tank.speed * DT,
    };
  }

  function hitsTarget(inheritPercent: number, targetSpeed: number, isCarryKnown: boolean): boolean {
    const shooter = shooterTank({ x: 400, y: 600, heading: Math.PI / 2, speed: STATS.maxSpeed });
    const target = makeTank({ name: 'Цель', stats: DEFAULT_STATS }, TARGET, { x: 1000, y: 400, heading: Math.PI });
    target.speed = targetSpeed;
    const from = afterMove(shooter);
    const at = afterMove(target);
    const velocity = { x: Math.cos(target.heading) * targetSpeed, y: Math.sin(target.heading) * targetSpeed };
    const carry = isCarryKnown ? shotCarry(shooter, inheritPercent) : NO_CARRY;
    const { aim } = leadShot(from, at, velocity, STATS.bulletSpeed, carry);
    shooter.turret = Math.atan2(aim.y - from.y, aim.x - from.x);
    const world = worldOf(inheritPercent, [shooter, target]);
    const targetAction: Action = { ...IDLE_ACTION, throttle: targetSpeed === 0 ? 0 : 1 };
    const actions = (shooterAction: Action): Action[] =>
      world.tanks.map((tank) => (tank.id === SHOOTER ? shooterAction : targetAction));
    target.stats = { ...target.stats, maxSpeed: targetSpeed };
    let events = stepWorld(world, actions(GAS_FIRE));
    for (let tick = 0; tick < HIT_WINDOW_TICKS; tick++) {
      if (events.some((event) => event.type === 'hit' && event.tank === TARGET)) {
        return true;
      }
      events = stepWorld(world, actions(GAS));
    }
    return false;
  }

  it.each([FULL, HALF])('при %i %% ствол на точку наводки — попадание по едущей цели', (inheritPercent) => {
    expect(hitsTarget(inheritPercent, 120, true)).toBe(true);
    expect(hitsTarget(inheritPercent, 120, false)).toBe(false);
  });

  it.each([FULL, HALF])('при %i %% с хода по стоящей цели — попадание', (inheritPercent) => {
    expect(hitsTarget(inheritPercent, 0, true)).toBe(true);
    expect(hitsTarget(inheritPercent, 0, false)).toBe(false);
  });
});
