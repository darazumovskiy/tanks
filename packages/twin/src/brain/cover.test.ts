import { wallClearance, type Coefficients } from '@tanks/analysis';
import { mapByIndex, type Point } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { craftView, profileWith, type ViewSpec } from '../fixture.js';
import type { Band } from '../profile.js';
import { TwinBrain } from './brain.js';
import { Ambush, hasLineOfSight } from './cover.js';
import { gridOf } from './path.js';
import { aimTurret } from './steering.js';

const POLYGON = mapByIndex(0);
const GRID = gridOf(POLYGON);
const COVER = { distanceBand: { near: 250, far: 700 }, wallDistanceBand: { near: 30, far: 120 } };
const ALWAYS: Coefficients = {
  intercept: 50,
  weights: {
    class8: 0,
    class9: 0,
    class10: 0,
    lossStreak: 0,
    roundIndex: 0,
    recentDamageShare: 0,
    healthShare: 0,
    exchangeShare: 0,
    hasCover: 0,
    fightSeconds: 0,
    positionSeconds: 0,
  },
};
const NEVER: Coefficients = { ...ALWAYS, intercept: -50 };
const START: ViewSpec = { me: { x: 200, y: 450 }, enemy: { x: 900, y: 200 } };

function inBand(value: number, band: Band): boolean {
  return value >= band.near && value <= band.far;
}

function coverBrain(cover = COVER): TwinBrain {
  const brain = new TwinBrain(profileWith({ cover, modeSwitch: { enter: ALWAYS, leave: NEVER } }));
  brain.init({ level: 8, roundIndex: 0, lossStreak: 0, mapIndex: 0, hasRicochetGuard: false, seed: 6 });
  return brain;
}

function chosenSpot(spec: ViewSpec): Point {
  const ambush = new Ambush(COVER);
  ambush.choose(GRID, spec.me, spec.enemy);
  const spot = ambush.spot;
  if (spot === null) {
    throw new Error('нет места засады');
  }
  return spot;
}

describe('позиция за укрытием', () => {
  it('место засады есть: стена закрывает противника, дистанция и расстояние до стены — в полосах профиля', () => {
    const brain = coverBrain();
    const spot = chosenSpot(START);
    brain.tick(craftView(START));

    expect(brain.mode).toBe('cover');
    expect(hasLineOfSight(POLYGON.walls, spot, START.enemy)).toBe(false);
    expect(inBand(Math.hypot(spot.x - START.enemy.x, spot.y - START.enemy.y), COVER.distanceBand)).toBe(true);
    expect(inBand(wallClearance(POLYGON.walls, spot.x, spot.y), COVER.wallDistanceBand)).toBe(true);
  });

  it('танк на открытом месте в полосе дистанции — засада всё равно там, где стена закрывает противника', () => {
    const open: ViewSpec = { me: { x: 500, y: 100 }, enemy: { x: 900, y: 100 } };
    const spot = chosenSpot(open);

    expect(hasLineOfSight(POLYGON.walls, open.me, open.enemy)).toBe(true);
    expect(hasLineOfSight(POLYGON.walls, spot, open.enemy)).toBe(false);
  });

  it('на месте — газ 0, башня по руке на точку выхода противника', () => {
    const brain = coverBrain();
    const spot = chosenSpot(START);
    brain.tick(craftView(START));
    const ambush = new Ambush(COVER);
    ambush.choose(GRID, START.me, START.enemy);
    const exit = ambush.exit(GRID, START.enemy, 2);
    const toExit = Math.atan2(exit.y - spot.y, exit.x - spot.x);
    const turret = toExit + 0.02;
    const decision = brain.tick(craftView({ ...START, me: { ...spot, turret }, tick: 2 }));

    expect(hasLineOfSight(POLYGON.walls, spot, exit)).toBe(true);
    expect(decision.action.throttle).toBe(0);
    expect(decision.action.turn).toBe(0);
    expect(Math.abs(decision.action.turretTurn)).toBeLessThan(1);
    expect(decision.action.turretTurn).toBeCloseTo(aimTurret(toExit, turret), 9);
  });

  it('противник вышел в видимость — башня на противника, танк не сдвигается', () => {
    const brain = coverBrain();
    const spot = chosenSpot(START);
    brain.tick(craftView(START));
    const enemy = { x: spot.x + 300, y: spot.y };
    expect(hasLineOfSight(POLYGON.walls, spot, enemy)).toBe(true);
    const decision = brain.tick(craftView({ me: { ...spot, turret: Math.PI / 2 }, enemy, tick: 2 }));

    expect(brain.mode).toBe('cover');
    expect(decision.action.throttle).toBe(0);
    expect(decision.action.turretTurn).toBeCloseTo(aimTurret(0, Math.PI / 2), 9);
  });

  it('укрытия нет — режим «позиция» не включается', () => {
    const brain = coverBrain({ ...COVER, distanceBand: { near: 5000, far: 6000 } });
    brain.tick(craftView(START));

    expect(brain.mode).toBe('manoeuvre');
  });

  it('у профиля без позиции режим не включается при любых коэффициентах', () => {
    const brain = new TwinBrain(profileWith({ modeSwitch: { enter: ALWAYS, leave: NEVER } }));
    brain.init({ level: 8, roundIndex: 0, lossStreak: 0, mapIndex: 0, hasRicochetGuard: false, seed: 6 });
    brain.tick(craftView(START));

    expect(brain.mode).toBe('manoeuvre');
  });

  it('выход из позиции — по потоку «позиция → манёвр»; место засады сбрасывается', () => {
    const brain = new TwinBrain(profileWith({ cover: COVER, modeSwitch: { enter: ALWAYS, leave: ALWAYS } }));
    brain.init({ level: 8, roundIndex: 0, lossStreak: 0, mapIndex: 0, hasRicochetGuard: false, seed: 6 });
    const modes: string[] = [];
    for (let tick = 0; tick <= 60; tick += 30) {
      for (let k = 0; k < 30; k++) {
        brain.tick(craftView({ ...START, tick: tick + k }));
      }
      modes.push(brain.mode);
    }

    expect(modes).toEqual(['cover', 'manoeuvre', 'cover']);
  });
});
