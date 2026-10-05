import { describe, expect, it } from 'vitest';
import { BULLET_LIFETIME, BULLET_RADIUS, DEFAULT_STATS, FFA, TANK_RADIUS, TICK_RATE } from './constants.js';
import {
  createFfaMatch,
  ffaEfficiency,
  ffaStandings,
  joinFfaMatch,
  leaveFfaMatch,
  stepFfaMatch,
  type FfaEvent,
  type FfaMatch,
  type FfaPlayer,
  type FfaSetup,
} from './ffa.js';
import { FFA_SIZES, ffaMap, type FfaMap, type SpawnArea } from './ffaMaps.js';
import type { Wall } from './geometry.js';
import { createRandom, nextRandom } from './random.js';
import { DEFAULT_RULES, IDLE_ACTION, zoneRadiusAt, type Action, type Tank } from './round.js';
import { traceShot } from './trajectory.js';

const WIDTH = 2000;
const HEIGHT = 1200;
const DAMAGE = 28;
const BULLET_SPEED = 550;
const CORNER_AREAS: SpawnArea[] = [
  { x: 300, y: 300, radius: 90 },
  { x: 1700, y: 300, radius: 90 },
  { x: 300, y: 900, radius: 90 },
  { x: 1700, y: 900, radius: 90 },
];
const NO_ACTIONS: ReadonlyMap<number, unknown> = new Map();
const WRECK_TICKS = FFA.wreckSeconds * TICK_RATE;
const RESPAWN_TICKS = FFA.respawnSeconds * TICK_RATE;

function testMap(spawnAreas: SpawnArea[] = CORNER_AREAS, walls: Wall[] = []): FfaMap {
  return { name: 'Проба', size: 10, seed: 1, width: WIDTH, height: HEIGHT, walls, kits: [], spawnAreas };
}

function setups(count: number, firstId = 0): FfaSetup[] {
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    name: `Игрок ${String(firstId + index)}`,
    stats: DEFAULT_STATS,
  }));
}

function tankOf(match: FfaMatch, id: number): Tank {
  const tank = match.world.tanks.find((candidate) => candidate.id === id);
  if (tank === undefined) {
    throw new Error(`танка ${String(id)} нет на поле`);
  }
  return tank;
}

function playerOf(match: FfaMatch, id: number): FfaPlayer {
  const player = match.players.find((candidate) => candidate.id === id);
  if (player === undefined) {
    throw new Error(`игрока ${String(id)} нет в матче`);
  }
  return player;
}

// Ставит танк в точку без неуязвимости: сцены боя собираются вручную.
function put(match: FfaMatch, id: number, x: number, y: number, hp?: number): Tank {
  const tank = tankOf(match, id);
  tank.x = x;
  tank.y = y;
  tank.heading = 0;
  tank.turret = 0;
  tank.speed = 0;
  tank.shieldLeft = 0;
  if (hp !== undefined) {
    tank.hp = hp;
  }
  return tank;
}

function shoot(match: FfaMatch, owner: number, x: number, y: number, vx: number, vy: number, hasBounced = false): void {
  match.world.bullets.push({
    id: match.world.nextBulletId++,
    owner,
    x,
    y,
    vx,
    vy,
    damage: DAMAGE,
    bouncesLeft: hasBounced ? 0 : 1,
    hasBounced,
    age: 0,
    isDead: false,
  });
}

function run(match: FfaMatch, ticks: number, actions: ReadonlyMap<number, unknown> = NO_ACTIONS): FfaEvent[] {
  const events: FfaEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    events.push(...stepFfaMatch(match, actions));
  }
  return events;
}

function deaths(events: FfaEvent[]): Extract<FfaEvent, { type: 'death' }>[] {
  return events.filter((event): event is Extract<FfaEvent, { type: 'death' }> => event.type === 'death');
}

function openMatch(count: number, map: FfaMap = testMap()): FfaMatch {
  return createFfaMatch(map, setups(count), 1, DEFAULT_RULES);
}

