import { describe, expect, it } from 'vitest';
import { FFA_SIZES, ffaMap, type FieldSize } from '@tanks/shared/engine';
import { ffaCameraWindow, type ScreenSize } from '../ffa/ffaCamera.js';
import type { Camera } from './camera.js';
import {
  drawWithinBudget,
  FLOOR_CHUNK_SIZE,
  FLOOR_FRAME_BUDGET_MS,
  floorChunkAt,
  floorChunkBytes,
  floorKeysTouching,
  floorResolution,
  pendingFloorArea,
  placeChunk,
  planFloor,
  type ChunkPlacement,
  type FloorChunk,
  type FloorPlan,
  type ScreenTransform,
} from './floorChunks.js';

// Договор пола: бюджет кадра 4 мс, но хотя бы один новый кусок; 64 куска в кэше.
const FLOOR_CHUNK_LIMIT = 64;
// Слабый телефон (процессор ×4): кусок со стенами в среднем 3,6 мс — два за кадр; худший 27 мс — один.
const AVERAGE_CHUNK_MS = 3.6;
const WORST_CHUNK_MS = 27;
const AVERAGE_CHUNKS_PER_FRAME = 2;
// Поля холста куска: точка перекрытия и точка на сглаживание.
const PADDING_PX = 3;
const MAP = ffaMap(50);
const COLUMNS = Math.ceil(MAP.width / FLOOR_CHUNK_SIZE);
const BYTES_PER_MB = 1e6;
const FRAME_S = 1 / 60;
// Экраны в точках холста: телефон 844 × 390 с плотностью 3,25 и компьютер 4K.
const PHONE: ScreenSize = { width: Math.round(844 * 3.25), height: Math.round(390 * 3.25) };
const DESKTOP_4K: ScreenSize = { width: 3840, height: 2160 };
const PHONE_RESOLUTION = 1.75;
const DESKTOP_RESOLUTION = 2;
// Окно камеры с запасом полкуска задевает не больше стольких кусков.
const PHONE_WINDOW_CHUNKS = 45;
const DESKTOP_WINDOW_CHUNKS = 54;
const TANK_SPEED = 220;
const CAMERA_SPEED = 800;
// Свой танк не дальше края поля, точка камеры — не дальше сдвига по башне.
const CAMERA_REACH = 240;
const WARMUP_FRAMES = 30;

interface Point {
  x: number;
  y: number;
}

function cameraAt(screen: ScreenSize, centerX: number, centerY: number): Camera {
  const view = ffaCameraWindow(screen);
  return {
    x: centerX - view.width / 2,
    y: centerY - view.height / 2,
    width: view.width,
    height: view.height,
    scale: screen.height / view.height,
  };
}

function chunkOfKey(key: number, resolution: number): FloorChunk {
  return floorChunkAt(MAP, key % COLUMNS, Math.floor(key / COLUMNS), resolution);
}

function interiorBytes(resolution: number): number {
  return floorChunkBytes(floorChunkAt(MAP, 5, 5, resolution));
}

function distanceToCenter(chunk: FloorChunk, camera: Camera): number {
  const { area } = chunk;
  return Math.hypot(
    area.x + area.width / 2 - (camera.x + camera.width / 2),
    area.y + area.height / 2 - (camera.y + camera.height / 2),
  );
}

// Кэш, как его держит пол кусками: выбросить, затем рисовать в бюджет кадра; каждый кусок стоит `chunkMs`.
class CacheModel {
  readonly chunks = new Map<number, FloorChunk>();

  constructor(private readonly chunkMs = AVERAGE_CHUNK_MS) {}

  plan(field: FieldSize, camera: Camera): FloorPlan {
    const cached = new Map([...this.chunks].map(([key, chunk]) => [key, chunk.resolution]));
    return planFloor(field, camera, cached);
  }

  // Нарисованные за кадр.
  apply(plan: FloorPlan): FloorChunk[] {
    for (const key of plan.evict) {
      this.chunks.delete(key);
    }
    let clockMs = 0;
    const drawn: FloorChunk[] = [];
    drawWithinBudget(
      plan.create,
      FLOOR_FRAME_BUDGET_MS,
      () => clockMs,
      (chunk) => {
        clockMs += this.chunkMs;
        this.chunks.set(chunk.key, chunk);
        drawn.push(chunk);
      },
    );
    return drawn;
  }

