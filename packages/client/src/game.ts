import { DEFAULT_STATS, DT, type Stats } from '@tanks/shared/engine';
import { quantizeAction, type RoundStartMessage } from '@tanks/shared/protocol';
import { InputReader } from './input.js';
import { NetClient, websocketUrl } from './net.js';
import { Prediction } from './prediction.js';
import { Renderer, SIDE_COLORS } from './render.js';

export interface GameOptions {
  roomCode: string;
  nickname: string;
  stats?: Stats;
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
}

const TICK_MS = DT * 1000;
const ROUND_OVER_SHOW_MS = 3000;

// Связывает сеть, предсказание, ввод и рендер; держит цикл кадров и фиксированный шаг ввода.
export class Game {
  private readonly renderer: Renderer;
  private readonly input: InputReader;
  private readonly net: NetClient;
  private prediction: Prediction | null = null;
  private side: 0 | 1 | null = null;
  private roundStart: RoundStartMessage | null = null;
  private roundStartedAt = 0;
  private roundOverAt: number | null = null;
  private accumulator = 0;
  private lastFrame = performance.now();
  private frames = 0;
  private fps = 0;
  private fpsWindowStart = performance.now();
  private isClosed = false;

  constructor(private readonly options: GameOptions) {
    this.renderer = new Renderer(options.canvas);
    this.input = new InputReader(options.canvas, this.renderer);
    this.net = new NetClient(
      websocketUrl(),
      {
        onWelcome: (message): void => {
          this.side = message.side;
        },
        onRoomState: (message): void => {
          const isWaiting = message.slots.some((slot) => !slot.isTaken);
          if (isWaiting) {
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
          this.roundOverAt = null;
          this.prediction = new Prediction(this.side, message.mapIndex, message.tanks);
          this.hideOverlay();
        },
        onSnapshot: (message, receivedAt): void => {
          if (this.prediction === null) {
            return;
          }
          const hasBeenOver = this.prediction.view(receivedAt).round.isOver;
          this.prediction.applySnapshot(message, receivedAt);
          if (message.isOver && !hasBeenOver) {
            this.roundOverAt = receivedAt;
          }
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
    side: 0 | 1 | null;
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
    if (prediction === null || this.roundStart === null) {
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
    this.renderer.draw(view, {
      names: [this.roundStart.tanks[0].nickname, this.roundStart.tanks[1].nickname],
      score: this.roundStart.score,
      rttMs: this.net.rttMs,
      serverTick: this.net.serverTick,
      pending: prediction.pendingCount,
      correctionPx: prediction.lastCorrectionPx,
      fps: this.fps,
    });
    this.updateRoundOverlay(now, view.round.isOver, view.round.winner);
  }

  private updateRoundOverlay(now: number, isOver: boolean, winner: 0 | 1 | null): void {
    if (this.roundStart === null) {
      return;
    }
    if (isOver && this.roundOverAt !== null && now - this.roundOverAt < ROUND_OVER_SHOW_MS) {
      const text = winner === null ? 'Ничья' : `Победил ${this.roundStart.tanks[winner].nickname}`;
      this.showOverlay(text, false, winner === null ? undefined : SIDE_COLORS[winner]);
      return;
    }
    const countdownMs = this.roundStart.countdownTicks * TICK_MS;
    const sinceStart = now - this.roundStartedAt;
    if (this.prediction !== null && !this.prediction.isFighting && sinceStart < countdownMs + 500) {
      const left = Math.max(0, Math.ceil((countdownMs - sinceStart) / 1000));
      this.showOverlay(left > 0 ? String(left) : 'БОЙ!', false);
      return;
    }
    this.hideOverlay();
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

  private showOverlay(text: string, isError: boolean, color?: string): void {
    const { overlay } = this.options;
    if (overlay.textContent === text && !overlay.hidden) {
      return;
    }
    overlay.innerHTML = '';
    const title = document.createElement('div');
    title.className = isError ? 'overlay-title overlay-error' : 'overlay-title';
    title.textContent = text;
    if (color !== undefined) {
      title.style.color = color;
    }
    overlay.append(title);
    overlay.hidden = false;
  }

  private hideOverlay(): void {
    this.options.overlay.hidden = true;
  }
}
