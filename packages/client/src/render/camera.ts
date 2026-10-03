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
// к краям поля; поле уже окна — окно центрируется на поле.
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

export interface CameraFollow {
  boxPercent: number;
  lagMs: number;
}

// Центр камеры догоняет цель только когда она выходит из «свободного прямоугольника» — доли окна вокруг центра;
// сдвиг сглаживается: за lagMs проходится половина пути. Нулевая свобода и нулевой догон — жёсткая привязка.
export function followCenter(
  previous: Point | null,
  target: Point,
  view: { width: number; height: number },
  follow: CameraFollow,
  dtMs: number,
): Point {
  if (previous === null) {
    return { x: target.x, y: target.y };
  }
  const halfBoxWidth = (view.width * follow.boxPercent) / 200;
  const halfBoxHeight = (view.height * follow.boxPercent) / 200;
  const wanted = {
    x: pullIntoBox(previous.x, target.x, halfBoxWidth),
    y: pullIntoBox(previous.y, target.y, halfBoxHeight),
  };
  if (follow.lagMs <= 0) {
    return wanted;
  }
  const k = 1 - Math.pow(0.5, dtMs / follow.lagMs);
  return { x: previous.x + (wanted.x - previous.x) * k, y: previous.y + (wanted.y - previous.y) * k };
}

function pullIntoBox(center: number, target: number, halfBox: number): number {
  if (target > center + halfBox) {
    return target - halfBox;
  }
  if (target < center - halfBox) {
    return target + halfBox;
  }
  return center;
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

// Точка вне окна → место на рамке экрана (с отступом в пикселях) на луче из центра окна и направление луча.
export function edgeMarker(camera: Camera, point: Point, insetPx: number): EdgeMarker | null {
  const isInside =
    point.x >= camera.x &&
    point.x <= camera.x + camera.width &&
    point.y >= camera.y &&
    point.y <= camera.y + camera.height;
  if (isInside) {
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