describe('старт матча', () => {
  it.each(FFA_SIZES.map((size) => [size] as const))(
    'полный состав на карте %i: все на поле, порознь, в областях',
    (size) => {
      const map = ffaMap(size);
      const match = createFfaMatch(map, setups(size), 42, DEFAULT_RULES);
      expect(match.world.tanks).toHaveLength(size);
      for (const tank of match.world.tanks) {
        expect(tank.shieldLeft).toBe(FFA.shieldSeconds);
        expect(map.spawnAreas.some((area) => Math.hypot(tank.x - area.x, tank.y - area.y) <= area.radius)).toBe(true);
        for (const other of match.world.tanks) {
          if (other !== tank) {
            expect(Math.hypot(tank.x - other.x, tank.y - other.y)).toBeGreaterThanOrEqual(TANK_RADIUS * 2);
          }
        }
      }
      expect(match.players.every((player) => player.state === 'alive')).toBe(true);
    },
  );
});

describe('счёт', () => {
  it('прямое попадание добивает: убийство, смерть, урон, убийца', () => {
    const match = openMatch(2);
    put(match, 0, 500, 600);
    put(match, 1, 800, 600, 1);
    const events = run(match, 30, new Map([[0, { ...IDLE_ACTION, isFiring: true }]]));
    const [death] = deaths(events);
    expect(death).toMatchObject({ tank: 1, cause: 'bullet', by: 0 });
    expect(playerOf(match, 0)).toMatchObject({ kills: 1, deaths: 0, damageDealt: 1 });
    expect(playerOf(match, 1)).toMatchObject({ kills: 0, deaths: 1, damageTaken: 1, killerId: 0, state: 'wreck' });
  });

  it('один снял почти всё, другой добил — убийство добившему, урон обоим по факту', () => {
    const match = openMatch(3);
    put(match, 0, 1700, 900);
    put(match, 1, 1000, 600, 40);
    put(match, 2, 300, 300);
    shoot(match, 2, 1000, 560, 0, BULLET_SPEED);
    run(match, 2);
    expect(tankOf(match, 1).hp).toBe(40 - DAMAGE);
    shoot(match, 0, 1000, 700, 0, -BULLET_SPEED);
    run(match, 10);
    expect(playerOf(match, 2)).toMatchObject({ kills: 0, damageDealt: DAMAGE });
    expect(playerOf(match, 0)).toMatchObject({ kills: 1, damageDealt: 40 - DAMAGE });
    expect(playerOf(match, 1)).toMatchObject({ deaths: 1, damageTaken: 40, killerId: 0 });
  });

  it('свой рикошет добивает — смерть без убийства, нанесённый урон не растёт', () => {
    const match = openMatch(2);
    put(match, 0, 500, 600, 1);
    put(match, 1, 1500, 600);
    shoot(match, 0, 500, 560, 0, BULLET_SPEED, true);
    const events = run(match, 3);
    expect(deaths(events)[0]).toMatchObject({ tank: 0, cause: 'self', by: 0 });
    expect(playerOf(match, 0)).toMatchObject({ kills: 0, deaths: 1, damageDealt: 0, damageTaken: 1, killerId: null });
    expect(playerOf(match, 1).kills).toBe(0);
  });

  it('смерть в зоне — без убийства; неуязвимого зона не ранит', () => {
    const match = openMatch(2);
    put(match, 0, 300, 300, 1);
    const shielded = put(match, 1, 1700, 900);
    shielded.shieldLeft = FFA.shieldSeconds;
    match.world.zonePlan = { startRadius: 50, finalRadius: 50, startShrink: 0, endShrink: 1 };
    const events = run(match, 5);
    expect(deaths(events)[0]).toMatchObject({ tank: 0, cause: 'zone', by: null });
    expect(playerOf(match, 0)).toMatchObject({ deaths: 1, killerId: null });
    expect(playerOf(match, 1).kills).toBe(0);
    expect(tankOf(match, 1).hp).toBe(tankOf(match, 1).stats.maxHp);
  });

  it('двое убивают друг друга в одном тике — у обоих убийство и смерть', () => {
    const match = openMatch(2);
    put(match, 0, 500, 600, 1);
    put(match, 1, 900, 600, 1);
    shoot(match, 0, 900, 560, 0, BULLET_SPEED);
    shoot(match, 1, 500, 560, 0, BULLET_SPEED);
    const events = run(match, 1);
    expect(deaths(events)).toHaveLength(2);
    expect(playerOf(match, 0)).toMatchObject({ kills: 1, deaths: 1 });
    expect(playerOf(match, 1)).toMatchObject({ kills: 1, deaths: 1 });
  });

  it('снаряд убитого добивает после его смерти — убийство засчитано', () => {
    const match = openMatch(3);
    put(match, 0, 500, 600, 1);
    put(match, 1, 1500, 600, 1);
    put(match, 2, 300, 1000);
    shoot(match, 2, 500, 560, 0, BULLET_SPEED);
    shoot(match, 0, 1300, 600, BULLET_SPEED, 0);
    run(match, 1);
    expect(playerOf(match, 0).state).toBe('wreck');
    run(match, 15);
    expect(playerOf(match, 0).kills).toBe(1);
    expect(playerOf(match, 1)).toMatchObject({ deaths: 1, killerId: 0 });
  });

  it('снаряд вышедшего добивает — смерть засчитана, убийство никому', () => {
    const match = openMatch(3);
    put(match, 0, 500, 600);
    put(match, 1, 900, 600, 1);
    put(match, 2, 300, 1000);
    shoot(match, 0, 800, 600, BULLET_SPEED, 0);
    leaveFfaMatch(match, 0);
    run(match, 10);
    expect(playerOf(match, 1).deaths).toBe(1);
    expect(match.players.every((player) => player.kills === 0)).toBe(true);
    expect(match.world.tanks.some((tank) => tank.id === 0)).toBe(false);
  });
});

