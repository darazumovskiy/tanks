import { ARENA } from '@tanks/shared/engine';
import {
  frameTargets,
  keepTargetOutOfThumbZones,
  smoothCamera,
  stabilizedHeight,
  type Camera,
  type FramingInsets,
  type Point,
  type ThumbZones,
} from './camera.js';

export interface DuelCameraTuning {
  minViewPercent: number;
  cameraLagMs: number;
  zoomLagMs: number;
}

// Доли окна под панели (сверху) и большие пальцы на стиках (снизу, по бокам): цели кадрирования держатся вне их.
export const FRAMING_INSETS: FramingInsets = { side: 0.12, top: 0.14, bottom: 0.32 };
// Свой танк не заходит в нижние углы (зоны пальцев) и под панели даже ценой пустоты за полем.
export const THUMB_ZONES: ThumbZones = { side: 0.32, cornerTop: 0.5, top: 0.12 };
// Масштаб переключается ступенями: пока нужная высота в пределах ±20 % от зафиксированной, она не меняется.
export const ZOOM_DEAD_BAND = 0.2;
// Отдаление вдвое быстрее приближения.
export const ZOOM_OUT_RATIO = 0.5;

// Камера дуэли на телефоне целиком: кадрирование целей → ступенчатый масштаб → зоны пальцев → сглаживание.
// Один и тот же конвейер крутят рендер, сценарные тесты и лаборатория камеры.
export class DuelCamera {
  private smoothed: Camera | null = null;
  private committedHeight: number | null = null;

  constructor(private readonly tuning: Readonly<DuelCameraTuning>) {}

  // Новый раунд — танки появляются в другом месте, камера не должна ехать к ним через всё поле.
  reset(): void {
    this.smoothed = null;
    this.committedHeight = null;
  }

  update(me: Point, enemy: Point | null, canvasWidth: number, canvasHeight: number, dtMs: number): Camera {
    const targets: Point[] = enemy === null ? [me] : [me, enemy];
    const minViewHeight = (ARENA.height * this.tuning.minViewPercent) / 100;
    const needed = frameTargets(targets, canvasWidth, canvasHeight, minViewHeight, FRAMING_INSETS);
    this.committedHeight = stabilizedHeight(this.committedHeight, needed.height, ZOOM_DEAD_BAND);
    const framed = frameTargets(
      targets,
      canvasWidth,
      canvasHeight,
      minViewHeight,
      FRAMING_INSETS,
      this.committedHeight,
    );
    const wanted = keepTargetOutOfThumbZones(framed, me, THUMB_ZONES);
    const smoothing = {
      moveLagMs: this.tuning.cameraLagMs,
      zoomInLagMs: this.tuning.zoomLagMs,
      zoomOutLagMs: this.tuning.zoomLagMs * ZOOM_OUT_RATIO,
    };
    this.smoothed = smoothCamera(this.smoothed, wanted, smoothing, dtMs);
    return this.smoothed;
  }

  // Прогон до установившегося состояния: столько кадров по 16 мс, сколько нужно, чтобы движение затухло.
  settle(me: Point, enemy: Point | null, canvasWidth: number, canvasHeight: number, durationMs = 4000): Camera {
    const frameMs = 16;
    let camera = this.update(me, enemy, canvasWidth, canvasHeight, frameMs);
    for (let elapsed = frameMs; elapsed < durationMs; elapsed += frameMs) {
      camera = this.update(me, enemy, canvasWidth, canvasHeight, frameMs);
    }
    return camera;
  }
}
