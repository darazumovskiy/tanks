import { ARENA, clamp } from '@tanks/shared/engine';

export interface Camera {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface Point {
  x: number;
  y: number;
}

// Окно заданной высоты в единицах поля, ширина — по пропорциям экрана. Центрируется на цели и прижимается
// к краям поля, чтобы не показывать пустоту; поле уже окна — окно центрируется на поле.
export function frameCamera(target: Point, canvasWidth: number, canvasHeight: number, viewHeight: number): Camera {
  const scale = canvasHeight / viewHeight;
  const width = canvasWidth / scale;
  return {
    x: clampAxis(target.x - width / 2, width, ARENA.width),
    y: clampAxis(target.y - viewHeight / 2, viewHeight, ARENA.height),
    width,
    height: viewHeight,
    scale,
  };
}

function clampAxis(start: number, size: number, limit: number): number {
  if (size >= limit) {
    return (limit - size) / 2;
  }
  return clamp(start, 0, limit - size);
}

// Разрешённая область центра своего танка на экране, долями. Нижняя граница зависит от горизонтали: у боков
// лежат большие пальцы на стиках, между ними танк может быть ниже; переход линейный, чтобы малый сдвиг
// танка не давал скачка окна.
export const TANK_AREA = {
  left: 0.12,
  right: 0.88,
  top: 0.19,
  bottomAtSides: 0.5,
  bottomAtCenter: 0.75,
  sideEnd: 0.32,
  centerStart: 0.45,
} as const;

export function tankBottomLimit(fx: number): number {
  const fromEdge = Math.min(fx, 1 - fx);
  const t = clamp((fromEdge - TANK_AREA.sideEnd) / (TANK_AREA.centerStart - TANK_AREA.sideEnd), 0, 1);
  return TANK_AREA.bottomAtSides + (TANK_AREA.bottomAtCenter - TANK_AREA.bottomAtSides) * t;
}

export interface Interval {
  min: number;
  max: number;
}

// Начала окна по оси, при которых точка стоит в долях [minFraction, maxFraction] размера окна.
export function windowRangeFor(value: number, size: number, minFraction: number, maxFraction: number): Interval {
  return { min: value - size * maxFraction, max: value - size * minFraction };
}

// Начала окна по оси, при которых пустота за полем не превышает `limit` единиц; окно шире поля с обоими
// запасами — единственное положение, центр поля.
export function voidRange(size: number, fieldSize: number, limit: number): Interval {
  const min = -limit;
  const max = fieldSize - size + limit;
  if (min > max) {
    const center = (fieldSize - size) / 2;
    return { min: center, max: center };
  }
  return { min, max };
}

// Вложенные зажимы: каждый следующий интервал важнее предыдущего — при конфликте побеждает последний,
// а значение остаётся ближайшим к тому, что требовали менее важные.
export function resolveAxis(ideal: number, ranges: readonly Interval[]): number {
  let value = ideal;
  for (const range of ranges) {
    value = clamp(value, range.min, range.max);
  }
  return value;
}

// Жёсткая гарантия на уже сглаженном окне: свой танк в разрешённой области в каждом кадре, даже пока камера
// догоняет цель или переезжает после смены стратегии. Ось x — первой: от неё зависит нижняя граница.
export function keepTankInArea(camera: Camera, me: Point): Camera {
  const x = resolveAxis(camera.x, [windowRangeFor(me.x, camera.width, TANK_AREA.left, TANK_AREA.right)]);
  const fx = (me.x - x) / camera.width;
  const y = resolveAxis(camera.y, [windowRangeFor(me.y, camera.height, TANK_AREA.top, tankBottomLimit(fx))]);
  return { ...camera, x, y };
}

// Потолок скорости центра окна, единиц/с: крупные перестановки цели (смена стратегии, уровня масштаба) идут
// панорамой, а не рывком.
export const CAMERA_MAX_SPEED = 800;

export interface CameraSmoothing {
  moveLagMs: number;
  zoomInLagMs: number;
  zoomOutLagMs: number;
  maxSpeed: number;
}

// Экспоненциальный догон: за lagMs проходится половина пути, центр не быстрее maxSpeed единиц/с. Центр и
// высота сглаживаются раздельно; отдаление и приближение — со своими задержками. Ноль — мгновенно.
export function smoothCamera(previous: Camera | null, next: Camera, smoothing: CameraSmoothing, dtMs: number): Camera {
  if (previous === null) {
    return next;
  }
  const moveK = approach(smoothing.moveLagMs, dtMs);
  const isZoomingOut = next.height > previous.height;
  const zoomK = approach(isZoomingOut ? smoothing.zoomOutLagMs : smoothing.zoomInLagMs, dtMs);
  const height = previous.height + (next.height - previous.height) * zoomK;
  const aspect = next.width / next.height;
  const width = height * aspect;
  const previousCenterX = previous.x + previous.width / 2;
  const previousCenterY = previous.y + previous.height / 2;
  const nextCenterX = next.x + next.width / 2;
  const nextCenterY = next.y + next.height / 2;
  let stepX = (nextCenterX - previousCenterX) * moveK;
  let stepY = (nextCenterY - previousCenterY) * moveK;
  const stepLength = Math.hypot(stepX, stepY);
  const maxStep = (smoothing.maxSpeed * dtMs) / 1000;
  if (stepLength > maxStep && stepLength > 0) {
    stepX *= maxStep / stepLength;
    stepY *= maxStep / stepLength;
  }
  const centerX = previousCenterX + stepX;
  const centerY = previousCenterY + stepY;
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    scale: (next.scale * next.height) / height,
  };
}

export function approach(lagMs: number, dtMs: number): number {
  if (lagMs <= 0) {
    return 1;
  }
  return 1 - Math.pow(0.5, dtMs / lagMs);
}

export function worldToScreen(camera: Camera, point: Point): Point {
  return { x: (point.x - camera.x) * camera.scale, y: (point.y - camera.y) * camera.scale };
}

export function screenToWorld(camera: Camera, point: Point): Point {
  return { x: point.x / camera.scale + camera.x, y: point.y / camera.scale + camera.y };
}

export interface EdgeMarker {
  x: number;
  y: number;
  angle: number;
}

export function isInView(camera: Camera, point: Point): boolean {
  const isInsideX = point.x >= camera.x && point.x <= camera.x + camera.width;
  const isInsideY = point.y >= camera.y && point.y <= camera.y + camera.height;
  return isInsideX && isInsideY;
}

// Точка вне окна → место на рамке экрана (с отступом в пикселях) на луче из центра окна и направление луча.
export function edgeMarker(camera: Camera, point: Point, insetPx: number): EdgeMarker | null {
  if (isInView(camera, point)) {
    return null;
  }
  const screenWidth = camera.width * camera.scale;
  const screenHeight = camera.height * camera.scale;
  const centerX = screenWidth / 2;
  const centerY = screenHeight / 2;
  const target = worldToScreen(camera, point);
  const dx = target.x - centerX;
  const dy = target.y - centerY;
  const halfWidth = centerX - insetPx;
  const halfHeight = centerY - insetPx;
  const k = Math.min(halfWidth / Math.abs(dx || Number.EPSILON), halfHeight / Math.abs(dy || Number.EPSILON));
  return { x: centerX + dx * k, y: centerY + dy * k, angle: Math.atan2(dy, dx) };
}
