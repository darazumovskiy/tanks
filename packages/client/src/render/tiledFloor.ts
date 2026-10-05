import type { FfaMap } from '@tanks/shared/engine';
import type { Camera } from './camera.js';
import { createFfaShade, createFfaUnderlay, drawFfaFloor, UNDERLAY_SCALE } from './ffaFloor.js';
import {
  drawWithinBudget,
  FLOOR_FRAME_BUDGET_MS,
  floorChunkBytes,
  floorKeysTouching,
  pendingFloorArea,
  placeChunk,
  planFloor,
  type FloorChunk,
  type Rect,
} from './floorChunks.js';
import { makeCanvas } from './view.js';

const BYTES_PER_MB = 1e6;

interface ReadyChunk {
  chunk: FloorChunk;
  canvas: HTMLCanvasElement;
}

// Кусок целиком по рецепту пола: тон, крапинки, сетка, пунктир областей, стены с тенью в единицах поля.
export function renderFloorChunk(map: FfaMap, shade: HTMLCanvasElement, chunk: FloorChunk): HTMLCanvasElement {
  const { pixels, resolution } = chunk;
  const { canvas, ctx } = makeCanvas(pixels.width, pixels.height);
  ctx.setTransform(resolution, 0, 0, resolution, -pixels.x, -pixels.y);
  const area = {
    x: pixels.x / resolution,
    y: pixels.y / resolution,
    width: pixels.width / resolution,
    height: pixels.height / resolution,
  };
  drawFfaFloor(ctx, map, area, resolution, shade);
  return canvas;
}

// Что холст показывает сейчас — окно камеры вместе с тряской; null — холст ничего не показывает.
function shownArea(ctx: CanvasRenderingContext2D): Rect | null {
  const { a: scale, e: offsetX, f: offsetY } = ctx.getTransform();
  if (scale <= 0) {
    return null;
  }
  return {
    x: -offsetX / scale,
    y: -offsetY / scale,
    width: ctx.canvas.width / scale,
    height: ctx.canvas.height / scale,
  };
}

// Пол большой карты: подложка всего поля и куски полного качества вокруг окна камеры. Подложка видна только на
// месте кусков, которые ещё не нарисованы.
export class TiledFloor {
  private readonly shade: HTMLCanvasElement;
  private readonly underlay: HTMLCanvasElement;
  private readonly ready = new Map<number, ReadyChunk>();
  private bytes = 0;

  // `now` — часы бюджета кадра в миллисекундах.
  constructor(
    private readonly map: FfaMap,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.shade = createFfaShade(map);
    this.underlay = createFfaUnderlay(map, this.shade);
  }

  get chunkCount(): number {
    return this.ready.size;
  }

  get memoryMb(): number {
    return this.bytes / BYTES_PER_MB;
  }

  // Холст уже в координатах поля через камеру и тряску.
  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    this.update(camera);
    const shown = shownArea(ctx);
    if (shown === null) {
      return;
    }
    const pending = pendingFloorArea(this.map, shown, new Set(this.ready.keys()));
    if (pending !== null) {
      this.drawUnderlay(ctx, pending);
    }
    this.drawChunks(ctx);
  }

  update(camera: Camera): void {
    const cached = new Map([...this.ready].map(([key, ready]) => [key, ready.chunk.resolution]));
    const plan = planFloor(this.map, camera, cached);
    for (const key of plan.evict) {
      this.drop(key);
    }
    drawWithinBudget(plan.create, FLOOR_FRAME_BUDGET_MS, this.now, (chunk) => {
      const canvas = renderFloorChunk(this.map, this.shade, chunk);
      this.drop(chunk.key);
      this.ready.set(chunk.key, { chunk, canvas });
      this.bytes += floorChunkBytes(chunk);
    });
  }

  clear(): void {
    for (const key of [...this.ready.keys()]) {
      this.drop(key);
    }
  }

  // Готовые куски под тем, что показывает холст, — в целых точках экрана, по строкам.
  drawChunks(ctx: CanvasRenderingContext2D): void {
    const shown = shownArea(ctx);
    if (shown === null) {
      return;
    }
    const { a: scale, e: offsetX, f: offsetY } = ctx.getTransform();
    const screen = { scale, x: offsetX, y: offsetY };
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const key of floorKeysTouching(this.map, shown)) {
      const ready = this.ready.get(key);
      if (ready === undefined) {
        continue;
      }
      const placement = placeChunk(ready.chunk, screen);
      if (placement === null) {
        continue;
      }
      const { source, target } = placement;
      ctx.drawImage(
        ready.canvas,
        source.x,
        source.y,
        source.width,
        source.height,
        target.x,
        target.y,
        target.width,
        target.height,
      );
    }
    ctx.restore();
  }

  // Часть подложки под неготовыми кусками. Границы кусков приходятся на целые точки подложки, и край подложки ложится
  // ровно по краю неготового куска; точку экрана, которую он делит с готовым соседом, закрывает перекрытие соседа.
  private drawUnderlay(ctx: CanvasRenderingContext2D, area: Rect): void {
    const left = Math.floor(area.x * UNDERLAY_SCALE);
    const top = Math.floor(area.y * UNDERLAY_SCALE);
    const right = Math.min(this.underlay.width, Math.ceil((area.x + area.width) * UNDERLAY_SCALE));
    const bottom = Math.min(this.underlay.height, Math.ceil((area.y + area.height) * UNDERLAY_SCALE));
    const sourceWidth = right - left;
    const sourceHeight = bottom - top;
    ctx.drawImage(
      this.underlay,
      left,
      top,
      sourceWidth,
      sourceHeight,
      left / UNDERLAY_SCALE,
      top / UNDERLAY_SCALE,
      sourceWidth / UNDERLAY_SCALE,
      sourceHeight / UNDERLAY_SCALE,
    );
  }

  // Ширина 0 отдаёт память холста сразу, не дожидаясь сборщика.
  private drop(key: number): void {
    const ready = this.ready.get(key);
    if (ready === undefined) {
      return;
    }
    this.ready.delete(key);
    this.bytes -= floorChunkBytes(ready.chunk);
    ready.canvas.width = 0;
    ready.canvas.height = 0;
  }
}
