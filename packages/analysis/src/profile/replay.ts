import {
  BULLET_BOUNCES,
  BULLET_RADIUS,
  DEFAULT_RULES,
  DEFAULT_STATS,
  DUEL_ZONE_PLAN,
  IDLE_ACTION,
  MUZZLE_OFFSET,
  TANK_RADIUS,
  boundsHit,
  circleRect,
  createWorld,
  flyBullets,
  makeTank,
  mapByIndex,
  stepWorld,
  type BattleMap,
  type Bullet,
  type Point,
  type Side,
  type Tank,
  type World,
  type WorldEvent,
} from '@tanks/shared/engine';
import { EVENT_KIND } from '../bullets.js';
import type { GameEvent, ParsedRound, Pose } from '../logParser.js';
import { mostCommon } from '../numbers.js';

// Снаряды раунда летят движком по позам танков из журнала: танк на поле стоит там, где его записал сервер,
// и не гибнет от симуляции — гибель берётся из событий журнала.

export type ReplayOutcome = 'enemy' | 'self' | 'wall' | 'fizzle' | 'clash' | 'open' | 'unmatched';

export interface ReplayBullet {
  owner: Side;
  shotGt: number;
  endGt: number | null;
  outcome: ReplayOutcome;
}

// Точка выстрела в журнале округлена: ближе к центру танка направление по ней неточно — берётся угол башни.
const MUZZLE_DIRECTION_MIN = MUZZLE_OFFSET - 2;
// Скорость снаряда игры подбирается по первым 40 выстрелам стороны.
const SPEED_FIT_SHOTS = 40;
// Полёт до первой преграды прослеживается не дольше 130 тиков.
const SPEED_FIT_FLIGHT_TICKS = 130;
// Событие рикошета или удара совпало с расчётом: не дальше тика и 12 единиц.
const SPEED_FIT_MATCH_TICKS = 1;
const SPEED_FIT_MATCH_DISTANCE = 12;
// Угроза: снаряд бота прослеживается до 125 тиков, путь танка по прямой — на 130.
const THREAT_FLIGHT_TICKS = 125;
const THREAT_PATH_TICKS = 130;
const DEATH_NEVER_GT = Number.MAX_SAFE_INTEGER;
// Движок пишет попадание только при ненулевом уроне; здоровье танков на поле бесконечно.
const REPLAY_DAMAGE = 1;
const NO_TANKS: Tank[] = [];

function replayMap(mapIndex: number): BattleMap {
  return { ...mapByIndex(mapIndex), kits: [] };
}

function isInsideObstacle(map: BattleMap, x: number, y: number, radius: number): boolean {
  return boundsHit(x, y, radius, map) !== null || map.walls.some((wall) => circleRect(x, y, radius, wall) !== null);
}

function replayTank(id: Side, pose: Pose): Tank {
  const tank = makeTank({ name: '', stats: DEFAULT_STATS }, id, pose);
  tank.hp = Infinity;
  return tank;
}

function placeTank(tank: Tank, at: Point, isAlive: boolean): void {
  tank.x = at.x;
  tank.y = at.y;
  tank.speed = 0;
  tank.hp = Infinity;
  tank.isAlive = isAlive;
}

// Направление выстрела — от центра танка к точке дула из события.
export function shotAngle(shot: GameEvent, shooter: Pose): number {
  const dx = shot.x - shooter.x;
  const dy = shot.y - shooter.y;
  if (Math.hypot(dx, dy) > MUZZLE_DIRECTION_MIN) {
    return Math.atan2(dy, dx);
  }
  return shooter.turret;
}

// null — дуло в стене: снаряд гибнет, не вылетев.
function launch(world: World, owner: Side, shot: GameEvent, angle: number, speed: number): Bullet | null {
  if (isInsideObstacle(world.map, shot.x, shot.y, BULLET_RADIUS)) {
    return null;
  }
  const bullet: Bullet = {
    id: world.nextBulletId++,
    owner,
    x: shot.x,
    y: shot.y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    damage: REPLAY_DAMAGE,
    bouncesLeft: BULLET_BOUNCES,
    hasBounced: false,
    age: 0,
    isDead: false,
  };
  world.bullets.push(bullet);
  return bullet;
}

