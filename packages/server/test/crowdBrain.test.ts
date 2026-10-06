import { describe, expect, it } from 'vitest';
import {
  createWorld,
  DEFAULT_RULES,
  deriveStats,
  FFA,
  ffaViewReach,
  IDLE_ACTION,
  makeTank,
  stepWorld,
  type Action,
  type BattleMap,
  type FfaMap,
  type Tank,
  type ZonePlan,
} from '@tanks/shared/engine';
import {
  FfaInviteMiss,
  FfaPhase,
  MessageType,
  type FfaSnapshotEvent,
  type FfaSnapshotMessage,
  type FfaTankSnapshot,
  type ServerMessage,
} from '@tanks/shared/protocol';
import { CrowdBot } from '../src/crowd/bot.js';
import { CrowdBrain, PathQuota, type PathAllowance } from '../src/crowd/brain.js';
import {
  CROWD_PROFILES,
  crowdNickname,
  crowdPyramid,
  type CrowdLevel,
  type CrowdProfile,
} from '../src/crowd/profile.js';
import { chooseTarget, TargetBook, Targeting } from '../src/crowd/targets.js';
import { crowdView, type CrowdBullet, type CrowdTank, type CrowdView, type Frame } from '../src/crowd/view.js';
import { seededRandom } from './support.js';

const OPEN: BattleMap = { name: 'Открытое поле', width: 1600, height: 900, walls: [], kits: [] };
const WIDE: BattleMap = { name: 'Широкое поле', width: 5200, height: 2900, walls: [], kits: [] };
const STILL_ZONE: ZonePlan = { startRadius: 1e6, finalRadius: 1e6, startShrink: 0, endShrink: 1 };
const WIDE_ZONE = { x: 800, y: 450, radius: 5000 };
const ME = 1;

function crowdTank(id: number, x: number, y: number, overrides: Partial<CrowdTank> = {}): CrowdTank {
  const stats = deriveStats(CROWD_PROFILES[7].stats);
  const tank: CrowdTank = {
    id,
    x,
    y,
    heading: 0,
    turret: 0,
    speed: 0,
    vx: 0,
    vy: 0,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    reloadLeft: 0,
    shieldLeft: 0,
    isAlive: true,
    stats,
    ...overrides,
  };
  return { ...tank, vx: Math.cos(tank.heading) * tank.speed, vy: Math.sin(tank.heading) * tank.speed };
}

function bullet(
  id: number,
  owner: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  hasBounced = false,
): CrowdBullet {
  return { id, owner, x, y, vx, vy, hasBounced };
}

function viewOf(me: CrowdTank, overrides: Partial<CrowdView> = {}): CrowdView {
  return { tick: 0, map: OPEN, me, enemies: [], bullets: [], kits: [], zone: WIDE_ZONE, attackers: [], ...overrides };
}

function brainOf(profile: CrowdProfile, seed = 1): CrowdBrain {
  const brain = new CrowdBrain(profile, seededRandom(seed), 0);
  brain.init();
  return brain;
}

function profileOf(level: CrowdLevel, overrides: Partial<CrowdProfile> = {}): CrowdProfile {
  return { ...CROWD_PROFILES[level], ...overrides };
}

function ticks(brain: CrowdBrain, view: CrowdView, target: CrowdTank | null, count: number): Action[] {
  return Array.from({ length: count }, (_, index) => brain.tick({ ...view, tick: view.tick + index }, target));
}

function fromTank(tank: Tank): CrowdTank {
  return crowdTank(tank.id, tank.x, tank.y, {
    heading: tank.heading,
    turret: tank.turret,
    speed: tank.speed,
    hp: tank.hp,
    reloadLeft: tank.reloadLeft,
    stats: tank.stats,
    maxHp: tank.stats.maxHp,
  });
}

// Танк смотрит на север (вверх). A летит с запада прямо в центр, B — параллельно севернее: уход вперёд
// уводит под B, назад — мимо обоих.
const FACING_NORTH = -Math.PI / 2;
const FROM_WEST = bullet(101, 2, 300, 450, 500, 0);
const NORTH_OF_ME = bullet(102, 2, 300, 350, 500, 0);
const DODGER = profileOf(7, { dodgeChance: 1 });

function survivesCrossfire(drive: (world: ReturnType<typeof createWorld>, brain: CrowdBrain) => Action): number {
  const stats = CROWD_PROFILES[7].stats;
  const world = createWorld(
    OPEN,
    [
      makeTank({ name: 'Бот', stats }, ME, { x: 600, y: 450, heading: FACING_NORTH }),
      makeTank({ name: 'Стрелок', stats }, 2, { x: 1500, y: 850, heading: 0 }),
    ],
    DEFAULT_RULES,
    STILL_ZONE,
  );
  for (const shot of [FROM_WEST, NORTH_OF_ME]) {
    world.bullets.push({ ...shot, damage: 30, bouncesLeft: 1, age: 0, isDead: false });
  }
  const brain = brainOf(DODGER);
  for (let tick = 0; tick < 40; tick++) {
    stepWorld(world, [drive(world, brain), IDLE_ACTION]);
  }
  const me = world.tanks[0];
  return me === undefined ? 0 : me.stats.maxHp - me.hp;
}

