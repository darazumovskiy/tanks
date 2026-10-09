import type { Field, Point } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import type { FxBullet, FxTank } from './effects.js';
import { MUZZLE_EXIT_MAX_GAP, MUZZLE_EXIT_S, MuzzleExit, muzzleOf } from './muzzleExit.js';

const FIELD: Field = { width: 3000, height: 3000, walls: [] };
const FRAME_S = 0.016;
const COLOR = '#ffffff';
// Разрыв закрывается сглаженной ступенью: быстрее всего в середине — 1,5 разрыва за время выхода.
const PEAK_GAP_RATE = 1.5;

function tank(overrides: Partial<FxTank> = {}): FxTank {
  return {
    id: 1,
    x: 1000,
    y: 1000,
    heading: 0,
    turret: Math.PI / 2,
    speed: 220,
    hp: 100,
    maxHp: 100,
    isAlive: true,
    bulletSpeed: 500,
    shotInheritPercent: 100,
    ...overrides,
  };
}

function tanksOf(...list: FxTank[]): Map<number, FxTank> {
  return new Map(list.map((one) => [one.id, one]));
}

function bulletAt(point: Point, id = 9, owner = 1): FxBullet {
  return { id, owner, x: point.x, y: point.y, color: COLOR };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function placedOne(exit: MuzzleExit, bullet: FxBullet, tanks: Map<number, FxTank>, timeS: number): Point {
  const [placed] = exit.place([bullet], tanks, FIELD, timeS);
  if (placed === undefined) {
    throw new Error('снаряд не нарисован');
  }
  return placed;
}

// Едущий танк и его снаряд со скоростью танка: снаряд родился в 80 впереди дула по стволу.
function flight(ageS: number): { shooter: FxTank; bullet: Point } {
  const start = tank();
  const shooter = { ...start, x: start.x + start.speed * ageS };
  const muzzle = muzzleOf(start);
  return { shooter, bullet: { x: muzzle.x + start.speed * ageS, y: muzzle.y + 80 + start.bulletSpeed * ageS } };
}

describe('выход снаряда из дула', () => {
  it('M4 первый кадр — на дуле; разрыв убывает и к концу выхода — 0; сдвиг за кадр ограничен', () => {
    const exit = new MuzzleExit();
    let previous: Point | null = null;
    let previousTrue: Point | null = null;
    let previousGap = Infinity;
    for (let frame = 0; frame * FRAME_S <= 2 * MUZZLE_EXIT_S; frame++) {
      const ageS = frame * FRAME_S;
      const { shooter, bullet } = flight(ageS);
      const drawn = placedOne(exit, bulletAt(bullet), tanksOf(shooter), ageS);
      const gap = distance(drawn, bullet);
      if (frame === 0) {
        const muzzle = muzzleOf(shooter);
        expect(drawn.x).toBeCloseTo(muzzle.x, 6);
        expect(drawn.y).toBeCloseTo(muzzle.y, 6);
      }
      expect(gap).toBeLessThanOrEqual(previousGap);
      if (ageS >= MUZZLE_EXIT_S) {
        expect(gap).toBe(0);
      }
      if (previous !== null && previousTrue !== null) {
        const allowed = distance(bullet, previousTrue) + (PEAK_GAP_RATE * 80 * FRAME_S) / MUZZLE_EXIT_S;
        expect(distance(drawn, previous)).toBeLessThanOrEqual(allowed + 1e-6);
      }
      previous = drawn;
      previousTrue = bullet;
      previousGap = gap;
    }
  });

  it('M5 в упор: другой танк на пути, стена на пути, край поля — с первого кадра на своём месте; танк в стороне — выход', () => {
    const shooter = tank();
    const muzzle = muzzleOf(shooter);
    const bullet = { x: muzzle.x, y: muzzle.y + 20 };
    const onPath = tank({ id: 2, x: muzzle.x, y: muzzle.y + 60, speed: 0 });
    expect(placedOne(new MuzzleExit(), bulletAt(bullet), tanksOf(shooter, onPath), 0)).toEqual(bulletAt(bullet));

    const walled: Field = { ...FIELD, walls: [{ x: muzzle.x - 100, y: muzzle.y + 50, w: 200, h: 40 }] };
    const [nearWall] = new MuzzleExit().place([bulletAt(bullet)], tanksOf(shooter), walled, 0);
    expect(nearWall).toEqual(bulletAt(bullet));

    const atEdge = tank({ y: FIELD.height - 70 });
    const edgeMuzzle = muzzleOf(atEdge);
    const edgeBullet = { x: edgeMuzzle.x, y: edgeMuzzle.y + 20 };
    expect(placedOne(new MuzzleExit(), bulletAt(edgeBullet), tanksOf(atEdge), 0)).toEqual(bulletAt(edgeBullet));

    const aside = tank({ id: 2, x: muzzle.x + 200, y: muzzle.y + 60, speed: 0 });
    const drawn = placedOne(new MuzzleExit(), bulletAt(bullet), tanksOf(shooter, aside), 0);
    expect(drawn.x).toBeCloseTo(muzzle.x, 6);
    expect(drawn.y).toBeCloseTo(muzzle.y, 6);
  });

  it('M6 далеко от дула, стрелка нет в кадре, стрелок подбит — на своём месте', () => {
    const shooter = tank();
    const muzzle = muzzleOf(shooter);
    const far = { x: muzzle.x, y: muzzle.y + MUZZLE_EXIT_MAX_GAP + 60 };
    expect(placedOne(new MuzzleExit(), bulletAt(far), tanksOf(shooter), 0)).toEqual(bulletAt(far));
    const near = { x: muzzle.x, y: muzzle.y + 40 };
    expect(placedOne(new MuzzleExit(), bulletAt(near), tanksOf(), 0)).toEqual(bulletAt(near));
    const wreck = { ...shooter, isAlive: false };
    expect(placedOne(new MuzzleExit(), bulletAt(near), tanksOf(wreck), 0)).toEqual(bulletAt(near));
  });

  it('M7 смена номера продолжает выход; пропавший и вернувшийся под другим номером — новый выход; сброс — новый выход', () => {
    const exit = new MuzzleExit();
    const half = MUZZLE_EXIT_S / 2;
    const start = flight(0);
    placedOne(exit, bulletAt(start.bullet, 900), tanksOf(start.shooter), 0);
    const middle = flight(half);
    exit.rename(900, 5);
    const renamed = placedOne(exit, bulletAt(middle.bullet, 5), tanksOf(middle.shooter), half);
    const reference = new MuzzleExit();
    placedOne(reference, bulletAt(start.bullet, 900), tanksOf(start.shooter), 0);
    const continued = placedOne(reference, bulletAt(middle.bullet, 900), tanksOf(middle.shooter), half);
    expect(renamed.x).toBeCloseTo(continued.x, 9);
    expect(renamed.y).toBeCloseTo(continued.y, 9);

    exit.place([], tanksOf(middle.shooter), FIELD, half);
    const muzzle = muzzleOf(middle.shooter);
    const again = placedOne(exit, bulletAt(middle.bullet, 6), tanksOf(middle.shooter), half);
    expect(again.x).toBeCloseTo(muzzle.x, 6);
    expect(again.y).toBeCloseTo(muzzle.y, 6);

    exit.reset();
    const fresh = placedOne(exit, bulletAt(middle.bullet, 6), tanksOf(middle.shooter), half);
    expect(fresh.x).toBeCloseTo(muzzle.x, 6);
    expect(fresh.y).toBeCloseTo(muzzle.y, 6);
  });
});
