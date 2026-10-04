import { AIM_LINE_STYLE, type AimLineStyle } from '../render/aimLineStyle.js';

// Раунды вариантов стиля линии выстрела. В каждом раунде два якоря: «безопасный» — ориентир, с которым
// сравнивают, и «плохой» — заведомо мимо; кандидаты отличаются направлением, не числами. `pick` — выбор Димы.

export type AnchorKind = 'safe' | 'bad' | null;

export interface StyleVariant {
  id: string;
  title: string;
  anchor: AnchorKind;
  // Короткая пометка под названием: роль якоря или суть направления.
  note: string;
  style: AimLineStyle;
}

export interface StyleRound {
  id: string;
  title: string;
  pick: string | null;
  variants: readonly StyleVariant[];
}

const STATE_COLORS = { onTarget: '#e8825a', lead: '#5dffa0', danger: '#ff5a6a' };
const NO_PULSE: AimLineStyle['pulse'] = {
  none: { hz: 0, depth: 0 },
  onTarget: { hz: 0, depth: 0 },
  lead: { hz: 0, depth: 0 },
};
const COLD = '#9fb4c8';

const FLAT: AimLineStyle = {
  ...AIM_LINE_STYLE,
  neutral: '#9a9a9a',
  core: { widthPx: 5, alpha: 1, highlightAlpha: 1, color: null },
  pulse: NO_PULSE,
  tail: { widthScale: 1, alphaScale: 1 },
  fadeMs: 1,
};

const COLD_LASER: AimLineStyle = {
  ...AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  core: { widthPx: 1.6, alpha: 0.9, highlightAlpha: 0.95, color: '#ffffff' },
  layers: [
    { widthPx: 14, alpha: 0.07 },
    { widthPx: 7, alpha: 0.14 },
    { widthPx: 3, alpha: 0.35 },
  ],
  dash: { onPx: 10, offPx: 14, speedPxPerS: 120, alpha: 0.09 },
  pulse: { none: { hz: 0.8, depth: 0.15 }, onTarget: { hz: 2.5, depth: 0.35 }, lead: { hz: 1.6, depth: 0.25 } },
  muzzle: { radiusPx: 10, alpha: 0.5 },
  end: { radiusPx: 14, alpha: 0.8, ringRadiusPx: 5, ringWidthPx: 1.5, wallScale: 0.6 },
  tail: { widthScale: 0.7, alphaScale: 0.6 },
  fadeMs: 180,
};

const HOT_PLASMA: AimLineStyle = {
  ...AIM_LINE_STYLE,
  ...STATE_COLORS,
  core: { widthPx: 2, alpha: 0.9, highlightAlpha: 1, color: '#fff6ea' },
  layers: [
    { widthPx: 22, alpha: 0.06 },
    { widthPx: 11, alpha: 0.12 },
    { widthPx: 4, alpha: 0.3 },
  ],
  pulse: { none: { hz: 1, depth: 0.25 }, onTarget: { hz: 3, depth: 0.45 }, lead: { hz: 2, depth: 0.3 } },
  muzzle: { radiusPx: 14, alpha: 0.6 },
  end: { radiusPx: 20, alpha: 0.9, ringRadiusPx: 0, ringWidthPx: 0, wallScale: 0.5 },
  tail: { widthScale: 0.7, alphaScale: 0.55 },
  mark: { halfLengthPx: 8, widthPx: 2.5 },
  fadeMs: 180,
};

const TRACER: AimLineStyle = {
  ...AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  core: { widthPx: 1.2, alpha: 0.5, highlightAlpha: 0.8, color: null },
  layers: [
    { widthPx: 8, alpha: 0.08 },
    { widthPx: 4, alpha: 0.2 },
  ],
  dash: { onPx: 18, offPx: 10, speedPxPerS: 260, alpha: 0.6 },
  pulse: { none: { hz: 0, depth: 0 }, onTarget: { hz: 2, depth: 0.2 }, lead: { hz: 1.5, depth: 0.15 } },
  end: { radiusPx: 10, alpha: 0.7, ringRadiusPx: 4, ringWidthPx: 1.2, wallScale: 0.7 },
  tail: { widthScale: 0.8, alphaScale: 0.6 },
};

