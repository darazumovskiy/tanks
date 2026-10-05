import type { FfaMap } from '@tanks/shared/engine';
import { makeCanvas, seededRandom } from './view.js';

// Пол большой карты — рецепт пола дуэли, где каждая деталь зависит только от своего места: любую область
// можно нарисовать отдельно, и она совпадёт с соседними. Детали — по клеткам из хэша (клетка, сид карты);
// градиент, сетка и пунктир заданы в координатах поля.

interface FloorArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

const GRADIENT_INNER_RADIUS = 80;
// Внешний радиус градиента — доля полудиагонали поля: у дуэли 950 при полудиагонали 918.
const GRADIENT_OUTER_SHARE = 1.035;
const GRADIENT_CENTER_COLOR = '#262a30';
const GRADIENT_EDGE_COLOR = '#131519';

const BLOB_CELL = 512;
const BLOB_MIN_COUNT = 2;
const BLOB_EXTRA_COUNT = 2;
const BLOB_MIN_RADIUS = 80;
const BLOB_RADIUS_SPREAD = 220;
const BLOB_MIN_ALPHA = 0.08;
const BLOB_ALPHA_SPREAD = 0.1;

const SPECK_CELL = 64;
const SPECKS_PER_CELL = 26;
const SPECK_MIN_SIZE = 1;
const SPECK_SIZE_SPREAD = 2;
const SPECK_LIGHT = 'rgba(255,255,255,0.035)';
const SPECK_DARK = 'rgba(0,0,0,0.12)';

const GRID_STEP = 50;
const GRID_MAJOR_STEP = 200;
const GRID_MAJOR_COLOR = 'rgba(255,255,255,0.06)';
const GRID_MINOR_COLOR = 'rgba(255,255,255,0.025)';
// Линия сетки сдвинута на полширины, чтобы ложиться целой полосой.
const GRID_LINE_OFFSET = 0.5;

const SPAWN_RING_COLOR = 'rgba(255,255,255,0.08)';
const SPAWN_RING_DASH: readonly number[] = [8, 8];
const SPAWN_RING_WIDTH = 2;

// Тень стены — в единицах поля, как у пола дуэли; в точки холста пересчитывается по масштабу.
const WALL_SHADOW_COLOR = 'rgba(0,0,0,0.6)';
const WALL_SHADOW_BLUR = 9;
const WALL_SHADOW_OFFSET_X = 3.5;
const WALL_SHADOW_OFFSET_Y = 5;
// Тень и полоса не выходят за стену дальше этого: стена рисуется, если её задевает область с этим запасом.
const WALL_REACH = 30;
const WALL_BASE_COLOR = '#30353c';
const WALL_LIGHT_COLOR = '#4d545d';
const WALL_INSET = 4;
const WALL_INSET_FILL = 'rgba(255,255,255,0.07)';
const WALL_BEVEL_COLOR = 'rgba(255,255,255,0.18)';
const WALL_BEVEL_WIDTH = 1.5;
const WALL_EDGE_COLOR = 'rgba(0,0,0,0.5)';
const WALL_STRIPE_MARGIN = 6;
const WALL_STRIPE_WIDTH = 6;
const WALL_STRIPE_COLOR = 'rgba(240,180,40,0.35)';
const WALL_STRIPE_STEP = 16;
const WALL_STRIPE_THICKNESS = 8;

const FIELD_EDGE_COLOR = '#4a5059';
const FIELD_EDGE_WIDTH = 6;

// Подложка и тон пола — всё поле в четверть точки на единицу.
export const UNDERLAY_SCALE = 0.25;
// Точка тона за краем области: растяжение у края берёт соседние точки тона, а не повторённый край.
const SHADE_MARGIN_PX = 1;

const SALT_BLOBS = 0x51ab;
const SALT_SPECKS = 0x5bec;

