import { ARENA } from '@tanks/shared/engine';
import type { Settings } from '../settings.js';
import { CAMERA_MAX_SPEED, TANK_AREA, tankBottomLimit, type Camera, type Point } from './camera.js';
import { FOLLOW_VOID_LIMIT } from './cameraFollow.js';
import { ENEMY_AREA, FAR_ENEMY_AREA, isFarCamera, type ScreenArea } from './cameraLevels.js';
import { createCameraStrategy, type CameraInput, type CameraStrategy, type PhoneCameraMode } from './cameraStrategy.js';

// Сценарий — положения танков на поле; противник `null` — мёртв или ушёл.
export interface CameraScenario {
  id: string;
  title: string;
  me: Point;
  enemy: Point | null;
}

// Геометрия экрана телефона в CSS-пикселях и плотность; холст = CSS × плотность.
export interface ScreenGeometry {
  id: string;
  width: number;
  height: number;
  pixelRatio: number;
}

export const PHONE_SCREENS: readonly ScreenGeometry[] = [
  { id: 'xiaomi-14t-pro', width: 834, height: 375, pixelRatio: 3.25 },
  { id: 'phone-844', width: 844, height: 390, pixelRatio: 2.6 },
  { id: 'tablet-16x9', width: 1024, height: 576, pixelRatio: 2 },
];

const EDGE = 60;
const CENTER: Point = { x: ARENA.width / 2, y: ARENA.height / 2 };

export const CAMERA_SCENARIOS: readonly CameraScenario[] = [
  {
    id: 'spawn',
    title: 'Старт раунда: танки на противоположных краях',
    me: { x: 1460, y: 450 },
    enemy: { x: 140, y: 450 },
  },
  { id: 'left-wall', title: 'Оба у левой стенки', me: { x: 24, y: 450 }, enemy: { x: 120, y: 500 } },
  { id: 'right-wall', title: 'Оба у правой стенки', me: { x: 1576, y: 450 }, enemy: { x: 1480, y: 400 } },
  { id: 'top-wall', title: 'Оба у верхней стенки', me: { x: 800, y: 24 }, enemy: { x: 700, y: 80 } },
  { id: 'bottom-wall', title: 'Оба у нижней стенки', me: { x: 800, y: 876 }, enemy: { x: 900, y: 820 } },
  {
    id: 'corner-bl',
    title: 'Оба в левом нижнем углу',
    me: { x: EDGE, y: ARENA.height - EDGE },
    enemy: { x: 160, y: 760 },
  },
  {
    id: 'corner-br',
    title: 'Оба в правом нижнем углу',
    me: { x: ARENA.width - EDGE, y: ARENA.height - EDGE },
    enemy: { x: 1440, y: 760 },
  },
  { id: 'corner-tl', title: 'Оба в левом верхнем углу', me: { x: EDGE, y: EDGE }, enemy: { x: 160, y: 140 } },
  {
    id: 'corner-tr',
    title: 'Оба в правом верхнем углу',
    me: { x: ARENA.width - EDGE, y: EDGE },
    enemy: { x: 1440, y: 140 },
  },
  {
    id: 'diagonal',
    title: 'Диагональ через всё поле',
    me: { x: EDGE, y: ARENA.height - EDGE },
    enemy: { x: ARENA.width - EDGE, y: EDGE },
  },
  {
    id: 'me-corner-enemy-center',
    title: 'Я в углу, противник в центре',
    me: { x: EDGE, y: ARENA.height - EDGE },
    enemy: CENTER,
  },
  {
    id: 'me-center-enemy-corner',
    title: 'Я в центре, противник в углу',
    me: CENTER,
    enemy: { x: ARENA.width - EDGE, y: EDGE },
  },
  { id: 'close-center', title: 'Вплотную в центре', me: { x: 780, y: 460 }, enemy: { x: 860, y: 430 } },
  {
    id: 'medium-horizontal',
    title: 'Среднее расстояние по горизонтали',
    me: { x: 500, y: 450 },
    enemy: { x: 1100, y: 450 },
  },
  {
    id: 'medium-vertical',
    title: 'Среднее расстояние по вертикали',
    me: { x: 800, y: 150 },
    enemy: { x: 800, y: 750 },
  },
  {
    id: 'enemy-above-close',
    title: 'Противник прямо надо мной, близко',
    me: { x: 800, y: 700 },
    enemy: { x: 800, y: 480 },
  },
  {
    id: 'alone-corner',
    title: 'Противник мёртв, я в левом нижнем углу',
    me: { x: EDGE, y: ARENA.height - EDGE },
    enemy: null,
  },
  { id: 'alone-center', title: 'Противник мёртв, я в центре', me: CENTER, enemy: null },
  {
    id: 'me-bottom-center',
    title: 'Я внизу по центру, противник сверху',
    me: { x: 800, y: 876 },
    enemy: { x: 800, y: 300 },
  },
  {
    id: 'me-bottom-left-enemy-right',
    title: 'Я внизу слева, противник справа на той же высоте',
    me: { x: 200, y: 850 },
    enemy: { x: 1100, y: 850 },
  },
];