describe('подбитый и возрождение', () => {
  it('2 с на поле препятствием, сквозь него летят снаряды; через 4 с после смерти — снова в бою с неуязвимостью', () => {
    const match = openMatch(2);
    put(match, 0, 500, 600);
    put(match, 1, 900, 600, 1);
    shoot(match, 0, 900, 560, 0, BULLET_SPEED);
    run(match, 1);
    expect(playerOf(match, 1).state).toBe('wreck');
    const wreck = tankOf(match, 1);
    expect(wreck.isAlive).toBe(false);

    shoot(match, 0, 900, 540, 0, BULLET_SPEED);
    const pushed = put(match, 0, 900 - TANK_RADIUS, 600);
    const passing = run(match, 5, new Map([[0, { ...IDLE_ACTION, throttle: 1 }]]));
    expect(passing.some((event) => event.type === 'hit' || event.type === 'shield')).toBe(false);
    expect(wreck.x).toBe(900);
    expect(wreck.y).toBe(600);
    expect(Math.hypot(pushed.x - wreck.x, pushed.y - wreck.y)).toBeGreaterThanOrEqual(TANK_RADIUS * 2 - 1e-9);

    run(match, WRECK_TICKS - 6);
    expect(match.world.tanks.some((tank) => tank.id === 1)).toBe(true);
    run(match, 1);
    expect(match.world.tanks.some((tank) => tank.id === 1)).toBe(false);
    expect(playerOf(match, 1).state).toBe('waiting');

    run(match, RESPAWN_TICKS - WRECK_TICKS - 1);
    expect(match.world.tanks.some((tank) => tank.id === 1)).toBe(false);
    const spawned = run(match, 1);
    expect(spawned.filter((event) => event.type === 'spawn')).toMatchObject([{ type: 'spawn', tank: 1 }]);
    const reborn = tankOf(match, 1);
    expect(reborn).toMatchObject({ isAlive: true, hp: reborn.stats.maxHp, shieldLeft: FFA.shieldSeconds });
    expect(playerOf(match, 1)).toMatchObject({ state: 'alive', deaths: 1 });
  });

  it('места для возрождения нет — ждёт; место освободилось — появляется на следующем тике', () => {
    const match = openMatch(2, testMap([{ x: 1000, y: 600, radius: 10 }]));
    expect(match.world.tanks.map((tank) => tank.id)).toEqual([0]);
    expect(playerOf(match, 1)).toMatchObject({ state: 'waiting', ticksLeft: 0 });
    run(match, 5);
    expect(playerOf(match, 1).state).toBe('waiting');
    put(match, 0, 300, 300);
    const events = run(match, 1);
    expect(events.filter((event) => event.type === 'spawn')).toMatchObject([{ type: 'spawn', tank: 1 }]);
    expect(playerOf(match, 1).state).toBe('alive');
  });

  it('неуязвимость: снаряд гибнет без урона, держится 3 с, свой выстрел снимает сразу', () => {
    const match = openMatch(2);
    const target = put(match, 1, 900, 600);
    target.shieldLeft = FFA.shieldSeconds;
    put(match, 0, 300, 300);
    shoot(match, 0, 900, 560, 0, BULLET_SPEED);
    const events = run(match, 1);
    expect(events.filter((event) => event.type === 'shield')).toMatchObject([{ type: 'shield', tank: 1, owner: 0 }]);
    expect(target.hp).toBe(target.stats.maxHp);
    expect(match.world.bullets).toHaveLength(0);

    run(match, FFA.shieldSeconds * TICK_RATE - 3);
    expect(target.shieldLeft).toBeGreaterThan(0);
    run(match, 3);
    expect(target.shieldLeft).toBe(0);

    const shooter = tankOf(match, 0);
    shooter.shieldLeft = FFA.shieldSeconds;
    run(match, 1, new Map([[0, { ...IDLE_ACTION, isFiring: true }]]));
    expect(shooter.shieldLeft).toBe(0);
  });
});

