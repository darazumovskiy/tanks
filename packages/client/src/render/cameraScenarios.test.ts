import { ARENA } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { defaultSettings, type Settings } from '../settings.js';
import { TANK_AREA, tankBottomLimit, type Camera, type Point } from './camera.js';
import { ENEMY_AREA, enemyAreaOf, fitRatio, zoomLadder, ZOOM_IN_RATIO, ZOOM_OUT_RATIO } from './cameraLevels.js';
import {
  CAMERA_SCENARIOS,
  centerSpeedViolations,
  checkScenarioInvariants,
  FRAME_MS,
  fractionOf,
  mirrorCamera,
  mirrorX,
  PHONE_SCREENS,
  runTrajectory,
  SETTLE_MS,
  settle,
  type ScreenGeometry,
  type TrajectoryStep,
  type Violation,
} from './cameraScenarios.js';
import { createCameraStrategy, PHONE_CAMERA_MODES, type PhoneCameraMode } from './cameraStrategy.js';

const DEFAULT_SETTINGS = defaultSettings(true);
const GRID_X = [24, 140, 400, 800, 1200, 1460, 1576];
const GRID_Y = [24, 140, 450, 760, 876];
const GRID: Point[] = GRID_X.flatMap((x) => GRID_Y.map((y) => ({ x, y })));
const CONTINUITY_STEP = 2;
const CONTINUITY_TOLERANCE = 6;
const SPAWN_ME: Point = { x: 1460, y: 450 };
const SPAWN_ENEMY: Point = { x: 140, y: 450 };
// Быстрый танк проходит около 4 единиц за кадр; траектории ведут его с этой скоростью, а не телепортами.
const TANK_UNITS_PER_FRAME = 4;
const XIAOMI: ScreenGeometry = { id: 'xiaomi-14t-pro', width: 834, height: 375, pixelRatio: 3.25 };

function format(violations: readonly Violation[]): string {
  return violations.map((v) => `${v.invariant}: ${v.detail}`).join('; ');
}

function expectClose(actual: Camera, expected: Camera, tolerance: number, label: string): void {
  const detail = `${label}: ${JSON.stringify(actual)} против ${JSON.stringify(expected)}`;
  expect(Math.abs(actual.x - expected.x), detail).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y - expected.y), detail).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.height - expected.height), detail).toBeLessThanOrEqual(tolerance);
}

function nearHeight(settings: Readonly<Settings>): number {
  return (ARENA.height * settings.minViewPercent) / 100;
}

function hold(me: Point, enemy: Point | null, holdMs: number): TrajectoryStep {
  return { me, enemy, holdMs };
}

// Траектории для проверки потолка скорости: проезды, круг противника, смерть противника.
function speedTrajectories(): Record<string, TrajectoryStep[]> {
  const bottomDrive: TrajectoryStep[] = [];
  for (let x = 50; x <= 1550; x += TANK_UNITS_PER_FRAME) {
    bottomDrive.push(hold({ x, y: 850 }, { x: 800, y: 200 }, FRAME_MS));
  }
  const leftWallDown: TrajectoryStep[] = [];
  for (let y = 450; y <= 876; y += TANK_UNITS_PER_FRAME) {
    leftWallDown.push(hold({ x: 140, y }, { x: 1460, y: 450 }, FRAME_MS));
  }
  const circle: TrajectoryStep[] = [];
  for (let i = 0; i <= 120; i++) {
    const angle = (i / 120) * Math.PI * 2;
    circle.push(hold({ x: 800, y: 450 }, { x: 800 + 700 * Math.cos(angle), y: 450 + 400 * Math.sin(angle) }, 50));
  }
  return {
    bottomDrive,
    leftWallDown,
    circle,
    enemyDies: [hold({ x: 400, y: 450 }, { x: 1400, y: 450 }, 3000), hold({ x: 400, y: 450 }, null, 3000)],
  };
}