// Траектория: точки с временем удержания; конвейер гоняется кадрами по 16 мс без сброса между точками.
export interface TrajectoryStep {
  me: Point;
  enemy: Point | null;
  holdMs: number;
}

export const FRAME_MS = 16;
// Самое медленное звено — приближение в `pair` с полупериодом 600 мс: за 8 с остаток пути меньше единицы.
export const SETTLE_MS = 8000;

export function runTrajectory(
  strategy: CameraStrategy,
  steps: readonly TrajectoryStep[],
  screen: ScreenGeometry,
  onFrame?: (camera: Camera, step: TrajectoryStep) => void,
): Camera[] {
  const canvasWidth = screen.width * screen.pixelRatio;
  const canvasHeight = screen.height * screen.pixelRatio;
  const settled: Camera[] = [];
  for (const step of steps) {
    const input: CameraInput = { me: step.me, enemy: step.enemy, canvasWidth, canvasHeight };
    let camera = strategy.update(input, FRAME_MS);
    onFrame?.(camera, step);
    for (let elapsed = FRAME_MS; elapsed < step.holdMs; elapsed += FRAME_MS) {
      camera = strategy.update(input, FRAME_MS);
      onFrame?.(camera, step);
    }
    settled.push(camera);
  }
  return settled;
}

export function settle(
  mode: PhoneCameraMode,
  settings: Readonly<Settings>,
  scenario: CameraScenario,
  screen: ScreenGeometry,
): Camera {
  const strategy = createCameraStrategy(mode, settings);
  const [camera] = runTrajectory(strategy, [{ me: scenario.me, enemy: scenario.enemy, holdMs: SETTLE_MS }], screen);
  if (camera === undefined) {
    throw new Error('пустая траектория');
  }
  return camera;
}

export interface Violation {
  invariant: string;
  detail: string;
}

export interface ScreenFraction {
  fx: number;
  fy: number;
}

export function fractionOf(camera: Camera, point: Point): ScreenFraction {
  return { fx: (point.x - camera.x) / camera.width, fy: (point.y - camera.y) / camera.height };
}

const EPS = 1e-6;
// Запас на округление сглаживания: за 4 с камера подходит к цели ближе единицы, но не точно.
const SETTLE_TOLERANCE = 1;

export interface VoidLimits {
  x: number;
  y: number;
}

export function voidLimitsFor(mode: PhoneCameraMode, settings: Readonly<Settings>): VoidLimits {
  if (mode === 'pair') {
    const share = settings.pairVoidPercent / 100;
    return { x: share, y: share };
  }
  return FOLLOW_VOID_LIMIT;
}

// Коробка противника, ради которой стратегия вправе выйти за лимит пустоты; `null` — стратегия так не делает.
export function enemyAreaFor(mode: PhoneCameraMode, camera: Camera): ScreenArea | null {
  if (isFarCamera(camera) && mode !== 'follow') {
    return FAR_ENEMY_AREA;
  }
  return mode === 'pair' ? ENEMY_AREA : null;
}

// Полный набор общих инвариантов для сценария: стратегия задаёт лимит пустоты и коробку противника.
export function checkScenarioInvariants(
  mode: PhoneCameraMode,
  settings: Readonly<Settings>,
  camera: Camera,
  me: Point,
  enemy: Point | null,
): Violation[] {
  return checkCommonInvariants({
    camera,
    me,
    enemy,
    minViewPercent: settings.minViewPercent,
    voidLimits: voidLimitsFor(mode, settings),
    enemyArea: enemyAreaFor(mode, camera),
  });
}

// Пустота за полем по сторонам, в единицах поля.
export function voidAround(camera: Camera): { left: number; right: number; top: number; bottom: number } {
  return {
    left: Math.max(0, -camera.x),
    right: Math.max(0, camera.x + camera.width - ARENA.width),
    top: Math.max(0, -camera.y),
    bottom: Math.max(0, camera.y + camera.height - ARENA.height),
  };
}

export interface CommonInvariantInput {
  camera: Camera;
  me: Point;
  minViewPercent: number;
  voidLimits: VoidLimits;
  // Противник и коробка, ради которой стратегия вправе выйти за лимит пустоты; `null` — стратегия так не делает.
  enemy: Point | null;
  enemyArea: ScreenArea | null;
}

