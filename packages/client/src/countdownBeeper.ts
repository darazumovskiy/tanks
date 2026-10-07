import type { Overlay } from './render/renderer.js';
import type { Sfx } from './sfx.js';

const NONE_PLAYED = 0;
const GO_PLAYED = -1;

// Писк отсчёта: по одному на каждую цифру и «БОЙ!» один раз, сколько бы кадров ни показали одно и то же.
export class CountdownBeeper {
  private lastPlayedSecond = NONE_PLAYED;

  constructor(private readonly sfx: Pick<Sfx, 'play'>) {}

  reset(): void {
    this.lastPlayedSecond = NONE_PLAYED;
  }

  update(overlay: Overlay): void {
    if (overlay === null) {
      return;
    }
    const secondsLeft = Math.ceil(overlay.totalS - overlay.elapsedS);
    if (secondsLeft >= 1 && secondsLeft !== this.lastPlayedSecond) {
      this.lastPlayedSecond = secondsLeft;
      this.sfx.play('beep');
      return;
    }
    if (secondsLeft < 1 && this.lastPlayedSecond !== GO_PLAYED) {
      this.lastPlayedSecond = GO_PLAYED;
      this.sfx.play('go');
    }
  }
}
