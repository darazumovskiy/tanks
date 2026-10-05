import { ARENA } from '@tanks/shared/engine';
import { EventFlag, type SnapshotEvent } from '@tanks/shared/protocol';

export type SoundName =
  'shot' | 'ricochet' | 'impact' | 'hit' | 'zoneTick' | 'death' | 'clash' | 'pickup' | 'beep' | 'go' | 'alarm' | 'win';

// Синтезированные звуки через Web Audio, без файлов. Контекст создаётся по первому действию игрока.
interface Audio {
  ctx: AudioContext;
  master: GainNode;
  noise: AudioBuffer;
}

const DUEL_PAN_LIMIT = 0.8;

// Панорама дуэли — по месту на поле: всё поле видно, левый край слева.
function duelPan(x: number): number {
  return Math.max(-DUEL_PAN_LIMIT, Math.min(DUEL_PAN_LIMIT, (x / ARENA.width) * 2 * DUEL_PAN_LIMIT - DUEL_PAN_LIMIT));
}

function isDocumentHidden(): boolean {
  return document.visibilityState === 'hidden';
}

// Громкость и панорама приходят от вызывающего: дуэль считает их по полю, толпа — по экрану. Скрытая вкладка молчит.
export class Sfx {
  private audio: Audio | null = null;
  isMuted = false;

  constructor(private readonly isHidden: () => boolean = isDocumentHidden) {}

  unlock(): void {
    if (this.audio === null) {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = 0.55;
      const compressor = ctx.createDynamicsCompressor();
      master.connect(compressor).connect(ctx.destination);
      const length = ctx.sampleRate;
      const noise = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.audio = { ctx, master, noise };
    }
    if (this.audio.ctx.state === 'suspended') {
      void this.audio.ctx.resume();
    }
  }

  toggle(): boolean {
    this.isMuted = !this.isMuted;
    return this.isMuted;
  }

  private out(audio: Audio, pan: number, gain: number): GainNode {
    const g = audio.ctx.createGain();
    g.gain.value = gain;
    const panner = audio.ctx.createStereoPanner();
    panner.pan.value = pan;
    g.connect(panner).connect(audio.master);
    return g;
  }

  private envelope(node: GainNode, t: number, attack: number, decay: number, peak = 1): void {
    node.gain.setValueAtTime(0.0001, t);
    node.gain.exponentialRampToValueAtTime(peak, t + attack);
    node.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private noiseBurst(
    audio: Audio,
    dest: GainNode,
    t: number,
    duration: number,
    type: BiquadFilterType,
    f1: number,
    f2: number,
    q = 1,
  ): void {
    const { ctx } = audio;
    const source = ctx.createBufferSource();
    source.buffer = audio.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f1, t);
    filter.frequency.exponentialRampToValueAtTime(f2, t + duration);
    const g = ctx.createGain();
    this.envelope(g, t, 0.004, duration);
    source.connect(filter).connect(g).connect(dest);
    source.start(t, Math.random() * 0.5);
    source.stop(t + duration + 0.05);
  }

  private tone(
    audio: Audio,
    dest: GainNode,
    t: number,
    duration: number,
    type: OscillatorType,
    f1: number,
    f2: number,
    peak = 1,
  ): void {
    const { ctx } = audio;
    const oscillator = ctx.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(f1, t);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + duration);
    const g = ctx.createGain();
    this.envelope(g, t, 0.005, duration, peak);
    oscillator.connect(g).connect(dest);
    oscillator.start(t);
    oscillator.stop(t + duration + 0.05);
  }

  // pan — от −1 (слева) до 1 (справа); volume — множитель громкости звука.
  play(name: SoundName, pan = 0, volume = 1): void {
    const audio = this.audio;
    if (audio === null || this.isMuted || this.isHidden()) {
      return;
    }
    const t = audio.ctx.currentTime;
    switch (name) {
      case 'shot': {
        const o = this.out(audio, pan, 0.32 * volume);
        this.noiseBurst(audio, o, t, 0.14, 'lowpass', 2600, 400);
        this.tone(audio, o, t, 0.16, 'sine', 140, 45);
        break;
      }
      case 'ricochet': {
        const o = this.out(audio, pan, 0.12 * volume);
        this.tone(audio, o, t, 0.16, 'sine', 2600 + Math.random() * 600, 1300);
        this.noiseBurst(audio, o, t, 0.05, 'highpass', 3000, 5000);
        break;
      }
      case 'impact':
        this.noiseBurst(audio, this.out(audio, pan, 0.12 * volume), t, 0.08, 'bandpass', 1200, 500, 2);
        break;
      case 'hit': {
        const o = this.out(audio, pan, 0.35 * volume);
        this.noiseBurst(audio, o, t, 0.18, 'bandpass', 1400, 400, 1.5);
        this.tone(audio, o, t, 0.12, 'square', 190, 90, 0.4);
        break;
      }
      case 'zoneTick':
        this.tone(audio, this.out(audio, pan, 0.05 * volume), t, 0.06, 'sawtooth', 260, 200);
        break;
      case 'death': {
        const o = this.out(audio, pan, 0.7 * volume);
        this.noiseBurst(audio, o, t, 1.4, 'lowpass', 1800, 90);
        this.tone(audio, o, t, 0.9, 'sine', 90, 28);
        this.noiseBurst(audio, o, t + 0.05, 0.5, 'bandpass', 700, 200, 1);
        break;
      }
      case 'clash': {
        const o = this.out(audio, pan, 0.2 * volume);
        this.tone(audio, o, t, 0.3, 'triangle', 1700, 1500);
        this.tone(audio, o, t, 0.25, 'triangle', 2550, 2300, 0.6);
        break;
      }
      case 'pickup': {
        const o = this.out(audio, pan, 0.18 * volume);
        [660, 880, 1320].forEach((frequency, index) => {
          this.tone(audio, o, t + index * 0.07, 0.14, 'sine', frequency, frequency);
        });
        break;
      }
      case 'beep':
        this.tone(audio, this.out(audio, pan, 0.2 * volume), t, 0.12, 'sine', 880, 880);
        break;
      case 'go': {
        const o = this.out(audio, pan, 0.25 * volume);
        this.tone(audio, o, t, 0.4, 'sawtooth', 660, 1320, 0.5);
        this.tone(audio, o, t, 0.4, 'sine', 1320, 1320);
        break;
      }
      case 'alarm': {
        const o = this.out(audio, pan, 0.14 * volume);
        for (let i = 0; i < 3; i++) {
          this.tone(audio, o, t + i * 0.28, 0.22, 'sawtooth', 330, 220);
        }
        break;
      }
      case 'win': {
        const o = this.out(audio, pan, 0.2 * volume);
        [523, 659, 784, 1046].forEach((frequency, index) => {
          this.tone(audio, o, t + index * 0.09, 0.35, 'triangle', frequency, frequency);
        });
        break;
      }
    }
  }

  // События дуэли: панорама по месту на поле, полная громкость.
  events(events: readonly SnapshotEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case 'shot':
        case 'ricochet':
        case 'impact':
        case 'death':
        case 'clash':
        case 'pickup':
          this.play(event.kind, duelPan(event.x));
          break;
        case 'hit':
          if ((event.flags & EventFlag.Zone) !== 0) {
            if (Math.random() < 0.15) {
              this.play('zoneTick', duelPan(event.x));
            }
          } else {
            this.play('hit', duelPan(event.x));
          }
          break;
        case 'zoneStart':
          this.play('alarm');
          break;
        case 'roundOver':
          this.play('win');
          break;
        default:
          break;
      }
    }
  }
}
