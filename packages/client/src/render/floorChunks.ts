import type { FieldSize } from '@tanks/shared/engine';
import type { Camera } from './camera.js';

// Пол большой карты кусками: разрешение кусков, какие нарисовать и какие выбросить, сколько успеть за кадр, где
// кусок ляжет на экран и где вместо неготовых видна подложка. Холсты кусков держит `tiledFloor.ts`.

export const FLOOR_CHUNK_SIZE = 256;
const FLOOR_CHUNK_LIMIT = 64;
// Четверть кадра на 60 Гц. Кусок со стенами на слабом телефоне — в среднем 3,6 мс, худший 27 мс: средних за кадр
// два, после тяжёлого — ни одного больше. На обычном телефоне кусок впятеро дешевле, и экран собирается быстрее.
export const FLOOR_FRAME_BUDGET_MS = 4;
// Разрешение — масштаб камеры, округлённый вверх до шага, не больше потолка: на плотных экранах пол не раздувает
// память.
const RESOLUTION_STEP = 0.25;
const MAX_RESOLUTION = 2;
// Масштаб ровно на шаге не уходит на следующий шаг из-за погрешности деления.
const RESOLUTION_EPSILON = 1e-9;
// Кэш держит куски под окном камеры, расширенным на полкуска: шаг танка назад не заставляет рисовать заново.
const KEEP_MARGIN = FLOOR_CHUNK_SIZE / 2;
// Холст куска шире квадрата на столько точек с каждой стороны, где есть сосед: точка перекрытия на экране берётся
// из настоящих точек соседа, а не из повторённого края. Точка экрана — меньше двух точек куска: разрешение выше
// масштаба меньше чем на шаг, и при масштабе от четверти это меньше чем вдвое (мельче — перекрытие сужается до
// полей). Ещё одна точка — на сглаживание при растяжении, которое берёт соседнюю.
const CHUNK_PADDING_PX = 3;
// Со стороны соседа кусок заходит на него на столько точек экрана.
const SCREEN_OVERLAP_PX = 1;
const BYTES_PER_PIXEL = 4;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloorChunk {
  key: number;
  resolution: number;
  // Квадрат куска в единицах поля, обрезанный по краю поля.
  area: Rect;
  // Холст куска в точках разрешения от угла поля: квадрат с полями со сторон соседей.
  pixels: Rect;
}

export interface FloorPlan {
  // Куски вне окна с запасом и сверх лимита; кусок старого разрешения под окном остаётся до замены.
  evict: number[];
  // Всё, что надо нарисовать, по важности: сначала видимые, среди них — недостающие раньше старого разрешения, затем
  // ближние к центру окна. Новый кусок заменяет старый на том же месте.
  create: FloorChunk[];
}

// Точка экрана — точка поля, умноженная на масштаб, плюс сдвиг; в точках холста.
export interface ScreenTransform {
  scale: number;
  x: number;
  y: number;
}

export interface ChunkPlacement {
  source: Rect;
  target: Rect;
}

interface ChunkRange {
  fromColumn: number;
  toColumn: number;
  fromRow: number;
  toRow: number;
}

// Квадрат куска и его холст по одной оси.
interface AxisSpan {
  start: number;
  size: number;
  pixelStart: number;
  pixelSize: number;
}

interface AxisPlacement {
  sourceFrom: number;
  sourceSize: number;
  targetFrom: number;
  targetSize: number;
}

export function floorResolution(scale: number): number {
  const steps = Math.max(1, Math.ceil(scale / RESOLUTION_STEP - RESOLUTION_EPSILON));
  return Math.min(MAX_RESOLUTION, steps * RESOLUTION_STEP);
}

function gridColumns(field: FieldSize): number {
  return Math.ceil(field.width / FLOOR_CHUNK_SIZE);
}

function gridRows(field: FieldSize): number {
  return Math.ceil(field.height / FLOOR_CHUNK_SIZE);
}

// Края холста по оси: со стороны соседа — поля, у края поля — до края, захватывая точку, которую он делит.
function pixelSpan(start: number, end: number, limit: number, resolution: number): [number, number] {
  const fieldEnd = Math.ceil(limit * resolution);
  const from = start > 0 ? start * resolution - CHUNK_PADDING_PX : 0;
  if (end >= limit) {
    return [from, fieldEnd];
  }
  return [from, Math.min(fieldEnd, end * resolution + CHUNK_PADDING_PX)];
}

