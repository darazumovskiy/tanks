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
// целей оказывается выше середины экрана — внизу живут стики. Полностью отдалена (высота окна — всё поле) —
// центрируется поле; любое приближение — центр событий, даже если за краем поля видна пустота, а дальний край
// поля ушёл за кадр.
export function frameTargets(
  targets: readonly Point[],
  canvasWidth: number,
  canvasHeight: number,
  minViewHeight: number,
  insets: FramingInsets,
  fixedHeight: number | null = null,
): Camera {
  const aspect = canvasWidth / canvasHeight;
  const left = Math.min(...targets.map((point) => point.x)) - TARGET_MARGIN;
  const right = Math.max(...targets.map((point) => point.x)) + TARGET_MARGIN;
  const top = Math.min(...targets.map((point) => point.y)) - TARGET_MARGIN;
  const bottom = Math.max(...targets.map((point) => point.y)) + TARGET_MARGIN;
  const safeWidthFraction = 1 - insets.side * 2;
  const safeHeightFraction = 1 - insets.top - insets.bottom;
  const neededHeight = Math.max((bottom - top) / safeHeightFraction, (right - left) / (safeWidthFraction * aspect));
  const height = clamp(fixedHeight ?? neededHeight, minViewHeight, ARENA.height);
  const width = height * aspect;
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const safeCenterYFraction = insets.top + safeHeightFraction / 2;
  const isFullyOut = height >= ARENA.height;
  return {
    x: isFullyOut ? (ARENA.width - width) / 2 : centerX - width / 2,
    y: isFullyOut ? (ARENA.height - height) / 2 : centerY - height * safeCenterYFraction,
    width,
    height,
    scale: canvasHeight / height,
  };
}

// Зоны больших пальцев — нижние углы экрана: ближе `side` к боку и ниже `cornerTop` от верха. Сверху — панели.
export interface ThumbZones {
  side: number;
  cornerTop: number;
  top: number;
}

// Вертикальный сдвиг прячет поле внизу, где идёт бой, поэтому горизонтальный предпочтительнее, пока он не сильно больше.
const VERTICAL_SHIFT_PREFERENCE = 1.5;

// Цель попала в зону пальца — окно сдвигается за край поля ровно до её границы тем способом, что даёт меньше пустоты.
export function keepTargetOutOfThumbZones(camera: Camera, target: Point, zones: ThumbZones): Camera {
  let { x, y } = camera;
  const fy = (target.y - y) / camera.height;
  if (fy < zones.top) {
    y = target.y - camera.height * zones.top;
  }
  const fx = (target.x - x) / camera.width;
  const isLow = fy > zones.cornerTop;
  const isLeft = fx < zones.side;
  const isRight = fx > 1 - zones.side;
  if (!isLow || (!isLeft && !isRight)) {
    return { ...camera, x, y };
  }
  const shiftX = (isLeft ? zones.side - fx : fx - (1 - zones.side)) * camera.width;
  const shiftY = (fy - zones.cornerTop) * camera.height;
  if (shiftX <= shiftY * VERTICAL_SHIFT_PREFERENCE) {
    x = isLeft ? target.x - camera.width * zones.side : target.x - camera.width * (1 - zones.side);
  } else {
    y = target.y - camera.height * zones.cornerTop;
  }
  return { ...camera, x, y };
}

// Высота окна меняется ступенями: пока нужная высота отличается от зафиксированной меньше чем на долю
// deadBand, остаётся зафиксированная — мелкое маневрирование не трогает масштаб.
export function stabilizedHeight(committed: number | null, needed: number, deadBand: number): number {
  if (committed === null) {
    return needed;
  }
  if (Math.abs(needed - committed) / committed <= deadBand) {
    return committed;
  }
  return needed;
}

export interface CameraSmoothing {
  moveLagMs: number;
  zoomInLagMs: number;
  zoomOutLagMs: number;
}

// Экспоненциальный догон: за lagMs проходится половина пути. Центр и высота сглаживаются раздельно;
// отдаление быстрее приближения — не видеть противника хуже, чем видеть его чуть мельче. Ноль — мгновенно.
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
