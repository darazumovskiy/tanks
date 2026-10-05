import { describe, expect, it } from 'vitest';
import { FFA, type Point } from '@tanks/shared/engine';
import { TANK_AREA, tankBottomLimit } from '../render/camera.js';
import { FfaCamera, ffaCameraWindow, type FfaAim, type FfaFraming, type ScreenSize } from './ffaCamera.js';

const W = FFA.viewWidth;
const H = FFA.viewHeight;
const FRAME_MS = 16;
const EPSILON = 1e-6;
const SCREENS: readonly ScreenSize[] = [
  { width: 844, height: 390 },
  { width: 1280, height: 720 },
  { width: 960, height: 1080 },
  { width: 1024, height: 768 },
  { width: 2560, height: 1080 },
];
const DEGREE = Math.PI / 180;
const TURRET_STEP_DEGREES = 5;
const CURSOR_STEPS = 10;
const TANK_SPEED = 160;
const SETTLE_FRAMES = 60;
const HALF_LIFE_MS = 250;
const MAX_SPEED = 800;
// От поворота башни сдвиг не быстрее ≈ 720 единиц/с.
const TURRET_SHIFT_SPEED = 720;
const TURRET_RATE = 2.8;

function turretAims(): FfaAim[] {
  const aims: FfaAim[] = [];
  for (let degrees = -180; degrees < 180; degrees += TURRET_STEP_DEGREES) {
    aims.push({ kind: 'turret', angle: degrees * DEGREE });
  }
  return aims;
}

function cursorAims(): FfaAim[] {
  const aims: FfaAim[] = [];
  for (let col = 0; col <= CURSOR_STEPS; col++) {
    for (let row = 0; row <= CURSOR_STEPS; row++) {
      aims.push({ kind: 'mouse', cursor: { x: col / CURSOR_STEPS, y: row / CURSOR_STEPS } });
    }
  }
  return aims;
}

// Свойства кадра: окно — наибольший прямоугольник пропорций экрана, сдвиг по осям умножен на долю окна,
// свой танк в разрешённой области, экран внутри окна обзора W × H вокруг точки камеры.
function expectFrameInvariants(framing: FfaFraming, focus: Point, screen: ScreenSize): void {
  const { camera, viewCenter } = framing;
  const aspect = screen.width / screen.height;
  expect(camera.width / camera.height).toBeCloseTo(aspect, 9);
  expect(camera.width).toBeLessThanOrEqual(W + EPSILON);
  expect(camera.height).toBeLessThanOrEqual(H + EPSILON);
  expect(Math.max(camera.width / W, camera.height / H)).toBeCloseTo(1, 9);
  expect(camera.scale).toBeCloseTo(screen.height / camera.height, 9);
  const shiftX = viewCenter.x - focus.x;
  const shiftY = viewCenter.y - focus.y;
  expect(camera.x + camera.width / 2 - focus.x).toBeCloseTo((camera.width / W) * shiftX, 6);
  expect(camera.y + camera.height / 2 - focus.y).toBeCloseTo((camera.height / H) * shiftY, 6);
  const fx = (focus.x - camera.x) / camera.width;
  const fy = (focus.y - camera.y) / camera.height;
  expect(fx).toBeGreaterThanOrEqual(TANK_AREA.left);
  expect(fx).toBeLessThanOrEqual(TANK_AREA.right);
  expect(fy).toBeGreaterThanOrEqual(TANK_AREA.top);
  expect(fy).toBeLessThanOrEqual(tankBottomLimit(fx) + EPSILON);
  expect(fx).toBeGreaterThanOrEqual(0.35 - EPSILON);
  expect(fx).toBeLessThanOrEqual(0.65 + EPSILON);
  expect(fy).toBeGreaterThanOrEqual(0.27 - EPSILON);
  expect(fy).toBeLessThanOrEqual(0.64 + EPSILON);
  expect(camera.x).toBeGreaterThanOrEqual(viewCenter.x - W / 2 - EPSILON);
  expect(camera.x + camera.width).toBeLessThanOrEqual(viewCenter.x + W / 2 + EPSILON);
  expect(camera.y).toBeGreaterThanOrEqual(viewCenter.y - H / 2 - EPSILON);
  expect(camera.y + camera.height).toBeLessThanOrEqual(viewCenter.y + H / 2 + EPSILON);
}

