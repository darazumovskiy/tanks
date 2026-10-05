import { FFA, TICK_RATE, ZONE_START_MARGIN } from './constants.js';
import type { FfaMap } from './ffaMaps.js';
import { createRandom, type Random } from './random.js';
import {
  createWorld,
  makeTank,
  stepWorld,
  type WorldEvent,
  type RoundRules,
  type TankSetup,
  type World,
  type ZonePlan,
} from './round.js';
import { chooseSpawn } from './spawn.js';

// alive — танк на поле; wreck — подбит, ещё на поле; waiting — ждёт возрождения; spectator — зритель до конца матча.
export type FfaPlayerState = 'alive' | 'wreck' | 'waiting' | 'spectator';

export interface FfaSetup extends TankSetup {
  id: number;
}

export interface FfaPlayer {
  id: number;
  name: string;
  stats: unknown;
  state: FfaPlayerState;
  ticksLeft: number;
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
  killerId: number | null;
  // Был ли танк на поле в этом матче: вошедший в финал зрителем в счёт матча не входит.
  hasPlayed: boolean;
}

// durationSeconds — длительность матча; suddenDeathAt — секунда матча, с которой возрождения нет.
export interface FfaMatch {
  world: World;
  map: FfaMap;
  players: FfaPlayer[];
  random: Random;
  durationSeconds: number;
  suddenDeathAt: number;
  isSuddenDeath: boolean;
  isOver: boolean;
}

export type FfaEvent =
  WorldEvent | { type: 'spawn'; tank: number; x: number; y: number } | { type: 'suddenDeath' } | { type: 'matchOver' };

const WRECK_TICKS = Math.round(FFA.wreckSeconds * TICK_RATE);
// Тиков от исчезновения обломков до появления: клиент досчитывает по ним отсчёт подбитого.
export const FFA_RESPAWN_WAIT_TICKS = Math.round((FFA.respawnSeconds - FFA.wreckSeconds) * TICK_RATE);

function ffaZonePlan(map: FfaMap, playerCount: number, durationSeconds: number): ZonePlan {
  const startRadius = Math.hypot(map.width / 2, map.height / 2) + ZONE_START_MARGIN;
  return {
    startRadius,
    finalRadius: Math.min(startRadius, FFA.finalRadiusPerRootPlayer * Math.sqrt(Math.max(1, playerCount))),
    startShrink: durationSeconds * FFA.zoneStartShare,
    endShrink: durationSeconds * FFA.zoneEndShare,
  };
}

// Момент, когда круг проходит через точку на расстоянии distance от центра; внутри конечного круга — никогда.
function coverTime(plan: ZonePlan, distance: number): number {
  if (distance <= plan.finalRadius) {
    return Infinity;
  }
  const share = (plan.startRadius - distance) / (plan.startRadius - plan.finalRadius);
  return plan.startShrink + Math.max(0, share) * (plan.endShrink - plan.startShrink);
}

// Финал начинается, когда снаружи круга половина точек возрождения; не набралось к концу сжатия — в конце сжатия.
export function suddenDeathTime(map: FfaMap, plan: ZonePlan): number {
  const times = map.spawnAreas
    .map((area) => coverTime(plan, Math.hypot(area.x - map.width / 2, area.y - map.height / 2)))
    .sort((a, b) => a - b);
  const needed = Math.ceil(map.spawnAreas.length * FFA.suddenDeathShare);
  return Math.min(times[needed - 1] ?? plan.endShrink, plan.endShrink);
}

function newPlayer(setup: FfaSetup, state: FfaPlayerState): FfaPlayer {
  return {
    id: setup.id,
    name: setup.name,
    stats: setup.stats,
    state,
    ticksLeft: 0,
    kills: 0,
    deaths: 0,
    damageDealt: 0,
    damageTaken: 0,
    killerId: null,
    hasPlayed: false,
  };
}

function playerById(match: FfaMatch, id: number): FfaPlayer | undefined {
  return match.players.find((player) => player.id === id);
}

function spawnPlayer(match: FfaMatch, player: FfaPlayer, events: FfaEvent[]): void {
  const place = chooseSpawn(match.world, match.map.spawnAreas, match.random);
  if (place === null) {
    return;
  }
  const tank = makeTank({ name: player.name, stats: player.stats }, player.id, place);
  tank.shieldLeft = FFA.shieldSeconds;
  match.world.tanks.push(tank);
  player.state = 'alive';
  player.hasPlayed = true;
  events.push({ type: 'spawn', tank: tank.id, x: tank.x, y: tank.y });
}

export function createFfaMatch(
  map: FfaMap,
  setups: readonly FfaSetup[],
  seed: number,
  rules: Readonly<RoundRules>,
  durationSeconds: number = FFA.matchSeconds,
): FfaMatch {
  const plan = ffaZonePlan(map, setups.length, durationSeconds);
  const match: FfaMatch = {
    world: createWorld(map, [], rules, plan),
    map,
    players: setups.map((setup) => newPlayer(setup, 'waiting')),
    random: createRandom(seed),
    durationSeconds,
    suddenDeathAt: suddenDeathTime(map, plan),
    isSuddenDeath: false,
    isOver: false,
  };
  for (const player of match.players) {
    spawnPlayer(match, player, []);
  }
  return match;
}

