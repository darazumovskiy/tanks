import { ARENA, leadShot, MAPS, NO_CARRY, TANK_HIT_RADIUS, type Field } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { enemyLeadPoint, type AimLineEnemy } from './aimLine.js';
import { isShotInZone, ZONE_FIRE_MAX_RANGE, type ZoneFireInput } from './zoneFire.js';

const BULLET_SPEED = 550;
const POLYGON: Field = { width: ARENA.width, height: ARENA.height, walls: MAPS[0]?.walls ?? [] };
const OPEN_FIELD: Field = { ...POLYGON, walls: [] };
const SHOOTER = { x: 140, y: 450 };
const STANDING: AimLineEnemy = { x: 700, y: 450, heading: 0, speed: 0 };
// Едет вниз по экрану поперёк линии выстрела: точка упреждения заметно ниже корпуса.
const CROSSING: AimLineEnemy = { x: 700, y: 450, heading: Math.PI / 2, speed: 150 };
// Шаг поворота в развёртке — четверть единицы поля на дистанции цели: первый угол «в зоне» ловится точно.
const SWEEP_STEP = 0.0005;

function input(turret: number, enemy: AimLineEnemy | null, overrides: Partial<ZoneFireInput> = {}): ZoneFireInput {
  const targets = enemy === null ? [] : [enemy];
  return {
    field: POLYGON,
    shooter: { ...SHOOTER, turret },
    bulletSpeed: BULLET_SPEED,
    carry: NO_CARRY,
    targets,
    ...overrides,
  };
}

function angleTo(point: { x: number; y: number }): number {
  return Math.atan2(point.y - SHOOTER.y, point.x - SHOOTER.x);
}

// Расстояние от луча из стрелка под углом `turret` до точки.
function rayDistance(turret: number, point: { x: number; y: number }): number {
  const dx = point.x - SHOOTER.x;
  const dy = point.y - SHOOTER.y;
  return Math.abs(dx * Math.sin(turret) - dy * Math.cos(turret));
}

function leadOf(enemy: AimLineEnemy): { x: number; y: number } {
  const lead = enemyLeadPoint(SHOOTER, enemy, BULLET_SPEED, NO_CARRY);
  if (lead === null) {
    throw new Error('противник слишком медленный для упреждения');
  }
  return lead;
}

describe('isShotInZone', () => {
  it('башня на корпусе стоящего противника — в зоне; мимо на два радиуса — нет', () => {
    expect(isShotInZone(input(0, STANDING))).toBe(true);
    const aside = Math.atan((2 * TANK_HIT_RADIUS) / (STANDING.x - SHOOTER.x));
    expect(isShotInZone(input(aside, STANDING))).toBe(false);
  });

  it('противник едет поперёк: башня на точке упреждения и между корпусом и упреждением — в зоне', () => {
    const lead = leadOf(CROSSING);
    expect(lead.y - CROSSING.y).toBeGreaterThan(2 * TANK_HIT_RADIUS);
    expect(isShotInZone(input(angleTo(lead), CROSSING))).toBe(true);
    const middle = { x: (CROSSING.x + lead.x) / 2, y: (CROSSING.y + lead.y) / 2 };
    expect(isShotInZone(input(angleTo(middle), CROSSING))).toBe(true);
  });

  it('позади корпуса против хода дальше радиуса — не в зоне', () => {
    const behind = { x: CROSSING.x, y: CROSSING.y - 2 * TANK_HIT_RADIUS };
    expect(isShotInZone(input(angleTo(behind), CROSSING))).toBe(false);
  });

  it('стена между стрелком и противником — не в зоне', () => {
    const shooter = { x: 260, y: 260, turret: 0 };
    const enemy: AimLineEnemy = { x: 400, y: 260, heading: 0, speed: 0 };
    expect(isShotInZone(input(0, enemy, { shooter }))).toBe(false);
    expect(isShotInZone(input(0, enemy, { shooter, field: OPEN_FIELD }))).toBe(true);
  });

  it('дальше предела дальности — не в зоне, ближе — в зоне', () => {
    const far: AimLineEnemy = { ...STANDING, x: SHOOTER.x + 700 };
    expect(isShotInZone(input(0, far, { field: OPEN_FIELD }))).toBe(false);
    const near: AimLineEnemy = { ...STANDING, x: SHOOTER.x + ZONE_FIRE_MAX_RANGE - 10 };
    expect(isShotInZone(input(0, near, { field: OPEN_FIELD }))).toBe(true);
  });

  it('без противника — не в зоне', () => {
    expect(isShotInZone(input(0, null))).toBe(false);
  });

  it('несколько целей: в зоне, если путь проходит по любой из них, в каком бы порядке они ни пришли', () => {
    const aside: AimLineEnemy = { x: 500, y: 750, heading: 0, speed: 0 };
    const far: AimLineEnemy = { ...STANDING, x: SHOOTER.x + 700 };
    expect(isShotInZone(input(0, null, { targets: [aside, STANDING] }))).toBe(true);
    expect(isShotInZone(input(0, null, { targets: [STANDING, aside] }))).toBe(true);
    expect(isShotInZone(input(0, null, { targets: [aside, far], field: OPEN_FIELD }))).toBe(false);
  });

  it('снаряд со скоростью танка: ствол на точку наводки со сносом по едущей цели — в зоне; без сноса — нет', () => {
    const carry = { x: 0, y: -176 };
    const velocity = { x: 0, y: CROSSING.speed };
    const { aim } = leadShot(SHOOTER, CROSSING, velocity, BULLET_SPEED, carry);
    const turret = angleTo(aim);
    expect(isShotInZone(input(turret, CROSSING, { field: OPEN_FIELD, carry }))).toBe(true);
    expect(isShotInZone(input(turret, CROSSING, { field: OPEN_FIELD }))).toBe(false);
  });

  it('дуло в стене — не в зоне', () => {
    const shooter = { x: 300, y: 260, turret: 0 };
    const enemy: AimLineEnemy = { x: 400, y: 260, heading: 0, speed: 0 };
    expect(isShotInZone(input(0, enemy, { shooter }))).toBe(false);
  });

  // Первый угол, на котором линия входит в зону, при повороте башни от `from` к `to`.
  function firstInZone(from: number, to: number, enemy: AimLineEnemy): number {
    const step = to > from ? SWEEP_STEP : -SWEEP_STEP;
    for (let turret = from; (to - turret) * step > 0; turret += step) {
      if (isShotInZone(input(turret, enemy))) {
        return turret;
      }
    }
    throw new Error('зона не найдена');
  }

  it('чтение намерения: подвод с хвоста входит в зону у корпуса, подвод спереди — у точки упреждения', () => {
    const lead = leadOf(CROSSING);
    const bodyAngle = angleTo(CROSSING);
    const leadAngle = angleTo(lead);

    const fromTail = firstInZone(bodyAngle - 0.3, leadAngle, CROSSING);
    expect(rayDistance(fromTail, CROSSING)).toBeCloseTo(TANK_HIT_RADIUS, 0);
    expect(rayDistance(fromTail, lead)).toBeGreaterThan(2 * TANK_HIT_RADIUS);

    const fromFront = firstInZone(leadAngle + 0.3, bodyAngle, CROSSING);
    expect(rayDistance(fromFront, lead)).toBeCloseTo(TANK_HIT_RADIUS, 0);
    expect(rayDistance(fromFront, CROSSING)).toBeGreaterThan(2 * TANK_HIT_RADIUS);
  });
});
