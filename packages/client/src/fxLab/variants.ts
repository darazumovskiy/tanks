import { PLAIN_AIM_LINE_STYLE, type AimLineStyle } from '../render/aimLineStyle.js';
import { AIM_LINE_STYLES, type AimLineStyleEntry } from '../render/aimLineStyles.js';

// Раунды вариантов стиля линии выстрела. В каждом раунде два якоря: «безопасный» — ориентир, с которым
// сравнивают, и «плохой» — заведомо мимо. `picks` — выбор оператора. Стили, вошедшие в выбор, живут в боевом
// реестре `render/aimLineStyles.ts`; здесь — только якоря и история.

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
  picks: readonly string[];
  variants: readonly StyleVariant[];
}

const NO_PULSE: AimLineStyle['pulse'] = {
  none: { hz: 0, depth: 0 },
  onTarget: { hz: 0, depth: 0 },
  lead: { hz: 0, depth: 0 },
};

const FLAT: AimLineStyle = {
  ...PLAIN_AIM_LINE_STYLE,
  neutral: '#9a9a9a',
  core: { widthPx: 5, alpha: 1, highlightAlpha: 1, color: null },
  pulse: NO_PULSE,
  tail: { widthScale: 1, alphaScale: 1 },
  fadeMs: 1,
};

function fromRegistry(entry: AimLineStyleEntry, anchor: AnchorKind, note: string): StyleVariant {
  return { id: entry.id, title: entry.title, anchor, note, style: entry.style };
}

function registryEntry(id: string): AimLineStyleEntry {
  const entry = AIM_LINE_STYLES.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new Error(`нет стиля ${id} в реестре`);
  }
  return entry;
}

export const AIM_LINE_ROUNDS: readonly StyleRound[] = [
  {
    id: '1',
    title: 'Раунд 1: направления',
    picks: ['tracer', 'neon'],
    variants: [
      { id: 'current', title: 'Как было', anchor: 'safe', note: 'якорь: прежний вид', style: PLAIN_AIM_LINE_STYLE },
      { id: 'flat', title: 'Плоская серая', anchor: 'bad', note: 'якорь: заведомо плохо', style: FLAT },
      fromRegistry(registryEntry('tracer'), null, 'штрихи главные'),
      fromRegistry(registryEntry('neon'), null, 'мягкий ореол, кольцо'),
    ],
  },
  {
    id: '2',
    title: 'Раунд 2: вспомогательный прицел — тонкий или блёклый',
    picks: ['tracer', 'neon', 'hairline', 'dots', 'tapered', 'grain', 'soft-tracer'],
    variants: [
      fromRegistry(registryEntry('tracer'), 'safe', 'якорь: ориентир раунда 1'),
      fromRegistry(registryEntry('neon'), 'bad', 'якорь: слишком сочно'),
      fromRegistry(registryEntry('hairline'), null, 'тонко, почти без ореола'),
      fromRegistry(registryEntry('dots'), null, 'пунктир точками, нить едва видна'),
      fromRegistry(registryEntry('tapered'), null, 'узко у дула, шире и бледнее к концу'),
      fromRegistry(registryEntry('grain'), null, 'текстура шума вдоль нити'),
      fromRegistry(registryEntry('soft-tracer'), null, 'штрихи реже и бледнее'),
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