  get bytes(): number {
    return [...this.chunks.values()].reduce((sum, chunk) => sum + floorChunkBytes(chunk), 0);
  }

  missingVisible(field: FieldSize, camera: Camera): number[] {
    return floorKeysTouching(field, camera).filter((key) => !this.chunks.has(key));
  }
}

// Новые видимые среди нарисованных за кадр — столько, сколько их не хватает, но не больше нарисованных.
function expectVisibleFirst(drawn: readonly FloorChunk[], missing: readonly number[]): void {
  const createdVisible = drawn.filter((chunk) => missing.includes(chunk.key)).length;
  expect(createdVisible).toBe(Math.min(drawn.length, missing.length));
}

// Змейка точек камеры через всю карту с шагом кадра: строки от верхнего края до нижнего, каждая — от края до края.
function serpentine(speed: number): Point[] {
  const step = speed * FRAME_S;
  const rows = [-CAMERA_REACH, MAP.height * 0.25, MAP.height * 0.5, MAP.height * 0.75, MAP.height + CAMERA_REACH];
  const points: Point[] = [];
  rows.forEach((y, index) => {
    const isForward = index % 2 === 0;
    const from = isForward ? -CAMERA_REACH : MAP.width + CAMERA_REACH;
    const to = isForward ? MAP.width + CAMERA_REACH : -CAMERA_REACH;
    for (let travelled = 0; travelled <= Math.abs(to - from); travelled += step) {
      points.push({ x: from + Math.sign(to - from) * travelled, y });
    }
    const nextY = rows[index + 1];
    if (nextY === undefined) {
      return;
    }
    for (let travelled = step; travelled < nextY - y; travelled += step) {
      points.push({ x: to, y: y + travelled });
    }
  });
  return points;
}

interface PathReport {
  peakChunks: number;
  peakBytes: number;
  framesWithHole: number;
}

// Каждый кадр пути: новые в бюджет кадра, видимые первыми, кэш в лимите; возвращает пики и кадры с дырой.
function drivePath(
  screen: ScreenSize,
  points: readonly Point[],
  resolution: number,
  chunkMs = AVERAGE_CHUNK_MS,
): PathReport {
  const cache = new CacheModel(chunkMs);
  const perFrame = Math.max(1, Math.ceil(FLOOR_FRAME_BUDGET_MS / chunkMs));
  const report: PathReport = { peakChunks: 0, peakBytes: 0, framesWithHole: 0 };
  points.forEach((point, frame) => {
    const camera = cameraAt(screen, point.x, point.y);
    const missing = cache.missingVisible(MAP, camera);
    const plan = cache.plan(MAP, camera);
    expect(plan.create.every((chunk) => chunk.resolution === resolution)).toBe(true);
    const drawn = cache.apply(plan);
    expect(drawn).toHaveLength(Math.min(perFrame, plan.create.length));
    expectVisibleFirst(drawn, missing);
    expect(cache.chunks.size).toBeLessThanOrEqual(FLOOR_CHUNK_LIMIT);
    report.peakChunks = Math.max(report.peakChunks, cache.chunks.size);
    report.peakBytes = Math.max(report.peakBytes, cache.bytes);
    if (frame >= WARMUP_FRAMES && cache.missingVisible(MAP, camera).length > 0) {
      report.framesWithHole++;
    }
  });
  return report;
}

function placed(placement: ChunkPlacement | null | undefined): ChunkPlacement {
  if (placement === null || placement === undefined) {
    throw new Error('кусок не лёг на экран');
  }
  return placement;
}

describe('разрешение кусков', () => {
  it.each([
    [0.1, 0.25],
    [0.8, 1],
    [1, 1],
    [1.0000000001, 1],
    [1.055, 1.25],
    [1.714, 1.75],
    [1.75, 1.75],
    [2.4, 2],
  ])('масштаб %f — разрешение %f', (scale, resolution) => {
    expect(floorResolution(scale)).toBe(resolution);
  });

  it('телефон 844 × 390 с плотностью 3,25 — 1,75; компьютер 4K — 2', () => {
    expect(floorResolution(cameraAt(PHONE, 0, 0).scale)).toBe(PHONE_RESOLUTION);
    expect(floorResolution(cameraAt(DESKTOP_4K, 0, 0).scale)).toBe(DESKTOP_RESOLUTION);
  });
});

