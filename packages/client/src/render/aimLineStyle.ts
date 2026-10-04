import type { Point, ShotSegment } from '@tanks/shared/engine';
import type { AimLine, AimLineState } from '../aimLine.js';
import { makeCanvas, rgba, seededRandom } from './view.js';

// Вид линии выстрела одним объектом: цвета состояний, ядро, слои ореола, штрихи, пульс, горячие точки.
// Толщины и радиусы — в экранных пикселях: при отрисовке делятся на масштаб камеры, лазер одинаково тонок при
// любом приближении.

export interface GlowLayer {
  widthPx: number;
  alpha: number;
}

export interface DashFlow {
  onPx: number;
  offPx: number;
  speedPxPerS: number;
  alpha: number;
}

export interface Pulse {
  hz: number;
  depth: number;
}

export interface Hotspot {
  radiusPx: number;
  alpha: number;
}

export interface EndHotspot extends Hotspot {
  ringRadiusPx: number;
  ringWidthPx: number;
  // Доля радиуса для точки у стены: там снаряд просто ударит, это не цель.
  wallScale: number;
}

// Множители ширины в начале и в конце участка: узко у дула, шире к концу — или наоборот.
export interface Taper {
  start: number;
  end: number;
}

// Зернистость вдоль ядра: полоска шума в цвете состояния натягивается узором по длине и медленно ползёт.
export interface Grain {
  alpha: number;
  periodPx: number;
  speedPxPerS: number;
}

export interface AimLineStyle {
  neutral: string;
  onTarget: string;
  lead: string;
  danger: string;
  taper: Taper | null;
  grain: Grain | null;
  // Ядро своего цвета (белое над цветным ореолом) или `null` — цветом состояния; `highlightAlpha` — когда
  // линия проходит через противника или точку упреждения.
  core: { widthPx: number; alpha: number; highlightAlpha: number; color: string | null };
  // От внешнего к внутреннему; штрихи ложатся на средний слой.
  layers: GlowLayer[];
  dash: DashFlow | null;
  pulse: Record<AimLineState, Pulse>;
  muzzle: Hotspot | null;
  end: EndHotspot | null;
  tail: { widthScale: number; alphaScale: number };
  mark: { halfLengthPx: number; widthPx: number };
  fadeMs: number;
}

export const AIM_LINE_STYLE: AimLineStyle = {
  neutral: '#f4f1e8',
  onTarget: '#e8825a',
  lead: '#5dffa0',
  danger: '#ff5a6a',
  taper: null,
  grain: null,
  core: { widthPx: 1.6, alpha: 0.34, highlightAlpha: 0.85, color: null },
  layers: [],
  dash: null,
  pulse: { none: { hz: 0, depth: 0 }, onTarget: { hz: 0, depth: 0 }, lead: { hz: 0, depth: 0 } },
  muzzle: null,
  end: null,
  tail: { widthScale: 0.75, alphaScale: 0.55 },
  mark: { halfLengthPx: 7, widthPx: 2 },
  fadeMs: 160,
};

export interface AimLineFrame {
  timeS: number;
  // CSS-пиксели экрана на единицу поля (масштаб камеры без плотности экрана).
  scale: number;
  // Доля появления 0–1, уже сглаженная.
  glow: number;
}

const SPRITE_RADIUS_PX = 32;
const spriteCache = new Map<string, HTMLCanvasElement>();

function hotspotSprite(color: string): HTMLCanvasElement {
  const cached = spriteCache.get(color);
  if (cached !== undefined) {
    return cached;
  }
  const size = SPRITE_RADIUS_PX * 2;
  const { canvas, ctx } = makeCanvas(size, size);
  const gradient = ctx.createRadialGradient(
    SPRITE_RADIUS_PX,
    SPRITE_RADIUS_PX,
    0,
    SPRITE_RADIUS_PX,
    SPRITE_RADIUS_PX,
    SPRITE_RADIUS_PX,
  );
  gradient.addColorStop(0, rgba(color, 1));
  gradient.addColorStop(0.35, rgba(color, 0.5));
  gradient.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  spriteCache.set(color, canvas);
  return canvas;
}

function pulseFactor(pulse: Pulse, timeS: number): number {
  if (pulse.depth <= 0 || pulse.hz <= 0) {
    return 1;
  }
  return 1 - pulse.depth * (0.5 + 0.5 * Math.sin(timeS * pulse.hz * Math.PI * 2));
}

function stateColor(style: AimLineStyle, state: AimLineState): string {
  if (state === 'onTarget') {
    return style.onTarget;
  }
  if (state === 'lead') {
    return style.lead;
  }
  return style.neutral;
}

function segmentPath(ctx: CanvasRenderingContext2D, segment: ShotSegment): void {
  ctx.beginPath();
  ctx.moveTo(segment.x1, segment.y1);
  ctx.lineTo(segment.x2, segment.y2);
}

interface StrokeSet {
  color: string;
  coreColor: string;
  isHighlighted: boolean;
  // Ослабленный участок: уже, бледнее и гаснет к концу — хвост после отскока, путь за точкой упреждения.
  isWeak: boolean;
  // Штрихи бегут от начала отрезка к концу; отрицательная скорость — обратно.
  dashDirection: 1 | -1;
}

