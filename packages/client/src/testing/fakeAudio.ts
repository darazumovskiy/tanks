// Поддельный Web Audio для тестов в happy-dom: настоящий `Sfx` строит звуки на нём, а тест видит, какие выходы
// звука созданы — громкость и панораму каждого — и какие из них заглушены раньше конца.

export interface SoundOutput {
  gain: number;
  pan: number;
}

class FakeParam {
  value = 0;

  setValueAtTime(): this {
    return this;
  }

  exponentialRampToValueAtTime(): this {
    return this;
  }
}

class FakeNode {
  connect<T>(target: T): T {
    return target;
  }

  start(): void {
    return undefined;
  }

  stop(): void {
    return undefined;
  }
}

class FakePanner extends FakeNode {
  readonly pan = new FakeParam();
}

// Громкость выхода звука: увод к нулю — звук заглушён раньше конца.
class FakeGainParam extends FakeParam {
  constructor(private readonly onRelease: () => void) {
    super();
  }

  setTargetAtTime(target: number): this {
    this.value = target;
    this.onRelease();
    return this;
  }
}

class FakeGain extends FakeNode {
  private output: SoundOutput | null = null;
  readonly gain = new FakeGainParam(() => {
    if (this.output !== null) {
      this.released.push(this.output);
    }
  });

  constructor(
    private readonly outputs: SoundOutput[],
    private readonly released: SoundOutput[],
  ) {
    super();
  }

  override connect<T>(target: T): T {
    if (target instanceof FakePanner) {
      this.output = { gain: this.gain.value, pan: target.pan.value };
      this.outputs.push(this.output);
    }
    return target;
  }
}

class FakeFilter extends FakeNode {
  type = '';
  readonly Q = new FakeParam();
  readonly frequency = new FakeParam();
}

// Источник звука: когда его остановят — по этому тест сверяет длительность звука.
class FakeScheduledNode extends FakeNode {
  constructor(private readonly stops: number[]) {
    super();
  }

  override stop(when = 0): void {
    this.stops.push(when);
  }
}

class FakeOscillator extends FakeScheduledNode {
  type = '';
  readonly frequency = new FakeParam();
}

class FakeSource extends FakeScheduledNode {
  buffer: unknown = null;
}

const SAMPLE_RATE = 8;

export interface FakeAudio {
  outputs: SoundOutput[];
  released: SoundOutput[];
  // Моменты остановки источников, секунды от начала звука.
  stops: number[];
  restore: () => void;
}

export function installFakeAudio(): FakeAudio {
  const outputs: SoundOutput[] = [];
  const released: SoundOutput[] = [];
  const stops: number[] = [];
  const previous = (globalThis as { AudioContext?: unknown }).AudioContext;
  class FakeAudioContext {
    readonly sampleRate = SAMPLE_RATE;
    readonly currentTime = 0;
    readonly destination = new FakeNode();
    state = 'running';

    createGain(): FakeGain {
      return new FakeGain(outputs, released);
    }

    createStereoPanner(): FakePanner {
      return new FakePanner();
    }

    createDynamicsCompressor(): FakeNode {
      return new FakeNode();
    }

    createBiquadFilter(): FakeFilter {
      return new FakeFilter();
    }

    createOscillator(): FakeOscillator {
      return new FakeOscillator(stops);
    }

    createBufferSource(): FakeSource {
      return new FakeSource(stops);
    }

    createBuffer(_channels: number, length: number): { getChannelData: () => Float32Array } {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    }

    resume(): Promise<void> {
      return Promise.resolve();
    }
  }
  Object.assign(globalThis, { AudioContext: FakeAudioContext });
  return {
    outputs,
    released,
    stops,
    restore: (): void => {
      Object.assign(globalThis, { AudioContext: previous });
    },
  };
}
