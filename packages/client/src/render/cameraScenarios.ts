import { ARENA } from '@tanks/shared/engine';
import type { Camera, Point } from './camera.js';
import { FRAMING_INSETS, THUMB_ZONES, type DuelCameraTuning } from './duelCamera.js';

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
];

export interface Violation {
  invariant: string;
  detail: string;
}

interface ScreenFraction {
  fx: number;
  fy: number;
}

function fractionOf(camera: Camera, point: Point): ScreenFraction {
  return { fx: (point.x - camera.x) / camera.width, fy: (point.y - camera.y) / camera.height };
}

const EPS = 1e-6;

// Инварианты камеры дуэли в установившемся состоянии. Нумерация — для ссылок из документов и разговора.
export function checkCameraInvariants(
  camera: Camera,
  scenario: CameraScenario,
  tuning: Readonly<DuelCameraTuning>,
): Violation[] {
  const violations: Violation[] = [];
  const me = fractionOf(camera, scenario.me);
  const minViewHeight = (ARENA.height * tuning.minViewPercent) / 100;

  // I1. Высота окна — между максимальным приближением и целым полем.
  if (camera.height < minViewHeight - EPS || camera.height > ARENA.height + EPS) {
    violations.push({
      invariant: 'I1',
      detail: `высота ${camera.height.toFixed(0)} вне [${minViewHeight.toFixed(0)}, ${String(ARENA.height)}]`,
    });
  }

  // I2. Живой противник — в кадре целиком, с запасом безопасной области по бокам и сверху.
  if (scenario.enemy !== null) {
    const enemy = fractionOf(camera, scenario.enemy);
    const isInside =
      enemy.fx >= FRAMING_INSETS.side - EPS &&
      enemy.fx <= 1 - FRAMING_INSETS.side + EPS &&
      enemy.fy >= FRAMING_INSETS.top - EPS &&
      enemy.fy <= 1 - FRAMING_INSETS.bottom + EPS;
    if (!isInside) {
      violations.push({ invariant: 'I2', detail: `противник на ${pct(enemy.fx)} / ${pct(enemy.fy)} экрана` });
    }
  }

  // I3. Свой танк не в нижних углах (зоны пальцев) и не под панелями.
  const isLow = me.fy > THUMB_ZONES.cornerTop + EPS;
  const isSide = me.fx < THUMB_ZONES.side - EPS || me.fx > 1 - THUMB_ZONES.side + EPS;
  if (isLow && isSide) {
    violations.push({ invariant: 'I3', detail: `свой танк в зоне пальца: ${pct(me.fx)} / ${pct(me.fy)}` });
  }
  if (me.fy < THUMB_ZONES.top - EPS) {
    violations.push({ invariant: 'I3', detail: `свой танк под панелями: ${pct(me.fy)} от верха` });
  }

  // I4. Свой танк в кадре целиком (не за экраном).
  if (me.fx < 0 || me.fx > 1 || me.fy < 0 || me.fy > 1) {
    violations.push({ invariant: 'I4', detail: `свой танк за кадром: ${pct(me.fx)} / ${pct(me.fy)}` });
  }

  // I5. Полное отдаление — поле центрировано, пустота только симметричными полями по бокам.
  const isFullyOut = camera.height >= ARENA.height - EPS;
  if (isFullyOut) {
    const left = -camera.x;
    const right = camera.x + camera.width - ARENA.width;
    if (Math.abs(left - right) > 1 || Math.abs(camera.y) > 1) {
      violations.push({
        invariant: 'I5',
        detail: `поле не центрировано: слева ${left.toFixed(0)}, справа ${right.toFixed(0)}, сверху ${(-camera.y).toFixed(0)}`,
      });
    }
  }

  // I6. Приближение — центр пары (или свой танк, если противника нет) в средней части экрана.
  if (!isFullyOut) {
    const focus =
      scenario.enemy === null
        ? scenario.me
        : { x: (scenario.me.x + scenario.enemy.x) / 2, y: (scenario.me.y + scenario.enemy.y) / 2 };
    const f = fractionOf(camera, focus);
    const isCentered = f.fx >= 0.3 - EPS && f.fx <= 0.7 + EPS && f.fy >= 0.25 - EPS && f.fy <= 0.6 + EPS;
    if (!isCentered) {
      violations.push({ invariant: 'I6', detail: `центр событий на ${pct(f.fx)} / ${pct(f.fy)} экрана` });
    }
  }

  // I7. Пустота за полем — не больше трети экрана по каждой оси.
  const voidLeft = Math.max(0, -camera.x) / camera.width;
  const voidRight = Math.max(0, camera.x + camera.width - ARENA.width) / camera.width;
  const voidTop = Math.max(0, -camera.y) / camera.height;
  const voidBottom = Math.max(0, camera.y + camera.height - ARENA.height) / camera.height;
  const worst = Math.max(voidLeft, voidRight, voidTop, voidBottom);
  if (!isFullyOut && worst > 1 / 3 + EPS) {
    violations.push({ invariant: 'I7', detail: `пустота ${pct(worst)} экрана` });
  }

  return violations;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)} %`;
}
