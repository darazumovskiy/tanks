import { ARENA } from '@tanks/shared/engine';
import {
  resolveAxis,
  TANK_AREA,
  tankBottomLimit,
  voidRange,
  windowRangeFor,
  type Camera,
  type Interval,
  type Point,
} from './camera.js';

// Коробка противника на ближнем уровне; на дальнем достаточно, чтобы он был в окне с небольшим запасом.
export const ENEMY_AREA = { left: 0.1, right: 0.9, top: 0.14, bottom: 0.7 };
export const ENEMY_FAR_MARGIN = 0.04;
// Гистерезис уровня: отдаление — когда пара перестала помещаться, приближение — когда помещается с запасом
// и это держится долго: приближение заметнее отдаления, его нельзя делать на каждый манёвр.
export const ZOOM_OUT_RATIO = 1;
export const ZOOM_IN_RATIO = 0.85;
export const ZOOM_OUT_DWELL_MS = 150;
export const ZOOM_IN_DWELL_MS = 1500;

export type Level = 'near' | 'far';

export interface ScreenArea {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// Два уровня масштаба с гистерезисом и выдержкой. Без противника уровень не меняется; после сброса выбирается
// сразу по текущему разносу.
export class ZoomLevels {
  private level: Level | null = null;
  private pendingLevel: Level | null = null;
  private pendingMs = 0;

  reset(): void {
    this.level = null;
    this.pendingLevel = null;
    this.pendingMs = 0;
  }

  next(ratio: number | null, dtMs: number): Level {
    this.level = this.resolve(ratio, dtMs);
    return this.level;
  }

  private resolve(ratio: number | null, dtMs: number): Level {
    if (ratio === null) {
      return this.level ?? 'far';
    }
    if (this.level === null) {
      return ratio <= ZOOM_OUT_RATIO ? 'near' : 'far';
    }
    const desired = desiredLevel(this.level, ratio);
    if (desired === this.level) {
      this.pendingLevel = null;
      this.pendingMs = 0;
      return this.level;
    }
    if (this.pendingLevel !== desired) {
      this.pendingLevel = desired;
      this.pendingMs = 0;
    }
    this.pendingMs += dtMs;
    const dwell = desired === 'far' ? ZOOM_OUT_DWELL_MS : ZOOM_IN_DWELL_MS;
    if (this.pendingMs < dwell) {
      return this.level;
    }
    this.pendingLevel = null;
    this.pendingMs = 0;
    return desired;
  }
}

function desiredLevel(current: Level, ratio: number): Level {
  if (current === 'near') {
    return ratio > ZOOM_OUT_RATIO ? 'far' : 'near';
  }
  return ratio < ZOOM_IN_RATIO ? 'near' : 'far';
}

// Во сколько раз разнос пары превышает то, что помещается на ближнем уровне при соблюдении коробок
// обоих танков: по x — общая полоса, по y — зависит от того, кто выше (свой танк не ниже половины экрана).
export function fitRatio(me: Point, enemy: Point, height: number, aspect: number): number {
  const width = height * aspect;
  const spanX = (ENEMY_AREA.right - TANK_AREA.left) * width;
  const dy = enemy.y - me.y;
  const spanY =
    dy < 0 ? (TANK_AREA.bottomAtSides - ENEMY_AREA.top) * height : (ENEMY_AREA.bottom - TANK_AREA.top) * height;
  return Math.max(Math.abs(enemy.x - me.x) / spanX, Math.abs(dy) / spanY);
}

export const FAR_ENEMY_AREA: ScreenArea = {
  left: ENEMY_FAR_MARGIN,
  right: 1 - ENEMY_FAR_MARGIN,
  top: ENEMY_FAR_MARGIN,
  bottom: 1 - ENEMY_FAR_MARGIN,
};

export function isFarCamera(camera: Camera): boolean {
  return camera.height >= ARENA.height - 1;
}

// Интервал начала окна по оси, при котором противник остаётся в заданной коробке; без противника — пусто.
export function enemyRange(value: number | undefined, size: number, min: number, max: number): Interval[] {
  if (value === undefined) {
    return [];
  }
  return [windowRangeFor(value, size, min, max)];
}

// Дальний уровень: поле по центру, противник в окне, свой танк в разрешённой области; пустота — в лимите.
export function farFieldWindow(
  me: Point,
  enemy: Point | null,
  canvasWidth: number,
  canvasHeight: number,
  voidLimit: { x: number; y: number },
): Camera {
  const height = ARENA.height;
  const width = height * (canvasWidth / canvasHeight);
  const x = resolveAxis((ARENA.width - width) / 2, [
    voidRange(width, ARENA.width, voidLimit.x * width),
    ...enemyRange(enemy?.x, width, FAR_ENEMY_AREA.left, FAR_ENEMY_AREA.right),
    windowRangeFor(me.x, width, TANK_AREA.left, TANK_AREA.right),
  ]);
  const fx = (me.x - x) / width;
  const y = resolveAxis((ARENA.height - height) / 2, [
    voidRange(height, ARENA.height, voidLimit.y * height),
    ...enemyRange(enemy?.y, height, FAR_ENEMY_AREA.top, FAR_ENEMY_AREA.bottom),
    windowRangeFor(me.y, height, TANK_AREA.top, tankBottomLimit(fx)),
  ]);
  return { x, y, width, height, scale: canvasHeight / height };
}