describe('финал и конец', () => {
  it.each(FFA_SIZES.map((size) => [size] as const))(
    'карта %i: финал — когда снаружи половина точек; радиус 120 × √N',
    (size) => {
      const map = ffaMap(size);
      const match = createFfaMatch(map, setups(size), 7, DEFAULT_RULES);
      const plan = match.world.zonePlan;
      expect(plan.finalRadius).toBeCloseTo(FFA.finalRadiusPerRootPlayer * Math.sqrt(size), 9);
      const needed = Math.ceil(map.spawnAreas.length * FFA.suddenDeathShare);
      const outsideAt = (time: number): number =>
        map.spawnAreas.filter(
          (area) => Math.hypot(area.x - map.width / 2, area.y - map.height / 2) > zoneRadiusAt(plan, time),
        ).length;
      expect(match.suddenDeathAt).toBeGreaterThan(plan.startShrink);
      expect(match.suddenDeathAt).toBeLessThan(plan.endShrink);
      expect(plan.startShrink).toBe(45);
      expect(plan.endShrink).toBe(105);
      expect(outsideAt(match.suddenDeathAt + 1e-6)).toBeGreaterThanOrEqual(needed);
      expect(outsideAt(match.suddenDeathAt - 0.01)).toBeLessThan(needed);
    },
  );

  it('внезапная смерть: событие, ждущие и подбитые становятся зрителями, возрождений нет', () => {
    const match = openMatch(4);
    match.suddenDeathAt = 3;
    put(match, 0, 300, 300);
    put(match, 1, 1700, 300, 1);
    put(match, 2, 300, 900, 1);
    put(match, 3, 1700, 900);
    shoot(match, 0, 1700, 260, 0, BULLET_SPEED);
    run(match, 1);
    const toSuddenDeath = run(match, 3 * TICK_RATE - 1);
    expect(toSuddenDeath.filter((event) => event.type === 'suddenDeath')).toHaveLength(1);
    expect(match.isSuddenDeath).toBe(true);
    expect(playerOf(match, 1)).toMatchObject({ state: 'spectator', ticksLeft: 0 });

    shoot(match, 3, 300, 860, 0, BULLET_SPEED);
    run(match, 1);
    expect(playerOf(match, 2).state).toBe('wreck');
    const later = run(match, WRECK_TICKS + RESPAWN_TICKS);
    expect(playerOf(match, 2)).toMatchObject({ state: 'spectator', ticksLeft: 0 });
    expect(later.some((event) => event.type === 'spawn' || event.type === 'suddenDeath')).toBe(false);
    expect(match.isOver).toBe(false);
  });

  it('конец по времени — ровно на 120 с; после конца шаги ничего не меняют', () => {
    const center: SpawnArea[] = [
      { x: 900, y: 600, radius: 40 },
      { x: 1100, y: 600, radius: 40 },
    ];
    const match = openMatch(4, testMap(center));
    const events = run(match, FFA.matchSeconds * TICK_RATE + 30);
    expect(events.filter((event) => event.type === 'matchOver')).toHaveLength(1);
    expect(match.isOver).toBe(true);
    expect(match.world.tick).toBe(FFA.matchSeconds * TICK_RATE);
    expect(match.world.tanks.every((tank) => tank.isAlive)).toBe(true);
  });

  it('длительность — настройка: матч на 60 с кончается на 60 с, зона сжимается в тех же долях', () => {
    const center: SpawnArea[] = [{ x: 1000, y: 600, radius: 60 }];
    const match = createFfaMatch(testMap(center), setups(2), 1, DEFAULT_RULES, 60);
    expect(match.world.zonePlan).toMatchObject({ startShrink: 22.5, endShrink: 52.5 });
    run(match, 60 * TICK_RATE + 10);
    expect(match.isOver).toBe(true);
    expect(match.world.tick).toBe(60 * TICK_RATE);
  });

  it('в финале остался один живой — конец до 120 с', () => {
    const match = openMatch(3);
    match.suddenDeathAt = 1;
    put(match, 0, 300, 300);
    put(match, 1, 1700, 300, 1);
    put(match, 2, 300, 900, 1);
    run(match, TICK_RATE + 5);
    expect(match.isOver).toBe(false);
    shoot(match, 0, 1700, 260, 0, BULLET_SPEED);
    shoot(match, 0, 300, 860, 0, BULLET_SPEED);
    const events = run(match, 1);
    expect(events.filter((event) => event.type === 'matchOver')).toHaveLength(1);
    expect(match.isOver).toBe(true);
    expect(match.world.time).toBeLessThan(FFA.matchSeconds);
  });
});

