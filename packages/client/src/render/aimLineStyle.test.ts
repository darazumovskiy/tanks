import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AimLine } from '../aimLine.js';
import { PLAIN_AIM_LINE_STYLE, drawAimLine, type AimLineStyle } from './aimLineStyle.js';

// Подменный контекст пишет журнал вызовов и состояние на момент каждого `stroke`/`drawImage`.
interface StrokeRecord {
  op: GlobalCompositeOperation;
  lineWidth: number;
  strokeStyle: string;
  dash: number[];
  dashOffset: number;
}

interface ImageRecord {
  x: number;
  y: number;
  width: number;
  alpha: number;
}

function fakeContext(): {
  ctx: CanvasRenderingContext2D;
  strokes: StrokeRecord[];
  images: ImageRecord[];
  calls: string[];
} {
  const strokes: StrokeRecord[] = [];
  const images: ImageRecord[] = [];
  const calls: string[] = [];
  let dash: number[] = [];
  const state = {
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
    globalAlpha: 1,
    lineWidth: 1,
    lineDashOffset: 0,
    strokeStyle: '',
    fillStyle: '',
    lineCap: 'butt',
  };
  const ctx = {
    ...state,
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    beginPath: () => calls.push('beginPath'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    arc: () => calls.push('arc'),
    translate: () => calls.push('translate'),
    rotate: () => calls.push('rotate'),
    setLineDash: (segments: number[]) => {
      dash = segments;
      calls.push('setLineDash');
    },
    // Градиент записывается строкой из своих остановок, чтобы проверять цвет и затухание.
    createLinearGradient: () => {
      const stops: string[] = [];
      return {
        addColorStop: (_offset: number, color: string) => stops.push(color),
        toString: () => `gradient(${stops.join('|')})`,
      };
    },
    stroke: () => {
      calls.push('stroke');
      strokes.push({
        op: ctx.globalCompositeOperation,
        lineWidth: ctx.lineWidth,
        strokeStyle: String(ctx.strokeStyle),
        dash: [...dash],
        dashOffset: ctx.lineDashOffset,
      });
    },
    drawImage: (_image: CanvasImageSource, x: number, y: number, width: number) => {
      calls.push('drawImage');
      images.push({ x, y, width, alpha: ctx.globalAlpha });
    },
    scale: () => calls.push('scale'),
    createPattern: () => {
      calls.push('createPattern');
      return { toString: () => 'pattern' };
    },
  } as unknown as CanvasRenderingContext2D & typeof state;
  return { ctx, strokes, images, calls };
}

// Спрайт горячей точки заготавливается на холсте — в happy-dom его нет, подменяем создание.
vi.mock('./view.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./view.js')>();
  return {
    ...original,
    makeCanvas: () => ({
      canvas: {} as HTMLCanvasElement,
      ctx: {
        createRadialGradient: () => ({ addColorStop: () => undefined }),
        fillRect: () => undefined,
        set fillStyle(_value: unknown) {
          return;
        },
      } as unknown as CanvasRenderingContext2D,
    }),
  };
});

const LAYERED: AimLineStyle = {
  neutral: '#9fb4c8',
  onTarget: '#e8825a',
  lead: '#5dffa0',
  danger: '#ff5a6a',
  taper: null,
  grain: null,
  core: { widthPx: 2, alpha: 0.8, highlightAlpha: 1, color: '#ffffff' },
  layers: [
    { widthPx: 12, alpha: 0.1 },
    { widthPx: 6, alpha: 0.2 },
    { widthPx: 3, alpha: 0.4 },
  ],
  dash: { onPx: 10, offPx: 10, speedPxPerS: 100, alpha: 0.5 },
  pulse: { none: { hz: 1, depth: 0.5 }, onTarget: { hz: 2, depth: 0.5 }, lead: { hz: 1, depth: 0.2 } },
  muzzle: { radiusPx: 8, alpha: 0.5 },
  end: { radiusPx: 10, alpha: 0.8, ringRadiusPx: 5, ringWidthPx: 1, wallScale: 0.5 },
  tail: { widthScale: 0.5, alphaScale: 0.5 },
  mark: { halfLengthPx: 6, widthPx: 2 },
  fadeMs: 100,
};

const TWO_SEGMENTS: AimLine = {
  segments: [
    { x1: 0, y1: 0, x2: 100, y2: 0 },
    { x1: 100, y1: 0, x2: 150, y2: 50 },
  ],
  state: 'none',
  mark: null,
  isReturning: false,
};

const SCALE = 0.5;

// Альфа сплошного цвета или первой остановки градиента.
function alphaOf(style: string): number {
  const match = /,([\d.]+)\)/.exec(style);
  return match?.[1] === undefined ? 1 : Number(match[1]);
}

