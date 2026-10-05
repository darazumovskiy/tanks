import type { Point } from '@tanks/shared/engine';
import type { FfaSnapshotEvent } from '@tanks/shared/protocol';
import type { SoundName, Voice } from './sfx.js';

// Больше голосов разом — каша, в которой не слышно своего.
export const MAX_VOICES = 8;
// Громкость падает с расстоянием до слушателя до четверти на половине диагонали окна обзора и дальше не тише.
const FADE_DISTANCE = 918;
const FADE_DEPTH = 0.75;
const MS_PER_S = 1000;

// Звук события для микшера: чей он и откуда; источник `null` — звук без места, полной громкости.
export interface MixedSound {
  name: SoundName;
  isOwn: boolean;
  source: Point | null;
}

interface ActiveVoice {
  voice: Voice;
  isOwn: boolean;
  endsAtMs: number;
}

// Свои звуки — то, что случилось с собой и от своей руки: свой выстрел, попадание в свой танк, своя смерть, своя
// аптечка, убийство своим снарядом. Тревога зоны слышна всем, места у неё нет — она тоже своя.
export function mixedSound(event: FfaSnapshotEvent, name: SoundName, myId: number | null): MixedSound {
  if (event.kind === 'zoneStart') {
    return { name, isOwn: true, source: null };
  }
  return { name, isOwn: isOwnEvent(event, myId), source: { x: event.x, y: event.y } };
}

function isOwnEvent(event: FfaSnapshotEvent, myId: number | null): boolean {
  if (myId === null) {
    return false;
  }
  switch (event.kind) {
    case 'shot':
    case 'hit':
    case 'pickup':
      return event.tank === myId;
    case 'death':
      return event.tank === myId || event.by === myId;
    default:
      return false;
  }
}

function distanceVolume(source: Point | null, listener: Point): number {
  if (source === null) {
    return 1;
  }
  const distance = Math.hypot(source.x - listener.x, source.y - listener.y);
  return 1 - FADE_DEPTH * Math.min(1, distance / FADE_DISTANCE);
}

// Голоса боя толпы: не больше восьми разом; голос держит место, пока звучит его звук. Набор полон — свой звук
// вытесняет самый старый чужой (чужих нет — самый старый свой), чужой не звучит.
export class AudioMix {
  private voices: ActiveVoice[] = [];

  constructor(private readonly durationsS: Readonly<Record<SoundName, number>>) {}

  activeCount(nowMs: number): number {
    this.release(nowMs);
    return this.voices.length;
  }

  // `start` пускает звук с громкостью и отдаёт его голос; `null` — звук не прозвучал и места не занимает.
  play(sound: MixedSound, listener: Point, nowMs: number, start: (volume: number) => Voice | null): boolean {
    this.release(nowMs);
    const isFull = this.voices.length >= MAX_VOICES;
    if (isFull && !sound.isOwn) {
      return false;
    }
    const voice = start(distanceVolume(sound.source, listener));
    if (voice === null) {
      return false;
    }
    if (isFull) {
      this.evictOldest();
    }
    this.voices.push({
      voice,
      isOwn: sound.isOwn,
      endsAtMs: nowMs + this.durationsS[sound.name] * MS_PER_S,
    });
    return true;
  }

  private release(nowMs: number): void {
    this.voices = this.voices.filter((active) => active.endsAtMs > nowMs);
  }

  // Голоса лежат в порядке запуска: первый подходящий — самый старый.
  private evictOldest(): void {
    const oldestOther = this.voices.findIndex((active) => !active.isOwn);
    const index = oldestOther === -1 ? 0 : oldestOther;
    const [evicted] = this.voices.splice(index, 1);
    evicted?.voice.stop();
  }
}