describe.each(PHONE_CAMERA_MODES)('камера «$label»', ({ mode }) => {
  const settings = DEFAULT_SETTINGS;
  const check = (camera: Camera, me: Point, enemy: Point | null): Violation[] =>
    checkScenarioInvariants(mode, settings, camera, me, enemy);

  describe.each(PHONE_SCREENS)('$id', (screen) => {
    it.each(CAMERA_SCENARIOS)('$title', (scenario) => {
      const camera = settle(mode, settings, scenario, screen);
      const violations = [
        ...check(camera, scenario.me, scenario.enemy),
        ...checkModeInvariants(mode, camera, scenario.me, scenario.enemy, settings, screen),
      ];
      expect(violations, format(violations)).toEqual([]);
    });

    it('сетка позиций без предыстории и с приездом из зеркальной точки: C1, C4, C8', () => {
      const violations: string[] = [];
      for (const me of GRID) {
        for (const enemy of GRID) {
          const scenario = { id: 'grid', title: 'grid', me, enemy };
          const camera = settle(mode, settings, scenario, screen);
          const common = check(camera, me, enemy);
          const mirrored = settle(mode, settings, { ...scenario, me: mirrorX(me), enemy: mirrorX(enemy) }, screen);
          const back = mirrorCamera(mirrored);
          const isSymmetric = Math.abs(back.x - camera.x) < 0.01 && Math.abs(back.y - camera.y) < 0.01;
          const strategy = createCameraStrategy(mode, settings);
          const [, arrived] = runTrajectory(
            strategy,
            [hold(mirrorX(me), mirrorX(enemy), SETTLE_MS), hold(me, enemy, SETTLE_MS)],
            screen,
          );
          const withHistory = arrived === undefined ? [] : check(arrived, me, enemy);
          const label = `я (${String(me.x)}, ${String(me.y)}), противник (${String(enemy.x)}, ${String(enemy.y)})`;
          for (const v of [...common, ...withHistory]) {
            violations.push(`${label}: ${v.invariant} ${v.detail}`);
          }
          if (!isSymmetric) {
            violations.push(`${label}: C4 зеркало ${JSON.stringify(back)} против ${JSON.stringify(camera)}`);
          }
        }
      }
      expect(violations.slice(0, 20), `${String(violations.length)} нарушений`).toEqual([]);
    });

    it('C3: сдвиг своего танка на 2 единицы меняет окно не более чем на 6 при том же уровне', () => {
      const violations: string[] = [];
      for (const me of GRID) {
        for (const enemy of [SPAWN_ENEMY, { x: 800, y: 450 }, { x: 1576, y: 876 }, null]) {
          const base = settle(mode, settings, { id: 'c3', title: 'c3', me, enemy }, screen);
          for (const shifted of [
            { x: me.x + CONTINUITY_STEP, y: me.y },
            { x: me.x, y: me.y + CONTINUITY_STEP },
          ]) {
            const moved = settle(mode, settings, { id: 'c3', title: 'c3', me: shifted, enemy }, screen);
            const isSameLevel = Math.abs(moved.height - base.height) < 1;
            if (!isSameLevel) {
              continue;
            }
            const jump = Math.max(Math.abs(moved.x - base.x), Math.abs(moved.y - base.y));
            if (jump > CONTINUITY_TOLERANCE) {
              violations.push(
                `я (${String(me.x)}, ${String(me.y)}) → (${String(shifted.x)}, ${String(shifted.y)}): скачок ${jump.toFixed(1)}`,
              );
            }
          }
        }
      }
      expect(violations.slice(0, 20), `${String(violations.length)} нарушений`).toEqual([]);
    });

    it('C5: сходимость — окно через 4 с и через 8 с одинаково', () => {
      for (const scenario of CAMERA_SCENARIOS) {
        const strategy = createCameraStrategy(mode, settings);
        const [half, full] = runTrajectory(
          strategy,
          [hold(scenario.me, scenario.enemy, SETTLE_MS / 2), hold(scenario.me, scenario.enemy, SETTLE_MS / 2)],
          screen,
        );
        if (half === undefined || full === undefined) {
          throw new Error('нет кадров');
        }
        expectClose(half, full, 1, scenario.id);
      }
    });

    it('C6: первый кадр после сброса — установившееся состояние', () => {
      const strategy = createCameraStrategy(mode, settings);
      runTrajectory(strategy, [hold({ x: 60, y: 840 }, { x: 160, y: 760 }, SETTLE_MS)], screen);
      strategy.reset();
      const canvasWidth = screen.width * screen.pixelRatio;
      const canvasHeight = screen.height * screen.pixelRatio;
      const first = strategy.update({ me: SPAWN_ME, enemy: SPAWN_ENEMY, canvasWidth, canvasHeight }, FRAME_MS);
      const settled = settle(mode, settings, { id: 'spawn', title: 'spawn', me: SPAWN_ME, enemy: SPAWN_ENEMY }, screen);
      expectClose(first, settled, 1, 'после сброса');
    });

    it('C7: шаг кадра 16 и 33 мс даёт одно окно', () => {
      for (const scenario of CAMERA_SCENARIOS) {
        const canvasWidth = screen.width * screen.pixelRatio;
        const canvasHeight = screen.height * screen.pixelRatio;
        const input = { me: scenario.me, enemy: scenario.enemy, canvasWidth, canvasHeight };
        const fine = createCameraStrategy(mode, settings);
        const coarse = createCameraStrategy(mode, settings);
        let fineCamera = fine.update(input, FRAME_MS);
        let coarseCamera = coarse.update(input, 33);
        for (let elapsed = 0; elapsed < SETTLE_MS; elapsed += 33) {
          fineCamera = fine.update(input, FRAME_MS);
          fineCamera = fine.update(input, 33 - FRAME_MS);
          coarseCamera = coarse.update(input, 33);
        }
        expectClose(fineCamera, coarseCamera, 1, scenario.id);
      }
    });

    it('C9: скорость центра не выше потолка на траекториях', () => {
      for (const [name, steps] of Object.entries(speedTrajectories())) {
        const frames: Camera[] = [];
        const strategy = createCameraStrategy(mode, settings);
        runTrajectory(strategy, steps, screen, (camera) => {
          frames.push(camera);
        });
        const violations = centerSpeedViolations(frames);
        expect(violations.slice(0, 5), `${name}: ${format(violations)}`).toEqual([]);
        const last = frames.at(-1);
        const lastStep = steps.at(-1);
        if (last === undefined || lastStep === undefined) {
          throw new Error('нет кадров');
        }
        const common = check(last, lastStep.me, lastStep.enemy);
        expect(common, `${name}: ${format(common)}`).toEqual([]);
      }
    });
  });
});