// Целочисленный хэш клетки на Math.imul: одинаков на всех движках, поэтому пол одинаков у всех игроков.
function cellSeed(cellX: number, cellY: number, mapSeed: number, salt: number): number {
  let hash = Math.imul(cellX, 0x27d4eb2d) ^ Math.imul(cellY, 0x165667b1) ^ Math.imul(mapSeed, 0x9e3779b1) ^ salt;
  hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

interface CellRange {
  fromX: number;
  toX: number;
  fromY: number;
  toY: number;
}

function cellsTouching(area: FloorArea, cell: number, reach: number): CellRange {
  return {
    fromX: Math.floor((area.x - reach) / cell),
    toX: Math.floor((area.x + area.width + reach) / cell),
    fromY: Math.floor((area.y - reach) / cell),
    toY: Math.floor((area.y + area.height + reach) / cell),
  };
}

function drawBlobs(g: CanvasRenderingContext2D, map: FfaMap, area: FloorArea): void {
  const range = cellsTouching(area, BLOB_CELL, BLOB_MIN_RADIUS + BLOB_RADIUS_SPREAD);
  for (let cellY = range.fromY; cellY <= range.toY; cellY++) {
    for (let cellX = range.fromX; cellX <= range.toX; cellX++) {
      const random = seededRandom(cellSeed(cellX, cellY, map.seed, SALT_BLOBS));
      const count = BLOB_MIN_COUNT + Math.floor(random() * BLOB_EXTRA_COUNT);
      for (let index = 0; index < count; index++) {
        const x = (cellX + random()) * BLOB_CELL;
        const y = (cellY + random()) * BLOB_CELL;
        const radius = BLOB_MIN_RADIUS + random() * BLOB_RADIUS_SPREAD;
        const alpha = BLOB_MIN_ALPHA + random() * BLOB_ALPHA_SPREAD;
        const blob = g.createRadialGradient(x, y, 0, x, y, radius);
        blob.addColorStop(0, `rgba(0,0,0,${String(alpha)})`);
        blob.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = blob;
        // За радиусом градиент прозрачен: круг вместо квадрата не тратит заливку на пустые углы.
        g.beginPath();
        g.arc(x, y, radius, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}

function drawSpecks(g: CanvasRenderingContext2D, map: FfaMap, area: FloorArea): void {
  const range = cellsTouching(area, SPECK_CELL, SPECK_MIN_SIZE + SPECK_SIZE_SPREAD);
  for (let cellY = range.fromY; cellY <= range.toY; cellY++) {
    for (let cellX = range.fromX; cellX <= range.toX; cellX++) {
      const random = seededRandom(cellSeed(cellX, cellY, map.seed, SALT_SPECKS));
      for (let index = 0; index < SPECKS_PER_CELL; index++) {
        g.fillStyle = random() < 0.5 ? SPECK_LIGHT : SPECK_DARK;
        const x = (cellX + random()) * SPECK_CELL;
        const y = (cellY + random()) * SPECK_CELL;
        const width = SPECK_MIN_SIZE + random() * SPECK_SIZE_SPREAD;
        const height = SPECK_MIN_SIZE + random() * SPECK_SIZE_SPREAD;
        g.fillRect(x, y, width, height);
      }
    }
  }
}

function drawGrid(g: CanvasRenderingContext2D, map: FfaMap, area: FloorArea): void {
  g.lineWidth = 1;
  const fromX = Math.max(0, Math.ceil((area.x - GRID_STEP) / GRID_STEP) * GRID_STEP);
  const toX = Math.min(map.width, area.x + area.width + GRID_STEP);
  for (let x = fromX; x <= toX; x += GRID_STEP) {
    g.strokeStyle = x % GRID_MAJOR_STEP === 0 ? GRID_MAJOR_COLOR : GRID_MINOR_COLOR;
    g.beginPath();
    g.moveTo(x + GRID_LINE_OFFSET, 0);
    g.lineTo(x + GRID_LINE_OFFSET, map.height);
    g.stroke();
  }
  const fromY = Math.max(0, Math.ceil((area.y - GRID_STEP) / GRID_STEP) * GRID_STEP);
  const toY = Math.min(map.height, area.y + area.height + GRID_STEP);
  for (let y = fromY; y <= toY; y += GRID_STEP) {
    g.strokeStyle = y % GRID_MAJOR_STEP === 0 ? GRID_MAJOR_COLOR : GRID_MINOR_COLOR;
    g.beginPath();
    g.moveTo(0, y + GRID_LINE_OFFSET);
    g.lineTo(map.width, y + GRID_LINE_OFFSET);
    g.stroke();
  }
}

function isTouching(area: FloorArea, x: number, y: number, width: number, height: number, reach: number): boolean {
  const isAcross = x + width + reach >= area.x && x - reach <= area.x + area.width;
  const isAlong = y + height + reach >= area.y && y - reach <= area.y + area.height;
  return isAcross && isAlong;
}

function drawSpawnRings(g: CanvasRenderingContext2D, map: FfaMap, area: FloorArea): void {
  g.strokeStyle = SPAWN_RING_COLOR;
  g.setLineDash(SPAWN_RING_DASH);
  g.lineWidth = SPAWN_RING_WIDTH;
  for (const spawn of map.spawnAreas) {
    const size = spawn.radius * 2;
    if (!isTouching(area, spawn.x - spawn.radius, spawn.y - spawn.radius, size, size, SPAWN_RING_WIDTH)) {
      continue;
    }
    g.beginPath();
    g.arc(spawn.x, spawn.y, spawn.radius, 0, Math.PI * 2);
    g.stroke();
  }
  g.setLineDash([]);
}

function drawWalls(g: CanvasRenderingContext2D, map: FfaMap, area: FloorArea, scale: number): void {
  const walls = map.walls.filter((wall) => isTouching(area, wall.x, wall.y, wall.w, wall.h, WALL_REACH));
  g.save();
  g.shadowColor = WALL_SHADOW_COLOR;
  g.shadowBlur = WALL_SHADOW_BLUR * scale;
  g.shadowOffsetX = WALL_SHADOW_OFFSET_X * scale;
  g.shadowOffsetY = WALL_SHADOW_OFFSET_Y * scale;
  g.fillStyle = WALL_BASE_COLOR;
  for (const wall of walls) {
    g.fillRect(wall.x, wall.y, wall.w, wall.h);
  }
  g.restore();
  for (const wall of walls) {
    const gradient = g.createLinearGradient(wall.x, wall.y, wall.x + wall.w, wall.y + wall.h);
    gradient.addColorStop(0, WALL_LIGHT_COLOR);
    gradient.addColorStop(1, WALL_BASE_COLOR);
    g.fillStyle = gradient;
    g.fillRect(wall.x, wall.y, wall.w, wall.h);
    g.fillStyle = WALL_INSET_FILL;
    g.fillRect(wall.x + WALL_INSET, wall.y + WALL_INSET, wall.w - WALL_INSET * 2, wall.h - WALL_INSET * 2);
    g.strokeStyle = WALL_BEVEL_COLOR;
    g.lineWidth = WALL_BEVEL_WIDTH;
    g.beginPath();
    g.moveTo(wall.x + WALL_BEVEL_WIDTH / 2, wall.y + wall.h);
    g.lineTo(wall.x + WALL_BEVEL_WIDTH / 2, wall.y + WALL_BEVEL_WIDTH / 2);
    g.lineTo(wall.x + wall.w, wall.y + WALL_BEVEL_WIDTH / 2);
    g.stroke();
    g.strokeStyle = WALL_EDGE_COLOR;
    g.strokeRect(wall.x + 0.5, wall.y + 0.5, wall.w - 1, wall.h - 1);
    drawWallStripe(g, wall);
  }
}

// Предупредительная полоса вдоль длинной стороны стены: косые штрихи под клипом.
function drawWallStripe(g: CanvasRenderingContext2D, wall: FfaMap['walls'][number]): void {
  g.save();
  g.beginPath();
  if (wall.w >= wall.h) {
    g.rect(
      wall.x + WALL_STRIPE_MARGIN,
      wall.y + wall.h / 2 - WALL_STRIPE_WIDTH / 2,
      wall.w - WALL_STRIPE_MARGIN * 2,
      WALL_STRIPE_WIDTH,
    );
  } else {
    g.rect(
      wall.x + wall.w / 2 - WALL_STRIPE_WIDTH / 2,
      wall.y + WALL_STRIPE_MARGIN,
      WALL_STRIPE_WIDTH,
      wall.h - WALL_STRIPE_MARGIN * 2,
    );
  }
  g.clip();
  g.fillStyle = WALL_STRIPE_COLOR;
  const sweep = wall.w + wall.h;
  for (let shift = -sweep; shift < sweep; shift += WALL_STRIPE_STEP) {
    g.beginPath();
    g.moveTo(wall.x + shift, wall.y);
    g.lineTo(wall.x + shift + WALL_STRIPE_THICKNESS, wall.y);
    g.lineTo(wall.x + shift + WALL_STRIPE_THICKNESS - sweep, wall.y + sweep);
    g.lineTo(wall.x + shift - sweep, wall.y + sweep);
    g.fill();
  }
  g.restore();
}

function clipToField(g: CanvasRenderingContext2D, map: FfaMap): void {
  g.beginPath();
  g.rect(0, 0, map.width, map.height);
  g.clip();
}

function fieldArea(map: FfaMap): FloorArea {
  return { x: 0, y: 0, width: map.width, height: map.height };
}

function underlayCanvas(map: FfaMap): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  return makeCanvas(Math.ceil(map.width * UNDERLAY_SCALE), Math.ceil(map.height * UNDERLAY_SCALE));
}

// Детали поверх тона: крапинки, сетка, пунктир областей, стены с тенью, край поля.
function drawDetails(
  g: CanvasRenderingContext2D,
  map: FfaMap,
  area: FloorArea,
  scale: number,
  hasSpecks: boolean,
): void {
  if (hasSpecks) {
    drawSpecks(g, map, area);
  }
  drawGrid(g, map, area);
  drawSpawnRings(g, map, area);
  drawWalls(g, map, area, scale);
  g.strokeStyle = FIELD_EDGE_COLOR;
  g.lineWidth = FIELD_EDGE_WIDTH;
  g.strokeRect(FIELD_EDGE_WIDTH / 2, FIELD_EDGE_WIDTH / 2, map.width - FIELD_EDGE_WIDTH, map.height - FIELD_EDGE_WIDTH);
}

// Тон пола — фоновый градиент и тёмные пятна. Он плавный, поэтому рисуется один раз на всё поле в разрешении
// подложки, а под кусок растягивается: градиенты — самая дорогая часть рецепта.
export function createFfaShade(map: FfaMap): HTMLCanvasElement {
  const { canvas, ctx } = underlayCanvas(map);
  ctx.scale(UNDERLAY_SCALE, UNDERLAY_SCALE);
  clipToField(ctx, map);
  const centerX = map.width / 2;
  const centerY = map.height / 2;
  const outer = GRADIENT_OUTER_SHARE * Math.hypot(centerX, centerY);
  const background = ctx.createRadialGradient(centerX, centerY, GRADIENT_INNER_RADIUS, centerX, centerY, outer);
  background.addColorStop(0, GRADIENT_CENTER_COLOR);
  background.addColorStop(1, GRADIENT_EDGE_COLOR);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, map.width, map.height);
  drawBlobs(ctx, map, fieldArea(map));
  return canvas;
}

// Область `area` пола полным рецептом: тон растянут, детали — в разрешении холста; холст уже переведён в координаты
// поля с масштабом `scale` точек на единицу. Рисуется только по полю: кромку за краем пол не закрывает.
export function drawFfaFloor(
  g: CanvasRenderingContext2D,
  map: FfaMap,
  area: FloorArea,
  scale: number,
  shade: HTMLCanvasElement,
): void {
  g.save();
  clipToField(g, map);
  const left = Math.max(0, Math.floor(area.x * UNDERLAY_SCALE) - SHADE_MARGIN_PX);
  const top = Math.max(0, Math.floor(area.y * UNDERLAY_SCALE) - SHADE_MARGIN_PX);
  const right = Math.min(shade.width, Math.ceil((area.x + area.width) * UNDERLAY_SCALE) + SHADE_MARGIN_PX);
  const bottom = Math.min(shade.height, Math.ceil((area.y + area.height) * UNDERLAY_SCALE) + SHADE_MARGIN_PX);
  g.drawImage(
    shade,
    left,
    top,
    right - left,
    bottom - top,
    left / UNDERLAY_SCALE,
    top / UNDERLAY_SCALE,
    (right - left) / UNDERLAY_SCALE,
    (bottom - top) / UNDERLAY_SCALE,
  );
  drawDetails(g, map, area, scale, true);
  g.restore();
}

// Подложка: тон и детали всего поля при четверти точки на единицу — на карте 50 около 4 МБ. Крапинка не крупнее
// трёх единиц здесь меньше точки и не видна — подложка рисуется без крапинок.
export function createFfaUnderlay(map: FfaMap, shade: HTMLCanvasElement): HTMLCanvasElement {
  const { canvas, ctx } = underlayCanvas(map);
  ctx.drawImage(shade, 0, 0);
  ctx.scale(UNDERLAY_SCALE, UNDERLAY_SCALE);
  clipToField(ctx, map);
  drawDetails(ctx, map, fieldArea(map), UNDERLAY_SCALE, false);
  return canvas;
}
