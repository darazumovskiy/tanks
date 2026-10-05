import { ffaMap } from '@tanks/shared/engine';
import { describe, expect, it, vi } from 'vitest';
import type { Camera } from './camera.js';
import { floorKeysTouching } from './floorChunks.js';
import { TiledFloor } from './tiledFloor.js';

// Холстов в happy-dom нет: холст куска — запись размеров, рисование куска двигает часы на его цену.
interface FakeCanvas {
  width: number;
  height: number;
}

const fake = vi.hoisted(() => ({
  chunkCanvases: [] as FakeCanvas[],
  underlay: { width: 1300, height: 725 },
  clockMs: 0,
  chunkMs: 1,
}));

vi.mock('./view.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./view.js')>();
  return {
    ...original,
    makeCanvas: (width: number, height: number) => {
      const canvas: FakeCanvas = { width, height };
      fake.chunkCanvases.push(canvas);
      return { canvas, ctx: { setTransform: () => undefined } };
    },
  };
});

vi.mock('./ffaFloor.js', () => ({
  UNDERLAY_SCALE: 0.25,
  createFfaShade: () => ({ width: 1300, height: 725 }),
  createFfaUnderlay: () => fake.underlay,
  drawFfaFloor: () => {
    fake.clockMs += fake.chunkMs;
  },
}));

const MAP = ffaMap(50);
const SETTLE_FRAMES = 80;
const PHONE: Camera = { x: 2000, y: 1000, width: 1600, height: 740, scale: 1.714 };
const FAR: Camera = { ...PHONE, x: 300, y: 300 };
// Тот же телефон, повёрнутый или с другим окном: масштаб и разрешение другие.
const RESIZED: Camera = { ...FAR, scale: 1.2 };

function newFloor(chunkMs: number): TiledFloor {
  fake.chunkCanvases.length = 0;
  fake.chunkMs = chunkMs;
  return new TiledFloor(MAP, () => fake.clockMs);
}

function settle(floor: TiledFloor, camera: Camera): void {
  for (let frame = 0; frame < SETTLE_FRAMES; frame++) {
    floor.update(camera);
  }
}

function heldCanvases(): FakeCanvas[] {
  return fake.chunkCanvases.filter((canvas) => canvas.width > 0 || canvas.height > 0);
}

interface DrawLog {
  chunks: number;
  underlays: number;
}

// Холст размером с окно камеры без тряски; считает, сколько раз лёг кусок и подложка.
function drawOnce(floor: TiledFloor, camera: Camera): DrawLog {
  const log: DrawLog = { chunks: 0, underlays: 0 };
  const ctx = {
    canvas: { width: camera.width * camera.scale, height: camera.height * camera.scale },
    getTransform: () => ({ a: camera.scale, e: -camera.x * camera.scale, f: -camera.y * camera.scale }),
    save: () => undefined,
    restore: () => undefined,
    setTransform: () => undefined,
    drawImage: (image: unknown) => {
      if (image === fake.underlay) {
        log.underlays++;
      } else {
        log.chunks++;
      }
    },
  } as unknown as CanvasRenderingContext2D;
  floor.draw(ctx, camera);
  return log;
}

describe('пол кусками: бюджет кадра', () => {
  it.each([
    ['средние куски слабого телефона', 3.6, 2],
    ['обычный телефон', 0.9, 5],
    ['худшие куски', 27, 1],
  ])('%s — за первый кадр столько кусков, сколько влезло в бюджет', (_name, chunkMs, chunks) => {
    const floor = newFloor(chunkMs);
    floor.update(PHONE);
    expect(floor.chunkCount).toBe(chunks);
  });
});

describe('пол кусками: память холстов', () => {
  it('выброшенные холсты — ширина и высота 0: после ухода окна, смены разрешения и clear', () => {
    const floor = newFloor(1);
    settle(floor, PHONE);
    const first = [...fake.chunkCanvases];
    expect(heldCanvases()).toHaveLength(floor.chunkCount);

    settle(floor, FAR);
    expect(heldCanvases()).toHaveLength(floor.chunkCount);
    const leftBehind = first.filter((canvas) => canvas.width === 0 && canvas.height === 0);
    expect(leftBehind.length).toBeGreaterThan(0);

    const beforeResize = [...fake.chunkCanvases];
    settle(floor, RESIZED);
    expect(heldCanvases()).toHaveLength(floor.chunkCount);
    expect(beforeResize.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);

    floor.clear();
    expect(floor.chunkCount).toBe(0);
    expect(floor.memoryMb).toBe(0);
    expect(heldCanvases()).toEqual([]);
  });
});

describe('пол кусками: смена разрешения', () => {
  it('сразу после смены видны все куски старого разрешения, подложки нет; за кадр заменяется в бюджет', () => {
    const floor = newFloor(3.6);
    settle(floor, FAR);
    const count = floor.chunkCount;
    const held = heldCanvases().length;
    expect(drawOnce(floor, RESIZED)).toEqual({ chunks: floorKeysTouching(MAP, RESIZED).length, underlays: 0 });
    expect(floor.chunkCount).toBe(count);
    expect(heldCanvases()).toHaveLength(held);
  });
});