function shiftOf(framing: FfaFraming, focus: Point): Point {
  return { x: framing.viewCenter.x - focus.x, y: framing.viewCenter.y - focus.y };
}

describe('окно камеры толпы', () => {
  it.each(SCREENS)('экран $width × $height — наибольший прямоугольник его пропорций внутри 1600 × 900', (screen) => {
    const window = ffaCameraWindow(screen);
    const isWide = screen.width / screen.height >= W / H;
    expect(isWide ? window.width : window.height).toBe(isWide ? W : H);
    expect(window.width / window.height).toBeCloseTo(screen.width / screen.height, 9);
  });
});

describe('камера толпы: свойства каждого кадра', () => {
  it.each(SCREENS)(
    'экран $width × $height: башня через 5°, курсор по сетке, танк стоит и едет, смена цели',
    (screen) => {
      const camera = new FfaCamera();
      const aims = [...turretAims(), ...cursorAims()];
      let focus = { x: 3000, y: 1500 };
      let frames = 0;
      for (const aim of aims) {
        for (let frame = 0; frame < SETTLE_FRAMES / 4; frame++) {
          const isDriving = frames % 2 === 0;
          if (isDriving) {
            focus = { x: focus.x + (TANK_SPEED * FRAME_MS) / 1000, y: focus.y - (TANK_SPEED * FRAME_MS) / 2000 };
          }
          expectFrameInvariants(camera.update(focus, aim, screen, FRAME_MS), focus, screen);
          frames++;
        }
      }
    },
  );

  it.each(SCREENS)('экран $width × $height: курсор в центре — танк в центре экрана', (screen) => {
    const camera = new FfaCamera();
    const focus = { x: 500, y: 400 };
    const framing = camera.update(focus, { kind: 'mouse', cursor: { x: 0.5, y: 0.5 } }, screen, FRAME_MS);
    expect((focus.x - framing.camera.x) / framing.camera.width).toBeCloseTo(0.5, 9);
    expect((focus.y - framing.camera.y) / framing.camera.height).toBeCloseTo(0.5, 9);
  });

  it('курсор за краем экрана — сдвиг полный, не дальше', () => {
    const screen = { width: 1280, height: 720 };
    const focus = { x: 500, y: 400 };
    const framing = new FfaCamera().update(focus, { kind: 'mouse', cursor: { x: 1.6, y: 0.5 } }, screen, FRAME_MS);
    expect(shiftOf(framing, focus).x).toBeCloseTo(240, 9);
    expectFrameInvariants(framing, focus, screen);
  });

  it('без наведения — точка камеры на самом фокусе', () => {
    const framing = new FfaCamera().update(
      { x: 2600, y: 1450 },
      { kind: 'none' },
      { width: 1280, height: 720 },
      FRAME_MS,
    );
    expect(framing.viewCenter).toEqual({ x: 2600, y: 1450 });
  });
});

