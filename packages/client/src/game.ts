import { DEFAULT_STATS, DT, type Side, type Stats } from '@tanks/shared/engine';
import { EventFlag, quantizeAction, type RoundStartMessage, type SnapshotEvent } from '@tanks/shared/protocol';
import { InputReader } from './input.js';
import { NetClient, websocketUrl } from './net.js';
import { Prediction } from './prediction.js';
import { Effects } from './render/effects.js';
import { Renderer, type Overlay } from './render/renderer.js';
import { Sfx } from './sfx.js';

export interface GameOptions {
  roomCode: string;
  nickname: string;
  stats?: Stats;
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
}

const TICK_MS = DT * 1000;
const ROUND_OVER_SHOW_MS = 3000;

// Связывает сеть, предсказание, ввод, эффекты, звук и рендер; держит цикл кадров и фиксированный шаг ввода.
export class Game {
  private readonly effects: Effects;
  private readonly renderer: Renderer;
  private readonly input: InputReader;
  private readonly sfx = new Sfx();
  private readonly net: NetClient;
  private prediction: Prediction | null = null;
  private side: Side | null = null;
  private roundStart: RoundStartMessage | null = null;
  private roundStartedAt = 0;
  private roundOver: { at: number; winner: Side | null; reason: string } | null = null;
  private countdownBeeped = 0;
  private accumulator = 0;
  private lastFrame = performance.now();
  private frames = 0;
  private fps = 0;
  private fpsWindowStart = performance.now();
  private isClosed = false;

  constructor(private readonly options: GameOptions) {
    this.effects = new Effects(() => this.names());
    this.renderer = new Renderer(options.canvas, this.effects);
    this.input = new InputReader(options.canvas, this.renderer);
    this.bindAudioUnlock();
    this.net = new NetClient(
      websocketUrl(),
      {
        onWelcome: (message): void => {
          this.side = message.side;
        },
        onRoomState: (message): void => {
          if (message.slots.some((slot) => !slot.isTaken)) {
            this.prediction = null;
            this.roundStart = null;
            this.showWaiting();
          }
        },
        onRoundStart: (message): void => {
          if (this.side === null) {
            return;
          }
          this.roundStart = message;
          this.roundStartedAt = performance.now();
          this.roundOver = null;
          this.countdownBeeped = 0;
          this.prediction = new Prediction(this.side, message.mapIndex, message.tanks);
          this.effects.reset();
          this.hideOverlay();
        },
        onSnapshot: (message, receivedAt): void => {
          if (this.prediction === null) {
            return;
          }
          this.prediction.applySnapshot(message, receivedAt);
          this.effects.onSnapshot(message.tick, message.tanks);
          for (const event of message.events) {
            this.effects.onEvent(event);
            if (event.kind === 'roundOver') {
              this.onRoundOver(event, receivedAt);
            }
          }
          this.sfx.events(message.events);
        },
        onError: (message): void => {
          this.showOverlay(message.text, true);
        },
        onClose: (): void => {
          if (!this.isClosed) {
            this.showOverlay('Связь с сервером потеряна. Обнови страницу.', true);
          }
        },
      },
      { roomCode: options.roomCode, nickname: options.nickname, stats: options.stats ?? { ...DEFAULT_STATS } },
    );
    this.showOverlay('Подключаюсь…', false);
    requestAnimationFrame((now) => {
      this.frame(now);
    });
  }

  close(): void {
    this.isClosed = true;
    this.net.close();
  }

  debugState(): {
    side: Side | null;
    rttMs: number;
    serverTick: number;
    me: unknown;
    bullets: number;
    pending: number;
  } | null {
    if (this.prediction === null) {
      return null;
    }
    const view = this.prediction.view(performance.now());
    return {
      side: this.side,
      rttMs: this.net.rttMs,
      serverTick: this.net.serverTick,
      me: { ...this.prediction.me, tally: undefined, stats: undefined },
      bullets: view.bullets.length,
      pending: this.prediction.pendingCount,
    };
  }

  private names(): [string, string] {
    if (this.roundStart === null) {
      return ['', ''];
    }
    return [this.roundStart.tanks[0].nickname, this.roundStart.tanks[1].nickname];
  }