export function floorChunkAt(field: FieldSize, column: number, row: number, resolution: number): FloorChunk {
  const x = column * FLOOR_CHUNK_SIZE;
  const y = row * FLOOR_CHUNK_SIZE;
  const right = Math.min(field.width, x + FLOOR_CHUNK_SIZE);
  const bottom = Math.min(field.height, y + FLOOR_CHUNK_SIZE);
  const [left, rightPx] = pixelSpan(x, right, field.width, resolution);
  const [top, bottomPx] = pixelSpan(y, bottom, field.height, resolution);
  return {
    key: row * gridColumns(field) + column,
    resolution,
    area: { x, y, width: right - x, height: bottom - y },
    pixels: { x: left, y: top, width: rightPx - left, height: bottomPx - top },
  };
}

export function floorChunkBytes(chunk: FloorChunk): number {
  return chunk.pixels.width * chunk.pixels.height * BYTES_PER_PIXEL;
}

// Куски, которые задевает прямоугольник поля; за полем кусков нет.
function chunkRange(field: FieldSize, rect: Rect): ChunkRange {
  return {
    fromColumn: Math.max(0, Math.floor(rect.x / FLOOR_CHUNK_SIZE)),
    toColumn: Math.min(gridColumns(field) - 1, Math.ceil((rect.x + rect.width) / FLOOR_CHUNK_SIZE) - 1),
    fromRow: Math.max(0, Math.floor(rect.y / FLOOR_CHUNK_SIZE)),
    toRow: Math.min(gridRows(field) - 1, Math.ceil((rect.y + rect.height) / FLOOR_CHUNK_SIZE) - 1),
  };
}

// Номера кусков под прямоугольником по строкам: в этом порядке куски ложатся на экран.
export function floorKeysTouching(field: FieldSize, rect: Rect): number[] {
  const range = chunkRange(field, rect);
  const columns = gridColumns(field);
  const keys: number[] = [];
  for (let row = range.fromRow; row <= range.toRow; row++) {
    for (let column = range.fromColumn; column <= range.toColumn; column++) {
      keys.push(row * columns + column);
    }
  }
  return keys;
}