// До финала вошедший появляется на ближайшем тике, в финале — смотрит зрителем.
export function joinFfaMatch(match: FfaMatch, setup: FfaSetup): void {
  if (playerById(match, setup.id) !== undefined) {
    throw new Error(`игрок ${String(setup.id)} уже в матче`);
  }
  match.players.push(newPlayer(setup, match.isSuddenDeath ? 'spectator' : 'waiting'));
}

export function leaveFfaMatch(match: FfaMatch, id: number): void {
  match.players = match.players.filter((player) => player.id !== id);
  match.world.tanks = match.world.tanks.filter((tank) => tank.id !== id);
}

// Убийство — автору добивающего выстрела; свой рикошет и зона — смерть без убийства.
function scoreEvent(match: FfaMatch, event: WorldEvent): void {
  if (event.type === 'hit') {
    const victim = playerById(match, event.tank);
    if (victim !== undefined) {
      victim.damageTaken += event.damage;
    }
    const shooter = event.cause === 'bullet' && event.by !== undefined ? playerById(match, event.by) : undefined;
    if (shooter !== undefined) {
      shooter.damageDealt += event.damage;
    }
    return;
  }
  if (event.type !== 'death') {
    return;
  }
  const victim = playerById(match, event.tank);
  if (victim !== undefined) {
    victim.deaths++;
    victim.killerId = event.cause === 'bullet' ? event.by : null;
    victim.state = 'wreck';
    victim.ticksLeft = WRECK_TICKS;
  }
  const killer = event.cause === 'bullet' && event.by !== null ? playerById(match, event.by) : undefined;
  if (killer !== undefined) {
    killer.kills++;
  }
}

function advancePlayer(match: FfaMatch, player: FfaPlayer, events: FfaEvent[]): void {
  if (player.state === 'wreck') {
    player.ticksLeft--;
    if (player.ticksLeft > 0) {
      return;
    }
    match.world.tanks = match.world.tanks.filter((tank) => tank.id !== player.id);
    if (match.isSuddenDeath) {
      becomeSpectator(player);
      return;
    }
    player.state = 'waiting';
    player.ticksLeft = FFA_RESPAWN_WAIT_TICKS;
    return;
  }
  if (player.state !== 'waiting') {
    return;
  }
  if (player.ticksLeft > 0) {
    player.ticksLeft--;
  }
  if (player.ticksLeft === 0) {
    spawnPlayer(match, player, events);
  }
}

function becomeSpectator(player: FfaPlayer): void {
  player.state = 'spectator';
  player.ticksLeft = 0;
}

function startSuddenDeath(match: FfaMatch, events: FfaEvent[]): void {
  match.isSuddenDeath = true;
  events.push({ type: 'suddenDeath' });
  for (const player of match.players) {
    if (player.state === 'waiting') {
      becomeSpectator(player);
    }
  }
}

// actions — команды по номеру игрока; нет команды — танк стоит.
export function stepFfaMatch(match: FfaMatch, actions: ReadonlyMap<number, unknown>): FfaEvent[] {
  if (match.isOver) {
    return [];
  }
  const world = match.world;
  const roundEvents = stepWorld(
    world,
    world.tanks.map((tank) => actions.get(tank.id)),
  );
  const events: FfaEvent[] = [...roundEvents];
  if (!match.isSuddenDeath && world.time >= match.suddenDeathAt - 1e-9) {
    startSuddenDeath(match, events);
  }
  // Таймеры — до счёта: убитый на этом тике начинает отсчёт 2 с на поле со следующего тика.
  for (const player of match.players) {
    advancePlayer(match, player, events);
  }
  for (const event of roundEvents) {
    scoreEvent(match, event);
  }
  const aliveCount = world.tanks.filter((tank) => tank.isAlive).length;
  const isTimeUp = world.time >= match.durationSeconds - 1e-9;
  if (isTimeUp || (match.isSuddenDeath && aliveCount <= 1)) {
    match.isOver = true;
    events.push({ type: 'matchOver' });
  }
  return events;
}

// Строка таблицы: игрок матча на сервере или строка счёта у клиента.
export interface FfaStandingRow {
  id: number;
  kills: number;
  deaths: number;
}

function compareStanding(a: FfaStandingRow, b: FfaStandingRow): number {
  if (a.kills !== b.kills) {
    return b.kills - a.kills;
  }
  if (a.deaths !== b.deaths) {
    return a.deaths - b.deaths;
  }
  return a.id - b.id;
}

// По убийствам, при равенстве — по меньшему числу смертей, затем по номеру.
export function ffaStandings<T extends FfaStandingRow>(rows: readonly T[]): T[] {
  return [...rows].sort(compareStanding);
}

// Строка счёта с уроном: игрок матча на сервере или строка счёта у клиента.
export interface FfaTallyRow extends FfaStandingRow {
  damageDealt: number;
  damageTaken: number;
}

// Сколько урона игрок раздал на каждую единицу полученного; убийство и смерть весят как танк.
export function ffaEfficiency(row: FfaTallyRow): number | null {
  if (row.damageTaken === 0 && row.deaths === 0) {
    return null;
  }
  const weight = FFA.efficiencyTankWeight;
  return (row.damageDealt + weight * row.kills) / (row.damageTaken + weight * row.deaths);
}
