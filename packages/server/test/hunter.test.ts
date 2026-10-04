import { describe, expect, it } from 'vitest';
import { botView, createRound, TICK_RATE, type Action, type BotView } from '@tanks/shared/engine';
import { HunterBrain } from '../src/bots/hunter.js';
import { PROFILES, type BotProfile } from '../src/bots/profile.js';
import { seededRandom } from './support.js';

const POLYGON = 0;
const HUNTER = PROFILES[8];
const SHOOTER = { armor: 3, engine: 3, gun: 2, reload: 2 };

// Мозг — функция от вида, как движок: редкие игровые ситуации задаются видом напрямую.
function viewOnPolygon(): BotView {
  const round = createRound(POLYGON, [
    { name: 'Бот', stats: SHOOTER },
    { name: 'Цель', stats: SHOOTER },
  ]);
  return botView(round, 0);
}

// Открытое поле, противник прямо справа на расстоянии distance, башня уже смотрит на него.
function duelView(distance: number): BotView {
  const view = viewOnPolygon();
  view.arena.walls = [];
  view.me.x = 400;
  view.me.y = 450;
  view.me.turret = 0;
  view.enemy.x = 400 + distance;
  view.enemy.y = 450;
  return view;
}

function brainOf(profile: BotProfile, seed = 1): HunterBrain {
  const brain = new HunterBrain(profile, seededRandom(seed));
  brain.init();
  return brain;
}

function ticks(brain: HunterBrain, view: BotView, count: number): Action[] {
  return Array.from({ length: count }, () => brain.tick(view));
}