// Исход погибшего снаряда — по событию тика с его координатами; без события — его сбил встречный.
function outcomeOf(bullet: Bullet, events: readonly WorldEvent[]): ReplayOutcome {
  for (const event of events) {
    const isHit =
      event.type === 'hit' && event.by === bullet.owner && event.bulletX === bullet.x && event.bulletY === bullet.y;
    if (isHit) {
      return event.tank === bullet.owner ? 'self' : 'enemy';
    }
    const isAt = 'owner' in event && event.owner === bullet.owner && event.x === bullet.x && event.y === bullet.y;
    if (isAt && event.type === 'impact') {
      return 'wall';
    }
    if (isAt && event.type === 'fizzle') {
      return 'fizzle';
    }
  }
  return 'clash';
}

function shotsOf(round: ParsedRound, side: Side): GameEvent[] {
  return round.events.filter((event) => event.kind === EVENT_KIND.shot && event.side === side);
}

function wallEventsOf(round: ParsedRound, side: Side): GameEvent[] {
  return round.events.filter(
    (event) => (event.kind === EVENT_KIND.ricochet || event.kind === EVENT_KIND.impact) && event.side === side,
  );
}

// Тик и место первого касания преграды снарядом с этой скоростью; null — дуло в стене или касания не было.
function firstWallTouch(
  map: BattleMap,
  side: Side,
  shot: GameEvent,
  angle: number,
  speed: number,
): { gt: number; x: number; y: number } | null {
  const world = createWorld(map, NO_TANKS, DEFAULT_RULES, DUEL_ZONE_PLAN);
  const bullet = launch(world, side, shot, angle, speed);
  if (bullet === null) {
    return null;
  }
  for (let gt = shot.gt; gt < shot.gt + SPEED_FIT_FLIGHT_TICKS; gt++) {
    flyBullets(world);
    if (bullet.hasBounced || bullet.isDead) {
      return { gt, x: bullet.x, y: bullet.y };
    }
  }
  return null;
}

export interface SpeedFit {
  speed: number | null;
  matches: number;
}

// Скорость снаряда стороны — кандидат, чей полёт до первой преграды совпал с событием рикошета или удара
// чаще других. Выстрел из дула в стене входит в 40 проверенных, но ни с одним кандидатом не совпадает.
export function fitBulletSpeed(rounds: readonly ParsedRound[], side: Side, candidates: readonly number[]): SpeedFit {
  const matched: number[] = [];
  let tested = 0;
  for (const round of rounds) {
    if (tested >= SPEED_FIT_SHOTS) {
      break;
    }
    const map = replayMap(round.mapIndex);
    const poses = new Map(round.ticks.map((tick) => [tick.gt, tick.poses[side]]));
    const wallEvents = wallEventsOf(round, side);
    for (const shot of shotsOf(round, side)) {
      const shooter = poses.get(shot.gt);
      if (shooter === undefined) {
        continue;
      }
      tested++;
      const angle = shotAngle(shot, shooter);
      for (const speed of candidates) {
        const touch = firstWallTouch(map, side, shot, angle, speed);
        if (touch === null) {
          continue;
        }
        const isMatched = wallEvents.some(
          (event) =>
            Math.abs(event.gt - touch.gt) <= SPEED_FIT_MATCH_TICKS &&
            Math.hypot(event.x - touch.x, event.y - touch.y) < SPEED_FIT_MATCH_DISTANCE,
        );
        if (isMatched) {
          matched.push(speed);
        }
      }
      if (tested >= SPEED_FIT_SHOTS) {
        break;
      }
    }
  }
  const speed = mostCommon(matched);
  return { speed, matches: speed === null ? 0 : matched.filter((value) => value === speed).length };
}

function deathGtOf(round: ParsedRound, side: Side): number {
  return round.events.find((event) => event.kind === EVENT_KIND.death && event.side === side)?.gt ?? DEATH_NEVER_GT;
}