describe('сглаживание сдвига на 1280 × 720', () => {
  const SCREEN: ScreenSize = { width: 1280, height: 720 };
  const FOCUS = { x: 1000, y: 1000 };
  const CENTER: FfaAim = { kind: 'mouse', cursor: { x: 0.5, y: 0.5 } };
  const RIGHT_EDGE: FfaAim = { kind: 'mouse', cursor: { x: 1, y: 0.5 } };
  const LEFT_EDGE: FfaAim = { kind: 'mouse', cursor: { x: 0, y: 0.5 } };

  function settled(aim: FfaAim): FfaCamera {
    const camera = new FfaCamera();
    camera.update(FOCUS, aim, SCREEN, FRAME_MS);
    return camera;
  }

  it('курсор из центра к правому краю: половина пути 0 → 240 за 250 мс (± кадр)', () => {
    const camera = settled(CENTER);
    let elapsed = 0;
    let shiftX = 0;
    while (shiftX < 120) {
      elapsed += FRAME_MS;
      shiftX = shiftOf(camera.update(FOCUS, RIGHT_EDGE, SCREEN, FRAME_MS), FOCUS).x;
    }
    expect(Math.abs(elapsed - HALF_LIFE_MS)).toBeLessThanOrEqual(FRAME_MS);
    for (let frame = 0; frame < 300; frame++) {
      shiftX = shiftOf(camera.update(FOCUS, RIGHT_EDGE, SCREEN, FRAME_MS), FOCUS).x;
    }
    expect(shiftX).toBeCloseTo(240, 1);
  });

  it('курсор от левого края к правому: −240 → 240 не быстрее 800 единиц/с', () => {
    const camera = settled(LEFT_EDGE);
    let previous = shiftOf(camera.update(FOCUS, LEFT_EDGE, SCREEN, FRAME_MS), FOCUS).x;
    expect(previous).toBeCloseTo(-240, 6);
    let fastest = 0;
    for (let frame = 0; frame < 300; frame++) {
      const shiftX = shiftOf(camera.update(FOCUS, RIGHT_EDGE, SCREEN, FRAME_MS), FOCUS).x;
      fastest = Math.max(fastest, (Math.abs(shiftX - previous) * 1000) / FRAME_MS);
      previous = shiftX;
    }
    expect(fastest).toBeLessThanOrEqual(MAX_SPEED + EPSILON);
    expect(fastest).toBeGreaterThan(MAX_SPEED * 0.99);
    expect(previous).toBeCloseTo(240, 1);
  });

  it('башня повернулась вправо-вверх на 90° при касании: сдвиг не быстрее 720 единиц/с', () => {
    const camera = settled({ kind: 'turret', angle: 0 });
    let previous = shiftOf(camera.update(FOCUS, { kind: 'turret', angle: 0 }, SCREEN, FRAME_MS), FOCUS);
    let fastest = 0;
    for (let frame = 1; frame < 400; frame++) {
      const angle = -Math.min(Math.PI / 2, (TURRET_RATE * frame * FRAME_MS) / 1000);
      const shift = shiftOf(camera.update(FOCUS, { kind: 'turret', angle }, SCREEN, FRAME_MS), FOCUS);
      fastest = Math.max(fastest, (Math.hypot(shift.x - previous.x, shift.y - previous.y) * 1000) / FRAME_MS);
      previous = shift;
    }
    expect(fastest).toBeLessThanOrEqual(TURRET_SHIFT_SPEED);
    expect(previous.y).toBeCloseTo(-126, 1);
  });

  it('танк едет — камера ведёт его без отставания: сдвиг тот же, что у стоящего', () => {
    const still = settled(CENTER);
    const moving = settled(CENTER);
    for (let frame = 0; frame < 60; frame++) {
      const focus = { x: FOCUS.x + frame * 3, y: FOCUS.y - frame * 2 };
      const atRest = still.update(FOCUS, RIGHT_EDGE, SCREEN, FRAME_MS);
      const driving = moving.update(focus, RIGHT_EDGE, SCREEN, FRAME_MS);
      expect(shiftOf(driving, focus).x).toBeCloseTo(shiftOf(atRest, FOCUS).x, 9);
      expect(driving.camera.x - focus.x).toBeCloseTo(atRest.camera.x - FOCUS.x, 9);
    }
  });

  it('перестановка — сразу на целевой сдвиг', () => {
    const camera = settled(LEFT_EDGE);
    camera.snap();
    expect(shiftOf(camera.update(FOCUS, RIGHT_EDGE, SCREEN, FRAME_MS), FOCUS).x).toBeCloseTo(240, 9);
  });
});