describe('Охотник на крафтовых видах', () => {
  it('при здоровье ниже 60 % и активной аптечке сворачивает к аптечке, а не к противнику', () => {
    const healthy = viewOnPolygon();
    const wounded = viewOnPolygon();
    for (const kit of wounded.repairKits) {
      kit.isActive = true;
    }
    wounded.me.hp = wounded.me.maxHp * 0.3;

    // Обе аптечки равноудалены от точки появления, первой в карте идёт верхняя — поворот вверх (отрицательный).
    const toEnemy = brainOf(HUNTER).tick(healthy);
    const toKit = brainOf(HUNTER).tick(wounded);
    expect(toKit.turn).toBeLessThan(-0.1);
    expect(toKit.turn).not.toBe(toEnemy.turn);
  });

  it('без аптечек в профиле раненый едет к противнику', () => {
    const wounded = viewOnPolygon();
    for (const kit of wounded.repairKits) {
      kit.isActive = true;
    }
    wounded.me.hp = wounded.me.maxHp * 0.3;
    const noKits = brainOf({ ...HUNTER, hasKits: false }).tick(wounded);
    const withKits = brainOf(HUNTER).tick(wounded);
    expect(noKits.turn).not.toBe(withKits.turn);
  });

  it('за краем сжавшейся зоны бросает перестрелку и едет к центру', () => {
    const view = viewOnPolygon();
    view.arena.walls = [];
    view.enemy.x = view.me.x;
    view.enemy.y = view.me.y - 300;
    view.zone.radius = 200;

    const action = brainOf(HUNTER).tick(view);
    expect(action.throttle).toBe(1);
    expect(Math.abs(action.turn)).toBeLessThan(0.1);
  });

  it('цель внутри сплошной стены недостижима: пути нет, едет прямо на цель', () => {
    const view = viewOnPolygon();
    view.arena.walls = [{ x: 1000, y: 0, w: 600, h: 900 }];
    view.enemy.x = 1300;
    view.enemy.y = 450;

    const action = brainOf(HUNTER).tick(view);
    expect(action.throttle).toBe(1);
    expect(Math.abs(action.turn)).toBeLessThan(0.1);
    expect(action.isFiring).toBe(false);
  });

  it('упреждение целится туда, куда едет цель; без упреждения — в саму цель', () => {
    const view = duelView(300);
    view.enemy.vy = 150;
    const leading = brainOf({ ...HUNTER, leadChance: 1 }).tick(view);
    const direct = brainOf({ ...HUNTER, leadChance: 0 }).tick(view);
    expect(leading.turretTurn).toBeGreaterThan(0.3);
    expect(direct.isFiring).toBe(true);
    expect(Math.abs(direct.turretTurn)).toBeLessThan(0.01);
  });

  it('монетка упреждения бросается на каждый новый выстрел: за много перезарядок выпадают оба исхода', () => {
    const view = duelView(300);
    view.enemy.vy = 150;
    const brain = brainOf({ ...HUNTER, leadChance: 0.5 });
    const turns = new Set<boolean>();
    for (let shot = 0; shot < 20; shot++) {
      view.me.reloadLeft = 0.5;
      brain.tick(view);
      view.me.reloadLeft = 0;
      turns.add(brain.tick(view).turretTurn > 0.3);
    }
    expect(turns.size).toBe(2);
  });

  it('шум прицела уводит башню от цели и меняется со временем', () => {
    const view = duelView(300);
    const noisy = brainOf({ ...HUNTER, aimNoiseRad: 0.3 });
    const turns = ticks(noisy, view, TICK_RATE * 2).map((action) => action.turretTurn);
    expect(Math.max(...turns.map(Math.abs))).toBeGreaterThan(0.05);
    expect(new Set(turns).size).toBeGreaterThan(1);
  });

  it('вероятность выстрела: готовый и наведённый бот с шансом 0 не стреляет, с шансом 1 — стреляет', () => {
    const view = duelView(300);
    const never = ticks(brainOf({ ...HUNTER, fireChance: 0 }), view, TICK_RATE * 2);
    const always = brainOf(HUNTER).tick(view);
    expect(never.every((action) => !action.isFiring)).toBe(true);
    expect(always.isFiring).toBe(true);
  });

  it('не стреляет, пока перезаряжается', () => {
    const view = duelView(300);
    view.me.reloadLeft = 0.4;
    expect(brainOf(HUNTER).tick(view).isFiring).toBe(false);
  });

  it('промах, который вернётся рикошетом, не делается: цель в стороне, стена за ней отражает пулю в стрелка', () => {
    const view = duelView(300);
    view.enemy.y = 450 - 120;
    view.arena.walls = [{ x: 760, y: 300, w: 40, h: 300 }];
    const careless = brainOf({ ...HUNTER, fireWindowRad: Math.PI });
    expect(careless.tick(view).isFiring).toBe(false);
  });

  it('патруль не идёт на противника и замирает по расписанию', () => {
    const view = duelView(600);
    const patrol = brainOf({ ...PROFILES[1], pauseEverySec: 1 });
    const actions = ticks(patrol, view, TICK_RATE * 2);
    const paused = actions.filter((action) => action.throttle === 0 && action.turn === 0);
    expect(paused.length).toBeGreaterThanOrEqual(TICK_RATE / 2);
    expect(actions.some((action) => action.throttle !== 0)).toBe(true);
  });

  it('патруль без свободных точек в зоне едет к её центру', () => {
    const view = duelView(600);
    // Зона ещё вмещает танк, но весь её внутренний круг занят стеной — свободных точек для патруля нет.
    view.zone.radius = 190;
    view.arena.walls = [{ x: 700, y: 350, w: 200, h: 200 }];
    view.me.x = view.zone.x;
    view.me.y = view.zone.y;
    const action = brainOf({ ...PROFILES[1], pauseEverySec: null }).tick(view);
    expect(Math.abs(action.throttle)).toBeLessThanOrEqual(PROFILES[1].throttleCap);
  });

  it('сближение: вплотную отъезжает, на дистанции смещается поперёк, издалека едет к цели', () => {
    const approach = { ...PROFILES[3], throttleCap: 1, aimNoiseRad: 0 };
    const close = brainOf(approach).tick(duelView(200));
    const held = brainOf(approach).tick(duelView(320));
    const far = brainOf(approach).tick(duelView(400));
    expect(close.throttle).toBeLessThan(0);
    expect(Math.abs(held.turn)).toBeGreaterThan(0.5);
    expect(far.throttle).toBe(1);
    expect(Math.abs(far.turn)).toBeLessThan(0.1);
  });

  it('круг: в перестрелке ходит вокруг цели, а не прямо на неё', () => {
    const circle = brainOf({ ...PROFILES[5], aimNoiseRad: 0 }).tick(duelView(320));
    expect(Math.abs(circle.turn)).toBeGreaterThan(0.3);
  });

  it('уклонение: от чужой пули уходит с вероятностью профиля, решение по пуле не меняется', () => {
    const view = duelView(500);
    view.bullets = [
      {
        id: 7,
        x: 600,
        y: 450,
        vx: -550,
        vy: 0,
        isMine: false,
        bouncesLeft: 1,
        damage: 28,
        canHitOwner: false,
      },
    ];
    const dodging = brainOf(HUNTER).tick(view);
    expect(Math.abs(dodging.turn)).toBeGreaterThan(0.5);

    const brave = brainOf({ ...HUNTER, dodgeChance: 0 });
    const first = brave.tick(view);
    const second = brave.tick(view);
    expect(Math.abs(first.turn)).toBeLessThan(0.1);
    expect(second.turn).toBe(first.turn);
  });

  it('от собственной вернувшейся пули уходит любой небеспечный уровень; беспечный — стоит под ней', () => {
    const view = duelView(500);
    view.bullets = [
      { id: 3, x: 200, y: 450, vx: 500, vy: 0, isMine: true, bouncesLeft: 0, damage: 23, canHitOwner: true },
    ];
    const careful = brainOf({ ...PROFILES[3], aimNoiseRad: 0, carelessness: 0 }).tick(view);
    const careless = brainOf({ ...PROFILES[3], aimNoiseRad: 0, carelessness: 1 }).tick(view);
    expect(Math.abs(careful.turn)).toBeGreaterThan(0.5);
    expect(Math.abs(careless.turn)).toBeLessThan(0.1);
  });

  it('беспечный выстрел не проверяет, вернётся ли пуля', () => {
    const view = duelView(300);
    view.enemy.y = 450 - 120;
    view.arena.walls = [{ x: 760, y: 300, w: 40, h: 300 }];
    const careless = brainOf({ ...HUNTER, fireWindowRad: Math.PI, carelessness: 1 });
    expect(careless.tick(view).isFiring).toBe(true);
  });

  it('память решений по пулям ограничена: после многих пуль старые забываются без ошибок', () => {
    const view = duelView(500);
    const brain = brainOf({ ...HUNTER, dodgeChance: 0 });
    for (let id = 0; id < 70; id++) {
      view.bullets = [
        { id, x: 600, y: 450, vx: -550, vy: 0, isMine: false, bouncesLeft: 1, damage: 28, canHitOwner: false },
      ];
      brain.tick(view);
    }
    expect(Math.abs(brain.tick(view).turn)).toBeLessThan(0.1);
  });

  it('поза готовности: шаг вбок, когда противник наведён и его перезарядка на исходе', () => {
    const ready = duelView(450);
    ready.enemy.turret = Math.PI;
    ready.enemy.reloadLeft = 0.05;
    const reloading = duelView(450);
    reloading.enemy.turret = Math.PI;
    reloading.enemy.reloadLeft = 0.5;

    const ace = PROFILES[9];
    expect(Math.abs(brainOf(ace).tick(ready).turn)).toBeGreaterThan(0.5);
    expect(Math.abs(brainOf(HUNTER).tick(ready).turn)).toBeLessThan(0.1);
    expect(Math.abs(brainOf(ace).tick(reloading).turn)).toBeLessThan(0.1);
  });
});
