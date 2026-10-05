import {
  ARENA,
  BULLET_RADIUS,
  leadPoint,
  MAPS,
  MUZZLE_OFFSET,
  TANK_HIT_RADIUS,
  traceShot,
  type Field,
  type ShotSegment,
  type Wall,
} from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { AIM_LINE_TAIL, computeAimLine, firstTargetOnPath, type AimLineEnemy, type AimLineInput } from './aimLine.js';

const BULLET_SPEED = 550;
const POLYGON: Field = { width: ARENA.width, height: ARENA.height, walls: MAPS[0]?.walls ?? [] };
const deg = (value: number): number => (value * Math.PI) / 180;

function length(segment: { x1: number; y1: number; x2: number; y2: number }): number {
  return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
}

function standing(x: number, y: number): AimLineEnemy {
  return { x, y, heading: 0, speed: 0 };
}

// Вход дуэли: один противник или никого.
type DuelInput = Omit<AimLineInput, 'targets'> & { enemy: AimLineEnemy | null };

function input(overrides: Partial<DuelInput> & Pick<DuelInput, 'shooter'>): AimLineInput {
  const { enemy = null, ...rest } = overrides;
  return {
    field: POLYGON,
    bulletSpeed: BULLET_SPEED,
    hasLeadHint: false,
    ...rest,
    targets: enemy === null ? [] : [enemy],
  };
}

function crowdInput(shooter: AimLineInput['shooter'], targets: readonly AimLineEnemy[], field = POLYGON): AimLineInput {
  return { field, shooter, bulletSpeed: BULLET_SPEED, targets, hasLeadHint: false };
}

describe('computeAimLine — геометрия', () => {
  it('выстрел в ближний край: первый отрезок до раздутого края, хвост 180, возврат в себя', () => {
    const line = computeAimLine(input({ shooter: { x: 140, y: 450, turret: Math.PI } }));
    expect(line.segments).toHaveLength(2);
    expect(line.segments[0]).toMatchObject({ x1: 140 - MUZZLE_OFFSET, y1: 450, x2: BULLET_RADIUS, y2: 450 });
    expect(line.segments[1]?.x1).toBe(BULLET_RADIUS);
    expect(length(line.segments[1] ?? { x1: 0, y1: 0, x2: 0, y2: 0 })).toBeCloseTo(AIM_LINE_TAIL, 6);
    expect(line.segments[1]?.x2).toBeCloseTo(BULLET_RADIUS + AIM_LINE_TAIL, 6);
    expect(line.state).toBe('none');
    expect(line.mark).toBeNull();
    expect(line.isReturning).toBe(true);
  });

  it('выстрел в упор в стену «Полигона»: первый отрезок до стены, хвост 180 назад', () => {
    const line = computeAimLine(input({ shooter: { x: 260, y: 260, turret: 0 } }));
    expect(line.segments[0]?.x2).toBe(330 - BULLET_RADIUS);
    expect(line.segments[1]?.x2).toBeCloseTo(330 - BULLET_RADIUS - AIM_LINE_TAIL, 6);
    expect(line.isReturning).toBe(true);
  });

  it('хвост обрезан преградой, если она ближе 180', () => {
    const walls: Wall[] = [
      { x: 100, y: 0, w: 50, h: 900 },
      { x: 300, y: 0, w: 50, h: 900 },
    ];
    const line = computeAimLine(input({ field: { ...POLYGON, walls }, shooter: { x: 200, y: 450, turret: 0 } }));
    expect(line.segments[0]?.x2).toBe(300 - BULLET_RADIUS);
    const tail = line.segments[1] ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
    expect(length(tail)).toBeLessThan(AIM_LINE_TAIL);
    expect(tail.x2).toBeCloseTo(150 + BULLET_RADIUS, 6);
  });

  it('дуло в стене — пусто', () => {
    expect(computeAimLine(input({ shooter: { x: 300, y: 260, turret: 0 } }))).toEqual({
      segments: [],
      state: 'none',
      mark: null,
      isReturning: false,
    });
  });

  it('дальность кончается раньше преграды — один отрезок без хвоста', () => {
    const line = computeAimLine(input({ shooter: { x: 140, y: 450, turret: Math.PI }, bulletSpeed: 5 }));
    expect(line.segments).toHaveLength(1);
    expect(line.state).toBe('none');
    expect(line.isReturning).toBe(false);
  });

  it('противник null — линия есть, состояния нет', () => {
    const line = computeAimLine(input({ shooter: { x: 140, y: 450, turret: 0 }, hasLeadHint: true }));
    expect(line.segments.length).toBeGreaterThan(0);
    expect(line.state).toBe('none');
  });
});