// Сплошной цвет или градиент вдоль отрезка от `alpha` до нуля — для ослабленных участков.
function paint(
  ctx: CanvasRenderingContext2D,
  segment: ShotSegment,
  color: string,
  alpha: number,
  isFading: boolean,
): string | CanvasGradient {
  if (!isFading) {
    return rgba(color, alpha);
  }
  const gradient = ctx.createLinearGradient(segment.x1, segment.y1, segment.x2, segment.y2);
  gradient.addColorStop(0, rgba(color, alpha));
  gradient.addColorStop(1, rgba(color, 0));
  return gradient;
}

const TAPER_PIECES = 12;
const GRAIN_STRIP_HEIGHT = 4;
const GRAIN_WIDTH_SCALE = 1.6;
const grainCache = new Map<string, CanvasPattern | null>();

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Обводка одной толщины или, при сужении, кусками с толщиной, меняющейся вдоль участка. Куски стыкуются
// плоскими торцами, чтобы в `lighter` не светились нахлёсты.
function strokeTapered(
  ctx: CanvasRenderingContext2D,
  segment: ShotSegment,
  widthWorld: number,
  taper: Taper | null,
  strokeStyle: string | CanvasGradient,
): void {
  ctx.strokeStyle = strokeStyle;
  if (taper === null) {
    ctx.lineWidth = widthWorld;
    segmentPath(ctx, segment);
    ctx.stroke();
    return;
  }
  ctx.lineCap = 'butt';
  for (let index = 0; index < TAPER_PIECES; index++) {
    const t0 = index / TAPER_PIECES;
    const t1 = (index + 1) / TAPER_PIECES;
    ctx.lineWidth = widthWorld * lerp(taper.start, taper.end, (t0 + t1) / 2);
    ctx.beginPath();
    ctx.moveTo(lerp(segment.x1, segment.x2, t0), lerp(segment.y1, segment.y2, t0));
    ctx.lineTo(lerp(segment.x1, segment.x2, t1), lerp(segment.y1, segment.y2, t1));
    ctx.stroke();
  }
  ctx.lineCap = 'round';
}

// Полоска шума в цвете состояния: столбцы случайной прозрачности, период — в CSS-пикселях.
function grainPattern(ctx: CanvasRenderingContext2D, color: string, periodPx: number): CanvasPattern | null {
  const key = `${color}:${String(periodPx)}`;
  const cached = grainCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const width = Math.max(8, Math.round(periodPx));
  const strip = makeCanvas(width, GRAIN_STRIP_HEIGHT);
  const random = seededRandom(width);
  for (let x = 0; x < width; x++) {
    strip.ctx.fillStyle = rgba(color, random());
    strip.ctx.fillRect(x, 0, 1, GRAIN_STRIP_HEIGHT);
  }
  const pattern = ctx.createPattern(strip.canvas, 'repeat');
  grainCache.set(key, pattern);
  return pattern;
}

// Узор рисуется в системе координат, повёрнутой вдоль участка и выраженной в CSS-пикселях.
function strokeGrain(
  ctx: CanvasRenderingContext2D,
  segment: ShotSegment,
  grain: Grain,
  color: string,
  widthPx: number,
  alpha: number,
  frame: AimLineFrame,
): void {
  const pattern = grainPattern(ctx, color, grain.periodPx);
  if (pattern === null) {
    return;
  }
  const lengthPx = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1) * frame.scale;
  const shift = (frame.timeS * grain.speedPxPerS) % grain.periodPx;
  ctx.save();
  ctx.translate(segment.x1, segment.y1);
  ctx.rotate(Math.atan2(segment.y2 - segment.y1, segment.x2 - segment.x1));
  ctx.scale(1 / frame.scale, 1 / frame.scale);
  ctx.translate(-shift, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha;
  ctx.lineWidth = widthPx * GRAIN_WIDTH_SCALE;
  ctx.strokeStyle = pattern;
  ctx.beginPath();
  ctx.moveTo(shift, 0);
  ctx.lineTo(shift + lengthPx, 0);
  ctx.stroke();
  ctx.restore();
}