describe('вход и выход посреди матча', () => {
  it('до финала — на поле на ближайшем тике с неуязвимостью; в финале — зритель; повторный номер — ошибка', () => {
    const match = openMatch(2);
    run(match, 10);
    joinFfaMatch(match, { id: 10, name: 'Новичок', stats: DEFAULT_STATS });
    expect(playerOf(match, 10).state).toBe('waiting');
    const events = run(match, 1);
    expect(events.some((event) => event.type === 'spawn' && event.tank === 10)).toBe(true);
    expect(tankOf(match, 10).shieldLeft).toBe(FFA.shieldSeconds);

    match.suddenDeathAt = 0;
    run(match, 1);
    joinFfaMatch(match, { id: 11, name: 'Опоздавший', stats: DEFAULT_STATS });
    run(match, 5);
    expect(playerOf(match, 11).state).toBe('spectator');
    expect(match.world.tanks.some((tank) => tank.id === 11)).toBe(false);
    expect(() => {
      joinFfaMatch(match, { id: 10, name: 'Двойник', stats: DEFAULT_STATS });
    }).toThrow();
  });

  it('вышедший убран с поля и из игроков', () => {
    const match = openMatch(3);
    leaveFfaMatch(match, 1);
    expect(match.players.map((player) => player.id)).toEqual([0, 2]);
    expect(match.world.tanks.map((tank) => tank.id)).toEqual([0, 2]);
  });
});

describe('поле боя толпы', () => {
  it('танки, сбившиеся в кучу, расталкиваются и не перекрываются', () => {
    const match = openMatch(20, testMap([{ x: 1000, y: 600, radius: 400 }]));
    const random = createRandom(9);
    for (const tank of match.world.tanks) {
      put(match, tank.id, 1000 + nextRandom(random) * 60, 600 + nextRandom(random) * 60);
    }
    run(match, 30);
    for (const [i, a] of match.world.tanks.entries()) {
      for (const b of match.world.tanks.slice(i + 1)) {
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(TANK_RADIUS * 2 - 1);
      }
    }
  });

  it('большое поле: танк упирается в правый и нижний край, снаряд отскакивает от края, трассировка видит тот же край', () => {
    const map = ffaMap(50);
    const match = createFfaMatch(map, setups(2), 3, DEFAULT_RULES);
    const tank = put(match, 0, map.width - 40, map.height - 40);
    tank.heading = Math.PI / 4;
    run(match, 30, new Map([[0, { ...IDLE_ACTION, throttle: 1 }]]));
    expect(tank.x).toBe(map.width - TANK_RADIUS);
    expect(tank.y).toBe(map.height - TANK_RADIUS);

    put(match, 1, 300, 300);
    put(match, 0, map.width / 2, 40);
    shoot(match, 1, map.width - 30, 30, BULLET_SPEED, 0);
    const events = run(match, 2);
    const ricochet = events.find((event) => event.type === 'ricochet');
    expect(ricochet).toMatchObject({ x: map.width - BULLET_RADIUS, nx: -1 });

    const trace = traceShot(map, { x: map.width - 60, y: 30 }, 0, BULLET_SPEED);
    expect(trace.segments[0]?.x2).toBe(map.width - BULLET_RADIUS);
    expect(BULLET_SPEED * BULLET_LIFETIME).toBeGreaterThan(60);
  });
});