function checkModeInvariants(
  mode: PhoneCameraMode,
  camera: Camera,
  me: Point,
  enemy: Point | null,
  settings: Readonly<Settings>,
  screen: ScreenGeometry,
): Violation[] {
  if (mode === 'follow') {
    return checkFollowInvariants(camera, settings);
  }
  return checkLevelInvariants(camera, me, enemy, settings, screen, mode === 'pair');
}

// F1: высота окна — всегда настройка обзора.
function checkFollowInvariants(camera: Camera, settings: Readonly<Settings>): Violation[] {
  if (Math.abs(camera.height - nearHeight(settings)) > 1) {
    return [
      { invariant: 'F1', detail: `высота ${camera.height.toFixed(0)} вместо ${nearHeight(settings).toFixed(0)}` },
    ];
  }
  return [];
}

// P1/P2 в статике: уровень — первый на лестнице, где пара помещается (не помещается нигде — первый дальний),
// либо выше, если спуск заперт гистерезисом (отношение на уровне ниже ≥ 0,85); на уровне, где пара
// помещается, противник в коробке этого уровня (на ближнем — только в `pair`).
function checkLevelInvariants(
  camera: Camera,
  me: Point,
  enemy: Point | null,
  settings: Readonly<Settings>,
  screen: ScreenGeometry,
  hasEnemyBox: boolean,
): Violation[] {
  if (enemy === null) {
    return [];
  }
  const ladder = zoomLadder(nearHeight(settings));
  const aspect = screen.width / screen.height;
  const meBottom = tankBottomLimit(fractionOf(camera, me).fx);
  const ratios = ladder.map((level) => fitRatio(me, enemy, level, aspect, meBottom));
  const fitting = ratios.findIndex((ratio) => ratio <= ZOOM_OUT_RATIO);
  const firstFar = Math.max(
    0,
    ladder.findIndex((level) => level.isFar),
  );
  const expectedIndex = fitting === -1 ? firstFar : fitting;
  const acceptable = new Set<number>([expectedIndex]);
  for (let index = expectedIndex + 1; index < ladder.length; index++) {
    const below = ratios[index - 1];
    if (below === undefined || below < ZOOM_IN_RATIO) {
      break;
    }
    acceptable.add(index);
  }
  const actualIndex = ladder.findIndex((level) => Math.abs(level.height - camera.height) <= 1);
  const violations: Violation[] = [];
  if (!acceptable.has(actualIndex)) {
    violations.push({
      invariant: 'P1',
      detail: `отношения ${ratios.map((r) => r.toFixed(2)).join('/')}, высота ${camera.height.toFixed(0)}`,
    });
    return violations;
  }
  const level = ladder[actualIndex];
  const ratio = ratios[actualIndex];
  if (level === undefined || ratio === undefined || ratio > ZOOM_OUT_RATIO) {
    return violations;
  }
  if (!hasEnemyBox && !level.isFar) {
    return violations;
  }
  const area = enemyAreaOf(level);
  const f = fractionOf(camera, enemy);
  const isInside =
    f.fx >= area.left - 1e-3 && f.fx <= area.right + 1e-3 && f.fy >= area.top - 1e-3 && f.fy <= area.bottom + 1e-3;
  if (!isInside) {
    violations.push({
      invariant: 'P2',
      detail: `противник вне коробки уровня ${level.height.toFixed(0)}: ${(f.fx * 100).toFixed(0)} % / ${(f.fy * 100).toFixed(0)} %`,
    });
  }
  return violations;
}

