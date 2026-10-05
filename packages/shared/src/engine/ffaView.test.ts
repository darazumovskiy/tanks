import { describe, expect, it } from 'vitest';
import { FFA } from './constants.js';
import { ffaViewCenter, ffaViewReach } from './ffaView.js';

const SIDE = FFA.viewAheadSide * FFA.viewWidth;
const DOWN = FFA.viewAheadDown * FFA.viewHeight;
const UP = FFA.viewAheadUp * FFA.viewHeight;
const TANK = { x: 1000, y: 700 };
const NEAR = 1e-9;
const CONTINUITY_STEPS = 20_000;
const CONTINUITY_TOLERANCE = 0.2;

// Радиус эллипса, посчитанный независимо от кода модуля.
function expectedReach(angle: number): number {
  const vertical = Math.sin(angle) >= 0 ? DOWN : UP;
  return 1 / Math.sqrt(Math.cos(angle) ** 2 / SIDE ** 2 + Math.sin(angle) ** 2 / vertical ** 2);
}

function shiftAt(turret: number): { dx: number; dy: number } {
  const center = ffaViewCenter({ ...TANK, turret });
  return { dx: center.x - TANK.x, dy: center.y - TANK.y };
}

describe('точка обзора толпы', () => {
  it('полуоси эллипса — 240 вбок, 207 вниз, 126 вверх', () => {
    expect(SIDE).toBeCloseTo(240, 9);
    expect(DOWN).toBeCloseTo(207, 9);
    expect(UP).toBeCloseTo(126, 9);
  });

  it.each([
    ['вправо', 0, SIDE, 0],
    ['вниз', Math.PI / 2, 0, DOWN],
    ['влево', Math.PI, -SIDE, 0],
    ['вверх', -Math.PI / 2, 0, -UP],
  ])('башня %s — сдвиг вдоль ствола на полуось', (_name, turret, dx, dy) => {
    const shift = shiftAt(turret);
    expect(shift.dx).toBeCloseTo(dx, 6);
    expect(shift.dy).toBeCloseTo(dy, 6);
  });

  it.each([Math.PI / 4, (3 * Math.PI) / 4, -Math.PI / 4, (-3 * Math.PI) / 4, 0.3, -2.5])(
    'башня %f — сдвиг вдоль ствола длиной R(θ)',
    (turret) => {
      const shift = shiftAt(turret);
      expect(Math.hypot(shift.dx, shift.dy)).toBeCloseTo(expectedReach(turret), 6);
      expect(Math.atan2(shift.dy, shift.dx)).toBeCloseTo(turret, 9);
      expect(ffaViewReach(turret)).toBeCloseTo(expectedReach(turret), 9);
    },
  );

  it('около 0 и около π с обеих сторон радиус одинаков — обе половины сходятся на горизонтали', () => {
    expect(ffaViewReach(NEAR)).toBeCloseTo(SIDE, 6);
    expect(ffaViewReach(-NEAR)).toBeCloseTo(SIDE, 6);
    expect(ffaViewReach(Math.PI - NEAR)).toBeCloseTo(SIDE, 6);
    expect(ffaViewReach(-Math.PI + NEAR)).toBeCloseTo(SIDE, 6);
  });

  it('R непрерывна по кругу: соседние углы дают близкие радиусы', () => {
    let previous = ffaViewReach(-Math.PI);
    let largestJump = 0;
    for (let step = 1; step <= CONTINUITY_STEPS; step++) {
      const reach = ffaViewReach(-Math.PI + (2 * Math.PI * step) / CONTINUITY_STEPS);
      largestJump = Math.max(largestJump, Math.abs(reach - previous));
      previous = reach;
    }
    expect(largestJump).toBeLessThan(CONTINUITY_TOLERANCE);
  });
});