function strokeSegment(
  ctx: CanvasRenderingContext2D,
  segment: ShotSegment,
  style: AimLineStyle,
  frame: AimLineFrame,
  pulse: number,
  set: StrokeSet,
): void {
  const alphaBase = frame.glow * (set.isWeak ? style.tail.alphaScale : 1);
  const widthScale = set.isWeak ? style.tail.widthScale : 1;
  const toWorld = widthScale / frame.scale;
  const middleIndex = Math.floor(style.layers.length / 2);
  ctx.globalCompositeOperation = 'lighter';
  style.layers.forEach((layer, index) => {
    const layerPaint = paint(ctx, segment, set.color, layer.alpha * pulse * alphaBase, set.isWeak);
    strokeTapered(ctx, segment, layer.widthPx * toWorld, style.taper, layerPaint);
    if (style.dash !== null && index === middleIndex) {
      ctx.setLineDash([style.dash.onPx / frame.scale, style.dash.offPx / frame.scale]);
      ctx.lineDashOffset = (-frame.timeS * style.dash.speedPxPerS * set.dashDirection) / frame.scale;
      strokeTapered(
        ctx,
        segment,
        layer.widthPx * toWorld,
        null,
        paint(ctx, segment, set.color, style.dash.alpha * alphaBase, set.isWeak),
      );
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
  });
  ctx.globalCompositeOperation = 'source-over';
  const coreAlpha = set.isHighlighted ? style.core.highlightAlpha : style.core.alpha;
  const corePaint = paint(ctx, segment, set.coreColor, coreAlpha * alphaBase, set.isWeak);
  strokeTapered(ctx, segment, style.core.widthPx * toWorld, style.taper, corePaint);
  if (style.grain !== null) {
    strokeGrain(
      ctx,
      segment,
      style.grain,
      set.color,
      style.core.widthPx * widthScale,
      style.grain.alpha * alphaBase,
      frame,
    );
  }
}

function splitAt(segment: ShotSegment, point: Point): [ShotSegment, ShotSegment] {
  return [
    { x1: segment.x1, y1: segment.y1, x2: point.x, y2: point.y },
    { x1: point.x, y1: point.y, x2: segment.x2, y2: segment.y2 },
  ];
}

function drawHotspot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  spot: Hotspot,
  frame: AimLineFrame,
): void {
  const radius = spot.radiusPx / frame.scale;
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = spot.alpha * frame.glow;
  ctx.drawImage(hotspotSprite(color), x - radius, y - radius, radius * 2, radius * 2);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// Конец пути: на цели — точка в полный радиус и кольцо; у стены — только точка, уменьшенная `wallScale`.
function drawEnd(
  ctx: CanvasRenderingContext2D,
  point: Point,
  color: string,
  end: EndHotspot,
  frame: AimLineFrame,
  pulse: number,
  isOnTarget: boolean,
): void {
  const radiusPx = isOnTarget ? end.radiusPx * pulse : end.radiusPx * end.wallScale;
  drawHotspot(ctx, point.x, point.y, color, { radiusPx, alpha: end.alpha }, frame);
  if (!isOnTarget || end.ringRadiusPx <= 0) {
    return;
  }
  ctx.lineWidth = end.ringWidthPx / frame.scale;
  ctx.strokeStyle = rgba(color, frame.glow);
  ctx.beginPath();
  ctx.arc(point.x, point.y, (end.ringRadiusPx * pulse) / frame.scale, 0, Math.PI * 2);
  ctx.stroke();
}

export function drawAimLine(
  ctx: CanvasRenderingContext2D,
  line: AimLine,
  style: AimLineStyle,
  frame: AimLineFrame,
): void {
  const [first, tail] = line.segments;
  if (first === undefined || frame.glow <= 0) {
    return;
  }
  const color = stateColor(style, line.state);
  const coreColor = style.core.color ?? color;
  const isHighlighted = line.state !== 'none';
  const pulse = pulseFactor(style.pulse[line.state], frame.timeS);
  // За точкой упреждения снаряд летит дальше, но это уже не прицел — путь ослаблен, как хвост.
  const [head, beyondLead] =
    line.state === 'lead' && line.mark !== null ? splitAt(first, line.mark) : [first, undefined];
  ctx.save();
  ctx.lineCap = 'round';
  strokeSegment(ctx, head, style, frame, pulse, { color, coreColor, isHighlighted, isWeak: false, dashDirection: 1 });
  if (beyondLead !== undefined) {
    strokeSegment(ctx, beyondLead, style, frame, pulse, {
      color,
      coreColor,
      isHighlighted,
      isWeak: true,
      dashDirection: 1,
    });
  }
  if (tail !== undefined) {
    strokeSegment(ctx, tail, style, frame, pulse, {
      color: line.isReturning ? style.danger : color,
      coreColor: line.isReturning ? style.danger : coreColor,
      isHighlighted: isHighlighted || line.isReturning,
      isWeak: true,
      dashDirection: line.isReturning ? -1 : 1,
    });
  }
  if (style.muzzle !== null) {
    drawHotspot(ctx, first.x1, first.y1, color, style.muzzle, frame);
  }
  if (style.end !== null) {
    const endPoint = line.mark ?? { x: first.x2, y: first.y2 };
    drawEnd(ctx, endPoint, color, style.end, frame, pulse, line.mark !== null);
  }
  if (line.mark !== null) {
    const half = (style.mark.halfLengthPx / frame.scale) * frame.glow;
    ctx.translate(line.mark.x, line.mark.y);
    ctx.rotate(line.mark.angle);
    ctx.lineWidth = style.mark.widthPx / frame.scale;
    ctx.strokeStyle = rgba(color, frame.glow);
    ctx.beginPath();
    ctx.moveTo(0, -half);
    ctx.lineTo(0, half);
    ctx.stroke();
  }
  ctx.restore();
}