describe('камера «За своим танком»: упреждение и мёртвая зона', () => {
  const settings = DEFAULT_SETTINGS;
  const screen = XIAOMI;

  it('F2: противник рядом — свой танк в точке покоя; далеко справа — смещён влево до потолка', () => {
    const close = settle(
      'follow',
      settings,
      { id: 'f2', title: 'f2', me: { x: 800, y: 450 }, enemy: { x: 900, y: 450 } },
      screen,
    );
    const closeMe = fractionOf(close, { x: 800, y: 450 });
    expect(Math.abs(closeMe.fx - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(closeMe.fy - 0.4)).toBeLessThan(0.01);
    const far = settle(
      'follow',
      settings,
      { id: 'f2', title: 'f2', me: { x: 800, y: 450 }, enemy: { x: 1576, y: 450 } },
      screen,
    );
    const farMe = fractionOf(far, { x: 800, y: 450 });
    expect(farMe.fx).toBeGreaterThanOrEqual(0.35 - 0.01);
    expect(farMe.fx).toBeLessThanOrEqual(0.37);
  });

  it('F3: колебание своего танка внутри мёртвой зоны не двигает окно', () => {
    const strategy = createCameraStrategy('follow', settings);
    const enemy = { x: 1576, y: 450 };
    runTrajectory(strategy, [hold({ x: 800, y: 450 }, enemy, SETTLE_MS)], screen);
    const xs: number[] = [];
    const steps: TrajectoryStep[] = [];
    for (let i = 0; i < 120; i++) {
      const phase = (i / 120) * Math.PI * 2;
      steps.push(hold({ x: 800 + 20 * Math.sin(phase * 7), y: 450 + 10 * Math.cos(phase * 5) }, enemy, FRAME_MS));
    }
    runTrajectory(strategy, steps, screen, (camera) => {
      xs.push(camera.x);
    });
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.5);
  });

  it('F4: противник уничтожен — упреждение затухает, танк возвращается к точке покоя', () => {
    const strategy = createCameraStrategy('follow', settings);
    const me = { x: 800, y: 450 };
    const [withEnemy, alone] = runTrajectory(
      strategy,
      [hold(me, { x: 1576, y: 450 }, SETTLE_MS), hold(me, null, SETTLE_MS)],
      screen,
    );
    if (withEnemy === undefined || alone === undefined) {
      throw new Error('нет кадров');
    }
    expect(fractionOf(withEnemy, me).fx).toBeLessThan(0.4);
    expect(Math.abs(fractionOf(alone, me).fx - 0.5)).toBeLessThanOrEqual(0.04 + 1e-3);
  });

  it('упреждение живёт на дальнем уровне: после возврата камера не едет сначала в старую сторону', () => {
    const strategy = createCameraStrategy('followZoom', settings);
    const me = { x: 800, y: 450 };
    runTrajectory(strategy, [hold(me, { x: 1576, y: 450 }, 4000), hold(me, { x: 1576, y: 24 }, 4000)], screen);
    const centers: number[] = [];
    runTrajectory(strategy, [hold(me, { x: 400, y: 500 }, 4000)], screen, (camera) => {
      centers.push(camera.x + camera.width / 2);
    });
    const start = centers[0];
    if (start === undefined) {
      throw new Error('нет кадров');
    }
    expect(Math.max(...centers)).toBeLessThanOrEqual(start + 10);
  });

  it('свой танк у нижней стенки: у бока — на половине экрана, в середине — на трёх четвертях', () => {
    const atSide = settle('follow', settings, { id: 's', title: 's', me: { x: 24, y: 876 }, enemy: null }, screen);
    expect(fractionOf(atSide, { x: 24, y: 876 }).fy).toBeCloseTo(TANK_AREA.bottomAtSides, 2);
    const atCenter = settle('follow', settings, { id: 'c', title: 'c', me: { x: 800, y: 876 }, enemy: null }, screen);
    expect(fractionOf(atCenter, { x: 800, y: 876 }).fy).toBeCloseTo(TANK_AREA.bottomAtCenter, 2);
  });
});

