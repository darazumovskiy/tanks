import { TICK_RATE } from '@tanks/shared/engine';
import type { FightSample } from './rounds.js';

// Позиция — отрезок боя не короче 1 с, где танк стоит (скорость ниже 20), а башня поворачивается или огонь
// зажат хотя бы в 30 % тиков; отрезки, разделённые сдвигом короче 1 с, сливаются. Остальное время — манёвр.
export const STILL_SPEED = 20;
const MIN_POSITION_TICKS = TICK_RATE;
const MIN_POSITION_ACTIVE_SHARE = 0.3;
const MERGE_GAP_TICKS = TICK_RATE;
// Раунд стоячей манеры — позиция не меньше 20 % боя.
export const HOLD_STYLE_SHARE = 0.2;

export interface Segment {
  start: number;
  end: number;
}

function activeShare(samples: readonly FightSample[], start: number, end: number): number {
  let active = 0;
  for (let i = start; i < end; i++) {
    const sample = samples[i];
    active += sample !== undefined && (sample.isFiring || sample.isTurretTurning) ? 1 : 0;
  }
  return active / (end - start);
}

function stillEpisodes(samples: readonly FightSample[]): Segment[] {
  const episodes: Segment[] = [];
  let start: number | null = null;
  for (let i = 0; i <= samples.length; i++) {
    const isStill = i < samples.length && (samples[i]?.speed ?? Infinity) < STILL_SPEED;
    if (isStill) {
      start ??= i;
      continue;
    }
    if (start === null) {
      continue;
    }
    const isLong = i - start >= MIN_POSITION_TICKS;
    if (isLong && activeShare(samples, start, i) >= MIN_POSITION_ACTIVE_SHARE) {
      episodes.push({ start, end: i });
    }
    start = null;
  }
  return episodes;
}

// Отрезки позиции раунда по тикам боя, индексы — в тиках боя.
export function positionSegments(samples: readonly FightSample[]): Segment[] {
  const merged: Segment[] = [];
  for (const episode of stillEpisodes(samples)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && episode.start - last.end < MERGE_GAP_TICKS) {
      last.end = episode.end;
      continue;
    }
    merged.push({ ...episode });
  }
  return merged;
}

export function positionMask(length: number, segments: readonly Segment[]): boolean[] {
  const mask = Array.from({ length }, () => false);
  for (const segment of segments) {
    mask.fill(true, segment.start, segment.end);
  }
  return mask;
}
