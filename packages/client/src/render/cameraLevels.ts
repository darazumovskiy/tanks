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

// Коробка противника на ближнем уровне; на дальних достаточно, чтобы он был в окне с небольшим запасом.
export const ENEMY_AREA = { left: 0.1, right: 0.9, top: 0.14, bottom: 0.7 };
const ENEMY_FAR_MARGIN = 0.04;
// Гистерезис уровня: выше — когда пара перестала помещаться, ниже — когда помещается с запасом и это
// держится долго: приближение заметнее отдаления, его нельзя делать на каждый манёвр. В полосе между
// порогами выдержка не копится и не сбрасывается.
export const ZOOM_OUT_RATIO = 1;
export const ZOOM_IN_RATIO = 0.85;
export const ZOOM_OUT_DWELL_MS = 150;
export const ZOOM_IN_DWELL_MS = 1500;
// Дальние уровни: всё поле и полтора поля — второй нужен, когда я у нижней стенки, а противник высоко:
// в окне высотой с поле он не помещается над моим танком, прижатым к верхней половине экрана.
export const FAR_HEIGHTS: readonly number[] = [ARENA.height, ARENA.height * 1.5];

export interface ScreenArea {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const FAR_ENEMY_AREA: ScreenArea = {
  left: ENEMY_FAR_MARGIN,
  right: 1 - ENEMY_FAR_MARGIN,
  top: ENEMY_FAR_MARGIN,
  bottom: 1 - ENEMY_FAR_MARGIN,
};

export interface ZoomLevel {
  height: number;
  isFar: boolean;
}

// Лестница уровней снизу вверх: ближний (обзор) и дальние. Обзор не меньше поля — ближнего уровня нет.
export function zoomLadder(near: number): ZoomLevel[] {
  const far = FAR_HEIGHTS.map((height) => ({ height, isFar: true }));
  if (near >= ARENA.height) {
    return far;
  }
  return [{ height: near, isFar: false }, ...far];
}

export function enemyAreaOf(level: ZoomLevel): ScreenArea {
  return level.isFar ? FAR_ENEMY_AREA : ENEMY_AREA;
}

export function isFarCamera(camera: Camera): boolean {
  return camera.height >= ARENA.height - 1;
}

// Во сколько раз разнос пары превышает то, что помещается на уровне при соблюдении коробок обоих танков:
// по x — общая полоса, по y — зависит от того, кто выше; `meBottom` — нижняя граница своего танка там, где
// он сейчас по горизонтали.
export function fitRatio(me: Point, enemy: Point, level: ZoomLevel, aspect: number, meBottom: number): number {
  const area = enemyAreaOf(level);
  const width = level.height * aspect;
  const spanX = (area.right - TANK_AREA.left) * width;
  const dy = enemy.y - me.y;
  const spanY = dy < 0 ? (meBottom - area.top) * level.height : (area.bottom - TANK_AREA.top) * level.height;
  return Math.max(Math.abs(enemy.x - me.x) / spanX, Math.abs(dy) / spanY);
}

type Fit = (level: ZoomLevel) => number | null;

// Положение на лестнице уровней с гистерезисом и выдержкой. Без противника уровень не меняется; после сброса
// берётся самый близкий уровень, где пара помещается; при смене стратегии — уровень по унаследованной высоте.
export class ZoomLevels {
  private index: number | null = null;
  private pendingIndex: number | null = null;
  private pendingMs = 0;

  reset(): void {
    this.index = null;
    this.pendingIndex = null;
    this.pendingMs = 0;
  }

  adopt(height: number, ladder: readonly ZoomLevel[]): void {
    let best = 0;
    ladder.forEach((level, index) => {
      const current = ladder[best];
      if (current !== undefined && Math.abs(level.height - height) < Math.abs(current.height - height)) {
        best = index;
      }
    });
    this.index = best;
    this.pendingIndex = null;
    this.pendingMs = 0;
  }

  next(ladder: readonly ZoomLevel[], fit: Fit, dtMs: number): ZoomLevel {
    this.index = this.resolve(ladder, fit, dtMs);
    return ladder[this.index] ?? ladder[ladder.length - 1] ?? { height: ARENA.height, isFar: true };
  }

  // Вверх — на первый уровень, где пара помещается; не помещается нигде — дальше первого дальнего не уходим:
  // отдаление без цели только мельчит картинку. Вниз — на самый близкий уровень, где помещается с запасом.
  private resolve(ladder: readonly ZoomLevel[], fit: Fit, dtMs: number): number {
    const last = ladder.length - 1;
    const ratios = ladder.map((level) => fit(level));
    const firstFar = Math.max(
      0,
      ladder.findIndex((level) => level.isFar),
    );
    const fitting = ratios.findIndex((ratio) => ratio !== null && ratio <= ZOOM_OUT_RATIO);
    if (this.index === null) {
      return fitting === -1 ? firstFar : fitting;
    }
    const index = Math.min(this.index, last);
    const currentRatio = ratios[index];
    if (currentRatio === null || currentRatio === undefined) {
      return index;
    }
    const lowestWithMargin = ratios.findIndex((ratio) => ratio !== null && ratio < ZOOM_IN_RATIO);
    let desired: number | null = null;
    let isHolding = false;
    if (currentRatio > ZOOM_OUT_RATIO) {
      const upward = fitting > index ? fitting : Math.max(index, firstFar);
      desired = upward === index ? null : upward;
    } else if (lowestWithMargin !== -1 && lowestWithMargin < index) {
      desired = lowestWithMargin;
    } else if (fitting < index) {
      isHolding = this.pendingIndex !== null && this.pendingIndex < index;
    }
    if (isHolding) {
      return index;
    }
    if (desired === null) {
      this.pendingIndex = null;
      this.pendingMs = 0;
      return index;
    }
    if (this.pendingIndex !== desired) {
      this.pendingIndex = desired;
      this.pendingMs = 0;
    }
    this.pendingMs += dtMs;
    const dwell = desired > index ? ZOOM_OUT_DWELL_MS : ZOOM_IN_DWELL_MS;
    if (this.pendingMs < dwell) {
      return index;
    }
    this.pendingIndex = null;
    this.pendingMs = 0;
    return desired;
  }
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
  height: number,
  canvasWidth: number,
  canvasHeight: number,
  voidLimit: { x: number; y: number },
): Camera {
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
