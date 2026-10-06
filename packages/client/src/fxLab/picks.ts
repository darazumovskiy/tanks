import type { StyleRound } from './variants.js';

// Отметки оператора «нравится» на вариантах: хранятся на устройстве через все раунды, собираются в текст для чата.

export const PICKS_KEY = 'tanks.fxPicks';
const EMPTY_TEXT = 'ничего не отмечено';

export interface VariantPick {
  round: string;
  variant: string;
}

export function pickKey(pick: VariantPick): string {
  return `${pick.round}:${pick.variant}`;
}

export function readPicks(storage: Pick<Storage, 'getItem'>): VariantPick[] {
  const raw = storage.getItem(PICKS_KEY);
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const picks: VariantPick[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') {
      continue;
    }
    const [round, variant] = item.split(':');
    if (round !== undefined && variant !== undefined && round !== '' && variant !== '') {
      picks.push({ round, variant });
    }
  }
  return picks;
}

export function writePicks(storage: Pick<Storage, 'setItem'>, picks: readonly VariantPick[]): void {
  storage.setItem(PICKS_KEY, JSON.stringify(picks.map(pickKey)));
}

export function hasPick(picks: readonly VariantPick[], pick: VariantPick): boolean {
  return picks.some((candidate) => pickKey(candidate) === pickKey(pick));
}

export function togglePick(picks: readonly VariantPick[], pick: VariantPick): VariantPick[] {
  if (hasPick(picks, pick)) {
    return picks.filter((candidate) => pickKey(candidate) !== pickKey(pick));
  }
  return [...picks, pick];
}

// Текст для чата: по строке на отметку в порядке раундов и вариантов внутри раунда.
export function picksText(picks: readonly VariantPick[], rounds: readonly StyleRound[]): string {
  const lines: string[] = [];
  for (const round of rounds) {
    for (const variant of round.variants) {
      if (hasPick(picks, { round: round.id, variant: variant.id })) {
        lines.push(`- раунд ${round.id} · ${variant.id} · ${variant.title}`);
      }
    }
  }
  if (lines.length === 0) {
    return EMPTY_TEXT;
  }
  return ['Понравилось в лаборатории (линия выстрела):', ...lines].join('\n');
}