describe('мозг толпы на крафтовых видах', () => {
  it('уклонение учитывает все замеченные снаряды: от одного уходит вперёд, от двух — назад, мимо обоих', () => {
    const me = crowdTank(ME, 600, 450, { heading: FACING_NORTH });
    const fromOne = brainOf(DODGER).tick(viewOf(me, { bullets: [FROM_WEST] }), null);
    const fromTwo = brainOf(DODGER).tick(viewOf(me, { bullets: [FROM_WEST, NORTH_OF_ME] }), null);
    expect(fromOne.throttle).toBeGreaterThan(0.5);
    expect(fromTwo.throttle).toBeLessThan(-0.5);
  });

  it('уход кормой вперёд, пока корма не довернулась к направлению ухода, — ползком назад с доворотом', () => {
    const me = crowdTank(ME, 800, 450, { heading: (-20 * Math.PI) / 180 });
    const fromBelow = bullet(103, 2, 900, 700, 0, -500);
    const fromRight = bullet(104, 2, 1050, 500, -500, 0);
    const action = brainOf(DODGER).tick(viewOf(me, { bullets: [fromBelow, fromRight] }), null);
    expect(action.throttle).toBeLessThan(0);
    expect(action.throttle).toBeGreaterThan(-0.5);
    expect(action.turn).toBe(1);
  });

  it('под перекрёстным огнём на настоящем движке бот уходит без попаданий; стоящий — получает урон', () => {
    const dodged = survivesCrossfire((world, brain) => {
      const tank = world.tanks[0];
      if (tank === undefined) {
        return IDLE_ACTION;
      }
      const bullets = world.bullets.map((shot) => bullet(shot.id, shot.owner, shot.x, shot.y, shot.vx, shot.vy));
      return brain.tick(viewOf(fromTank(tank), { tick: world.tick, bullets }), null);
    });
    const stood = survivesCrossfire(() => IDLE_ACTION);
    expect(dodged).toBe(0);
    expect(stood).toBeGreaterThan(0);
  });

  it('задним ходом к точке сзади-сбоку корма поворачивает к точке, а не от неё', () => {
    const me = crowdTank(ME, 800, 450, { heading: 0 });
    const behindBelow = crowdTank(2, 800 - 346, 650);
    const behindAbove = crowdTank(2, 800 - 346, 250);
    const toBelow = brainOf(profileOf(4)).tick(viewOf(me), behindBelow);
    const toAbove = brainOf(profileOf(4)).tick(viewOf(me), behindAbove);
    expect(toBelow).toMatchObject({ throttle: -1, turn: -1 });
    expect(toAbove).toMatchObject({ throttle: -1, turn: 1 });
  });

  it('снаряд, не замеченный по монетке, на движение не влияет; решение по снаряду не меняется от тика к тику', () => {
    const me = crowdTank(ME, 600, 450, { heading: FACING_NORTH });
    const calm = ticks(brainOf(profileOf(7, { dodgeChance: 0 })), viewOf(me), null, 5);
    const blind = ticks(brainOf(profileOf(7, { dodgeChance: 0 })), viewOf(me, { bullets: [FROM_WEST] }), null, 5);
    expect(blind).toEqual(calm);
    for (let seed = 1; seed <= 12; seed++) {
      const actions = ticks(
        brainOf(profileOf(7, { dodgeChance: 0.5 }), seed),
        viewOf(me, { bullets: [FROM_WEST] }),
        null,
        8,
      );
      const isDodging = actions.map((action) => action.throttle > 0.5);
      expect(new Set(isDodging).size).toBe(1);
    }
  });

  it('свой снаряд до отскока не опасен; после отскока небеспечный уходит, беспечный — нет', () => {
    const me = crowdTank(ME, 600, 450, { heading: FACING_NORTH });
    const own = bullet(103, ME, 300, 450, 500, 0);
    const returning = { ...own, hasBounced: true };
    const careful = profileOf(4, { pauseEverySec: null });
    const calm = brainOf(careful).tick(viewOf(me), null);
    expect(brainOf(careful).tick(viewOf(me, { bullets: [own] }), null)).toEqual(calm);
    expect(brainOf(careful).tick(viewOf(me, { bullets: [returning] }), null)).not.toEqual(calm);
    const careless = profileOf(4, { carelessness: 1 });
    const carelessCalm = brainOf(careless).tick(viewOf(me), null);
    expect(brainOf(careless).tick(viewOf(me, { bullets: [returning] }), null)).toEqual(carelessCalm);
  });

  it('уклонение не выбирает направление в стену: кандидаты в стене пропускаются', () => {
    const walled: BattleMap = { ...OPEN, walls: [{ x: 560, y: 470, w: 80, h: 200 }] };
    const me = crowdTank(ME, 600, 450, { heading: FACING_NORTH });
    const action = brainOf(DODGER).tick(viewOf(me, { map: walled, bullets: [FROM_WEST, NORTH_OF_ME] }), null);
    expect(action.throttle).not.toBeLessThan(-0.5);
  });

  it('застрял: газ держится секунду без движения — полсекунды задним ходом с поворотом, стороны чередуются', () => {
    const me = crowdTank(ME, 400, 450, { heading: 0 });
    const enemy = crowdTank(2, 1200, 450);
    const brain = brainOf(profileOf(4));
    const actions = ticks(brain, viewOf(me, { enemies: [enemy] }), enemy, 120);
    const firstBack = actions.findIndex((action) => action.throttle < 0);
    expect(firstBack).toBeGreaterThanOrEqual(29);
    expect(firstBack).toBeLessThanOrEqual(31);
    const unstick = actions.slice(firstBack, firstBack + 15);
    expect(new Set(unstick.map((action) => `${String(action.throttle)}/${String(action.turn)}`)).size).toBe(1);
    expect(Math.abs(unstick[0]?.turn ?? 0)).toBe(1);
    const secondBack = actions.findIndex((action, index) => index > firstBack + 15 && action.throttle < 0);
    expect(secondBack).toBeGreaterThan(firstBack + 15);
    expect(actions[secondBack]?.turn).toBe(-(unstick[0]?.turn ?? 0));
  });

  it('пятится и упёрся — выезд вперёд', () => {
    const me = crowdTank(ME, 400, 450, { heading: Math.PI });
    const enemy = crowdTank(2, 1200, 450);
    const actions = ticks(brainOf(profileOf(4)), viewOf(me, { enemies: [enemy] }), enemy, 40);
    expect(actions[0]?.throttle).toBeLessThan(0);
    expect(actions.some((action) => action.throttle === 1 && Math.abs(action.turn) === 1)).toBe(true);
  });

  it('без цели внутри зоны едет патрулём и не стреляет, башня — по ходу', () => {
    const me = crowdTank(ME, 800, 450, { heading: 0, turret: 1 });
    const actions = ticks(brainOf(profileOf(5)), viewOf(me), null, 60);
    expect(actions.every((action) => !action.isFiring)).toBe(true);
    expect(actions[0]?.turretTurn).toBeLessThan(0);
    expect(actions.some((action) => Math.abs(action.throttle) > 0.1)).toBe(true);
  });

  it('патруль без свободных точек в зоне едет к её центру', () => {
    const me = crowdTank(ME, 780, 450, { heading: 0 });
    const action = brainOf(profileOf(5)).tick(viewOf(me, { zone: { x: 800, y: 450, radius: 105 } }), null);
    expect(action.throttle).toBe(1);
  });

  it('за краем зоны едет к центру — с целью и без', () => {
    const me = crowdTank(ME, 100, 450, { heading: 0 });
    const zone = { x: 800, y: 450, radius: 300 };
    const enemy = crowdTank(2, 100, 100);
    for (const target of [null, enemy]) {
      const action = brainOf(profileOf(5)).tick(viewOf(me, { zone, enemies: [enemy] }), target);
      expect(action.throttle).toBeGreaterThan(0.5);
      expect(Math.abs(action.turn)).toBeLessThan(0.2);
    }
  });

  it('ранен при активной аптечке: уровень с аптечками едет к ней, без аптечек — нет', () => {
    const me = crowdTank(ME, 800, 450, { heading: 0, hp: 40 });
    const kits = [{ x: 800, y: 100, isActive: true, respawnIn: 0 }];
    const enemy = crowdTank(2, 1300, 450);
    const withKits = brainOf(profileOf(4)).tick(viewOf(me, { kits, enemies: [enemy] }), enemy);
    const withoutKits = brainOf(profileOf(3)).tick(viewOf(me, { kits, enemies: [enemy] }), enemy);
    expect(withKits.turn).toBeLessThan(-0.5);
    expect(Math.abs(withoutKits.turn)).toBeLessThan(0.2);
  });

  it('сближение: вплотную отъезжает, на дистанции смещается поперёк, издалека едет к цели', () => {
    const me = crowdTank(ME, 800, 450, { heading: 0 });
    const approach = profileOf(4);
    const close = brainOf(approach).tick(viewOf(me), crowdTank(2, 1000, 450));
    const holding = brainOf(approach).tick(viewOf(me), crowdTank(2, 1120, 450));
    const far = brainOf(approach).tick(viewOf(me), crowdTank(2, 1300, 450));
    expect(close.throttle).toBeLessThan(0);
    expect(Math.abs(holding.turn)).toBeGreaterThan(0.5);
    expect(far.throttle).toBe(1);
    expect(Math.abs(far.turn)).toBeLessThan(0.1);
  });

  it('круг: в перестрелке ходит вокруг цели, вплотную — по большему радиусу', () => {
    const me = crowdTank(ME, 800, 450, { heading: 0 });
    const circling = brainOf(profileOf(5)).tick(viewOf(me), crowdTank(2, 1100, 450));
    const near = brainOf(profileOf(5)).tick(viewOf(me), crowdTank(2, 1000, 450));
    expect(Math.abs(circling.turn)).toBeGreaterThan(0.5);
    expect(Math.abs(near.turn)).toBeGreaterThan(0.5);
  });

  it('цель за стеной — путь в обход, а не прямо', () => {
    const walled: BattleMap = { ...OPEN, walls: [{ x: 900, y: 250, w: 40, h: 400 }] };
    const me = crowdTank(ME, 700, 450, { heading: 0 });
    const action = brainOf(profileOf(5)).tick(viewOf(me, { map: walled }), crowdTank(2, 1100, 450));
    expect(Math.abs(action.turn)).toBeGreaterThan(0.3);
  });

  it('первый путь — только на своём тике по фазе: десять ботов на одном тике ищут путь по одному', () => {
    const walled: BattleMap = { ...OPEN, walls: [{ x: 900, y: 250, w: 40, h: 400 }] };
    const me = crowdTank(ME, 700, 450, { heading: 0 });
    const target = crowdTank(2, 1100, 450);
    const isDetouring = (phase: number, tick: number): boolean => {
      const brain = new CrowdBrain(profileOf(5), seededRandom(1), phase);
      brain.init();
      return Math.abs(brain.tick(viewOf(me, { map: walled, tick }), target).turn) > 0.3;
    };
    const phases = Array.from({ length: 10 }, (_, phase) => phase);
    expect(phases.filter((phase) => isDetouring(phase, 1))).toEqual([9]);
    expect(phases.filter((phase) => isDetouring(phase, 4))).toEqual([6]);
  });

  describe('поиск пути при ходе не на каждом тике', () => {
    const walled: BattleMap = { ...OPEN, walls: [{ x: 900, y: 250, w: 40, h: 400 }] };
    const me = crowdTank(ME, 700, 450, { heading: 0 });
    const target = crowdTank(2, 1100, 450);
    const isDetour = (action: Action): boolean => Math.abs(action.turn) > 0.3;
    const denied: PathAllowance = { take: () => false };

    it('тик расписания между ходами засчитывается: ходил на 5 и 12 — ищет путь на 12; на 11 и 12 — нет', () => {
      const skipped = brainOf(profileOf(5));
      skipped.tick(viewOf(me, { map: walled, tick: 5 }), target);
      const steady = brainOf(profileOf(5));
      steady.tick(viewOf(me, { map: walled, tick: 11 }), target);
      expect(isDetour(skipped.tick(viewOf(me, { map: walled, tick: 12 }), target))).toBe(true);
      expect(isDetour(steady.tick(viewOf(me, { map: walled, tick: 12 }), target))).toBe(false);
    });

    it('без разрешения едет прямо к цели пути; на следующем ходу с разрешением — в обход, хотя тик не расписания', () => {
      const brain = brainOf(profileOf(5));
      expect(isDetour(brain.tick(viewOf(me, { map: walled, tick: 10 }), target, denied))).toBe(false);
      expect(isDetour(brain.tick(viewOf(me, { map: walled, tick: 11 }), target))).toBe(true);
    });

    it('разрешение прохода: из десяти ботов, которым пора, путь ищут двое; бюджет прохода вышел — один', () => {
      const detoursWith = (quota: PathQuota): number =>
        Array.from({ length: 10 }, () =>
          brainOf(profileOf(5)).tick(viewOf(me, { map: walled, tick: 10 }), target, quota),
        ).filter(isDetour).length;
      expect(detoursWith(new PathQuota(() => false))).toBe(2);
      expect(detoursWith(new PathQuota(() => true))).toBe(1);
    });
  });

  it('цель внутри сплошной стены недостижима: пути нет, едет прямо на цель', () => {
    const block: BattleMap = { ...OPEN, walls: [{ x: 900, y: 100, w: 600, h: 700 }] };
    const me = crowdTank(ME, 400, 450, { heading: 0 });
    const action = brainOf(profileOf(4)).tick(viewOf(me, { map: block }), crowdTank(2, 1200, 450));
    expect(action.throttle).toBe(1);
    expect(Math.abs(action.turn)).toBeLessThan(0.1);
  });

  it('патруль замирает по расписанию', () => {
    const me = crowdTank(ME, 800, 450, { heading: 0 });
    const actions = ticks(brainOf(profileOf(1)), viewOf(me), null, 4 * 30 + 20);
    expect(actions.some((action) => action.throttle === 0 && action.turn === 0)).toBe(true);
  });

  it('возврат рикошета на поле 5200 × 2900: стена за целью отражает снаряд в стрелка — выстрела нет', () => {
    const sharp = profileOf(1, { fireChance: 1, aimNoiseRad: 0, carelessness: 0 });
    const me = crowdTank(ME, 4000, 1450, { turret: 0 });
    const target = crowdTank(2, 4300, 1530);
    const zone = { x: 2600, y: 1450, radius: 10_000 };
    const backWall: BattleMap = { ...WIDE, walls: [{ x: 4600, y: 1300, w: 40, h: 300 }] };
    const open = brainOf(sharp).tick(viewOf(me, { map: WIDE, zone, enemies: [target] }), target);
    const returning = brainOf(sharp).tick(viewOf(me, { map: backWall, zone, enemies: [target] }), target);
    expect(open.isFiring).toBe(true);
    expect(returning.isFiring).toBe(false);
  });

  it('стена между дулом и целью — выстрела нет; перезарядка — выстрела нет', () => {
    const sharp = profileOf(5, { aimNoiseRad: 0, leadChance: 0 });
    const me = crowdTank(ME, 700, 450, { turret: 0 });
    const target = crowdTank(2, 1100, 450);
    const blocked: BattleMap = { ...OPEN, walls: [{ x: 880, y: 350, w: 40, h: 200 }] };
    expect(brainOf(sharp).tick(viewOf(me, { map: blocked }), target).isFiring).toBe(false);
    expect(brainOf(sharp).tick(viewOf({ ...me, reloadLeft: 0.5 }), target).isFiring).toBe(false);
    expect(brainOf(sharp).tick(viewOf(me), target).isFiring).toBe(true);
  });

  it('вероятность выстрела: неудача — пауза перед новой попыткой; упреждение целится по ходу цели', () => {
    const shy = profileOf(5, { aimNoiseRad: 0, leadChance: 0, fireChance: 0 });
    const me = crowdTank(ME, 700, 450, { turret: 0 });
    const target = crowdTank(2, 1100, 450);
    expect(ticks(brainOf(shy), viewOf(me), target, 20).every((action) => !action.isFiring)).toBe(true);
    const moving = crowdTank(2, 1100, 450, { heading: Math.PI / 2, speed: 150 });
    const leading = brainOf(profileOf(5, { aimNoiseRad: 0, leadChance: 1, leadQuality: 1 }));
    const plain = brainOf(profileOf(5, { aimNoiseRad: 0, leadChance: 0 }));
    expect(leading.tick(viewOf(me), moving).turretTurn).toBeGreaterThan(plain.tick(viewOf(me), moving).turretTurn);
  });

  describe('таймеры в тиках: при решении раз в 3 тика держатся столько же тиков, сколько при решении каждый тик', () => {
    const SPARSE_STEP = 3;

    // Между решениями — прошлая команда, как у серверного бота, пропустившего ход.
    function decideEvery(step: number, count: number, decide: (tick: number) => Action): Action[] {
      const actions: Action[] = [];
      let last = IDLE_ACTION;
      for (let tick = 0; tick < count; tick++) {
        if (tick % step === 0) {
          last = decide(tick);
        }
        actions.push(last);
      }
      return actions;
    }

    // Отрезки подряд идущих тиков с условием: тик начала и длина.
    function runsOf(
      actions: readonly Action[],
      isOn: (action: Action) => boolean,
    ): { start: number; length: number }[] {
      const runs: { start: number; length: number }[] = [];
      actions.forEach((action, tick) => {
        const last = runs.at(-1);
        if (!isOn(action)) {
          return;
        }
        if (last !== undefined && last.start + last.length === tick) {
          last.length++;
          return;
        }
        runs.push({ start: tick, length: 1 });
      });
      return runs;
    }

    function expectSameTiming(play: (step: number) => { start: number; length: number }[]): void {
      const everyTick = play(1);
      const sparse = play(SPARSE_STEP);
      expect(everyTick.length).toBeGreaterThan(0);
      expect(sparse).toHaveLength(everyTick.length);
      everyTick.forEach((run, index) => {
        expect(Math.abs((sparse[index]?.start ?? Infinity) - run.start)).toBeLessThanOrEqual(SPARSE_STEP);
        expect(Math.abs((sparse[index]?.length ?? Infinity) - run.length)).toBeLessThanOrEqual(SPARSE_STEP);
      });
    }

    it('пауза патруля', () => {
      const me = crowdTank(ME, 800, 450);
      expectSameTiming((step) => {
        const brain = brainOf(profileOf(1, { pauseEverySec: 2 }));
        const actions = decideEvery(step, 200, (tick) => brain.tick(viewOf(me, { tick }), null));
        return runsOf(actions, (action) => action.throttle === 0 && action.turn === 0);
      });
    });

    it('застревание в танке: секунда газа без движения, затем задний ход', () => {
      const me = crowdTank(ME, 400, 450);
      const enemy = crowdTank(2, 1200, 450);
      expectSameTiming((step) => {
        const brain = brainOf(profileOf(4));
        const actions = decideEvery(step, 100, (tick) => brain.tick(viewOf(me, { tick, enemies: [enemy] }), enemy));
        return runsOf(actions, (action) => action.throttle < 0);
      });
    });

    it('уклонение: уход держится, хотя снаряд уже летит прочь', () => {
      const me = crowdTank(ME, 600, 450, { heading: FACING_NORTH });
      const enemy = crowdTank(2, 1300, 450);
      const away = { ...FROM_WEST, vx: -FROM_WEST.vx };
      expectSameTiming((step) => {
        const brain = brainOf(DODGER);
        const actions = decideEvery(step, 30, (tick) =>
          brain.tick(viewOf(me, { tick, bullets: [tick === 0 ? FROM_WEST : away], enemies: [enemy] }), enemy),
        );
        const dodge = actions[0];
        return runsOf(actions, (action) => action.throttle === dodge?.throttle && action.turn === dodge.turn);
      });
    });
  });

  it('монетка упреждения бросается заново на каждый выстрел: за много перезарядок выпадают оба исхода', () => {
    const brain = brainOf(profileOf(6, { aimNoiseRad: 0, leadChance: 0.5, leadQuality: 1 }));
    const me = crowdTank(ME, 700, 450);
    const moving = crowdTank(2, 1100, 450, { heading: Math.PI / 2, speed: 150 });
    const aims = new Set<number>();
    for (let shot = 0; shot < 24; shot++) {
      brain.tick(viewOf({ ...me, reloadLeft: 0.5 }), moving);
      aims.add(brain.tick(viewOf(me), moving).turretTurn);
    }
    expect(aims.size).toBe(2);
  });
});