const BOUND_TOLERANCE = 1e-3;

function isAtBound(value: number, bounds: readonly number[]): boolean {
  return bounds.some((bound) => Math.abs(value - bound) < BOUND_TOLERANCE);
}

// Общие инварианты установившегося окна для любой стратегии на телефоне. Лимит пустоты — долями окна;
// он может быть превышен, только когда по этой оси свой танк стоит ровно на границе разрешённой области
// или противник — на границе своей коробки.
export function checkCommonInvariants(input: CommonInvariantInput): Violation[] {
  const { camera, me, minViewPercent, voidLimits } = input;
  const violations: Violation[] = [];
  const f = fractionOf(camera, me);
  const bottom = tankBottomLimit(f.fx);
  const isInsideX = f.fx >= TANK_AREA.left - EPS && f.fx <= TANK_AREA.right + EPS;
  const isInsideY = f.fy >= TANK_AREA.top - EPS && f.fy <= bottom + EPS;
  if (!isInsideX || !isInsideY) {
    violations.push({
      invariant: 'C1',
      detail: `свой танк на ${pct(f.fx)} / ${pct(f.fy)} экрана, нижняя граница ${pct(bottom)}`,
    });
  }
  const minViewHeight = (ARENA.height * minViewPercent) / 100;
  if (camera.height < minViewHeight - SETTLE_TOLERANCE || camera.height > ARENA.height + SETTLE_TOLERANCE) {
    violations.push({
      invariant: 'C2',
      detail: `высота ${camera.height.toFixed(0)} вне [${minViewHeight.toFixed(0)}, ${String(ARENA.height)}]`,
    });
  }
  const around = voidAround(camera);
  const limitX = voidLimits.x * camera.width + SETTLE_TOLERANCE;
  const limitY = voidLimits.y * camera.height + SETTLE_TOLERANCE;
  const isWiderThanField = camera.width - 2 * voidLimits.x * camera.width > ARENA.width;
  const enemyF = input.enemy === null ? null : fractionOf(camera, input.enemy);
  const enemyArea = input.enemyArea;
  const isEnemyAtSideBound =
    enemyF !== null && enemyArea !== null && isAtBound(enemyF.fx, [enemyArea.left, enemyArea.right]);
  const isEnemyAtVerticalBound =
    enemyF !== null && enemyArea !== null && isAtBound(enemyF.fy, [enemyArea.top, enemyArea.bottom]);
  const isAtSideBound = isAtBound(f.fx, [TANK_AREA.left, TANK_AREA.right]) || isEnemyAtSideBound;
  const isAtVerticalBound = isAtBound(f.fy, [TANK_AREA.top, bottom]) || isEnemyAtVerticalBound;
  const isVoidX = around.left > limitX || around.right > limitX;
  const isVoidY = around.top > limitY || around.bottom > limitY;
  if (isVoidX && !isAtSideBound && !isWiderThanField) {
    violations.push({
      invariant: 'C8',
      detail: `пустота по x: слева ${around.left.toFixed(0)}, справа ${around.right.toFixed(0)}`,
    });
  }
  if (isVoidY && !isAtVerticalBound) {
    violations.push({
      invariant: 'C8',
      detail: `пустота по y: сверху ${around.top.toFixed(0)}, снизу ${around.bottom.toFixed(0)}`,
    });
  }
  return violations;
}

// Скорость центра по кадрам траектории: потолок соблюдается всюду, кроме первого кадра после сброса.
export function centerSpeedViolations(frames: readonly Camera[]): Violation[] {
  const violations: Violation[] = [];
  for (let i = 1; i < frames.length; i++) {
    const previous = frames[i - 1];
    const current = frames[i];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const dx = current.x + current.width / 2 - (previous.x + previous.width / 2);
    const dy = current.y + current.height / 2 - (previous.y + previous.height / 2);
    const speed = (Math.hypot(dx, dy) * 1000) / FRAME_MS;
    if (speed > CAMERA_MAX_SPEED + EPS) {
      violations.push({ invariant: 'C9', detail: `кадр ${String(i)}: скорость центра ${speed.toFixed(0)} ед/с` });
    }
  }
  return violations;
}

export function pct(value: number): string {
  return `${(value * 100).toFixed(0)} %`;
}

export function mirrorX(point: Point): Point {
  return { x: ARENA.width - point.x, y: point.y };
}

export function mirrorCamera(camera: Camera): Camera {
  return { ...camera, x: ARENA.width - camera.x - camera.width };
}