// Охват неготовых кусков под прямоугольником — там видна подложка; null — всё готово.
export function pendingFloorArea(field: FieldSize, rect: Rect, ready: ReadonlySet<number>): Rect | null {
  const range = chunkRange(field, rect);
  const columns = gridColumns(field);
  let hasPending = false;
  let left = field.width;
  let top = field.height;
  let right = 0;
  let bottom = 0;
  for (let row = range.fromRow; row <= range.toRow; row++) {
    for (let column = range.fromColumn; column <= range.toColumn; column++) {
      if (ready.has(row * columns + column)) {
        continue;
      }
      hasPending = true;
      left = Math.min(left, column * FLOOR_CHUNK_SIZE);
      top = Math.min(top, row * FLOOR_CHUNK_SIZE);
      right = Math.max(right, Math.min(field.width, (column + 1) * FLOOR_CHUNK_SIZE));
      bottom = Math.max(bottom, Math.min(field.height, (row + 1) * FLOOR_CHUNK_SIZE));
    }
  }
  if (!hasPending) {
    return null;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function grow(rect: Rect, margin: number): Rect {
  return { x: rect.x - margin, y: rect.y - margin, width: rect.width + margin * 2, height: rect.height + margin * 2 };
}

function isTouching(area: Rect, rect: Rect): boolean {
  const isAcross = area.x < rect.x + rect.width && area.x + area.width > rect.x;
  const isAlong = area.y < rect.y + rect.height && area.y + area.height > rect.y;
  return isAcross && isAlong;
}

interface RankedChunk {
  chunk: FloorChunk;
  isVisible: boolean;
  distance: number;
}

function byPriority(a: RankedChunk, b: RankedChunk): number {
  if (a.isVisible !== b.isVisible) {
    return a.isVisible ? -1 : 1;
  }
  if (a.distance !== b.distance) {
    return a.distance - b.distance;
  }
  return a.chunk.key - b.chunk.key;
}

// Куски под окном с запасом полкуска, по важности: видимые, затем ближние к центру окна; не больше лимита.
function wantedChunks(field: FieldSize, camera: Camera, resolution: number): RankedChunk[] {
  const range = chunkRange(field, grow(camera, KEEP_MARGIN));
  const centerX = camera.x + camera.width / 2;
  const centerY = camera.y + camera.height / 2;
  const ranked: RankedChunk[] = [];
  for (let row = range.fromRow; row <= range.toRow; row++) {
    for (let column = range.fromColumn; column <= range.toColumn; column++) {
      const chunk = floorChunkAt(field, column, row, resolution);
      const { area } = chunk;
      ranked.push({
        chunk,
        isVisible: isTouching(area, camera),
        distance: Math.hypot(area.x + area.width / 2 - centerX, area.y + area.height / 2 - centerY),
      });
    }
  }
  return ranked.sort(byPriority).slice(0, FLOOR_CHUNK_LIMIT);
}

// `cached` — разрешение каждого куска в кэше по номеру.
export function planFloor(field: FieldSize, camera: Camera, cached: ReadonlyMap<number, number>): FloorPlan {
  const resolution = floorResolution(camera.scale);
  const wanted = wantedChunks(field, camera, resolution);
  const wantedKeys = new Set(wanted.map((entry) => entry.chunk.key));
  const evict = [...cached.keys()].filter((key) => !wantedKeys.has(key));
  const urgency = (entry: RankedChunk): number => (entry.isVisible ? 0 : 2) + (cached.has(entry.chunk.key) ? 1 : 0);
  const create = wanted
    .filter((entry) => cached.get(entry.chunk.key) !== resolution)
    .sort((a, b) => urgency(a) - urgency(b))
    .map((entry) => entry.chunk);
  return { evict, create };
}

// Рисует по очереди, пока не истёк бюджет кадра, но хотя бы одно: иначе кусок дороже бюджета не появился бы никогда.
// Возвращает, сколько нарисовано.
export function drawWithinBudget<T>(
  queue: readonly T[],
  budgetMs: number,
  now: () => number,
  draw: (item: T) => void,
): number {
  const started = now();
  let drawn = 0;
  for (const item of queue) {
    draw(item);
    drawn++;
    if (now() - started >= budgetMs) {
      break;
    }
  }
  return drawn;
}

// Края квадрата — к целым точкам экрана: соседи сходятся без щели при любом дробном сдвиге и любом соотношении
// разрешения и масштаба. Со стороны соседа кусок заходит на него, беря точки из своих полей.
function placeAxis(span: AxisSpan, resolution: number, scale: number, offset: number): AxisPlacement | null {
  const end = span.start + span.size;
  const targetFrom = Math.round(span.start * scale + offset);
  const targetTo = Math.round(end * scale + offset);
  if (targetTo <= targetFrom) {
    return null;
  }
  const sourceFrom = span.start * resolution - span.pixelStart;
  const sourceTo = end * resolution - span.pixelStart;
  const ratio = (targetTo - targetFrom) / (sourceTo - sourceFrom);
  const before = Math.min(SCREEN_OVERLAP_PX, sourceFrom * ratio);
  const after = Math.min(SCREEN_OVERLAP_PX, (span.pixelSize - sourceTo) * ratio);
  return {
    sourceFrom: sourceFrom - before / ratio,
    sourceSize: sourceTo - sourceFrom + (before + after) / ratio,
    targetFrom: targetFrom - before,
    targetSize: targetTo - targetFrom + before + after,
  };
}

// null — кусок на экране мельче точки.
export function placeChunk(chunk: FloorChunk, screen: ScreenTransform): ChunkPlacement | null {
  const { area, pixels, resolution } = chunk;
  const across = placeAxis(
    { start: area.x, size: area.width, pixelStart: pixels.x, pixelSize: pixels.width },
    resolution,
    screen.scale,
    screen.x,
  );
  const along = placeAxis(
    { start: area.y, size: area.height, pixelStart: pixels.y, pixelSize: pixels.height },
    resolution,
    screen.scale,
    screen.y,
  );
  if (across === null || along === null) {
    return null;
  }
  return {
    source: { x: across.sourceFrom, y: along.sourceFrom, width: across.sourceSize, height: along.sourceSize },
    target: { x: across.targetFrom, y: along.targetFrom, width: across.targetSize, height: along.targetSize },
  };
}