describe('бюджет кадра', () => {
  // Очередь — цены кусков в миллисекундах; рисование куска двигает часы на его цену.
  function drawnOf(costs: readonly number[]): number {
    let clockMs = 100;
    return drawWithinBudget(
      costs,
      FLOOR_FRAME_BUDGET_MS,
      () => clockMs,
      (cost) => {
        clockMs += cost;
      },
    );
  }

  it.each([
    ['средние куски слабого телефона', [3.6, 3.6, 3.6, 3.6], 2],
    ['обычный телефон — впятеро дешевле', [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9], 5],
    ['первый тяжёлый — один, второй тяжёлый ждёт', [27, 27], 1],
    ['дешёвый, затем тяжёлый — тяжёлый ещё в этом кадре, дальше ни одного', [1, 27, 1], 2],
    ['ровно бюджет — стоп', [2, 2, 2], 2],
    ['очередь короче бюджета', [1], 1],
    ['пустая очередь', [], 0],
  ])('%s', (_name, costs, drawn) => {
    expect(drawnOf(costs)).toBe(drawn);
  });
});

describe('путь камеры через всю карту 50', () => {
  it.each([
    ['телефон, скорость танка', PHONE, TANK_SPEED, PHONE_RESOLUTION, PHONE_WINDOW_CHUNKS],
    ['телефон, потолок камеры', PHONE, CAMERA_SPEED, PHONE_RESOLUTION, PHONE_WINDOW_CHUNKS],
    ['компьютер 4K, скорость танка', DESKTOP_4K, TANK_SPEED, DESKTOP_RESOLUTION, DESKTOP_WINDOW_CHUNKS],
    ['компьютер 4K, потолок камеры', DESKTOP_4K, CAMERA_SPEED, DESKTOP_RESOLUTION, DESKTOP_WINDOW_CHUNKS],
  ])(
    '%s, средние куски слабого телефона: два новых за кадр, видимые первыми, в движении под окном нет неготовых',
    (_name, screen, speed, resolution, windowChunks) => {
      const report = drivePath(screen, serpentine(speed), resolution);
      expect(report.framesWithHole).toBe(0);
      expect(report.peakChunks).toBeLessThanOrEqual(windowChunks);
      expect(report.peakBytes).toBeLessThanOrEqual(windowChunks * interiorBytes(resolution));
    },
  );

  it.each([
    ['телефон', PHONE, PHONE_RESOLUTION],
    ['компьютер 4K', DESKTOP_4K, DESKTOP_RESOLUTION],
  ])('%s, все куски худшие: по одному за кадр, на скорости танка дыр нет', (_name, screen, resolution) => {
    expect(drivePath(screen, serpentine(TANK_SPEED), resolution, WORST_CHUNK_MS).framesWithHole).toBe(0);
  });

  it('память: телефон до 38 МБ, компьютер 4K до 59 МБ, предел кэша — 64 куска при разрешении 2, до 69 МБ', () => {
    const phone = drivePath(PHONE, serpentine(CAMERA_SPEED), PHONE_RESOLUTION);
    const desktop = drivePath(DESKTOP_4K, serpentine(CAMERA_SPEED), DESKTOP_RESOLUTION);
    expect(phone.peakBytes / BYTES_PER_MB).toBeLessThan(38);
    expect(desktop.peakBytes / BYTES_PER_MB).toBeLessThan(59);
    expect((FLOOR_CHUNK_LIMIT * interiorBytes(DESKTOP_RESOLUTION)) / BYTES_PER_MB).toBeLessThan(69);
  });
});