describe('выбор цели', () => {
  const me = crowdTank(ME, 800, 450);

  it('ближайший в окне; вне окна и подбитый — не цель', () => {
    const near = crowdTank(2, 1400, 450);
    const behind = crowdTank(3, 800 - 600, 450);
    const wreck = crowdTank(4, 900, 450, { isAlive: false });
    const frame: Frame = { tick: 0, tanks: [me, near, behind, wreck], bullets: [] };
    const view = crowdView({
      myId: ME,
      fresh: frame,
      delayed: frame,
      map: OPEN,
      kits: [],
      zone: WIDE_ZONE,
      attackers: [],
    });
    expect(view?.enemies.map((tank) => tank.id)).toEqual([2]);
    expect(chooseTarget(viewOf(me, { enemies: view?.enemies ?? [] }), null, true, () => false)).toBe(2);
  });

  it('под неуязвимостью — только если других свободных нет', () => {
    const shielded = crowdTank(2, 900, 450, { shieldLeft: 2 });
    const open = crowdTank(3, 1300, 450);
    expect(chooseTarget(viewOf(me, { enemies: [shielded, open] }), null, true, () => false)).toBe(3);
    expect(chooseTarget(viewOf(me, { enemies: [shielded] }), null, true, () => false)).toBe(2);
  });

  it('текущая держится, пока новый не ближе в полтора раза; до пересмотра — держится всегда', () => {
    const current = crowdTank(2, 1200, 450);
    const slightlyCloser = crowdTank(3, 800, 750);
    const muchCloser = crowdTank(4, 800, 600);
    expect(chooseTarget(viewOf(me, { enemies: [current, slightlyCloser] }), 2, true, () => false)).toBe(2);
    expect(chooseTarget(viewOf(me, { enemies: [current, muchCloser] }), 2, true, () => false)).toBe(4);
    expect(chooseTarget(viewOf(me, { enemies: [current, muchCloser] }), 2, false, () => false)).toBe(2);
  });

  it('не больше двух на одного: третий берёт другого, а если других нет — идёт без цели', () => {
    const book = new TargetBook();
    const first = {};
    const second = {};
    const third = {};
    const busy = crowdTank(2, 900, 450);
    const other = crowdTank(3, 1300, 450);
    book.claim(first, 'игра', 2);
    book.claim(second, 'игра', 2);
    book.claim({}, 'другая игра', 3);
    const targeting = new Targeting(book, third);
    expect(targeting.pick(viewOf(me, { enemies: [busy, other] }), 'игра')?.id).toBe(3);
    expect(new Targeting(book, {}).pick(viewOf(me, { enemies: [busy] }), 'игра')).toBeNull();
    book.claim(first, 'игра', null);
    expect(book.hunters('игра', 2, third)).toBe(1);
  });

  it('попавший видимый противник — цель сразу, даже если на нём уже двое', () => {
    const attacker = crowdTank(2, 1300, 450);
    const near = crowdTank(3, 900, 450);
    const view = viewOf(me, { enemies: [attacker, near], attackers: [2] });
    expect(chooseTarget(view, 3, false, () => true)).toBe(2);
  });

  it('пересмотр раз в секунду; пропавшая цель сменяется сразу; освобождение снимает запись', () => {
    const book = new TargetBook();
    const owner = {};
    const targeting = new Targeting(book, owner);
    const far = crowdTank(2, 1400, 450);
    const close = crowdTank(3, 850, 450);
    expect(targeting.pick(viewOf(me, { tick: 0, enemies: [far] }), 'игра')?.id).toBe(2);
    expect(targeting.pick(viewOf(me, { tick: 10, enemies: [far, close] }), 'игра')?.id).toBe(2);
    expect(targeting.pick(viewOf(me, { tick: 30, enemies: [far, close] }), 'игра')?.id).toBe(3);
    expect(targeting.pick(viewOf(me, { tick: 31, enemies: [far] }), 'игра')?.id).toBe(2);
    targeting.release();
    expect(book.hunters('игра', 2, {})).toBe(0);
  });
});

