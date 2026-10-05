import type { FfaSnapshotEvent } from '@tanks/shared/protocol';
import { describe, expect, it } from 'vitest';
import { AudioMix, MAX_VOICES, mixedSound, type MixedSound } from './audioMix.js';
import { SOUND_DURATIONS, type Voice } from './sfx.js';

const ME = 4;
const OTHER = 5;
const LISTENER = { x: 1000, y: 1000 };
const SHOT_MS = SOUND_DURATIONS.shot * 1000;

interface FakeVoice extends Voice {
  name: string;
  isStopped: boolean;
}

function voiceNamed(name: string): FakeVoice {
  const voice: FakeVoice = {
    name,
    isStopped: false,
    stop: () => {
      voice.isStopped = true;
    },
  };
  return voice;
}

function own(source = LISTENER): MixedSound {
  return { name: 'shot', isOwn: true, source };
}

function other(source = LISTENER): MixedSound {
  return { name: 'shot', isOwn: false, source };
}

function event(kind: FfaSnapshotEvent['kind'], tank: number | null, by: number | null = null): FfaSnapshotEvent {
  return { kind, tank, by, x: 300, y: 400, value: 0, dx: 0, dy: 0, flags: 0 };
}

// Микшер с записью запусков: какой звук с какой громкостью пошёл и его голос.
function recordingMix(): {
  mix: AudioMix;
  started: FakeVoice[];
  volumes: number[];
  play: (sound: MixedSound, nowMs: number) => boolean;
} {
  const mix = new AudioMix(SOUND_DURATIONS);
  const started: FakeVoice[] = [];
  const volumes: number[] = [];
  const play = (sound: MixedSound, nowMs: number): boolean =>
    mix.play(sound, LISTENER, nowMs, (volume) => {
      const voice = voiceNamed(`${sound.isOwn ? 'свой' : 'чужой'} ${String(started.length)}`);
      started.push(voice);
      volumes.push(volume);
      return voice;
    });
  return { mix, started, volumes, play };
}

describe('AudioMix — громкость', () => {
  it('падает с расстоянием до слушателя по формуле и дальше половины диагонали окна не тише четверти', () => {
    const { volumes, play } = recordingMix();
    for (const distance of [0, 459, 918, 2000]) {
      play(other({ x: LISTENER.x + distance, y: LISTENER.y }), 0);
    }
    play({ name: 'alarm', isOwn: true, source: null }, 0);
    expect(volumes).toEqual([1, 0.625, 0.25, 0.25, 1]);
  });
});

describe('AudioMix — голоса', () => {
  it('набор полон — девятый чужой не звучит и не запускается', () => {
    const { mix, started, play } = recordingMix();
    for (let index = 0; index < MAX_VOICES; index++) {
      expect(play(other(), 0)).toBe(true);
    }
    expect(play(other(), 10)).toBe(false);
    expect(started).toHaveLength(MAX_VOICES);
    expect(mix.activeCount(10)).toBe(MAX_VOICES);
  });

  it('набор полон — свой вытесняет самый старый чужой, а не старший свой', () => {
    const { mix, started, play } = recordingMix();
    play(own(), 0);
    for (let index = 1; index < MAX_VOICES; index++) {
      play(other(), index);
    }
    expect(play(own(), 20)).toBe(true);
    expect(started.filter((voice) => voice.isStopped).map((voice) => voice.name)).toEqual(['чужой 1']);
    expect(mix.activeCount(20)).toBe(MAX_VOICES);
    expect(play(own(), 21)).toBe(true);
    expect(started.filter((voice) => voice.isStopped).map((voice) => voice.name)).toEqual(['чужой 1', 'чужой 2']);
  });

  it('все восемь — свои: новый свой вытесняет самый старый свой', () => {
    const { started, play } = recordingMix();
    for (let index = 0; index < MAX_VOICES; index++) {
      play(own(), index);
    }
    play(own(), 20);
    expect(started.filter((voice) => voice.isStopped).map((voice) => voice.name)).toEqual(['свой 0']);
  });

  it('отзвучавший по таблице длительностей голос освобождает место', () => {
    const { mix, play } = recordingMix();
    play({ name: 'death', isOwn: false, source: LISTENER }, 0);
    for (let index = 1; index < MAX_VOICES; index++) {
      play(other(), 0);
    }
    expect(play(other(), SHOT_MS - 1)).toBe(false);
    expect(mix.activeCount(SHOT_MS)).toBe(1);
    expect(play(other(), SHOT_MS)).toBe(true);
    expect(mix.activeCount(SOUND_DURATIONS.death * 1000)).toBe(0);
  });

  it('звук, который не прозвучал (выключен, вкладка скрыта), места не занимает', () => {
    const mix = new AudioMix(SOUND_DURATIONS);
    expect(mix.play(own(), LISTENER, 0, () => null)).toBe(false);
    expect(mix.activeCount(0)).toBe(0);
  });
});

describe('mixedSound — чей звук', () => {
  it('свои: свой выстрел, попадание в свой танк, своя смерть, своя аптечка, убийство своим снарядом, тревога зоны', () => {
    const owned = [
      event('shot', ME),
      event('hit', ME, OTHER),
      event('death', ME, OTHER),
      event('pickup', ME),
      event('death', OTHER, ME),
    ];
    for (const candidate of owned) {
      expect(mixedSound(candidate, 'shot', ME)).toEqual({ name: 'shot', isOwn: true, source: { x: 300, y: 400 } });
    }
    expect(mixedSound(event('zoneStart', null), 'alarm', ME)).toEqual({ name: 'alarm', isOwn: true, source: null });
  });

  it('чужие: чужой выстрел, своё попадание по чужому, рикошет своего снаряда, чужая смерть; без своего номера — всё чужое', () => {
    const others = [
      event('shot', OTHER),
      event('hit', OTHER, ME),
      event('ricochet', ME),
      event('death', OTHER, 6),
      event('pickup', OTHER),
    ];
    for (const candidate of others) {
      expect(mixedSound(candidate, 'shot', ME).isOwn).toBe(false);
    }
    expect(mixedSound(event('shot', ME), 'shot', null).isOwn).toBe(false);
  });
});
