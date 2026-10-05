import { ffaMap, type FfaMap, type Point } from '@tanks/shared/engine';
import type { Camera } from '../render/camera.js';
import { createFfaShade, drawFfaFloor } from '../render/ffaFloor.js';
import { FLOOR_CHUNK_SIZE, FLOOR_FRAME_BUDGET_MS, floorChunkAt, type FloorChunk } from '../render/floorChunks.js';
import { renderFloorChunk, TiledFloor } from '../render/tiledFloor.js';
import { makeCanvas } from '../render/view.js';

// Сверки пола кусками в браузере на карте 50: кусок, нарисованный дважды, одинаков; стык четырёх кусков совпадает
// с цельной отрисовкой той же области; на экране при дробном положении камеры сквозь стыки не видно того, что под
// полом, а кромку за полем пол не закрывает; с дробной тряской, пока куски не готовы, под ними лежит подложка.

export interface FloorCheckReport {
  // Наибольшая разница канала, 0–255. Стык сдвинут на целые точки, но холст куска начинается не там, где цельный:
  // сглаживание градиентов и размытие тени расходятся в редких точках — на 1 в Chromium без видеокарты, на 2 с
  // видеокартой и в WebKit.
  redrawDiff: number;
  junctionDiff: number;
  // Точки поля, где под кусками видна заливка, и точки за полем, закрытые полом, по всем экранам и сдвигам.
  holes: number;
  borderCovered: number;
  screensChecked: number;
  // Точки поля, где видна заливка, в полной отрисовке с тряской сразу после перестановки.
  shakenHoles: number;
}

const MAP_SIZE = 50;
const RESOLUTIONS: readonly number[] = [1, 1.25, 1.75, 2];
// Масштабы экранов: компьютер 1280 × 720, телефон с плотностью 2 и 3,25, компьютер 4K.
const SCALES: readonly number[] = [0.8, 1.055, 1.714, 2.4];
const SUB_PIXEL_SHIFTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.13, 0.71],
  [0.37, 0.61],
  [0.5, 0.5],
  [0.71, 0.13],
  [0.94, 0.37],
];
// Стык четырёх кусков с угловой стеной через шов; ещё пробы — углы поля с кромкой за ними.
const JUNCTION: Point = { x: 1024, y: 512 };
const PROBE_WIDTH = 480;
const PROBE_HEIGHT = 320;
const BACKDROP = { r: 255, g: 0, b: 255 };
const BACKDROP_COLOR = '#ff00ff';
// Пол серый, стены серые, полоса жёлтая: заметная примесь пурпура в точке — это заливка из-под пола.
const BACKDROP_TINT = 16;
// Достаточно, чтобы пол собрал все куски под окном пробы.
const SETTLE_FRAMES = 40;
// Край поля и край куска сходятся с точностью до половины точки: сверка — на точку дальше от края поля.
const EDGE_SLACK_PX = 1;
// Тряска в единицах поля — дробная и больше сдвига окна от границы кусков; часы пробы пускают кусок за кадр.
const SHAKE = { x: 7.37, y: 5.61 };
const SHAKEN_CAMERA_SHIFT = { x: 0.3, y: 0.2 };
const SHAKEN_FRAMES = 12;
const CHANNELS = 4;
const RED = 0;
const GREEN = 1;
const BLUE = 2;

function maxDifference(a: ImageData, b: ImageData): number {
  let worst = 0;
  for (let index = 0; index < a.data.length; index++) {
    worst = Math.max(worst, Math.abs((a.data[index] ?? 0) - (b.data[index] ?? 0)));
  }
  return worst;
}