describe('вид бота', () => {
  it('окно — W × H вокруг точки обзора: впереди по башне видно дальше половины окна, сзади — ближе', () => {
    const halfWidth = FFA.viewWidth / 2;
    const halfHeight = FFA.viewHeight / 2;
    const reachRight = ffaViewReach(0);
    const reachDown = ffaViewReach(Math.PI / 2);
    const at = (dx: number, dy: number, id: number): CrowdTank => crowdTank(id, 2600 + dx, 1450 + dy);
    const visibleIds = (turret: number, tanks: CrowdTank[], bullets: CrowdBullet[] = []): number[][] => {
      const frame: Frame = { tick: 0, tanks: [crowdTank(ME, 2600, 1450, { turret }), ...tanks], bullets };
      const view = crowdView({
        myId: ME,
        fresh: frame,
        delayed: frame,
        map: WIDE,
        kits: [],
        zone: WIDE_ZONE,
        attackers: [],
      });
      return [view?.enemies.map((tank) => tank.id) ?? [], view?.bullets.map((shot) => shot.id) ?? []];
    };
    const right = [at(halfWidth + reachRight - 1, 0, 2), at(halfWidth + reachRight + 1, 0, 3)];
    const left = [at(-halfWidth + reachRight - 1, 0, 4), at(-halfWidth + reachRight + 1, 0, 5)];
    expect(visibleIds(0, [...right, ...left])).toEqual([[2, 5], []]);
    const down = [at(0, halfHeight + reachDown - 1, 6), at(0, -halfHeight + reachDown - 1, 7)];
    expect(visibleIds(Math.PI / 2, down)).toEqual([[6], []]);
    const bullets = [
      bullet(8, 2, 2600 + halfWidth + 100, 1450, 0, 0),
      bullet(9, 2, 2600 - halfWidth + 100, 1450, 0, 0),
    ];
    expect(visibleIds(0, [], bullets)).toEqual([[], [8]]);
  });

  it('противник и снаряды — из запаздывающего снимка, свой танк — из свежего; снаряд вне окна не виден', () => {
    const fresh: Frame = {
      tick: 5,
      tanks: [crowdTank(ME, 820, 450), crowdTank(2, 1200, 450)],
      bullets: [],
    };
    const delayed: Frame = {
      tick: 2,
      tanks: [crowdTank(ME, 800, 450), crowdTank(2, 1100, 450)],
      bullets: [bullet(7, 2, 1000, 450, -500, 0), bullet(8, 2, 1900, 450, -500, 0)],
    };
    const view = crowdView({ myId: ME, fresh, delayed, map: OPEN, kits: [], zone: WIDE_ZONE, attackers: [] });
    expect(view?.me.x).toBe(820);
    expect(view?.enemies[0]?.x).toBe(1100);
    expect(view?.bullets.map((shot) => shot.id)).toEqual([7]);
    const dead: Frame = { ...fresh, tanks: [crowdTank(ME, 820, 450, { isAlive: false })] };
    expect(
      crowdView({ myId: ME, fresh: dead, delayed, map: OPEN, kits: [], zone: WIDE_ZONE, attackers: [] }),
    ).toBeNull();
    expect(crowdView({ myId: 9, fresh, delayed, map: OPEN, kits: [], zone: WIDE_ZONE, attackers: [] })).toBeNull();
  });
});

