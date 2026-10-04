import type { AimLine } from '../aimLine.js';
import { drawAimLine, PLAIN_AIM_LINE_STYLE, type AimLineStyle } from './aimLineStyle.js';

// Стили линии выстрела на выбор игрока — итог двух раундов лаборатории эффектов. Цвета состояний у всех одни,
// стиль меняет форму: ядро, ореол, штрихи, пульс, точки, сужение, зерно.

export type AimLineStyleId = 'soft-tracer' | 'tracer' | 'dots' | 'hairline' | 'tapered' | 'grain' | 'neon';

export interface AimLineStyleEntry {
  id: AimLineStyleId;
  title: string;
  hint: string;
  style: AimLineStyle;
}

export const DEFAULT_AIM_LINE_STYLE_ID: AimLineStyleId = 'soft-tracer';

const STATE_COLORS = { onTarget: '#e8825a', lead: '#5dffa0', danger: '#ff5a6a' };
const COLD = '#9fb4c8';
const THIN_PULSE: AimLineStyle['pulse'] = {
  none: { hz: 0, depth: 0 },
  onTarget: { hz: 1.5, depth: 0.2 },
  lead: { hz: 1.2, depth: 0.15 },
};
const THIN_MARK = { halfLengthPx: 6, widthPx: 1.5 };

export const TRACER_STYLE: AimLineStyle = {
  ...PLAIN_AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  core: { widthPx: 1.5, alpha: 0.5, highlightAlpha: 0.8, color: null },
  layers: [
    { widthPx: 8, alpha: 0.08 },
    { widthPx: 4, alpha: 0.2 },
  ],
  dash: { onPx: 18, offPx: 10, speedPxPerS: 260, alpha: 0.6 },
  pulse: { none: { hz: 0, depth: 0 }, onTarget: { hz: 2, depth: 0.2 }, lead: { hz: 1.5, depth: 0.15 } },
  end: { radiusPx: 10, alpha: 0.7, ringRadiusPx: 4, ringWidthPx: 1.2, wallScale: 0.7 },
  tail: { widthScale: 0.8, alphaScale: 0.6 },
};

export const NEON_RING_STYLE: AimLineStyle = {
  ...PLAIN_AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  core: { widthPx: 1.5, alpha: 0.95, highlightAlpha: 1, color: '#ffffff' },
  layers: [
    { widthPx: 18, alpha: 0.05 },
    { widthPx: 10, alpha: 0.08 },
    { widthPx: 4, alpha: 0.2 },
  ],
  dash: { onPx: 10, offPx: 14, speedPxPerS: 120, alpha: 0.12 },
  pulse: { none: { hz: 0.8, depth: 0.1 }, onTarget: { hz: 2, depth: 0.3 }, lead: { hz: 1.5, depth: 0.2 } },
  muzzle: { radiusPx: 8, alpha: 0.4 },
  end: { radiusPx: 16, alpha: 0.7, ringRadiusPx: 9, ringWidthPx: 2, wallScale: 0.5 },
  tail: { widthScale: 0.7, alphaScale: 0.6 },
  mark: { halfLengthPx: 9, widthPx: 2 },
  fadeMs: 200,
};

export const HAIRLINE_STYLE: AimLineStyle = {
  ...PLAIN_AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  core: { widthPx: 1.5, alpha: 0.6, highlightAlpha: 0.85, color: null },
  layers: [{ widthPx: 3.5, alpha: 0.12 }],
  pulse: THIN_PULSE,
  end: { radiusPx: 6, alpha: 0.6, ringRadiusPx: 4, ringWidthPx: 1, wallScale: 0.6 },
  tail: { widthScale: 0.8, alphaScale: 0.5 },
  mark: THIN_MARK,
};

export const DOTS_STYLE: AimLineStyle = {
  ...PLAIN_AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  core: { widthPx: 1, alpha: 0.08, highlightAlpha: 0.2, color: null },
  layers: [{ widthPx: 4, alpha: 0.02 }],
  dash: { onPx: 3, offPx: 9, speedPxPerS: 60, alpha: 0.75 },
  pulse: THIN_PULSE,
  end: { radiusPx: 5, alpha: 0.6, ringRadiusPx: 3.5, ringWidthPx: 1, wallScale: 0.6 },
  tail: { widthScale: 0.8, alphaScale: 0.4 },
  mark: THIN_MARK,
};

