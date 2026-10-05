import { FFA, ffaViewCenter, ffaViewReach, type Point } from '@tanks/shared/engine';
import { CAMERA_MAX_SPEED, smoothCamera, type Camera, type CameraSmoothing } from '../render/camera.js';

// Сдвиг догоняет цель: половина пути за 250 мс, не быстрее потолка камеры.
const SHIFT_SMOOTHING: CameraSmoothing = {
  moveLagMs: 250,
  zoomInLagMs: 0,
  zoomOutLagMs: 0,
  maxSpeed: CAMERA_MAX_SPEED,
};
const NO_SHIFT: Point = { x: 0, y: 0 };

export interface ScreenSize {
  width: number;
  height: number;
}

interface WindowSize {
  width: number;
  height: number;
}

// turret — сдвиг по углу башни; mouse — по курсору, cursor — его место долями экрана от левого верхнего угла;
// none — камера на самой точке (лобби, вход без танка).
export type FfaAim = { kind: 'turret'; angle: number } | { kind: 'mouse'; cursor: Point } | { kind: 'none' };

export interface FfaFraming {
  camera: Camera;
  // Точка камеры: фокус со сглаженным сдвигом; вокруг неё окно обзора.
  viewCenter: Point;
}

// Наибольший прямоугольник пропорций экрана внутри окна обзора: шире 16:9 — вся ширина, уже — вся высота.
export function ffaCameraWindow(screen: ScreenSize): WindowSize {
  const aspect = screen.width / screen.height;
  if (aspect >= FFA.viewWidth / FFA.viewHeight) {
    return { width: FFA.viewWidth, height: FFA.viewWidth / aspect };
  }
  return { width: FFA.viewHeight * aspect, height: FFA.viewHeight };
}

function polar(angle: number, length: number): Point {
  return { x: Math.cos(angle) * length, y: Math.sin(angle) * length };
}

// От центра экрана до его края по направлению angle, в единицах поля.
function edgeDistance(view: WindowSize, angle: number): number {
  const byWidth = view.width / 2 / Math.abs(Math.cos(angle));
  const byHeight = view.height / 2 / Math.abs(Math.sin(angle));
  return Math.min(byWidth, byHeight);
}

// Целевой сдвиг лежит в фигуре сдвигов: по башне — до точки обзора, по курсору — доля от центра экрана до края.
function ffaAimShift(aim: FfaAim, focus: Point, view: WindowSize): Point {
  if (aim.kind === 'none') {
    return NO_SHIFT;
  }
  if (aim.kind === 'turret') {
    const center = ffaViewCenter({ x: focus.x, y: focus.y, turret: aim.angle });
    return { x: center.x - focus.x, y: center.y - focus.y };
  }
  const offsetX = (aim.cursor.x - 0.5) * view.width;
  const offsetY = (aim.cursor.y - 0.5) * view.height;
  const distance = Math.hypot(offsetX, offsetY);
  if (distance === 0) {
    return NO_SHIFT;
  }
  const angle = Math.atan2(offsetY, offsetX);
  return polar(angle, ffaViewReach(angle) * Math.min(1, distance / edgeDistance(view, angle)));
}

function pointCamera(point: Point): Camera {
  return { x: point.x - 0.5, y: point.y - 0.5, width: 1, height: 1, scale: 1 };
}

// Камера боя толпы: окно пропорций экрана внутри окна обзора, центр — фокус плюс сглаженный сдвиг, умноженный
// по осям на долю видимого окна. Фокус камера ведёт без отставания; сдвиг переставляется сразу после `snap`.
export class FfaCamera {
  private shift: Point | null = null;

  snap(): void {
    this.shift = null;
  }

  update(focus: Point, aim: FfaAim, screen: ScreenSize, dtMs: number): FfaFraming {
    const view = ffaCameraWindow(screen);
    const target = ffaAimShift(aim, focus, view);
    const previous = this.shift;
    const shift =
      previous === null
        ? target
        : centerOf(smoothCamera(pointCamera(previous), pointCamera(target), SHIFT_SMOOTHING, dtMs));
    this.shift = shift;
    const centerX = focus.x + (view.width / FFA.viewWidth) * shift.x;
    const centerY = focus.y + (view.height / FFA.viewHeight) * shift.y;
    return {
      camera: {
        x: centerX - view.width / 2,
        y: centerY - view.height / 2,
        width: view.width,
        height: view.height,
        scale: screen.height / view.height,
      },
      viewCenter: { x: focus.x + shift.x, y: focus.y + shift.y },
    };
  }
}

function centerOf(camera: Camera): Point {
  return { x: camera.x + camera.width / 2, y: camera.y + camera.height / 2 };
}