describe('computeAimLine — «на нём»', () => {
  it('противник на первом отрезке: линия кончается на краю его корпуса, хвоста нет, возврата нет', () => {
    const enemy = standing(300, 260);
    const shooter = { x: 200, y: 260, turret: 0 };
    const line = computeAimLine(input({ shooter, enemy }));
    expect(line.state).toBe('onTarget');
    expect(line.segments).toHaveLength(1);
    const end = line.segments[0] ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
    expect(Math.hypot(end.x2 - enemy.x, end.y2 - enemy.y)).toBeCloseTo(TANK_HIT_RADIUS, 6);
    expect(line.mark).toMatchObject({ x: end.x2, y: end.y2, angle: 0 });
    expect(line.isReturning).toBe(false);
    expect(computeAimLine(input({ shooter })).isReturning).toBe(true);
  });

  it('противник на хвосте: два отрезка, засечка на хвосте', () => {
    const shooter = { x: 140, y: 450, turret: -deg(150) };
    const without = computeAimLine(input({ shooter }));
    const tail = without.segments[1] ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
    const angle = Math.atan2(tail.y2 - tail.y1, tail.x2 - tail.x1);
    const enemy = standing(tail.x1 + Math.cos(angle) * 120, tail.y1 + Math.sin(angle) * 120);
    const line = computeAimLine(input({ shooter, enemy }));
    expect(line.state).toBe('onTarget');
    expect(line.segments).toHaveLength(2);
    expect(line.mark?.angle).toBeCloseTo(angle, 6);
    const markDistance = Math.hypot((line.mark?.x ?? 0) - enemy.x, (line.mark?.y ?? 0) - enemy.y);
    expect(markDistance).toBeCloseTo(TANK_HIT_RADIUS, 6);
  });

  it('противник стоит: башня на корпус — «на нём», чуть мимо — ничего даже с подсказкой упреждения', () => {
    const enemy = standing(700, 450);
    const onBody = computeAimLine(input({ shooter: { x: 140, y: 450, turret: 0 }, enemy, hasLeadHint: true }));
    expect(onBody.state).toBe('onTarget');
    const aside = computeAimLine(input({ shooter: { x: 140, y: 450, turret: 0.1 }, enemy, hasLeadHint: true }));
    expect(aside.state).toBe('none');
  });

  it('противник едет на стрелка: башня на корпусе и на точке упреждения — главнее «на нём»', () => {
    const enemy: AimLineEnemy = { x: 700, y: 450, heading: Math.PI, speed: 150 };
    const line = computeAimLine(input({ shooter: { x: 140, y: 450, turret: 0 }, enemy, hasLeadHint: true }));
    expect(line.state).toBe('onTarget');
  });
});