describe('перестановка и смена разрешения', () => {
  it.each([
    ['телефон', PHONE],
    ['компьютер 4K', DESKTOP_4K],
  ])('%s: перестановка через полкарты — старое выброшено, по два видимых за кадр от центра окна', (_name, screen) => {
    const cache = new CacheModel();
    const before = cameraAt(screen, MAP.width * 0.25, MAP.height / 2);
    for (let frame = 0; frame < 60; frame++) {
      cache.apply(cache.plan(MAP, before));
    }
    const oldKeys = new Set(cache.chunks.keys());
    const after = cameraAt(screen, MAP.width * 0.75, MAP.height / 2);
    const visible = floorKeysTouching(MAP, after);
    const first = cache.plan(MAP, after);
    expect(new Set(first.evict)).toEqual(oldKeys);
    const nearest = visible
      .map((key) => distanceToCenter(chunkOfKey(key, floorResolution(after.scale)), after))
      .sort((a, b) => a - b)
      .slice(0, AVERAGE_CHUNKS_PER_FRAME);
    expect(cache.apply(first).map((chunk) => distanceToCenter(chunk, after))).toEqual(nearest);
    let frames = 1;
    for (let missing = cache.missingVisible(MAP, after); missing.length > 0; frames++) {
      const drawn = cache.apply(cache.plan(MAP, after));
      expect(drawn).toHaveLength(AVERAGE_CHUNKS_PER_FRAME);
      expectVisibleFirst(drawn, missing);
      missing = cache.missingVisible(MAP, after);
    }
    expect(frames).toBe(Math.ceil(visible.length / AVERAGE_CHUNKS_PER_FRAME));
  });

  it('смена разрешения со сдвигом окна: старые куски видны до замены; недостающие, затем старые видимые, затем запас', () => {
    const cache = new CacheModel();
    const phone = cameraAt(PHONE, 2600, 1450);
    for (let frame = 0; frame < 40; frame++) {
      cache.apply(cache.plan(MAP, phone));
    }
    const resized = cameraAt({ width: 1688, height: 780 }, 2900, 1450);
    const visible = floorKeysTouching(MAP, resized);
    const kept = visible.filter((key) => cache.chunks.get(key)?.resolution === PHONE_RESOLUTION);
    expect(kept.length).toBeGreaterThan(0);
    expect(cache.missingVisible(MAP, resized).length).toBeGreaterThan(AVERAGE_CHUNKS_PER_FRAME);
    let frames = 0;
    for (let plan = cache.plan(MAP, resized); plan.create.length > 0; plan = cache.plan(MAP, resized)) {
      expect(plan.create.every((chunk) => chunk.resolution === 1.25)).toBe(true);
      const missing = cache.missingVisible(MAP, resized);
      const outdated = visible.filter((key) => cache.chunks.get(key)?.resolution !== 1.25);
      const drawn = cache.apply(plan);
      expectVisibleFirst(drawn, missing);
      const drawnVisible = drawn.filter((chunk) => visible.includes(chunk.key)).length;
      expect(drawnVisible).toBe(Math.min(drawn.length, outdated.length));
      expect(kept.every((key) => cache.chunks.has(key))).toBe(true);
      expect(cache.chunks.size).toBeLessThanOrEqual(FLOOR_CHUNK_LIMIT);
      frames++;
    }
    expect(frames).toBeGreaterThan(1);
    expect([...cache.chunks.values()].every((chunk) => chunk.resolution === 1.25)).toBe(true);
  });

  it('смена разрешения при окне больше лимита: кэш не растёт сверх 64 кусков, старые уходят по мере замены', () => {
    const cache = new CacheModel();
    const wide: Camera = { x: 600, y: 300, width: 3000, height: 2000, scale: 1 };
    for (let frame = 0; frame < 60; frame++) {
      cache.apply(cache.plan(MAP, wide));
    }
    const sharper = { ...wide, scale: 1.5 };
    for (let frame = 0; frame < 60; frame++) {
      const plan = cache.plan(MAP, sharper);
      expect(plan.evict).toEqual([]);
      const drawn = cache.apply(plan);
      expect(cache.chunks.size).toBe(FLOOR_CHUNK_LIMIT);
      expect(drawn.every((chunk) => chunk.resolution === 1.5)).toBe(true);
    }
    expect([...cache.chunks.values()].every((chunk) => chunk.resolution === 1.5)).toBe(true);
  });

  it('окно больше лимита: кэш не больше 64 кусков — ближних к центру', () => {
    const cache = new CacheModel();
    const wide: Camera = { x: 600, y: 300, width: 3000, height: 2000, scale: 1 };
    for (let frame = 0; frame < 60; frame++) {
      cache.apply(cache.plan(MAP, wide));
      expect(cache.chunks.size).toBeLessThanOrEqual(FLOOR_CHUNK_LIMIT);
    }
    expect(cache.chunks.size).toBe(FLOOR_CHUNK_LIMIT);
    expect(cache.plan(MAP, wide)).toMatchObject({ evict: [], create: [] });
    const farthestKept = Math.max(...[...cache.chunks.values()].map((chunk) => distanceToCenter(chunk, wide)));
    const nearestDropped = Math.min(
      ...floorKeysTouching(MAP, wide)
        .filter((key) => !cache.chunks.has(key))
        .map((key) => distanceToCenter(chunkOfKey(key, 1), wide)),
    );
    expect(farthestKept).toBeLessThanOrEqual(nearestDropped);
  });
});

