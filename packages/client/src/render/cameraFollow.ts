import { ARENA, clamp } from '@tanks/shared/engine';
import type { Settings } from '../settings.js';
import {
  approach,
  CAMERA_MAX_SPEED,
  keepTankInArea,
  resolveAxis,
  smoothCamera,
  TANK_AREA,
  tankBottomLimit,
  voidRange,
  windowRangeFor,
  type Camera,
  type Point,
} from './camera.js';
import { farFieldWindow, fitRatio, ZoomLevels } from './cameraLevels.js';
import type { CameraInput, CameraStrategy } from './cameraStrategy.js';

// Точка покоя своего танка — выше середины: внизу живут стики.
const REST = { fx: 0.5, fy: 0.4 };
// Пока фокус в этой окрестности точки покоя, окно не двигается — мелкое маневрирование не качает картинку.
const DEAD_ZONE = { fx: 0.04, fy: 0.03 };
// Упреждение включается плавно по удалённости противника, измеренной долями окна по каждой оси.
const LOOK_AHEAD_RAMP = { from: 0.25, to: 0.6 };
// Потолки упреждения долями окна: вбок и вниз по экрану — постоянные; вверх по экрану (противник выше) —
// до нижней границы разрешённой области, которая зависит от того, где танк по горизонтали.
const LOOK_AHEAD_CAP = { side: 0.15, down: 0.18 };
const LOOK_AHEAD_LAG_MS = 350;
const ZOOM_OUT_LAG_RATIO = 0.5;
export const FOLLOW_VOID_LIMIT = { x: 0.12, y: 0.15 };

// Камера за своим танком: танк в коробке экрана, окно упреждает к противнику, масштаб постоянен. С уровнями
// масштаба — то же, но когда противник не помещается, окно отдаляется до целого поля.
export class FollowCamera implements CameraStrategy {
  private readonly levels: ZoomLevels | null;
  private lookAhead: Point = { x: 0, y: 0 };
  private wanted: Camera | null = null;
  private smoothed: Camera | null = null;

  constructor(
    private readonly settings: Readonly<Settings>,
    hasZoomOut: boolean,
  ) {
    this.levels = hasZoomOut ? new ZoomLevels() : null;
  }

  reset(): void {
    this.levels?.reset();
    this.lookAhead = { x: 0, y: 0 };
    this.wanted = null;
    this.smoothed = null;
  }

  adopt(camera: Camera): void {
    this.smoothed = camera;
  }

  update(input: CameraInput, dtMs: number): Camera {
    const near = (ARENA.height * this.settings.minViewPercent) / 100;
    const aspect = input.canvasWidth / input.canvasHeight;
    const isFar = this.nextLevel(input, near, aspect, dtMs) === 'far';
    this.wanted = isFar
      ? farFieldWindow(input.me, input.enemy, input.canvasWidth, input.canvasHeight, FOLLOW_VOID_LIMIT)
      : this.nearWindow(input, near, aspect, dtMs);
    const smoothed = smoothCamera(
      this.smoothed,
      this.wanted,
      {
        moveLagMs: this.settings.followLagMs,
        zoomInLagMs: this.settings.zoomLagMs,
        zoomOutLagMs: this.settings.zoomLagMs * ZOOM_OUT_LAG_RATIO,
        maxSpeed: CAMERA_MAX_SPEED,
      },
      dtMs,
    );
    this.smoothed = keepTankInArea(smoothed, input.me);
    return this.smoothed;
  }

  private nextLevel(input: CameraInput, near: number, aspect: number, dtMs: number): 'near' | 'far' {
    if (this.levels === null) {
      return 'near';
    }
    const ratio = input.enemy === null ? null : fitRatio(input.me, input.enemy, near, aspect);
    return this.levels.next(ratio, dtMs);
  }

  private nearWindow(input: CameraInput, height: number, aspect: number, dtMs: number): Camera {
    const width = height * aspect;
    this.lookAhead = this.nextLookAhead(input, width, height, dtMs);
    const focus = { x: input.me.x + this.lookAhead.x, y: input.me.y + this.lookAhead.y };
    const previous = this.wanted !== null && this.wanted.height === height ? this.wanted : null;
    const idealX = this.idealStart(focus.x, width, REST.fx, DEAD_ZONE.fx, previous?.x);
    const idealY = this.idealStart(focus.y, height, REST.fy, DEAD_ZONE.fy, previous?.y);
    const x = resolveAxis(idealX, [
      voidRange(width, ARENA.width, FOLLOW_VOID_LIMIT.x * width),
      windowRangeFor(input.me.x, width, TANK_AREA.left, TANK_AREA.right),
    ]);
    const fx = (input.me.x - x) / width;
    const y = resolveAxis(idealY, [
      voidRange(height, ARENA.height, FOLLOW_VOID_LIMIT.y * height),
      windowRangeFor(input.me.y, height, TANK_AREA.top, tankBottomLimit(fx)),
    ]);
    return { x, y, width, height, scale: input.canvasHeight / height };
  }

  // Мёртвая зона: предыдущее целевое окно остаётся, пока фокус в окрестности точки покоя; вышел — окно
  // сдвигается ровно до её границы. Без предыстории — фокус точно в точке покоя.
  private idealStart(
    focus: number,
    size: number,
    rest: number,
    deadZone: number,
    previous: number | undefined,
  ): number {
    if (previous === undefined) {
      return focus - rest * size;
    }
    return clamp(previous, focus - (rest + deadZone) * size, focus - (rest - deadZone) * size);
  }

  private nextLookAhead(input: CameraInput, width: number, height: number, dtMs: number): Point {
    const target = this.lookAheadTarget(input, width, height);
    if (this.smoothed === null) {
      return target;
    }
    const k = approach(LOOK_AHEAD_LAG_MS, dtMs);
    return {
      x: this.lookAhead.x + (target.x - this.lookAhead.x) * k,
      y: this.lookAhead.y + (target.y - this.lookAhead.y) * k,
    };
  }

  private lookAheadTarget(input: CameraInput, width: number, height: number): Point {
    if (input.enemy === null) {
      return { x: 0, y: 0 };
    }
    const dx = input.enemy.x - input.me.x;
    const dy = input.enemy.y - input.me.y;
    const farness = Math.max(Math.abs(dx) / width, Math.abs(dy) / height);
    const ramp = clamp((farness - LOOK_AHEAD_RAMP.from) / (LOOK_AHEAD_RAMP.to - LOOK_AHEAD_RAMP.from), 0, 1);
    const share = this.settings.followLookAhead * ramp;
    const sideCap = LOOK_AHEAD_CAP.side * width;
    const previousFx = this.wanted === null ? REST.fx : (input.me.x - this.wanted.x) / this.wanted.width;
    const upCap = (tankBottomLimit(previousFx) - REST.fy - DEAD_ZONE.fy) * height;
    return {
      x: clamp(dx * share, -sideCap, sideCap),
      y: clamp(dy * share, -upCap, LOOK_AHEAD_CAP.down * height),
    };
  }
}
