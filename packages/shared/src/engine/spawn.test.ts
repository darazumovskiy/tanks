import { describe, expect, it } from 'vitest';
import { DEFAULT_STATS, DT, FFA, SPAWN, TANK_RADIUS } from './constants.js';
import type { SpawnArea } from './ffaMaps.js';
import { circleRect, type Wall } from './geometry.js';
import type { BattleMap } from './maps.js';
import { createRandom } from './random.js';
import { createWorld, DEFAULT_RULES, makeTank, zoneRadiusAt, type Tank, type World, type ZonePlan } from './round.js';
import { chooseSpawn } from './spawn.js';

const WIDTH = 2000;
const HEIGHT = 1200;
const OPEN_PLAN: ZonePlan = { startRadius: 5000, finalRadius: 5000, startShrink: 1000, endShrink: 1001 };

function testMap(walls: Wall[] = []): BattleMap {
  return { name: 'Проба', width: WIDTH, height: HEIGHT, walls, kits: [] };
}

function enemyAt(id: number, x: number, y: number): Tank {
  return makeTank({ name: `Враг ${String(id)}`, stats: DEFAULT_STATS }, id, { x, y, heading: 0 });
}

function worldWith(tanks: Tank[], walls: Wall[] = [], plan: ZonePlan = OPEN_PLAN): World {
  return createWorld(testMap(walls), tanks, DEFAULT_RULES, plan);
}

function isInArea(point: { x: number; y: number }, area: SpawnArea): boolean {
  return Math.hypot(point.x - area.x, point.y - area.y) <= area.radius + 1e-9;
}

describe('выбор точки возрождения', () => {
  const left: SpawnArea = { x: 300, y: 600, radius: 90 };
  const right: SpawnArea = { x: 1700, y: 600, radius: 90 };

  it('враг у одной из двух точек — появление у другой, при любом сиде', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const world = worldWith([enemyAt(7, 320, 600)]);
      const place = chooseSpawn(world, [left, right], createRandom(seed));
      expect(place).not.toBeNull();
      expect(place !== null && isInArea(place, right)).toBe(true);
    }
  });

  it('враг видит одну точку по прямой, другая закрыта стеной на том же расстоянии — появление у закрытой', () => {
    const open: SpawnArea = { x: 600, y: 900, radius: 60 };
    const covered: SpawnArea = { x: 1400, y: 900, radius: 60 };
    const wall: Wall = { x: 1150, y: 550, w: 40, h: 200 };
    for (let seed = 1; seed <= 20; seed++) {
      const world = worldWith([enemyAt(3, 1000, 300)], [wall]);
      const place = chooseSpawn(world, [open, covered], createRandom(seed));
      expect(place !== null && isInArea(place, covered)).toBe(true);
    }
  });

  it('место — внутри области, не в стене и не ближе двух радиусов с зазором к танку; курс на центр карты', () => {
    const area: SpawnArea = { x: 1000, y: 600, radius: 90 };
    const wall: Wall = { x: 990, y: 520, w: 20, h: 60 };
    const neighbour = enemyAt(1, 1050, 600);
    for (let seed = 1; seed <= 50; seed++) {
      const world = worldWith([neighbour], [wall]);
      const place = chooseSpawn(world, [area], createRandom(seed));
      expect(place).not.toBeNull();
      if (place === null) {
        continue;
      }
      expect(isInArea(place, area)).toBe(true);
      expect(Math.hypot(place.x - neighbour.x, place.y - neighbour.y)).toBeGreaterThanOrEqual(
        TANK_RADIUS * 2 + SPAWN.tankGap,
      );
      expect(circleRect(place.x, place.y, TANK_RADIUS, wall)).toBeNull();
      expect(place.heading).toBeCloseTo(Math.atan2(HEIGHT / 2 - place.y, WIDTH / 2 - place.x), 9);
    }
  });

  it('места нет — null; место освободилось — появление', () => {
    const tiny: SpawnArea = { x: 1000, y: 600, radius: 10 };
    const sitter = enemyAt(1, 1000, 600);
    const world = worldWith([sitter]);
    expect(chooseSpawn(world, [tiny], createRandom(5))).toBeNull();
    sitter.x = 1500;
    expect(chooseSpawn(world, [tiny], createRandom(5))).not.toBeNull();
  });

  it('во время сжатия — только точки, чья область внутри круга и через 5 с', () => {
    const plan: ZonePlan = { startRadius: 1200, finalRadius: 200, startShrink: 0, endShrink: 10 };
    const center: SpawnArea = { x: 1000, y: 600, radius: 90 };
    const edge: SpawnArea = { x: 200, y: 600, radius: 90 };
    const world = worldWith([], [], plan);
    world.tick = 30;
    world.time = world.tick * DT;
    world.zone.radius = zoneRadiusAt(plan, world.time);
    const radiusAhead = zoneRadiusAt(plan, world.time + FFA.spawnLookaheadSeconds);
    expect(800 + edge.radius + TANK_RADIUS).toBeGreaterThan(radiusAhead);
    expect(world.zone.radius).toBeGreaterThan(800 + edge.radius + TANK_RADIUS);
    for (let seed = 1; seed <= 20; seed++) {
      const place = chooseSpawn(world, [edge, center], createRandom(seed));
      expect(place !== null && isInArea(place, center)).toBe(true);
    }
  });

  it('ни одна область не годится по зоне — null', () => {
    const plan: ZonePlan = { startRadius: 100, finalRadius: 100, startShrink: 0, endShrink: 1 };
    const world = worldWith([], [], plan);
    expect(chooseSpawn(world, [left, right], createRandom(1))).toBeNull();
  });
});
