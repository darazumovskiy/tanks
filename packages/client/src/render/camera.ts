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

// Доли окна, в которых должны лежать цели кадрирования: по бокам и сверху — панели, снизу — большие пальцы на стиках.
export interface FramingInsets {
  side: number;
  top: number;
  bottom: number;
}

// Запас вокруг танка в единицах поля, чтобы он не стоял вплотную к границе безопасной области.
const TARGET_MARGIN = 110;

// Камера дуэли: держит в кадре все цели (свой танк и противника) внутри безопасной области окна, приближая,
// когда они рядом, и отдаляя до целого поля, когда далеко. Безопасная область сдвинута вверх, поэтому центр
// целей оказывается выше середины экрана — внизу живут стики. Окно прижимается к полю.
export function frameTargets(
  targets: readonly Point[],
  canvasWidth: number,
  canvasHeight: number,
  minViewHeight: number,
  insets: FramingInsets,
): Camera {
  const aspect = canvasWidth / canvasHeight;
  const left = Math.min(...targets.map((point) => point.x)) - TARGET_MARGIN;
  const right = Math.max(...targets.map((point) => point.x)) + TARGET_MARGIN;
  const top = Math.min(...targets.map((point) => point.y)) - TARGET_MARGIN;
  const bottom = Math.max(...targets.map((point) => point.y)) + TARGET_MARGIN;
  const safeWidthFraction = 1 - insets.side * 2;
  const safeHeightFraction = 1 - insets.top - insets.bottom;
  const neededHeight = Math.max((bottom - top) / safeHeightFraction, (right - left) / (safeWidthFraction * aspect));
  const height = clamp(neededHeight, minViewHeight, ARENA.height);
  const width = height * aspect;
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const safeCenterYFraction = insets.top + safeHeightFraction / 2;
  return {
    x: clampAxis(centerX - width / 2, width, ARENA.width),
    y: clampAxis(centerY - height * safeCenterYFraction, height, ARENA.height),
    width,
    height,
    scale: canvasHeight / height,
  };
}

// Сдвигает окно ровно настолько, чтобы цель вернулась в безопасную область, — даже за край поля.
export function keepTargetInSafeZone(camera: Camera, target: Point, insets: FramingInsets): Camera {
  const minX = target.x - camera.width * (1 - insets.side);
  const maxX = target.x - camera.width * insets.side;
  const minY = target.y - camera.height * (1 - insets.bottom);
  const maxY = target.y - camera.height * insets.top;
  return { ...camera, x: clamp(camera.x, minX, maxX), y: clamp(camera.y, minY, maxY) };
}

export interface CameraSmoothing {
  moveLagMs: number;
  zoomLagMs: number;
}

// Экспоненциальный догон: за lagMs проходится половина пути. Центр и высота сглаживаются раздельно —
// приближение медленнее, чтобы кадр не «дышал». Ноль — мгновенно.
export function smoothCamera(previous: Camera | null, next: Camera, smoothing: CameraSmoothing, dtMs: number): Camera {
  if (previous === null) {
    return next;
  }
  const moveK = approach(smoothing.moveLagMs, dtMs);
  const zoomK = approach(smoothing.zoomLagMs, dtMs);
  const height = previous.height + (next.height - previous.height) * zoomK;
  const aspect = next.width / next.height;
  const width = height * aspect;
  const previousCenterX = previous.x + previous.width / 2;
  const previousCenterY = previous.y + previous.height / 2;
  const nextCenterX = next.x + next.width / 2;
  const nextCenterY = next.y + next.height / 2;
  const centerX = previousCenterX + (nextCenterX - previousCenterX) * moveK;
  const centerY = previousCenterY + (nextCenterY - previousCenterY) * moveK;
  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    scale: (next.scale * next.height) / height,
  };
}

function approach(lagMs: number, dtMs: number): number {
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