function pixelsOf(canvas: HTMLCanvasElement): ImageData {
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('Canvas 2D недоступен');
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function redrawDifference(map: FfaMap, shade: HTMLCanvasElement, resolution: number): number {
  const chunk = floorChunkAt(map, JUNCTION.x / FLOOR_CHUNK_SIZE - 1, JUNCTION.y / FLOOR_CHUNK_SIZE, resolution);
  return maxDifference(pixelsOf(renderFloorChunk(map, shade, chunk)), pixelsOf(renderFloorChunk(map, shade, chunk)));
}

// Квадраты четырёх кусков вокруг стыка без полей — встык один к одному против той же области одним холстом.
function junctionDifference(map: FfaMap, shade: HTMLCanvasElement, resolution: number): number {
  const column = JUNCTION.x / FLOOR_CHUNK_SIZE;
  const row = JUNCTION.y / FLOOR_CHUNK_SIZE;
  const left = (column - 1) * FLOOR_CHUNK_SIZE;
  const top = (row - 1) * FLOOR_CHUNK_SIZE;
  const size = 2 * FLOOR_CHUNK_SIZE * resolution;
  const tiled = makeCanvas(size, size);
  const chunks: FloorChunk[] = [
    floorChunkAt(map, column - 1, row - 1, resolution),
    floorChunkAt(map, column, row - 1, resolution),
    floorChunkAt(map, column - 1, row, resolution),
    floorChunkAt(map, column, row, resolution),
  ];
  for (const chunk of chunks) {
    const { area, pixels } = chunk;
    const width = area.width * resolution;
    const height = area.height * resolution;
    tiled.ctx.drawImage(
      renderFloorChunk(map, shade, chunk),
      area.x * resolution - pixels.x,
      area.y * resolution - pixels.y,
      width,
      height,
      (area.x - left) * resolution,
      (area.y - top) * resolution,
      width,
      height,
    );
  }
  const whole = makeCanvas(size, size);
  whole.ctx.setTransform(resolution, 0, 0, resolution, -left * resolution, -top * resolution);
  const area = { x: left, y: top, width: 2 * FLOOR_CHUNK_SIZE, height: 2 * FLOOR_CHUNK_SIZE };
  drawFfaFloor(whole.ctx, map, area, resolution, shade);
  return maxDifference(pixelsOf(tiled.canvas), pixelsOf(whole.canvas));
}

interface ProbeCount {
  holes: number;
  borderCovered: number;
}

// Только куски, без подложки, поверх пурпурной заливки: точка `anchor` поля — в середине пробы со сдвигом в доли
// точки.
function probe(
  floor: TiledFloor,
  map: FfaMap,
  scale: number,
  anchor: Point,
  shift: readonly [number, number],
): ProbeCount {
  const { ctx } = makeCanvas(PROBE_WIDTH, PROBE_HEIGHT);
  ctx.fillStyle = BACKDROP_COLOR;
  ctx.fillRect(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
  const offsetX = PROBE_WIDTH / 2 + shift[0] - anchor.x * scale;
  const offsetY = PROBE_HEIGHT / 2 + shift[1] - anchor.y * scale;
  const camera: Camera = {
    x: -offsetX / scale,
    y: -offsetY / scale,
    width: PROBE_WIDTH / scale,
    height: PROBE_HEIGHT / scale,
    scale,
  };
  for (let frame = 0; frame < SETTLE_FRAMES; frame++) {
    floor.update(camera);
  }
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
  floor.drawChunks(ctx);
  const { data } = ctx.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
  const left = offsetX;
  const top = offsetY;
  const right = map.width * scale + offsetX;
  const bottom = map.height * scale + offsetY;
  const count: ProbeCount = { holes: 0, borderCovered: 0 };
  for (let y = 0; y < PROBE_HEIGHT; y++) {
    for (let x = 0; x < PROBE_WIDTH; x++) {
      const index = (y * PROBE_WIDTH + x) * CHANNELS;
      const red = data[index + RED] ?? 0;
      const green = data[index + GREEN] ?? 0;
      const blue = data[index + BLUE] ?? 0;
      const isAcross = x >= left + EDGE_SLACK_PX && x + 1 <= right - EDGE_SLACK_PX;
      const isAlong = y >= top + EDGE_SLACK_PX && y + 1 <= bottom - EDGE_SLACK_PX;
      const isInside = isAcross && isAlong;
      const isBeyondAcross = x + 1 <= left - EDGE_SLACK_PX || x >= right + EDGE_SLACK_PX;
      const isBeyondAlong = y + 1 <= top - EDGE_SLACK_PX || y >= bottom + EDGE_SLACK_PX;
      const isOutside = isBeyondAcross || isBeyondAlong;
      const isTinted = red - green > BACKDROP_TINT && blue - green > BACKDROP_TINT;
      const isBackdrop = red === BACKDROP.r && green === BACKDROP.g && blue === BACKDROP.b;
      if (isInside && isTinted) {
        count.holes++;
      }
      if (isOutside && !isBackdrop) {
        count.borderCovered++;
      }
    }
  }
  return count;
}

// Полная отрисовка пола с дробной тряской, по куску за кадр с нуля: окно камеры начинается у границы кусков, тряска
// открывает соседние ряд и столбец, которые камера не задевает. Подложка ложится под неготовые куски того, что
// показывает холст, — дыр нет ни в одном кадре.
function shakenHoles(map: FfaMap, scale: number): number {
  let clockMs = 0;
  const floor = new TiledFloor(map, () => (clockMs += FLOOR_FRAME_BUDGET_MS));
  const camera: Camera = {
    x: JUNCTION.x + SHAKEN_CAMERA_SHIFT.x,
    y: JUNCTION.y + SHAKEN_CAMERA_SHIFT.y,
    width: PROBE_WIDTH / scale,
    height: PROBE_HEIGHT / scale,
    scale,
  };
  let holes = 0;
  for (let frame = 0; frame < SHAKEN_FRAMES; frame++) {
    const { ctx } = makeCanvas(PROBE_WIDTH, PROBE_HEIGHT);
    ctx.fillStyle = BACKDROP_COLOR;
    ctx.fillRect(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
    ctx.setTransform(scale, 0, 0, scale, -camera.x * scale, -camera.y * scale);
    ctx.translate(SHAKE.x, SHAKE.y);
    floor.draw(ctx, camera);
    const { data } = ctx.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
    for (let index = 0; index < data.length; index += CHANNELS) {
      const red = data[index + RED] ?? 0;
      const green = data[index + GREEN] ?? 0;
      const blue = data[index + BLUE] ?? 0;
      if (red - green > BACKDROP_TINT && blue - green > BACKDROP_TINT) {
        holes++;
      }
    }
  }
  floor.clear();
  return holes;
}

export function checkFloor(): FloorCheckReport {
  const map = ffaMap(MAP_SIZE);
  const report: FloorCheckReport = {
    redrawDiff: 0,
    junctionDiff: 0,
    holes: 0,
    borderCovered: 0,
    screensChecked: 0,
    shakenHoles: 0,
  };
  const shade = createFfaShade(map);
  for (const resolution of RESOLUTIONS) {
    report.redrawDiff = Math.max(report.redrawDiff, redrawDifference(map, shade, resolution));
    report.junctionDiff = Math.max(report.junctionDiff, junctionDifference(map, shade, resolution));
  }
  const anchors: readonly Point[] = [JUNCTION, { x: 0, y: 0 }, { x: map.width, y: map.height }];
  const floor = new TiledFloor(map);
  for (const scale of SCALES) {
    for (const anchor of anchors) {
      for (const shift of SUB_PIXEL_SHIFTS) {
        const count = probe(floor, map, scale, anchor, shift);
        report.holes += count.holes;
        report.borderCovered += count.borderCovered;
        report.screensChecked++;
      }
    }
  }
  floor.clear();
  for (const scale of SCALES) {
    report.shakenHoles += shakenHoles(map, scale);
  }
  return report;
}