describe('куски и холсты', () => {
  it('внутренний кусок — квадрат с полями в три точки; у края поля холст обрезан по полю', () => {
    expect(floorChunkAt(MAP, 8, 2, 1.75)).toMatchObject({
      key: 2 * COLUMNS + 8,
      area: { x: 2048, y: 512, width: FLOOR_CHUNK_SIZE, height: FLOOR_CHUNK_SIZE },
      pixels: { x: 2048 * 1.75 - PADDING_PX, y: 512 * 1.75 - PADDING_PX, width: 454, height: 454 },
    });
    const corner = floorChunkAt(MAP, 20, 11, 1.75);
    expect(corner.area).toEqual({ x: 5120, y: 2816, width: 80, height: 84 });
    expect(corner.pixels).toEqual({
      x: 5120 * 1.75 - PADDING_PX,
      y: 2816 * 1.75 - PADDING_PX,
      width: 143,
      height: 150,
    });
    expect(floorChunkAt(MAP, 0, 0, 2).pixels).toEqual({ x: 0, y: 0, width: 515, height: 515 });
  });

  it.each(FFA_SIZES)('карта %i: холст ни одного куска при любом разрешении не выходит за поле', (size) => {
    const map = ffaMap(size);
    const columns = Math.ceil(map.width / FLOOR_CHUNK_SIZE);
    const rows = Math.ceil(map.height / FLOOR_CHUNK_SIZE);
    for (const resolution of [0.25, 0.5, 1.25, 1.75, 2]) {
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          const { pixels } = floorChunkAt(map, column, row, resolution);
          expect(pixels.x).toBeGreaterThanOrEqual(0);
          expect(pixels.y).toBeGreaterThanOrEqual(0);
          expect(pixels.x + pixels.width).toBeLessThanOrEqual(Math.ceil(map.width * resolution));
          expect(pixels.y + pixels.height).toBeLessThanOrEqual(Math.ceil(map.height * resolution));
        }
      }
    }
  });

  it('край поля на дробной точке разрешения: холст захватывает точку, которую делит край', () => {
    const bottom = floorChunkAt(ffaMap(30), 3, 8, 0.25);
    expect(bottom.area.y + bottom.area.height).toBe(2250);
    expect(bottom.pixels.y + bottom.pixels.height).toBe(563);
  });

  it('подложка видна только под неготовыми: всё готово — нигде; иначе охват неготовых в пределах поля', () => {
    const shown = { x: 4900.4, y: 2600.6, width: 600, height: 400 };
    const keys = floorKeysTouching(MAP, shown);
    expect(pendingFloorArea(MAP, shown, new Set(keys))).toBeNull();
    const cornerKey = 11 * COLUMNS + 20;
    expect(pendingFloorArea(MAP, shown, new Set(keys.filter((key) => key !== cornerKey)))).toEqual({
      x: 5120,
      y: 2816,
      width: 80,
      height: 84,
    });
    const firstKey = keys[0] ?? -1;
    expect(pendingFloorArea(MAP, shown, new Set(keys.filter((key) => key !== cornerKey && key !== firstKey)))).toEqual({
      x: 4864,
      y: 2560,
      width: 336,
      height: 340,
    });
    expect(pendingFloorArea(MAP, shown, new Set())).toEqual({ x: 4864, y: 2560, width: 336, height: 340 });
  });

  it('прямоугольник частью за полем — только куски поля, по строкам', () => {
    expect(floorKeysTouching(MAP, { x: -500, y: -500, width: 800, height: 900 })).toEqual([0, 1, COLUMNS, COLUMNS + 1]);
    expect(floorKeysTouching(MAP, { x: 5100, y: 2800, width: 900, height: 900 })).toEqual([
      10 * COLUMNS + 19,
      10 * COLUMNS + 20,
      11 * COLUMNS + 19,
      11 * COLUMNS + 20,
    ]);
    expect(floorKeysTouching(MAP, { x: -900, y: 100, width: 400, height: 100 })).toEqual([]);
  });
});

