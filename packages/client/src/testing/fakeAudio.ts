// Поддельный Web Audio для тестов в happy-dom: настоящий `Sfx` строит звуки на нём, а тест видит, какие выходы
// звука созданы — громкость и панораму каждого.

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

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();

  constructor(private readonly outputs: SoundOutput[]) {
    super();
  }

  override connect<T>(target: T): T {
    if (target instanceof FakePanner) {
      this.outputs.push({ gain: this.gain.value, pan: target.pan.value });
    }
    return target;
  }
}

class FakeFilter extends FakeNode {
  type = '';
  readonly Q = new FakeParam();
  readonly frequency = new FakeParam();
}

class FakeOscillator extends FakeNode {
  type = '';
  readonly frequency = new FakeParam();
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
}

const SAMPLE_RATE = 8;

export function installFakeAudio(): { outputs: SoundOutput[]; restore: () => void } {
  const outputs: SoundOutput[] = [];
  const previous = (globalThis as { AudioContext?: unknown }).AudioContext;
  class FakeAudioContext {
    readonly sampleRate = SAMPLE_RATE;
    readonly currentTime = 0;
    readonly destination = new FakeNode();
    state = 'running';

    createGain(): FakeGain {
      return new FakeGain(outputs);
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
      return new FakeOscillator();
    }

    createBufferSource(): FakeSource {
      return new FakeSource();
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
    restore: (): void => {
      Object.assign(globalThis, { AudioContext: previous });
    },
  };
}