describe('таблица и эффективность', () => {
  function player(id: number, kills: number, deaths: number, damageDealt = 0, damageTaken = 0): FfaPlayer {
    return {
      id,
      name: String(id),
      stats: DEFAULT_STATS,
      state: 'alive',
      ticksLeft: 0,
      kills,
      deaths,
      damageDealt,
      damageTaken,
      killerId: null,
    };
  }

  it('по убийствам, при равенстве — по меньшему числу смертей, затем по номеру', () => {
    const order = ffaStandings([player(5, 2, 3), player(1, 4, 9), player(3, 2, 1), player(2, 2, 3)]);
    expect(order.map((entry) => entry.id)).toEqual([1, 3, 2, 5]);
  });

  it('строки счёта из протокола упорядочиваются так же, как игроки матча', () => {
    const players = [player(5, 2, 3), player(1, 4, 9), player(3, 2, 1), player(2, 2, 3)];
    const rows = players.map(({ id, kills, deaths, damageDealt, damageTaken }) => ({
      id,
      kills,
      deaths,
      damageDealt,
      damageTaken,
    }));
    expect(ffaStandings(rows).map((row) => row.id)).toEqual(ffaStandings(players).map((entry) => entry.id));
  });

  it('эффективность по формуле; без полученного урона — нет', () => {
    const weight = FFA.efficiencyTankWeight;
    expect(ffaEfficiency(player(1, 3, 1, 400, 250))).toBeCloseTo((400 + weight * 3) / (250 + weight), 12);
    expect(ffaEfficiency(player(2, 0, 0, 100, 0))).toBeNull();
    expect(ffaEfficiency(player(3, 0, 0, 0, 20))).toBe(0);
  });
});

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function digestMatch(match: FfaMatch): string {
  const tanks = match.world.tanks.map((t) => [t.id, t.x, t.y, t.heading, t.turret, t.hp, t.isAlive, t.shieldLeft]);
  const players = match.players.map((p) => [p.id, p.state, p.ticksLeft, p.kills, p.deaths, p.damageDealt]);
  const bullets = match.world.bullets.map((b) => [b.id, b.owner, b.x, b.y]);
  return fnv1a(JSON.stringify([match.world.tick, tanks, players, bullets, match.isSuddenDeath, match.isOver]));
}

// Случайные команды всех игроков: каждые 10 тиков новая; вход и выход на заданных тиках.
function playMatch(size: 30 | 50, matchSeed: number, actionSeed: number, maxTicks = Infinity): string[] {
  const match = createFfaMatch(ffaMap(size), setups(size), matchSeed, DEFAULT_RULES);
  const random = createRandom(actionSeed);
  const actions = new Map<number, Action>();
  const digests: string[] = [];
  for (let tick = 0; !match.isOver && tick < maxTicks; tick++) {
    if (tick === 300) {
      leaveFfaMatch(match, 3);
    }
    if (tick === 400) {
      joinFfaMatch(match, { id: 1000, name: 'Новичок', stats: DEFAULT_STATS });
    }
    if (tick % 10 === 0) {
      for (const player of match.players) {
        actions.set(player.id, {
          throttle: nextRandom(random) * 2 - 1,
          turn: nextRandom(random) * 2 - 1,
          turretTurn: nextRandom(random) * 2 - 1,
          isFiring: nextRandom(random) < 0.5,
        });
      }
    }
    stepFfaMatch(match, actions);
    digests.push(digestMatch(match));
  }
  return digests;
}

// Полный матч на 50 танков под подсчётом покрытия идёт десятки секунд.
const FULL_MATCH_TIMEOUT_MS = 120_000;

describe('детерминизм матча', () => {
  it.each([30, 50] as const)(
    'матч на %i: два прогона с одним сидом совпадают на каждом тике, другой сид — расходится',
    (size) => {
      const first = playMatch(size, 11, 5);
      const second = playMatch(size, 11, 5);
      expect(second).toEqual(first);
      expect(first.length).toBeGreaterThan(TICK_RATE * 10);
      expect(playMatch(size, 12, 5, TICK_RATE)).not.toEqual(first.slice(0, TICK_RATE));
    },
    FULL_MATCH_TIMEOUT_MS,
  );
});