describe('drawAimLine', () => {
  let fake: ReturnType<typeof fakeContext>;

  beforeEach(() => {
    fake = fakeContext();
  });

  it('два отрезка: слои от широкого к узкому в lighter, штрихи на среднем, ядро в source-over; толщины делятся на масштаб', () => {
    drawAimLine(fake.ctx, TWO_SEGMENTS, LAYERED, { timeS: 0, scale: SCALE, glow: 1 });
    // На отрезок: 3 слоя + штрихи + ядро = 5 обводок.
    const first = fake.strokes.slice(0, 5);
    expect(first.map((stroke) => stroke.op)).toEqual(['lighter', 'lighter', 'lighter', 'lighter', 'source-over']);
    expect(first[0]?.lineWidth).toBeCloseTo(12 / SCALE);
    expect(first[1]?.lineWidth).toBeCloseTo(6 / SCALE);
    expect(first[1]?.dash).toEqual([]);
    expect(first[2]?.dash).toEqual([10 / SCALE, 10 / SCALE]);
    expect(first[3]?.lineWidth).toBeCloseTo(3 / SCALE);
    expect(first[4]?.lineWidth).toBeCloseTo(2 / SCALE);
    expect(first[4]?.strokeStyle).toBe('rgba(255,255,255,0.8)');
    expect(fake.strokes).toHaveLength(10);
    // Хвост: уже, бледнее и гаснет к концу градиентом.
    const tailCore = fake.strokes[9];
    expect(tailCore?.lineWidth).toBeCloseTo((2 * 0.5) / SCALE);
    expect(tailCore?.strokeStyle.startsWith('gradient(')).toBe(true);
    expect(alphaOf(tailCore?.strokeStyle ?? '')).toBeCloseTo(0.8 * 0.5);
    expect(tailCore?.strokeStyle.endsWith(',0))')).toBe(true);
    // Точка у стены — уменьшенная, без кольца.
    const end = fake.images[1];
    expect(end?.width).toBeCloseTo((2 * 10 * 0.5) / SCALE);
    expect(fake.calls).not.toContain('arc');
  });

  it('опасный хвост: ореол и ядро цветом danger, штрихи в обратную сторону', () => {
    drawAimLine(fake.ctx, { ...TWO_SEGMENTS, isReturning: true }, LAYERED, { timeS: 1, scale: 1, glow: 1 });
    const firstDash = fake.strokes[2];
    const tailDash = fake.strokes[7];
    expect(firstDash?.dashOffset).toBeLessThan(0);
    expect(tailDash?.dashOffset).toBeGreaterThan(0);
    expect(tailDash?.strokeStyle).toContain('rgba(255,90,106,');
    expect(fake.strokes[5]?.strokeStyle).toContain('rgba(255,90,106,');
    expect(fake.strokes[9]?.strokeStyle).toContain('rgba(255,90,106,');
    expect(fake.strokes[9]?.strokeStyle).not.toContain('rgba(255,255,255,');
  });

  it('«на нём» с засечкой: ореолы цветом onTarget, горячая точка в полный радиус, кольцо и засечка нарисованы', () => {
    const line: AimLine = {
      segments: [{ x1: 0, y1: 0, x2: 80, y2: 0 }],
      state: 'onTarget',
      mark: { x: 80, y: 0, angle: 0 },
      isReturning: false,
    };
    drawAimLine(fake.ctx, line, LAYERED, { timeS: 0, scale: 1, glow: 1 });
    expect(fake.strokes[0]?.strokeStyle.startsWith('rgba(232,130,90,')).toBe(true);
    // Дуло и конец.
    expect(fake.images).toHaveLength(2);
    const end = fake.images[1];
    expect(end).toBeDefined();
    expect((end?.x ?? 0) + (end?.width ?? 0) / 2).toBeCloseTo(80);
    // Пульс «на нём» на t=0: 1 − 0,5 · 0,5.
    expect(end?.width).toBeCloseTo(2 * 10 * 0.75);
    expect(fake.calls.filter((call) => call === 'arc')).toHaveLength(1);
    expect(fake.calls.filter((call) => call === 'rotate')).toHaveLength(1);
  });

  it('«упреждаю»: путь до точки упреждения в полную силу, дальше — ослабленный с затуханием', () => {
    const line: AimLine = {
      segments: [{ x1: 0, y1: 0, x2: 200, y2: 0 }],
      state: 'lead',
      mark: { x: 120, y: 0, angle: 0 },
      isReturning: false,
    };
    drawAimLine(fake.ctx, line, LAYERED, { timeS: 0, scale: 1, glow: 1 });
    // Два участка по пять обводок, кольцо и засечка.
    expect(fake.strokes).toHaveLength(12);
    expect(fake.strokes[0]?.strokeStyle.startsWith('rgba(93,255,160,')).toBe(true);
    expect(fake.strokes[5]?.strokeStyle.startsWith('gradient(rgba(93,255,160,')).toBe(true);
    expect(fake.strokes[5]?.lineWidth).toBeCloseTo(12 * 0.5);
    expect((fake.images[1]?.x ?? 0) + (fake.images[1]?.width ?? 0) / 2).toBeCloseTo(120);
  });

  it('glow 0,5 — альфы ореола и точки вдвое меньше', () => {
    drawAimLine(fake.ctx, TWO_SEGMENTS, LAYERED, { timeS: 0, scale: 1, glow: 0.5 });
    const full = fakeContext();
    drawAimLine(full.ctx, TWO_SEGMENTS, LAYERED, { timeS: 0, scale: 1, glow: 1 });
    expect(alphaOf(fake.strokes[0]?.strokeStyle ?? '')).toBeCloseTo(alphaOf(full.strokes[0]?.strokeStyle ?? '') / 2);
    expect(fake.images[0]?.alpha).toBeCloseTo((full.images[0]?.alpha ?? 0) / 2);
  });

  it('пульс меняет альфу ореола по времени, ядро не трогает', () => {
    drawAimLine(fake.ctx, TWO_SEGMENTS, LAYERED, { timeS: 0, scale: 1, glow: 1 });
    const half = fakeContext();
    // Четверть периода при 1 Гц — пик синуса.
    drawAimLine(half.ctx, TWO_SEGMENTS, LAYERED, { timeS: 0.25, scale: 1, glow: 1 });
    expect(alphaOf(fake.strokes[0]?.strokeStyle ?? '')).not.toBeCloseTo(alphaOf(half.strokes[0]?.strokeStyle ?? ''));
    expect(fake.strokes[4]?.strokeStyle).toBe(half.strokes[4]?.strokeStyle);
  });

  it('стиль без штрихов и точек: ни setLineDash, ни drawImage; ядро цветом состояния', () => {
    drawAimLine(fake.ctx, TWO_SEGMENTS, PLAIN_AIM_LINE_STYLE, { timeS: 0, scale: 1, glow: 1 });
    expect(fake.calls).not.toContain('setLineDash');
    expect(fake.calls).not.toContain('drawImage');
    expect(fake.strokes).toHaveLength(2);
    expect(fake.strokes[0]?.strokeStyle).toBe('rgba(244,241,232,0.34)');
  });

  it('пустая линия или glow 0 — ничего не рисуется', () => {
    drawAimLine(fake.ctx, { ...TWO_SEGMENTS, segments: [] }, LAYERED, { timeS: 0, scale: 1, glow: 1 });
    drawAimLine(fake.ctx, TWO_SEGMENTS, LAYERED, { timeS: 0, scale: 1, glow: 0 });
    expect(fake.calls).toHaveLength(0);
  });

  it('сужение: участок рисуется кусками с толщиной от start к end', () => {
    const style: AimLineStyle = {
      ...LAYERED,
      layers: [{ widthPx: 10, alpha: 0.1 }],
      dash: null,
      taper: { start: 1, end: 0.3 },
    };
    const line: AimLine = { ...TWO_SEGMENTS, segments: [{ x1: 0, y1: 0, x2: 120, y2: 0 }] };
    drawAimLine(fake.ctx, line, style, { timeS: 0, scale: SCALE, glow: 1 });
    const layerStrokes = fake.strokes.filter((stroke) => stroke.op === 'lighter');
    expect(layerStrokes.length).toBeGreaterThan(4);
    const widths = layerStrokes.map((stroke) => stroke.lineWidth);
    expect(widths[0]).toBeLessThanOrEqual(10 / SCALE);
    expect(widths[0]).toBeGreaterThan((0.9 * 10) / SCALE);
    expect(widths[widths.length - 1]).toBeLessThan((0.4 * 10) / SCALE);
    for (let index = 1; index < widths.length; index++) {
      expect(widths[index]).toBeLessThan(widths[index - 1] ?? 0);
    }
  });

  it('зернистость: один дополнительный штрих узором в lighter; без неё узора нет', () => {
    const style: AimLineStyle = { ...LAYERED, dash: null, grain: { alpha: 0.5, periodPx: 64, speedPxPerS: 40 } };
    const line: AimLine = { ...TWO_SEGMENTS, segments: [{ x1: 0, y1: 0, x2: 120, y2: 0 }] };
    drawAimLine(fake.ctx, line, style, { timeS: 0, scale: 1, glow: 1 });
    expect(fake.calls).toContain('createPattern');
    const patternStrokes = fake.strokes.filter((stroke) => stroke.strokeStyle === 'pattern');
    expect(patternStrokes).toHaveLength(1);
    expect(patternStrokes[0]?.op).toBe('lighter');
    const plain = fakeContext();
    drawAimLine(plain.ctx, line, { ...style, grain: null }, { timeS: 0, scale: 1, glow: 1 });
    expect(plain.calls).not.toContain('createPattern');
  });

  it('после отрисовки штрихи сброшены и контекст восстановлен', () => {
    drawAimLine(fake.ctx, TWO_SEGMENTS, LAYERED, { timeS: 0, scale: 1, glow: 1 });
    expect(fake.calls[fake.calls.length - 1]).toBe('restore');
    const lastDash = fake.calls.lastIndexOf('setLineDash');
    const lastStroke = fake.calls.lastIndexOf('stroke');
    expect(lastDash).toBeLessThan(lastStroke);
  });
});