describe('пирамида уровней', () => {
  function counts(count: number): number[] {
    const levels = crowdPyramid(count);
    return [1, 2, 3, 4, 5, 6, 7].map((level) => levels.filter((candidate) => candidate === level).length);
  }

  it('28 ботов — 7, 6, 5, 4, 3, 2 и 1; 8 — 2, 2, 1, 1, 1, 0 и 1; один — уровень 1; ноль — никого', () => {
    expect(counts(28)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(counts(8)).toEqual([2, 2, 1, 1, 1, 0, 1]);
    expect(crowdPyramid(1)).toEqual([1]);
    expect(crowdPyramid(0)).toEqual([]);
    expect(crowdPyramid(48)).toHaveLength(48);
  });

  it('6 ботов — по одному уровней 1–5 и 7; ник — имя уровня и уровень в скобках', () => {
    expect(crowdPyramid(6)).toEqual([1, 2, 3, 4, 5, 7]);
    expect(crowdPyramid(6).map(crowdNickname)).toEqual([
      'Манекен [1]',
      'Прогульщик [2]',
      'Новобранец [3]',
      'Сержант [4]',
      'Ветеран [5]',
      'Призрак [7]',
    ]);
  });
});

const TEST_MAP: FfaMap = {
  name: 'Проба',
  size: 10,
  seed: 1,
  width: 1600,
  height: 900,
  walls: [],
  kits: [{ x: 800, y: 450 }],
  spawnAreas: [{ x: 200, y: 450, radius: 60 }],
};

function botOf(level: CrowdLevel = 7, book = new TargetBook()): CrowdBot {
  return new CrowdBot({
    level,
    nickname: 'Бот 1',
    size: 10,
    random: seededRandom(5),
    book,
    phase: 0,
    mapFor: () => TEST_MAP,
  });
}

function tankSnapshot(id: number, x: number, y: number, overrides: Partial<FfaTankSnapshot> = {}): FfaTankSnapshot {
  return {
    id,
    x,
    y,
    heading: 0,
    turret: 0,
    speed: 0,
    hp: 100,
    reloadLeft: 0,
    isAlive: true,
    shieldLeft: 0,
    ...overrides,
  };
}

function snapshot(gameTick: number, overrides: Partial<FfaSnapshotMessage> = {}): FfaSnapshotMessage {
  return {
    type: MessageType.FfaSnapshot,
    tick: gameTick,
    gameTick,
    ackSeq: 0,
    hasSpareInput: false,
    self: { state: 'alive', ticksLeft: 0, killerId: null, idleTicksLeft: null, isOut: false },
    tanks: [tankSnapshot(ME, 400, 450), tankSnapshot(2, 900, 450), tankSnapshot(3, 1500, 450)],
    kits: [{ isActive: true, respawnIn: 0 }],
    events: [],
    births: [],
    bounces: [],
    deaths: [],
    ...overrides,
  };
}

function hit(by: number | null, value: number, tank = ME): FfaSnapshotEvent {
  return { kind: 'hit', tank, by, x: 0, y: 0, value, dx: 0, dy: 0, flags: 0 };
}

function enter(bot: CrowdBot, phase: FfaPhase = FfaPhase.Fight): void {
  const messages: ServerMessage[] = [
    {
      type: MessageType.FfaWelcome,
      playerId: ME,
      token: 'пропуск',
      gameId: 'игра',
      size: 10,
      rules: DEFAULT_RULES,
      inviteMiss: FfaInviteMiss.None,
    },
    {
      type: MessageType.FfaRoster,
      players: [
        { id: ME, nickname: 'Бот 1', stats: CROWD_PROFILES[7].stats, isBot: true },
        { id: 2, nickname: 'Враг', stats: CROWD_PROFILES[1].stats, isBot: false },
      ],
    },
    { type: MessageType.FfaState, phase, ticksLeft: 100, players: 3, capacity: 10, minimum: 2, matchIndex: 1 },
    {
      type: MessageType.FfaMatchStart,
      matchIndex: 1,
      durationSeconds: 120,
      zone: { startRadius: 2000, finalRadius: 200, startShrink: 45, endShrink: 105 },
      suddenDeathAt: 85,
    },
  ];
  for (const message of messages) {
    expect(bot.receive(message)).toBeNull();
  }
}

describe('бот толпы на сообщениях сервера', () => {
  it('снимок до входа и до начала матча — бот молчит', () => {
    const bot = botOf();
    expect(bot.receive(snapshot(1))).toBeNull();
    bot.receive({
      type: MessageType.FfaWelcome,
      playerId: ME,
      token: 'п',
      gameId: 'и',
      size: 10,
      rules: DEFAULT_RULES,
      inviteMiss: FfaInviteMiss.None,
    });
    expect(bot.receive(snapshot(2))).toBeNull();
  });

  it('в бою отвечает командой на каждый снимок; новое соединение — номера с единицы, пропуск сохраняется', () => {
    const bot = botOf();
    enter(bot);
    expect(bot.receive(snapshot(1))?.seq).toBe(1);
    expect(bot.receive(snapshot(2))?.seq).toBe(2);
    expect(bot.joinMessage()).toMatchObject({ token: 'пропуск', isBot: true, roomCode: 'ffa10', nickname: 'Бот 1' });
    enter(bot);
    expect(bot.receive(snapshot(3))?.seq).toBe(1);
    bot.forgetToken();
    expect(bot.joinMessage().token).toBe('');
    bot.disconnect();
    expect(bot.playerId).toBeNull();
  });

  it('на отсчёте, подбитым, в ожидании возрождения и зрителем команд не шлёт', () => {
    const counting = botOf();
    enter(counting, FfaPhase.Countdown);
    expect(counting.receive(snapshot(1))).toBeNull();
    const fallen = botOf();
    enter(fallen);
    for (const state of ['wreck', 'waiting', 'spectator'] as const) {
      const self = { state, ticksLeft: 30, killerId: 2, idleTicksLeft: null, isOut: false };
      expect(fallen.receive(snapshot(1, { self }))).toBeNull();
    }
    expect(fallen.receive(snapshot(2))?.seq).toBe(1);
  });

  it('пропущенный ход: повтор прошлой команды без выстрела', () => {
    const bot = botOf(7);
    enter(bot);
    let shot: Action | null = null;
    for (let tick = 1; tick <= 60 && shot === null; tick++) {
      const action = bot.receive(snapshot(tick))?.action;
      shot = action?.isFiring === true ? action : null;
    }
    expect(shot).not.toBeNull();
    expect(bot.repeat()?.action).toEqual({ ...shot, isFiring: false });
  });

  it('уход с поля сбрасывает прошлую команду: подбит, танк пропал из состава, новый матч, новое соединение — повтора нет', () => {
    const wreck = { state: 'wreck' as const, ticksLeft: 30, killerId: 2, idleTicksLeft: null, isOut: false };
    const fallen = botOf();
    enter(fallen);
    fallen.receive(snapshot(1));
    fallen.receive(snapshot(2, { self: wreck }));
    expect(fallen.repeat()).toBeNull();
    const vanished = botOf();
    enter(vanished);
    vanished.receive(snapshot(1));
    expect(vanished.receive(snapshot(2, { tanks: [tankSnapshot(2, 900, 450)] }))).toBeNull();
    expect(vanished.repeat()).toBeNull();
    const restarted = botOf();
    enter(restarted);
    restarted.receive(snapshot(1));
    enter(restarted);
    expect(restarted.repeat()).toBeNull();
    const rejoined = botOf();
    enter(rejoined);
    rejoined.receive(snapshot(1));
    rejoined.joinMessage();
    expect(rejoined.repeat()).toBeNull();
  });

  it('снимок живого ждёт решения; следом снимок, на котором бот подбит, — решать нечего', () => {
    const bot = botOf();
    enter(bot);
    const frame = { tick: 1, tanks: [crowdTank(ME, 400, 450), crowdTank(2, 900, 450)], bullets: [] };
    const wreck = { state: 'wreck' as const, ticksLeft: 30, killerId: 2, idleTicksLeft: null, isOut: false };
    bot.absorb(snapshot(1), frame);
    expect(bot.hasUndecided).toBe(true);
    bot.absorb(snapshot(2, { self: wreck }), { ...frame, tick: 2 });
    expect(bot.hasUndecided).toBe(false);
    expect(bot.decide()).toBeNull();
  });

  it('башня с учётом неподтверждённых команд: пока сервер их не применил, бот не проскакивает цель', () => {
    const bot = botOf(7);
    enter(bot);
    const facingAway = [tankSnapshot(ME, 400, 450, { turret: -0.6 }), tankSnapshot(2, 900, 450)];
    const turns: number[] = [];
    for (let gameTick = 1; gameTick <= 12; gameTick++) {
      turns.push(bot.receive(snapshot(gameTick, { tanks: facingAway, ackSeq: 0 }))?.action.turretTurn ?? 0);
    }
    expect(turns[0]).toBe(1);
    expect(Math.abs(turns.at(-1) ?? 1)).toBeLessThan(0.5);
    const confirmed = bot.receive(snapshot(13, { tanks: facingAway, ackSeq: 12 }));
    expect(confirmed?.action.turretTurn).toBe(1);
  });

  it('снаряд в виде появляется с задержкой реакции; вошедшему посреди матча — все снаряды сразу', () => {
    const bot = botOf(7);
    enter(bot);
    for (let gameTick = 1; gameTick <= 4; gameTick++) {
      bot.receive(snapshot(gameTick));
    }
    bot.takeCounters();
    const birth = { id: 9, owner: 2, x: 600, y: 450, vx: 0, vy: 100, bouncesLeft: 1, hasBounced: false, age: 0 };
    const seen: number[] = [];
    for (let gameTick = 5; gameTick <= 9; gameTick++) {
      bot.receive(snapshot(gameTick, { births: gameTick === 5 ? [birth] : [] }));
      seen.push(bot.takeCounters().visibleBullets);
    }
    expect(seen).toEqual([0, 0, 0, 1, 1]);
    const late = botOf(7);
    enter(late);
    late.receive({ type: MessageType.FfaBullets, bullets: [birth] });
    late.receive(snapshot(1));
    expect(late.takeCounters().visibleBullets).toBe(1);
  });

  it('урон по боту: от стрелка в окне и из-за экрана; зона и свой рикошет не считаются; разрывы в снимках', () => {
    const bot = botOf(1);
    enter(bot);
    bot.receive(snapshot(1));
    const vanished = 9;
    const events = [hit(2, 20), hit(3, 15), hit(vanished, 11), hit(null, 5), hit(ME, 7), hit(2, 9, 2)];
    bot.receive(snapshot(4, { events }));
    const counters = bot.takeCounters();
    expect(counters).toMatchObject({ snapshots: 2, gaps: 2, damageTaken: 46, offscreenDamage: 26 });
  });

  it('урон из-за экрана — по окну вокруг точки обзора: впереди по башне дальше половины окна виден, сзади ближе — нет', () => {
    const bot = botOf(1);
    enter(bot);
    const ahead = 1300;
    const behindClose = -400 + 100;
    const tanksFacing = (turret: number): FfaTankSnapshot[] => [
      tankSnapshot(ME, 400, 450, { turret }),
      tankSnapshot(2, ahead, 450),
      tankSnapshot(3, behindClose, 450),
    ];
    bot.receive(snapshot(1, { tanks: tanksFacing(0), ackSeq: 1 }));
    bot.receive(snapshot(2, { tanks: tanksFacing(0), ackSeq: 2, events: [hit(2, 10), hit(3, 20)] }));
    expect(bot.takeCounters()).toMatchObject({ damageTaken: 30, offscreenDamage: 20 });
    bot.receive(snapshot(3, { tanks: tanksFacing(Math.PI), ackSeq: 3 }));
    bot.receive(snapshot(4, { tanks: tanksFacing(Math.PI), ackSeq: 4, events: [hit(2, 10), hit(3, 20)] }));
    expect(bot.takeCounters()).toMatchObject({ damageTaken: 30, offscreenDamage: 10 });
  });

  it('попавший противник становится целью сразу, хотя другой ближе; незнакомый танк в составе не ломает вид', () => {
    const book = new TargetBook();
    const bot = botOf(5, book);
    enter(bot);
    const tanks = [tankSnapshot(ME, 400, 450), tankSnapshot(2, 1000, 450), tankSnapshot(3, 600, 450)];
    bot.receive(snapshot(1, { tanks }));
    expect(book.hunters('игра', 3, {})).toBe(1);
    bot.receive(snapshot(2, { tanks, events: [hit(2, 20)] }));
    expect(book.hunters('игра', 2, {})).toBe(1);
    expect(book.hunters('игра', 3, {})).toBe(0);
    expect(bot.receive({ type: MessageType.Pong, clientTime: 0, serverTick: 1 })).toBeNull();
  });
});