export const TAPERED_STYLE: AimLineStyle = {
  ...PLAIN_AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  taper: { start: 0.6, end: 1.5 },
  core: { widthPx: 1.5, alpha: 0.6, highlightAlpha: 0.85, color: null },
  layers: [{ widthPx: 8, alpha: 0.1 }],
  pulse: THIN_PULSE,
  end: { radiusPx: 7, alpha: 0.5, ringRadiusPx: 0, ringWidthPx: 0, wallScale: 0.6 },
  tail: { widthScale: 0.7, alphaScale: 0.5 },
  mark: THIN_MARK,
};

export const GRAIN_STYLE: AimLineStyle = {
  ...PLAIN_AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  grain: { alpha: 0.9, periodPx: 48, speedPxPerS: 40 },
  core: { widthPx: 1.5, alpha: 0.3, highlightAlpha: 0.6, color: null },
  layers: [{ widthPx: 4, alpha: 0.08 }],
  pulse: THIN_PULSE,
  end: { radiusPx: 6, alpha: 0.5, ringRadiusPx: 4, ringWidthPx: 1, wallScale: 0.6 },
  tail: { widthScale: 0.8, alphaScale: 0.5 },
  mark: THIN_MARK,
};

export const SOFT_TRACER_STYLE: AimLineStyle = {
  ...PLAIN_AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  core: { widthPx: 1.5, alpha: 0.5, highlightAlpha: 0.8, color: null },
  layers: [
    { widthPx: 6, alpha: 0.06 },
    { widthPx: 3, alpha: 0.14 },
  ],
  dash: { onPx: 18, offPx: 12, speedPxPerS: 160, alpha: 0.45 },
  pulse: THIN_PULSE,
  end: { radiusPx: 8, alpha: 0.5, ringRadiusPx: 4, ringWidthPx: 1, wallScale: 0.6 },
  tail: { widthScale: 0.8, alphaScale: 0.5 },
  mark: THIN_MARK,
};

export const AIM_LINE_STYLES: readonly AimLineStyleEntry[] = [
  { id: 'soft-tracer', title: 'Тихий трассер', hint: 'редкие бледные штрихи бегут к цели', style: SOFT_TRACER_STYLE },
  { id: 'tracer', title: 'Трассер', hint: 'штрихи чаще и ярче', style: TRACER_STYLE },
  { id: 'dots', title: 'Точки', hint: 'пунктир точками, нить едва видна', style: DOTS_STYLE },
  { id: 'hairline', title: 'Волосок', hint: 'тонкая нить почти без ореола', style: HAIRLINE_STYLE },
  { id: 'tapered', title: 'Расходящийся', hint: 'узко у дула, шире и бледнее к концу', style: TAPERED_STYLE },
  { id: 'grain', title: 'Зернистый', hint: 'зерно шума вдоль нити', style: GRAIN_STYLE },
  { id: 'neon', title: 'Неон с кольцом', hint: 'мягкий ореол, кольцо на цели', style: NEON_RING_STYLE },
];

export function isAimLineStyleId(value: unknown): value is AimLineStyleId {
  return AIM_LINE_STYLES.some((entry) => entry.id === value);
}

export function aimLineStyleById(id: AimLineStyleId): AimLineStyleEntry {
  const entry = AIM_LINE_STYLES.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new Error(`нет стиля линии ${id}`);
  }
  return entry;
}

const PREVIEW_PADDING_LEFT = 8;
const PREVIEW_PADDING_RIGHT = 10;

// Полоска-превью для панели настроек: нейтральный вид стиля слева направо, в CSS-пикселях холста, без раскраски
// по состояниям.
export function drawAimLinePreview(
  ctx: CanvasRenderingContext2D,
  style: AimLineStyle,
  width: number,
  height: number,
): void {
  const y = height / 2;
  const line: AimLine = {
    segments: [{ x1: PREVIEW_PADDING_LEFT, y1: y, x2: width - PREVIEW_PADDING_RIGHT, y2: y }],
    state: 'none',
    mark: null,
    isReturning: false,
  };
  drawAimLine(ctx, line, style, { timeS: 0, scale: 1, glow: 1 });
}
