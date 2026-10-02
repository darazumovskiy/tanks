import { ARENA, clamp } from '@tanks/shared/engine';

// Высота видимого окна в единицах поля одинакова на любом экране; ширина следует за пропорциями экрана.
export const CAMERA_VIEW_HEIGHT = 560;

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

// Окно центрируется на цели и прижимается к краям поля; поле уже окна — окно центрируется на поле.
export function frameCamera(target: Point, canvasWidth: number, canvasHeight: number): Camera {
  const scale = canvasHeight / CAMERA_VIEW_HEIGHT;
  const width = canvasWidth / scale;
  const height = CAMERA_VIEW_HEIGHT;
  return {
    x: clampAxis(target.x - width / 2, width, ARENA.width),
    y: clampAxis(target.y - height / 2, height, ARENA.height),
    width,
    height,
    scale,
  };
}

function clampAxis(start: number, size: number, limit: number): number {
  if (size >= limit) {
    return (limit - size) / 2;
  }
  return clamp(start, 0, limit - size);
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