describe('место куска на экране', () => {
  const JUNCTION = { x: 1024, y: 512 };

  // Четыре куска вокруг стыка: левый верхний, правый верхний, левый нижний; стык — в точке экрана (offsetX; offsetY).
  function aroundJunction(scale: number, offsetX: number, offsetY: number): ChunkPlacement[] {
    const resolution = floorResolution(scale);
    const screen: ScreenTransform = { scale, x: -JUNCTION.x * scale + offsetX, y: -JUNCTION.y * scale + offsetY };
    const column = JUNCTION.x / FLOOR_CHUNK_SIZE;
    const row = JUNCTION.y / FLOOR_CHUNK_SIZE;
    return [
      [column - 1, row - 1],
      [column, row - 1],
      [column - 1, row],
    ].map(([chunkColumn = 0, chunkRow = 0]) =>
      placed(placeChunk(floorChunkAt(MAP, chunkColumn, chunkRow, resolution), screen)),
    );
  }

  it.each([
    [0.8, 300.37, 200.61],
    [1.055, 421.5, 190.25],
    [1.714, 300.99, 333.01],
    [2.4, 512.13, 287.77],
    [0.3, 100.4, 80.6],
  ])(
    'масштаб %f, стык в дробной точке (%f; %f): края в целых точках, соседи заходят друг на друга на 1–2 точки',
    (scale, offsetX, offsetY) => {
      const [topLeft, topRight, bottomLeft] = aroundJunction(scale, offsetX, offsetY);
      const { target } = placed(topLeft);
      for (const value of [target.x, target.y, target.width, target.height]) {
        expect(Number.isInteger(value)).toBe(true);
      }
      const across = target.x + target.width - placed(topRight).target.x;
      const along = target.y + target.height - placed(bottomLeft).target.y;
      for (const overlap of [across, along]) {
        expect(overlap).toBeGreaterThanOrEqual(1);
        expect(overlap).toBeLessThanOrEqual(2);
      }
    },
  );

  it('масштаб от четверти до 3: точка перекрытия целиком из полей, и ещё точка полей остаётся на сглаживание', () => {
    const chunk = (resolution: number): FloorChunk => floorChunkAt(MAP, 5, 5, resolution);
    for (let scale = 0.25; scale <= 3; scale += 0.01) {
      const resolution = floorResolution(scale);
      const { area, pixels } = chunk(resolution);
      const screen: ScreenTransform = { scale, x: 0.37, y: 0.61 };
      const { source, target } = placed(placeChunk(chunk(resolution), screen));
      const label = `масштаб ${scale.toFixed(2)}`;
      expect(Math.round(area.x * scale + screen.x) - target.x, label).toBe(1);
      expect(source.x, label).toBeGreaterThanOrEqual(1);
      expect(area.x * resolution - pixels.x, label).toBe(PADDING_PX);
    }
  });

  it('очень мелкий масштаб: поля кончаются раньше точки перекрытия — перекрытие меньше, но щели нет', () => {
    const [topLeft, topRight] = aroundJunction(0.02, 40.3, 30.7);
    const left = placed(topLeft);
    expect(left.source.x).toBeCloseTo(0, 9);
    expect(left.target.x + left.target.width - placed(topRight).target.x).toBeGreaterThan(0);
  });

  it('у края поля кусок не заходит за край и не читает за холстом', () => {
    const scale = 1.714;
    const screen: ScreenTransform = { scale, x: -4800 * scale + 0.37, y: -2600 * scale + 0.61 };
    const resolution = floorResolution(scale);
    const corner = floorChunkAt(MAP, 20, 11, resolution);
    const { source, target } = placed(placeChunk(corner, screen));
    expect(target.x + target.width).toBe(Math.round(MAP.width * scale + screen.x));
    expect(target.y + target.height).toBe(Math.round(MAP.height * scale + screen.y));
    expect(source.x + source.width).toBeCloseTo(corner.pixels.width, 9);
    expect(source.y + source.height).toBeCloseTo(corner.pixels.height, 9);
    const origin = placeChunk(floorChunkAt(MAP, 0, 0, resolution), { scale, x: 10.4, y: 20.6 });
    expect(origin).toMatchObject({ source: { x: 0, y: 0 }, target: { x: 10, y: 21 } });
  });

  it('кусок мельче точки на экране не ложится', () => {
    expect(placeChunk(floorChunkAt(MAP, 3, 3, 0.25), { scale: 0.001, x: 0, y: 0 })).toBeNull();
  });
});
