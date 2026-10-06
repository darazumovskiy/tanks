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

// Кандидаты места старта по номеру; простор — расстояние до ближайшего выбранного места или с весом до края.
interface StartCandidates {
  xs: Float64Array;
  ys: Float64Array;
  nearestTankSquared: Float64Array;
  spreadSquared: Float64Array;
}

// Зона только сжимается: круг внутри зоны через spawnLookaheadSeconds — значит, и всё это время.
function isCircleInsideZoneAhead(world: World, x: number, y: number, radius: number): boolean {
  const radiusAhead = zoneRadiusAt(world.zonePlan, world.time + FFA.spawnLookaheadSeconds);
  const distance = Math.hypot(x - world.zone.x, y - world.zone.y);
  return distance + radius <= radiusAhead;
}

function isInsideZoneAhead(world: World, area: SpawnArea): boolean {
  return isCircleInsideZoneAhead(world, area.x, area.y, area.radius + TANK_RADIUS);
}

function headingToCenter(world: World, x: number, y: number): number {
  return Math.atan2(world.map.height / 2 - y, world.map.width / 2 - x);
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
      return { x, y, heading: headingToCenter(world, x, y) };
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

// Край поля считается соседом на расстоянии startEdgeWeight × до края: самые дальние места — не у края, а места
// у края встают в треть шага от него.
function startCandidates(world: World): StartCandidates {
  const step = SPAWN.startGridStep;
  const xs: number[] = [];
  const ys: number[] = [];
  const spreads: number[] = [];
  for (let y = step / 2; y < world.map.height; y += step) {
    for (let x = step / 2; x < world.map.width; x += step) {
      if (isPlaceFree(world, x, y) && isCircleInsideZoneAhead(world, x, y, TANK_RADIUS)) {
        const edge = SPAWN.startEdgeWeight * Math.min(x, y, world.map.width - x, world.map.height - y);
        xs.push(x);
        ys.push(y);
        spreads.push(edge * edge);
      }
    }
  }
  return {
    xs: Float64Array.from(xs),
    ys: Float64Array.from(ys),
    nearestTankSquared: new Float64Array(xs.length).fill(Infinity),
    spreadSquared: Float64Array.from(spreads),
  };
}

function shuffled(places: readonly Spawn[], random: Random): Spawn[] {
  const pool = [...places];
  const order: Spawn[] = [];
  while (pool.length > 0) {
    const [place] = pool.splice(randomIndex(random, pool.length), 1);
    if (place !== undefined) {
      order.push(place);
    }
  }
  return order;
}

// Места старта — по всему полю, куда зона не дойдёт в ближайшие секунды: каждое следующее — случайное среди почти
// самых дальних от уже выбранных мест и от края. Расстояния сравниваются квадратами: выбор не зависит от последнего
// бита Math.hypot. Игрокам места достаются в случайном порядке — первое место всегда ближе к середине поля.
// Мест меньше count, когда поле тесное: остальным — точки возрождения.
export function chooseStartPlaces(world: World, count: number, random: Random): Spawn[] {
  const { xs, ys, nearestTankSquared, spreadSquared } = startCandidates(world);
  const minSquared = (TANK_RADIUS * 2 + SPAWN.tankGap) ** 2;
  const nearBestShareSquared = SPAWN.startNearBestShare ** 2;
  const places: Spawn[] = [];
  const nearBest: number[] = [];
  let farthest = spreadSquared.reduce((best, spread) => Math.max(best, spread), -1);
  for (let i = 0; i < count && farthest >= 0; i++) {
    const threshold = farthest * nearBestShareSquared;
    nearBest.length = 0;
    for (let c = 0; c < xs.length; c++) {
      if ((nearestTankSquared[c] ?? 0) >= minSquared && (spreadSquared[c] ?? 0) >= threshold) {
        nearBest.push(c);
      }
    }
    const picked = nearBest[randomIndex(random, nearBest.length)] ?? 0;
    const x = xs[picked] ?? 0;
    const y = ys[picked] ?? 0;
    places.push({ x, y, heading: headingToCenter(world, x, y) });
    farthest = -1;
    for (let c = 0; c < xs.length; c++) {
      const dx = (xs[c] ?? 0) - x;
      const dy = (ys[c] ?? 0) - y;
      const distanceSquared = dx * dx + dy * dy;
      const nearest = Math.min(nearestTankSquared[c] ?? 0, distanceSquared);
      const spread = Math.min(spreadSquared[c] ?? 0, distanceSquared);
      nearestTankSquared[c] = nearest;
      spreadSquared[c] = spread;
      if (nearest >= minSquared && spread > farthest) {
        farthest = spread;
      }
    }
  }
  return shuffled(places, random);
}