  private bindAudioUnlock(): void {
    const unlock = (): void => {
      this.sfx.unlock();
    };
    window.addEventListener('keydown', unlock);
    window.addEventListener('mousedown', unlock);
    window.addEventListener('touchstart', unlock);
    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyM' && !event.repeat) {
        this.sfx.toggle();
      }
    });
  }

  private onRoundOver(event: SnapshotEvent, at: number): void {
    const isByTime = (event.flags & EventFlag.ByTime) !== 0;
    let reason: string;
    if (event.side === null) {
      reason = isByTime ? 'равная броня по истечении времени' : 'оба танка уничтожены';
    } else {
      reason = isByTime ? 'по оставшейся броне' : 'уничтожение';
    }
    this.roundOver = { at, winner: event.side, reason };
  }

  private frame(now: number): void {
    if (this.isClosed) {
      return;
    }
    requestAnimationFrame((next) => {
      this.frame(next);
    });
    const elapsed = Math.min(250, now - this.lastFrame);
    this.lastFrame = now;
    this.frames++;
    if (now - this.fpsWindowStart >= 1000) {
      this.fps = (this.frames * 1000) / (now - this.fpsWindowStart);
      this.frames = 0;
      this.fpsWindowStart = now;
    }

    const prediction = this.prediction;
    const roundStart = this.roundStart;
    if (prediction === null || roundStart === null) {
      return;
    }

    this.accumulator += elapsed;
    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      const action = quantizeAction(this.input.read(prediction.me));
      const seq = prediction.predict(action);
      this.net.sendInput(seq, action);
    }

    const view = prediction.view(now);
    this.effects.update(elapsed / 1000, view.tanks);
    this.renderer.draw(
      view,
      {
        names: this.names(),
        score: roundStart.score,
        roundIndex: roundStart.roundIndex,
        rttMs: this.net.rttMs,
        serverTick: this.net.serverTick,
        pending: prediction.pendingCount,
        correctionPx: prediction.lastCorrectionPx,
        fps: this.fps,
        isMuted: this.sfx.isMuted,
      },
      this.overlayFor(now, prediction, roundStart),
    );
  }

  private overlayFor(now: number, prediction: Prediction, roundStart: RoundStartMessage): Overlay {
    if (this.roundOver !== null && now - this.roundOver.at < ROUND_OVER_SHOW_MS) {
      return {
        kind: 'roundEnd',
        winner: this.roundOver.winner,
        reason: this.roundOver.reason,
        elapsedS: (now - this.roundOver.at) / 1000,
      };
    }
    const totalS = (roundStart.countdownTicks * TICK_MS) / 1000;
    const elapsedS = (now - this.roundStartedAt) / 1000;
    if (!prediction.isFighting && elapsedS < totalS + 0.6) {
      const secondsLeft = Math.ceil(totalS - elapsedS);
      if (secondsLeft >= 1 && secondsLeft !== this.countdownBeeped) {
        this.countdownBeeped = secondsLeft;
        this.sfx.play('beep');
      } else if (secondsLeft < 1 && this.countdownBeeped !== -1) {
        this.countdownBeeped = -1;
        this.sfx.play('go');
      }
      return { kind: 'countdown', elapsedS, totalS };
    }
    return null;
  }

  private showWaiting(): void {
    const link = location.href;
    this.options.overlay.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'overlay-title';
    title.textContent = 'Ждём соперника';
    const hint = document.createElement('div');
    hint.className = 'overlay-hint';
    hint.textContent = 'Отправь ссылку второму игроку:';
    const linkBox = document.createElement('input');
    linkBox.className = 'overlay-link';
    linkBox.readOnly = true;
    linkBox.value = link;
    linkBox.addEventListener('click', () => {
      linkBox.select();
      void navigator.clipboard.writeText(link);
    });
    this.options.overlay.append(title, hint, linkBox);
    this.options.overlay.hidden = false;
  }

  private showOverlay(text: string, isError: boolean): void {
    const { overlay } = this.options;
    if (overlay.textContent === text && !overlay.hidden) {
      return;
    }
    overlay.innerHTML = '';
    const title = document.createElement('div');
    title.className = isError ? 'overlay-title overlay-error' : 'overlay-title';
    title.textContent = text;
    overlay.append(title);
    overlay.hidden = false;
  }

  private hideOverlay(): void {
    this.options.overlay.hidden = true;
  }
}