const NEON_RING: AimLineStyle = {
  ...AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  core: { widthPx: 1.4, alpha: 0.95, highlightAlpha: 1, color: '#ffffff' },
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

const HAIRLINE: AimLineStyle = {
  ...AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  core: { widthPx: 1.5, alpha: 0.6, highlightAlpha: 0.85, color: null },
  layers: [{ widthPx: 3.5, alpha: 0.12 }],
  pulse: { none: { hz: 0, depth: 0 }, onTarget: { hz: 1.5, depth: 0.2 }, lead: { hz: 1.2, depth: 0.15 } },
  end: { radiusPx: 6, alpha: 0.6, ringRadiusPx: 4, ringWidthPx: 1, wallScale: 0.6 },
  tail: { widthScale: 0.8, alphaScale: 0.5 },
  mark: { halfLengthPx: 6, widthPx: 1.5 },
};

const DOTS: AimLineStyle = {
  ...AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  core: { widthPx: 1, alpha: 0.08, highlightAlpha: 0.2, color: null },
  layers: [{ widthPx: 4, alpha: 0.02 }],
  dash: { onPx: 3, offPx: 9, speedPxPerS: 60, alpha: 0.75 },
  pulse: { none: { hz: 0, depth: 0 }, onTarget: { hz: 1.5, depth: 0.2 }, lead: { hz: 1.2, depth: 0.15 } },
  end: { radiusPx: 5, alpha: 0.6, ringRadiusPx: 3.5, ringWidthPx: 1, wallScale: 0.6 },
  tail: { widthScale: 0.8, alphaScale: 0.4 },
  mark: { halfLengthPx: 6, widthPx: 1.5 },
};

const TAPERED: AimLineStyle = {
  ...AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  taper: { start: 0.4, end: 1.6 },
  core: { widthPx: 1.2, alpha: 0.6, highlightAlpha: 0.85, color: null },
  layers: [{ widthPx: 8, alpha: 0.1 }],
  pulse: { none: { hz: 0, depth: 0 }, onTarget: { hz: 1.5, depth: 0.2 }, lead: { hz: 1.2, depth: 0.15 } },
  end: { radiusPx: 7, alpha: 0.5, ringRadiusPx: 0, ringWidthPx: 0, wallScale: 0.6 },
  tail: { widthScale: 0.7, alphaScale: 0.5 },
  mark: { halfLengthPx: 6, widthPx: 1.5 },
};

const GRAIN: AimLineStyle = {
  ...AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  grain: { alpha: 0.9, periodPx: 48, speedPxPerS: 40 },
  core: { widthPx: 1.5, alpha: 0.3, highlightAlpha: 0.6, color: null },
  layers: [{ widthPx: 4, alpha: 0.08 }],
  pulse: { none: { hz: 0, depth: 0 }, onTarget: { hz: 1.5, depth: 0.2 }, lead: { hz: 1.2, depth: 0.15 } },
  end: { radiusPx: 6, alpha: 0.5, ringRadiusPx: 4, ringWidthPx: 1, wallScale: 0.6 },
  tail: { widthScale: 0.8, alphaScale: 0.5 },
  mark: { halfLengthPx: 6, widthPx: 1.5 },
};

const SOFT_TRACER: AimLineStyle = {
  ...AIM_LINE_STYLE,
  ...STATE_COLORS,
  neutral: COLD,
  core: { widthPx: 1.5, alpha: 0.5, highlightAlpha: 0.8, color: null },
  layers: [
    { widthPx: 6, alpha: 0.06 },
    { widthPx: 3, alpha: 0.14 },
  ],
  dash: { onPx: 18, offPx: 12, speedPxPerS: 160, alpha: 0.45 },
  pulse: { none: { hz: 0, depth: 0 }, onTarget: { hz: 1.5, depth: 0.2 }, lead: { hz: 1.2, depth: 0.15 } },
  end: { radiusPx: 8, alpha: 0.5, ringRadiusPx: 4, ringWidthPx: 1, wallScale: 0.6 },
  tail: { widthScale: 0.8, alphaScale: 0.5 },
  mark: { halfLengthPx: 6, widthPx: 1.5 },
};

export const AIM_LINE_ROUNDS: readonly StyleRound[] = [
  {
    id: '1',
    title: 'Раунд 1: направления',
    pick: 'tracer',
    variants: [
      { id: 'current', title: 'Как сейчас', anchor: 'safe', note: 'якорь: прежний вид', style: AIM_LINE_STYLE },
      { id: 'flat', title: 'Плоская серая', anchor: 'bad', note: 'якорь: заведомо плохо', style: FLAT },
      { id: 'cold', title: 'Холодный лазер', anchor: null, note: 'белое ядро, ореол, штрихи', style: COLD_LASER },
      { id: 'hot', title: 'Горячая плазма', anchor: null, note: 'широкий ореол, пульс', style: HOT_PLASMA },
      { id: 'tracer', title: 'Трассер', anchor: null, note: 'штрихи главные', style: TRACER },
      { id: 'neon', title: 'Неон с кольцом', anchor: null, note: 'мягкий ореол, кольцо', style: NEON_RING },
    ],
  },
  {
    id: '2',
    title: 'Раунд 2: вспомогательный прицел — тонкий или блёклый',
    pick: null,
    variants: [
      { id: 'tracer', title: 'Трассер', anchor: 'safe', note: 'якорь: ориентир раунда 1', style: TRACER },
      { id: 'neon', title: 'Неон с кольцом', anchor: 'bad', note: 'якорь: слишком сочно', style: NEON_RING },
      { id: 'hairline', title: 'Волосок', anchor: null, note: 'тонко, почти без ореола', style: HAIRLINE },
      { id: 'dots', title: 'Точки', anchor: null, note: 'пунктир точками, нить едва видна', style: DOTS },
      {
        id: 'tapered',
        title: 'Расходящийся',
        anchor: null,
        note: 'узко у дула, шире и бледнее к концу',
        style: TAPERED,
      },
      { id: 'grain', title: 'Зернистый', anchor: null, note: 'текстура шума вдоль нити', style: GRAIN },
      { id: 'soft-tracer', title: 'Тихий трассер', anchor: null, note: 'штрихи реже и бледнее', style: SOFT_TRACER },
    ],
  },
];

export function currentRound(): StyleRound {
  const round = AIM_LINE_ROUNDS[AIM_LINE_ROUNDS.length - 1];
  if (round === undefined) {
    throw new Error('нет раундов вариантов');
  }
  return round;
}

export function roundById(id: string | null): StyleRound {
  return AIM_LINE_ROUNDS.find((round) => round.id === id) ?? currentRound();
}