describe.each(['followZoom', 'pair'] as const)('камера %s: уровни масштаба', (mode) => {
  const settings = DEFAULT_SETTINGS;
  const screen = XIAOMI;
  const near = nearHeight(settings);
  const aspect = screen.width / screen.height;
  const me = { x: 600, y: 450 };
  // Разнос по x, при котором отношение к пределу ближнего уровня равно `ratio`.
  const enemyAt = (ratio: number): Point => ({
    x: me.x + ratio * (ENEMY_AREA.right - TANK_AREA.left) * near * aspect,
    y: 450,
  });

  it('P2 и P4: сближение–разъезд трижды — каждый раз приближение после паузы и быстрое отдаление', () => {
    const strategy = createCameraStrategy(mode, settings);
    const steps: TrajectoryStep[] = [];
    for (let i = 0; i < 3; i++) {
      steps.push(hold(me, enemyAt(0.5), 5000), hold(me, enemyAt(1.3), 2000));
    }
    const settled = runTrajectory(strategy, steps, screen);
    settled.forEach((camera, index) => {
      const expected = index % 2 === 0 ? near : ARENA.height;
      expect(Math.abs(camera.height - expected), `шаг ${String(index)}`).toBeLessThan(8);
    });
  });

  it('P3: дистанция колеблется в полосе гистерезиса — уровень не меняется', () => {
    for (const start of [0.5, 1.3]) {
      const strategy = createCameraStrategy(mode, settings);
      const steps: TrajectoryStep[] = [hold(me, enemyAt(start), 4000)];
      for (let i = 0; i < 20; i++) {
        steps.push(hold(me, enemyAt(0.88), 500), hold(me, enemyAt(0.98), 500));
      }
      const settled = runTrajectory(strategy, steps, screen);
      const first = settled[0];
      if (first === undefined) {
        throw new Error('нет кадров');
      }
      for (const camera of settled) {
        expect(Math.abs(camera.height - first.height)).toBeLessThan(1);
      }
    }
  });

  it('P4: приближение требует 1,5 с, отдаление — 0,15 с', () => {
    const strategy = createCameraStrategy(mode, settings);
    const [far, soon, later] = runTrajectory(
      strategy,
      [hold(me, enemyAt(1.3), 4000), hold(me, enemyAt(0.5), 1000), hold(me, enemyAt(0.5), 4000)],
      screen,
    );
    if (far === undefined || soon === undefined || later === undefined) {
      throw new Error('нет кадров');
    }
    expect(far.height).toBeCloseTo(ARENA.height, 0);
    expect(soon.height).toBeCloseTo(ARENA.height, 0);
    expect(Math.abs(later.height - near)).toBeLessThan(8);
    const [, out] = runTrajectory(
      createCameraStrategy(mode, settings),
      [hold(me, enemyAt(0.5), 4000), hold(me, enemyAt(1.3), 1000)],
      screen,
    );
    if (out === undefined) {
      throw new Error('нет кадров');
    }
    expect(out.height).toBeGreaterThan(near + (ARENA.height - near) * 0.75);
  });

  it('P5: противник уничтожен — уровень не меняется', () => {
    for (const start of [0.5, 1.3]) {
      const [before, after] = runTrajectory(
        createCameraStrategy(mode, settings),
        [hold(me, enemyAt(start), 4000), hold(me, null, 4000)],
        screen,
      );
      if (before === undefined || after === undefined) {
        throw new Error('нет кадров');
      }
      expect(Math.abs(after.height - before.height)).toBeLessThan(1);
    }
  });

  it('P3: в полосе гистерезиса выдержка приближения не сбрасывается — колебание 0,8/0,9 всё же приближает', () => {
    const strategy = createCameraStrategy(mode, settings);
    const steps: TrajectoryStep[] = [hold(me, enemyAt(1.3), 3000)];
    for (let i = 0; i < 12; i++) {
      steps.push(hold(me, enemyAt(0.8), 200), hold(me, enemyAt(0.9), 200));
    }
    steps.push(hold(me, enemyAt(0.9), 3000));
    const settled = runTrajectory(strategy, steps, screen);
    const last = settled.at(-1);
    if (last === undefined) {
      throw new Error('нет кадров');
    }
    expect(Math.abs(last.height - near)).toBeLessThan(8);
  });

  it('третий уровень: я у нижней стенки сбоку, противник в средней полосе — полтора поля и противник в кадре', () => {
    const scenario = { id: 't', title: 't', me: { x: 100, y: 876 }, enemy: { x: 300, y: 400 } };
    const camera = settle(mode, settings, scenario, screen);
    expect(camera.height).toBeCloseTo(ARENA.height * 1.5, 0);
    const f = fractionOf(camera, scenario.enemy);
    expect(f.fy).toBeGreaterThanOrEqual(0.04 - 1e-3);
    expect(fractionOf(camera, scenario.me).fy).toBeLessThanOrEqual(0.5 + 1e-3);
  });

  it('смена стратегии при мёртвом противнике сохраняет уровень', () => {
    for (const from of ['follow', 'followZoom', 'pair'] as const) {
      for (const startRatio of [0.5, 1.3]) {
        const source = createCameraStrategy(from, settings);
        const [, before] = runTrajectory(source, [hold(me, enemyAt(startRatio), 4000), hold(me, null, 1000)], screen);
        const target = createCameraStrategy(mode, settings);
        if (before === undefined) {
          throw new Error('нет кадров');
        }
        target.adopt(before);
        const [after] = runTrajectory(target, [hold(me, null, 4000)], screen);
        expect(after?.height, `${from} → ${mode} при отношении ${String(startRatio)}`).toBeCloseTo(before.height, 0);
      }
    }
  });

  it('P6: старт раунда — поле по центру, пустота симметрична', () => {
    const camera = settle(mode, settings, { id: 'spawn', title: 'spawn', me: SPAWN_ME, enemy: SPAWN_ENEMY }, screen);
    expect(camera.height).toBeCloseTo(ARENA.height, 0);
    expect(Math.abs(-camera.x - (camera.x + camera.width - ARENA.width))).toBeLessThan(1);
    expect(Math.abs(camera.y)).toBeLessThan(1);
  });
});