// Все снаряды раунда по позам журнала: исход каждого, включая взаимное уничтожение снарядов.
export function replayRound(round: ParsedRound, speeds: readonly [number, number]): ReplayBullet[] {
  const firstPoses = round.ticks[0]?.poses;
  if (firstPoses === undefined) {
    return [];
  }
  const tanks: [Tank, Tank] = [replayTank(0, firstPoses[0]), replayTank(1, firstPoses[1])];
  const world = createWorld(replayMap(round.mapIndex), tanks, DEFAULT_RULES, DUEL_ZONE_PLAN);
  const deathGts = [deathGtOf(round, 0), deathGtOf(round, 1)] as const;
  const shotsByGt = new Map<number, { shot: GameEvent; owner: Side }[]>();
  for (const event of round.events) {
    if (event.kind !== EVENT_KIND.shot || event.side === null) {
      continue;
    }
    const sameTick = shotsByGt.get(event.gt) ?? [];
    sameTick.push({ shot: event, owner: event.side });
    shotsByGt.set(event.gt, sameTick);
  }
  const all: ReplayBullet[] = [];
  const live: { bullet: Bullet; replay: ReplayBullet }[] = [];
  for (const tick of round.ticks) {
    const shots = [...(shotsByGt.get(tick.gt) ?? [])].sort((a, b) => a.owner - b.owner);
    for (const { shot, owner } of shots) {
      const replay: ReplayBullet = { owner, shotGt: tick.gt, endGt: null, outcome: 'open' };
      all.push(replay);
      const bullet = launch(world, owner, shot, shotAngle(shot, tick.poses[owner]), speeds[owner]);
      if (bullet === null) {
        replay.outcome = 'wall';
        replay.endGt = tick.gt;
        continue;
      }
      live.push({ bullet, replay });
    }
    placeTank(tanks[0], tick.poses[0], deathGts[0] >= tick.gt);
    placeTank(tanks[1], tick.poses[1], deathGts[1] >= tick.gt);
    const events = stepWorld(world, [IDLE_ACTION, IDLE_ACTION]);
    for (const entry of live) {
      if (entry.bullet.isDead) {
        entry.replay.outcome = outcomeOf(entry.bullet, events);
        entry.replay.endGt = tick.gt;
      }
    }
    live.splice(0, live.length, ...live.filter((entry) => !entry.bullet.isDead));
  }
  return all;
}

// Путь танка, едущего прямо с прежней скоростью за тик; упёрся в стену — стоит.
function straightPath(map: BattleMap, start: Point, velocity: Point, ticks: number): Point[] {
  const path: Point[] = [start];
  let at = start;
  let isStopped = false;
  for (let k = 1; k <= ticks; k++) {
    const next = { x: at.x + velocity.x, y: at.y + velocity.y };
    if (!isStopped && isInsideObstacle(map, next.x, next.y, TANK_RADIUS)) {
      isStopped = true;
    }
    if (!isStopped) {
      at = next;
    }
    path.push(at);
  }
  return path;
}

export interface ThreatInput {
  round: ParsedRound;
  tickIndex: number;
  shot: GameEvent;
  bot: Side;
  human: Side;
  speed: number;
  velocity: Point;
}

// Тиков до попадания снаряда бота, если бы человек ехал прямо; null — не попал бы.
export function counterfactualHit(input: ThreatInput): number | null {
  const { round, tickIndex, shot, bot, human, speed, velocity } = input;
  const tick = round.ticks[tickIndex];
  if (tick === undefined) {
    return null;
  }
  const map = replayMap(round.mapIndex);
  const tanks: [Tank, Tank] = [replayTank(0, tick.poses[0]), replayTank(1, tick.poses[1])];
  const world = createWorld(map, tanks, DEFAULT_RULES, DUEL_ZONE_PLAN);
  const bullet = launch(world, bot, shot, shotAngle(shot, tick.poses[bot]), speed);
  if (bullet === null) {
    return null;
  }
  const path = straightPath(map, tick.poses[human], velocity, THREAT_PATH_TICKS);
  let botPose = tick.poses[bot];
  for (let k = 0; k < THREAT_FLIGHT_TICKS; k++) {
    botPose = round.ticks[tickIndex + k]?.poses[bot] ?? botPose;
    placeTank(tanks[human], path[k] ?? tick.poses[human], true);
    placeTank(tanks[bot], botPose, true);
    const events = stepWorld(world, [IDLE_ACTION, IDLE_ACTION]);
    if (bullet.isDead) {
      return outcomeOf(bullet, events) === 'enemy' ? k : null;
    }
  }
  return null;
}
