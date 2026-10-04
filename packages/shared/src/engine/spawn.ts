import { BULLET_LIFETIME, BULLET_RADIUS, FFA, SPAWN, TANK_RADIUS } from './constants.js';
import { circleRect, isSegmentClear } from './geometry.js';
import type { SpawnArea } from './ffaMaps.js';
import type { Spawn } from './maps.js';
import { nextRandom, randomIndex, type Random } from './random.js';
import { zoneRadiusAt, type World } from './round.js';

interface ScoredArea {
  area: SpawnArea;
  score: number;
}

// Зона только сжимается: область целиком в круге через spawnLookaheadSeconds — значит, и всё это время.
function isInsideZoneAhead(world: World, area: SpawnArea): boolean {
  const radiusAhead = zoneRadiusAt(world.zonePlan, world.time + FFA.spawnLookaheadSeconds);
  const distance = Math.hypot(area.x - world.zone.x, area.y - world.zone.y);
  return distance + area.radius + TANK_RADIUS <= radiusAhead;
}

// Чем дальше ближайший живой враг, тем лучше; враг, который видит центр области в пределах дальности
// своего снаряда, — штраф.
function scoreArea(world: World, area: SpawnArea): number {
  let nearest: number = SPAWN.scoreCap;
  let isUnderFire = false;
  for (const tank of world.tanks) {
    if (!tank.isAlive) {
      continue;
    }
    const distance = Math.hypot(tank.x - area.x, tank.y - area.y);
    nearest = Math.min(nearest, distance);
    const isInRange = distance <= tank.stats.bulletSpeed * BULLET_LIFETIME;
    if (isInRange && isSegmentClear(world.map.walls, tank.x, tank.y, area.x, area.y, BULLET_RADIUS)) {
      isUnderFire = true;
    }
  }
  return isUnderFire ? nearest - SPAWN.lineOfFirePenalty : nearest;
}

function isPlaceFree(world: World, x: number, y: number): boolean {
  const isInsideField =
    x >= TANK_RADIUS && x <= world.map.width - TANK_RADIUS && y >= TANK_RADIUS && y <= world.map.height - TANK_RADIUS;
  if (!isInsideField) {
    return false;
  }
  if (world.map.walls.some((wall) => circleRect(x, y, TANK_RADIUS, wall) !== null)) {
    return false;
  }
  const minDistance = TANK_RADIUS * 2 + SPAWN.tankGap;
  return world.tanks.every((tank) => Math.hypot(tank.x - x, tank.y - y) >= minDistance);
}

function placeInArea(world: World, area: SpawnArea, random: Random): Spawn | null {
  for (let attempt = 0; attempt < SPAWN.placementTries; attempt++) {
    const angle = nextRandom(random) * Math.PI * 2;
    const distance = area.radius * Math.sqrt(nextRandom(random));
    const x = area.x + Math.cos(angle) * distance;
    const y = area.y + Math.sin(angle) * distance;
    if (isPlaceFree(world, x, y)) {
      return { x, y, heading: Math.atan2(world.map.height / 2 - y, world.map.width / 2 - x) };
    }
  }
  return null;
}

// Точка возрождения — случайная среди почти лучших по оценке; не нашлось места в ней — следующие по оценке.
export function chooseSpawn(world: World, areas: readonly SpawnArea[], random: Random): Spawn | null {
  const scored: ScoredArea[] = areas
    .filter((area) => isInsideZoneAhead(world, area))
    .map((area) => ({ area, score: scoreArea(world, area) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best === undefined) {
    return null;
  }
  const threshold = best.score - Math.abs(best.score) * (1 - SPAWN.nearBestShare);
  const nearBest = scored.filter((entry) => entry.score >= threshold);
  const picked = nearBest[randomIndex(random, nearBest.length)] ?? best;
  const order = [picked, ...scored.filter((entry) => entry !== picked)];
  for (const entry of order) {
    const place = placeInArea(world, entry.area, random);
    if (place !== null) {
      return place;
    }
  }
  return null;
}
