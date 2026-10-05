import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SnapshotEvent } from '@tanks/shared/protocol';
import { Sfx, SOUND_DURATIONS, type SoundName } from './sfx.js';
import { installFakeAudio, type FakeAudio } from './testing/fakeAudio.js';

// Громкость выстрела и панорама дуэли до перевода `play` на панораму и громкость.
const SHOT_GAIN = 0.32;
const HIT_GAIN = 0.35;

function event(kind: SnapshotEvent['kind'], x: number): SnapshotEvent {
  return { kind, side: 0, x, y: 450, value: 0, dx: 0, dy: 0, flags: 0 };
}

describe('Sfx', () => {
  let audio: FakeAudio;
  let isHidden: boolean;
  let sfx: Sfx;

  beforeEach(() => {
    audio = installFakeAudio();
    isHidden = false;
    sfx = new Sfx(() => isHidden);
    sfx.unlock();
  });

  afterEach(() => {
    audio.restore();
  });

  it('дуэль звучит как раньше: панорама от места на поле от −0,8 до 0,8, прежняя громкость', () => {
    sfx.events([event('shot', 0), event('shot', 800), event('shot', 1600), event('hit', 400)]);
    expect(audio.outputs.map((output) => output.pan)).toEqual([-0.8, 0, 0.8, -0.4]);
    expect(audio.outputs.map((output) => output.gain)).toEqual([SHOT_GAIN, SHOT_GAIN, SHOT_GAIN, HIT_GAIN]);
  });

  it('play берёт панораму и громкость от вызывающего', () => {
    sfx.play('shot', 0.5, 0.25);
    sfx.play('beep');
    expect(audio.outputs).toEqual([
      { gain: SHOT_GAIN * 0.25, pan: 0.5 },
      { gain: 0.2, pan: 0 },
    ]);
  });

  it('скрытая вкладка молчит; вернулась — звук снова идёт', () => {
    isHidden = true;
    sfx.play('shot', 0, 1);
    sfx.events([event('hit', 100)]);
    expect(audio.outputs).toHaveLength(0);
    isHidden = false;
    sfx.play('shot', 0, 1);
    expect(audio.outputs).toHaveLength(1);
  });

  it('выключенный звук молчит', () => {
    sfx.toggle();
    expect(sfx.play('shot')).toBeNull();
    expect(audio.outputs).toHaveLength(0);
  });

  it('прозвучавший звук глушится раньше конца; не прозвучавший — не голос', () => {
    const voice = sfx.play('death', 0.3, 0.5);
    sfx.play('shot');
    voice?.stop();
    expect(audio.released).toEqual([audio.outputs[0]]);
    isHidden = true;
    expect(sfx.play('shot')).toBeNull();
    expect(new Sfx(() => false).play('shot')).toBeNull();
  });

  it('таблица длительностей совпадает с синтезом: звук длится до остановки последнего источника', () => {
    for (const name of Object.keys(SOUND_DURATIONS) as SoundName[]) {
      audio.stops.length = 0;
      sfx.play(name);
      expect(Math.max(...audio.stops), name).toBeCloseTo(SOUND_DURATIONS[name], 6);
    }
  });
});
