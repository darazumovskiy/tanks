import { describe, expect, it } from 'vitest';
import { DEFAULT_STATS, DT } from './constants.js';
import { createFfaMatch, stepFfaMatch } from './ffa.js';
import { ffaMap } from './ffaMaps.js';
import type { Wall } from './geometry.js';
import type { BattleMap } from './maps.js';
import {
  createWorld,
  DEFAULT_RULES,
  IDLE_ACTION,
  makeTank,
  stepWorld,
  type Action,
  type Tank,
  type World,
  type WorldEvent,
  type ZonePlan,
} from './round.js';
import { deriveStats } from './stats.js';

const LEAD_TICKS = 2;
const STILL_ZONE: ZonePlan = { startRadius: 9000, finalRadius: 9000, startShrink: 1000, endShrink: 1001 };
const FIRE: Action = { ...IDLE_ACTION, isFiring: true };
const SHOOTER = 1;
const TARGET = 2;
const UP_RIGHT = -Math.PI / 4;
const SHOOTER_X = 500;
const SHOOTER_Y = 600;

interface Shooter {
  x?: number;
  y?: number;
  turret?: number;
  isBot?: boolean;
}

function openMap(walls: Wall[] = []): BattleMap {
  return { name: 'Проба', width: 2000, height: 1200, walls, kits: [] };
}

function shooterTank(shooter: Shooter = {}): Tank {
  return makeTank({ name: 'Стрелок', stats: DEFAULT_STATS, isBot: shooter.isBot === true }, SHOOTER, {
    x: shooter.x ?? SHOOTER_X,
    y: shooter.y ?? SHOOTER_Y,
    heading: shooter.turret ?? 0,
  });
}

function targetTank(x: number, y: number, heading = Math.PI): Tank {
  return makeTank({ name: 'Цель', stats: DEFAULT_STATS }, TARGET, { x, y, heading });
}

function worldOf(leadTicks: number, tanks: Tank[], walls: Wall[] = []): World {
  return createWorld(openMap(walls), tanks, { ...DEFAULT_RULES, shotLeadTicks: leadTicks }, STILL_ZONE);
}

function fireTick(world: World): WorldEvent[] {
  return stepWorld(
    world,
    world.tanks.map((tank) => (tank.id === SHOOTER ? FIRE : IDLE_ACTION)),
  );
}

function idleTicks(world: World, ticks: number): WorldEvent[] {
  const events: WorldEvent[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    events.push(...stepWorld(world, []));
  }
  return events;
}

function kinds(events: readonly WorldEvent[]): string[] {
  return events.map((event) => event.type);
}