describe('computeAimLine и firstTargetOnPath — толпа', () => {
  const lane = { x: 140, y: 450, turret: 0 };
  const shooterAtTail = { x: 140, y: 450, turret: -deg(150) };

  function pathOf(shooter: AimLineInput['shooter']): ShotSegment[] {
    return traceShot(POLYGON, shooter, shooter.turret, BULLET_SPEED).segments;
  }

  function tailPoint(distance: number): AimLineEnemy {
    const tail = computeAimLine(crowdInput(shooterAtTail, [])).segments[1] ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
    const angle = Math.atan2(tail.y2 - tail.y1, tail.x2 - tail.x1);
    return standing(tail.x1 + Math.cos(angle) * distance, tail.y1 + Math.sin(angle) * distance);
  }

  it('цель за стеной — цели нет: линия «ничего», первого танка на пути нет', () => {
    const shooter = { x: 260, y: 260, turret: 0 };
    const behindWall = standing(500, 260);
    expect(computeAimLine(crowdInput(shooter, [behindWall])).state).toBe('none');
    expect(firstTargetOnPath(pathOf(shooter), [behindWall])).toBeNull();
  });

  it('два танка на линии — цель ближний по пути, в каком бы порядке они ни пришли', () => {
    const near = standing(400, 450);
    const far = standing(700, 450);
    for (const targets of [
      [far, near],
      [near, far],
    ]) {
      const line = computeAimLine(crowdInput(lane, targets));
      expect(line.state).toBe('onTarget');
      expect(Math.hypot((line.mark?.x ?? 0) - near.x, (line.mark?.y ?? 0) - near.y)).toBeCloseTo(TANK_HIT_RADIUS, 6);
      expect(line.segments[0]?.x2).toBeCloseTo(near.x - TANK_HIT_RADIUS, 6);
      expect(firstTargetOnPath(pathOf(lane), targets)).toBe(near);
    }
  });

  it('цель на хвосте после отскока считается; на хвосте — ближний к отскоку; танк до отскока главнее хвоста', () => {
    const nearOnTail = tailPoint(60);
    const farOnTail = tailPoint(150);
    const aside = standing(1200, 800);
    const line = computeAimLine(crowdInput(shooterAtTail, [aside, farOnTail, nearOnTail]));
    expect(line.state).toBe('onTarget');
    expect(line.segments).toHaveLength(2);
    const markDistance = Math.hypot((line.mark?.x ?? 0) - nearOnTail.x, (line.mark?.y ?? 0) - nearOnTail.y);
    expect(markDistance).toBeCloseTo(TANK_HIT_RADIUS, 6);
    expect(firstTargetOnPath(pathOf(shooterAtTail), [aside, farOnTail, nearOnTail])).toBe(nearOnTail);
    const first = line.segments[0] ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
    const beforeBounce = standing((first.x1 + first.x2) / 2, (first.y1 + first.y2) / 2);
    const both = computeAimLine(crowdInput(shooterAtTail, [nearOnTail, beforeBounce]));
    expect(both.segments).toHaveLength(1);
    expect(both.isReturning).toBe(false);
    expect(firstTargetOnPath(pathOf(shooterAtTail), [nearOnTail, beforeBounce])).toBe(beforeBounce);
  });

  it('дуло в стене или никого на пути — первого танка нет', () => {
    expect(firstTargetOnPath(pathOf({ x: 300, y: 260, turret: 0 }), [standing(400, 260)])).toBeNull();
    expect(firstTargetOnPath(pathOf(lane), [standing(400, 700)])).toBeNull();
    expect(firstTargetOnPath(pathOf(lane), [])).toBeNull();
  });
});

describe('computeAimLine — «упреждаю»', () => {
  const shooter = { x: 140, y: 450 };
  const crossing: AimLineEnemy = { x: 700, y: 450, heading: Math.PI / 2, speed: 150 };
  const lead = leadPoint(shooter, crossing, { x: 0, y: crossing.speed }, BULLET_SPEED);
  const turretAtLead = Math.atan2(lead.y - shooter.y, lead.x - shooter.x);

  it('башня на точке упреждения: с флагом — «упреждаю» и засечка у точки, без флага — ничего', () => {
    const withHint = computeAimLine(
      input({ shooter: { ...shooter, turret: turretAtLead }, enemy: crossing, hasLeadHint: true }),
    );
    expect(withHint.state).toBe('lead');
    expect(withHint.segments).toHaveLength(2);
    const markDistance = Math.hypot((withHint.mark?.x ?? 0) - lead.x, (withHint.mark?.y ?? 0) - lead.y);
    expect(markDistance).toBeCloseTo(TANK_HIT_RADIUS, 6);
    const withoutHint = computeAimLine(input({ shooter: { ...shooter, turret: turretAtLead }, enemy: crossing }));
    expect(withoutHint.state).toBe('none');
    expect(withoutHint.mark).toBeNull();
  });

  it('несколько целей: «упреждаю» у той, чья точка упреждения на пути', () => {
    const aside = standing(400, 700);
    const line = computeAimLine({
      ...crowdInput({ ...shooter, turret: turretAtLead }, [aside, crossing]),
      hasLeadHint: true,
    });
    expect(line.state).toBe('lead');
    expect(Math.hypot((line.mark?.x ?? 0) - lead.x, (line.mark?.y ?? 0) - lead.y)).toBeCloseTo(TANK_HIT_RADIUS, 6);
  });

  it('скорость ниже порога — «упреждаю» не показывается', () => {
    const slow: AimLineEnemy = { ...crossing, speed: 20 };
    const slowLead = leadPoint(shooter, slow, { x: 0, y: slow.speed }, BULLET_SPEED);
    expect(Math.abs(slowLead.y - slow.y)).toBeLessThan(TANK_HIT_RADIUS);
    const turret = Math.atan2(slow.y + 40 - shooter.y, slow.x - shooter.x);
    const line = computeAimLine(input({ shooter: { ...shooter, turret }, enemy: slow, hasLeadHint: true }));
    expect(line.state).toBe('none');
  });
});
