import { ARENA } from '@tanks/shared/engine';
import type { Settings } from '../settings.js';
import {
  CAMERA_MAX_SPEED,
  keepTankInArea,
  resolveAxis,
  smoothCamera,
  TANK_AREA,
  tankBottomLimit,
  voidRange,
  windowRangeFor,
  type Camera,
} from './camera.js';
import { ENEMY_AREA, enemyRange, farFieldWindow, ZoomLevels } from './cameraLevels.js';
import type { CameraInput, CameraStrategy } from './cameraStrategy.js';

// Центр пары — выше середины экрана: внизу стики.
const PAIR_FOCUS = { fx: 0.5, fy: 0.42 };
const ZOOM_OUT_LAG_RATIO = 0.5;

// Камера «оба в кадре»: два уровня масштаба, на ближнем центр — пара танков; свой танк всегда в разрешённой
// области, противник — в своей коробке, пустота — в лимите, и именно в таком порядке важности.
export class PairCamera implements CameraStrategy {
  private readonly levels = new ZoomLevels();
  private smoothed: Camera | null = null;

  constructor(private readonly settings: Readonly<Settings>) {}

  reset(): void {
    this.levels.reset();
    this.smoothed = null;
  }

  adopt(camera: Camera): void {
    this.smoothed = camera;
  }

  update(input: CameraInput, dtMs: number): Camera {
    const aspect = input.canvasWidth / input.canvasHeight;
    const near = (ARENA.height * this.settings.minViewPercent) / 100;
    const level = this.levels.nextFor(input.me, input.enemy, near, aspect, dtMs);
    const share = this.settings.pairVoidPercent / 100;
    const voidLimit = { x: share, y: share };
    const wanted =
      level === 'far'
        ? farFieldWindow(input.me, input.enemy, input.canvasWidth, input.canvasHeight, voidLimit)
        : this.nearWindow(input, near, aspect, voidLimit);
    const smoothed = smoothCamera(
      this.smoothed,
      wanted,
      {
        moveLagMs: this.settings.pairLagMs,
        zoomInLagMs: this.settings.zoomLagMs,
        zoomOutLagMs: this.settings.zoomLagMs * ZOOM_OUT_LAG_RATIO,
        maxSpeed: CAMERA_MAX_SPEED,
      },
      dtMs,
    );
    this.smoothed = keepTankInArea(smoothed, input.me);
    return this.smoothed;
  }

  private nearWindow(input: CameraInput, height: number, aspect: number, voidLimit: { x: number; y: number }): Camera {
    const width = height * aspect;
    const center =
      input.enemy === null ? input.me : { x: (input.me.x + input.enemy.x) / 2, y: (input.me.y + input.enemy.y) / 2 };
    const x = resolveAxis(center.x - PAIR_FOCUS.fx * width, [
      voidRange(width, ARENA.width, voidLimit.x * width),
      ...enemyRange(input.enemy?.x, width, ENEMY_AREA.left, ENEMY_AREA.right),
      windowRangeFor(input.me.x, width, TANK_AREA.left, TANK_AREA.right),
    ]);
    const fx = (input.me.x - x) / width;
    const y = resolveAxis(center.y - PAIR_FOCUS.fy * height, [
      voidRange(height, ARENA.height, voidLimit.y * height),
      ...enemyRange(input.enemy?.y, height, ENEMY_AREA.top, ENEMY_AREA.bottom),
      windowRangeFor(input.me.y, height, TANK_AREA.top, tankBottomLimit(fx)),
    ]);
    return { x, y, width, height, scale: input.canvasHeight / height };
  }
}