describe('догон снаряда', () => {
  it('снаряд человека при догоне 2 в тике выстрела — там же, где снаряд без догона через 2 тика; возраст 3 тика', () => {
    const plain = worldOf(0, [shooterTank()]);
    const lead = worldOf(LEAD_TICKS, [shooterTank()]);
    fireTick(plain);
    idleTicks(plain, LEAD_TICKS);
    fireTick(lead);
    expect(lead.bullets).toEqual(plain.bullets);
    expect(lead.bullets[0]?.age).toBeCloseTo((LEAD_TICKS + 1) * DT, 12);
  });

  it('снаряд с догоном гаснет от старости на 2 тика раньше', () => {
    const fizzleTick = (leadTicks: number): number => {
      const world = worldOf(leadTicks, [shooterTank()]);
      fireTick(world);
      for (let tick = 1; tick < 500; tick++) {
        if (kinds(stepWorld(world, [])).includes('fizzle')) {
          return tick;
        }
      }
      return NaN;
    };
    const plain = fizzleTick(0);
    expect(plain).toBeGreaterThan(100);
    expect(fizzleTick(LEAD_TICKS)).toBe(plain - LEAD_TICKS);
  });

  it('снаряд бота при догоне 2 — как без догона', () => {
    const plain = worldOf(0, [shooterTank({ isBot: true })]);
    const lead = worldOf(LEAD_TICKS, [shooterTank({ isBot: true })]);
    fireTick(plain);
    fireTick(lead);
    expect(lead.bullets).toEqual(plain.bullets);
    expect(lead.bullets[0]?.age).toBeCloseTo(DT, 12);
  });

  it('матч толпы при догоне 2: снаряд человека рождается на 2 тика дальше, снаряд бота — нет', () => {
    const setups = [
      { id: 1, name: 'Человек', stats: DEFAULT_STATS },
      { id: 2, name: 'Бот', stats: DEFAULT_STATS, isBot: true },
    ];
    const match = createFfaMatch(ffaMap(10), setups, 3, { ...DEFAULT_RULES, shotLeadTicks: LEAD_TICKS });
    const ages = new Map<number, number>();
    for (let tick = 0; tick < 300 && ages.size < 2; tick++) {
      const known = new Set(match.world.bullets.map((bullet) => bullet.id));
      stepFfaMatch(
        match,
        new Map([
          [1, FIRE],
          [2, FIRE],
        ]),
      );
      for (const bullet of match.world.bullets.filter((candidate) => !known.has(candidate.id))) {
        ages.set(bullet.owner, bullet.age);
      }
    }
    expect(ages.get(1)).toBeCloseTo((LEAD_TICKS + 1) * DT, 12);
    expect(ages.get(2)).toBeCloseTo(DT, 12);
  });

  it('стена вплотную перед стволом: рикошет в тике выстрела, снаряд — там же, где без догона через 2 тика', () => {
    const ceiling: Wall = { x: 0, y: 0, w: 2000, h: 560 };
    const plain = worldOf(0, [shooterTank({ turret: UP_RIGHT })], [ceiling]);
    const lead = worldOf(LEAD_TICKS, [shooterTank({ turret: UP_RIGHT })], [ceiling]);
    expect(kinds(fireTick(plain))).toEqual(['shot', 'ricochet']);
    idleTicks(plain, LEAD_TICKS);
    expect(kinds(fireTick(lead))).toEqual(['shot', 'ricochet']);
    expect(lead.bullets).toEqual(plain.bullets);
    expect(lead.bullets[0]?.hasBounced).toBe(true);
  });

  it('угол из двух стен: второй удар в догоне — снаряд гибнет в тике выстрела', () => {
    const walls: Wall[] = [
      { x: 0, y: 0, w: 2000, h: 560 },
      { x: 548, y: 0, w: 100, h: 1200 },
    ];
    const plain = worldOf(0, [shooterTank({ turret: UP_RIGHT })], walls);
    const lead = worldOf(LEAD_TICKS, [shooterTank({ turret: UP_RIGHT })], walls);
    expect(kinds(fireTick(plain))).toEqual(['shot', 'ricochet']);
    expect(kinds(idleTicks(plain, 1))).toEqual(['impact']);
    expect(kinds(fireTick(lead))).toEqual(['shot', 'ricochet', 'impact']);
    expect(lead.bullets).toEqual([]);
  });

  it('цель в упор: попадание в тике выстрела, снаряда в поле нет', () => {
    const plain = worldOf(0, [shooterTank(), targetTank(590, SHOOTER_Y)]);
    const lead = worldOf(LEAD_TICKS, [shooterTank(), targetTank(590, SHOOTER_Y)]);
    expect(kinds(fireTick(plain))).toEqual(['shot']);
    expect(kinds(idleTicks(plain, 1))).toEqual(['hit']);
    expect(kinds(fireTick(lead))).toEqual(['shot', 'hit']);
    expect(lead.bullets).toEqual([]);
    const damage = deriveStats(DEFAULT_STATS).damage;
    expect(lead.tanks[1]?.hp).toBe(deriveStats(DEFAULT_STATS).maxHp - damage);
    expect(lead.tanks[1]?.hp).toBe(plain.tanks[1]?.hp);
  });

  it('цель в упор под неуязвимостью: снаряд гаснет о щит в тике выстрела', () => {
    const target = targetTank(590, SHOOTER_Y);
    target.shieldLeft = 3;
    const lead = worldOf(LEAD_TICKS, [shooterTank(), target]);
    expect(kinds(fireTick(lead))).toEqual(['shot', 'shield']);
    expect(lead.bullets).toEqual([]);
    expect(target.hp).toBe(deriveStats(DEFAULT_STATS).maxHp);
  });

  it('свой рикошет в догоне: снаряд отскакивает от стены вплотную и бьёт стрелка в тике выстрела', () => {
    const wall: Wall = { x: 548, y: 0, w: 100, h: 1200 };
    const plain = worldOf(0, [shooterTank()], [wall]);
    const lead = worldOf(LEAD_TICKS, [shooterTank()], [wall]);
    expect(kinds(fireTick(plain))).toEqual(['shot', 'ricochet']);
    expect(kinds(idleTicks(plain, 1))).toEqual(['hit']);
    const events = fireTick(lead);
    expect(kinds(events)).toEqual(['shot', 'ricochet', 'hit']);
    const hit = events.find((event) => event.type === 'hit');
    expect(hit?.type === 'hit' ? [hit.tank, hit.cause] : null).toEqual([SHOOTER, 'self']);
  });

  it('цель идёт поперёк: попавшие тики выстрела при догоне 2 — те же, что без догона, сдвинутые на 2 тика позже', () => {
    const shotWindow = 45;
    const hitTicks = (leadTicks: number): number[] => {
      const hits: number[] = [];
      for (let shotTick = 0; shotTick < shotWindow; shotTick++) {
        const target = targetTank(1000, 300, Math.PI / 2);
        target.speed = target.stats.maxSpeed;
        target.hp = 100_000;
        const world = worldOf(leadTicks, [shooterTank({ x: 300 }), target]);
        const drive: Action = { ...IDLE_ACTION, throttle: 1 };
        let isHit = false;
        for (let tick = 0; tick < shotTick + 80 && !isHit; tick++) {
          const shooterAction = tick === shotTick ? FIRE : IDLE_ACTION;
          isHit = stepWorld(world, [shooterAction, drive]).some((event) => event.type === 'hit');
        }
        if (isHit) {
          hits.push(shotTick);
        }
      }
      return hits;
    };
    const plain = hitTicks(0);
    const lead = hitTicks(LEAD_TICKS);
    expect(plain.length).toBeGreaterThan(3);
    expect(Math.min(...plain)).toBeGreaterThan(LEAD_TICKS);
    expect(Math.max(...lead)).toBeLessThan(shotWindow - 1);
    expect(lead).toEqual(plain.map((tick) => tick + LEAD_TICKS));
  });

  it('размен в упор двух людей мимо снарядов друг друга: оба гибнут при любом порядке танков, как при догоне 0', () => {
    const exchange = (leadTicks: number, isReversed: boolean): { alive: boolean[]; shots: number } => {
      const shooter = shooterTank();
      const target = targetTank(590, SHOOTER_Y + 25);
      shooter.hp = 1;
      target.hp = 1;
      const tanks = isReversed ? [target, shooter] : [shooter, target];
      const world = worldOf(leadTicks, tanks);
      const events = [...stepWorld(world, [FIRE, FIRE]), ...idleTicks(world, 3)];
      return {
        alive: [shooter.isAlive, target.isAlive],
        shots: kinds(events).filter((kind) => kind === 'shot').length,
      };
    };
    const bothDead = { alive: [false, false], shots: 2 };
    expect(exchange(0, false)).toEqual(bothDead);
    expect(exchange(LEAD_TICKS, false)).toEqual(bothDead);
    expect(exchange(LEAD_TICKS, true)).toEqual(bothDead);
  });

  it('встречный выстрел в упор при догоне 2 сбивается в тике выстрела при любом порядке танков', () => {
    const clashTick = (isReversed: boolean): { events: string[]; hp: number[]; bullets: number } => {
      const shooter = shooterTank();
      const target = targetTank(590, SHOOTER_Y);
      const tanks = isReversed ? [target, shooter] : [shooter, target];
      const world = worldOf(LEAD_TICKS, tanks);
      const events = kinds(stepWorld(world, [FIRE, FIRE]));
      idleTicks(world, 3);
      return { events, hp: [shooter.hp, target.hp], bullets: world.bullets.length };
    };
    const maxHp = deriveStats(DEFAULT_STATS).maxHp;
    const clashed = { events: ['shot', 'shot', 'clash'], hp: [maxHp, maxHp], bullets: 0 };
    expect(clashTick(false)).toEqual(clashed);
    expect(clashTick(true)).toEqual(clashed);
  });

  it('снаряд в догоне сбивает встречный снаряд поля в тике выстрела; перехват — стрелку', () => {
    const shooter = shooterTank();
    const enemy = targetTank(1500, 900);
    const world = worldOf(LEAD_TICKS, [shooter, enemy]);
    const speed = shooter.stats.bulletSpeed;
    world.bullets.push({
      id: world.nextBulletId++,
      owner: TARGET,
      x: 600,
      y: SHOOTER_Y,
      vx: -speed,
      vy: 0,
      damage: enemy.stats.damage,
      bouncesLeft: 1,
      hasBounced: false,
      age: 0,
      isDead: false,
    });
    expect(kinds(fireTick(world))).toEqual(['shot', 'clash']);
    expect(world.bullets).toEqual([]);
    expect(shooter.tally.intercepts).toBe(1);
    expect(shooter.hp).toBe(shooter.stats.maxHp);
  });
});
