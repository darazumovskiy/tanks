import { DEFAULT_STATS, DT, isShotReturning, type Action, type Side, type Stats } from '@tanks/shared/engine';
import {
  botLevelOf,
  EventFlag,
  quantizeAction,
  type RoundStartMessage,
  type SnapshotEvent,
  type SnapshotMessage,
} from '@tanks/shared/protocol';
import { computeAimLine, type AimLine, type AimLineState } from './aimLine.js';
import { DiagLog } from './diag.js';
import { InputReader } from './input.js';
import { browserInviteActions, renderInvite } from './invite.js';
import { NetClient, websocketUrl } from './net.js';
import { Prediction, type InterpolatedTank, type WorldView } from './prediction.js';
import { hideRoundEnd, showRoundEnd, type RoundResult } from './roundEnd.js';
import { isInView, type Camera } from './render/camera.js';
import { Effects } from './render/effects.js';
import { Renderer, type Overlay } from './render/renderer.js';
import type { Settings } from './settings.js';
import { Sfx } from './sfx.js';
import type { Telemetry } from './telemetry.js';

export interface GameOptions {
  roomCode: string;
  nickname: string;
  stats?: Stats;
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  roundEnd: HTMLElement;
  onAutoFireChange: (isOn: boolean) => void;
  settings: Readonly<Settings>;
  isTouchDevice: boolean;
  telemetry: Telemetry;
}

const TICK_MS = DT * 1000;
const FRAME_HISTORY = 120;
const WORST_FRAME_WINDOW_MS = 1000;
// Пороги журнала: кадр длиннее — заметный рывок; камера сменила высоту окна сильнее — ступень приближения.
const SLOW_FRAME_MS = 40;
const CAMERA_HEIGHT_LOG_RATIO = 0.01;
const DIAG_SUMMARY_INTERVAL_MS = 1000;

function formatAction(action: Action): string {
  const fire = action.isFiring ? '1' : '0';
  return `${action.throttle.toFixed(2)},${action.turn.toFixed(2)},${action.turretTurn.toFixed(2)},${fire}`;
}

function formatPoint(point: { x: number; y: number }): string {
  return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
}

function formatFlag(isOn: boolean): string {
  return isOn ? '1' : '0';
}

// Анализатор журналов группирует серию по настройкам: одна строка на все флажки.
function formatFlags(settings: Readonly<Settings>): string {
  const autoaim = formatFlag(settings.hasAutoAim);
  const guard = formatFlag(settings.hasRicochetGuard);
  const quickReverse = formatFlag(settings.hasQuickReverse);
  const aimLine = formatFlag(settings.hasAimLine);
  const leadHint = formatFlag(settings.hasLeadHint);
  return `flags autoaim=${autoaim} guard=${guard} quickreverse=${quickReverse} aimline=${aimLine} leadhint=${leadHint}`;
}

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
  private countdownBeeped = 0;
  private lastInputSeq = 0;
  private accumulator = 0;
  private lastFrame = performance.now();
  private frames = 0;
  private fps = 0;
  private fpsWindowStart = performance.now();
  private readonly frameTimes: number[] = [];
  private worstFrameMs = 0;
  private worstFrameWindowStart = performance.now();
  private worstFrameCandidate = 0;
  private isClosed = false;
  private readonly diag: DiagLog;
  private lastSnapshotAt: number | null = null;
  private snapshotsThisSecond = 0;
  private inputsThisSecond = 0;
  private summaryAt = performance.now();
  private loggedCamera: { mode: string; height: number } | null = null;
  private loggedFlags: string | null = null;
  private aimLine: AimLine | null = null;

  constructor(private readonly options: GameOptions) {
    this.diag = new DiagLog(options.roomCode);
    this.diag.write(
      `device ua=${navigator.userAgent} screen=${String(innerWidth)}x${String(innerHeight)} dpr=${String(devicePixelRatio)} touch=${options.isTouchDevice ? '1' : '0'}`,
    );
    this.effects = new Effects(() => this.names());
    this.renderer = new Renderer(options.canvas, this.effects, options.settings, options.isTouchDevice);
    this.input = new InputReader(options.canvas, this.renderer, options.settings, {
      onGuard: (event): void => {
        this.diag.write(`guard ${event}`);
      },
    });
    this.bindAudioUnlock();
    this.net = new NetClient(
      websocketUrl(),
      {
        onWelcome: (message): void => {
          this.side = message.side;
          this.diag.setSide(message.side);
          this.options.telemetry.setSide(message.side);
          this.diag.write(`net welcome side=${String(message.side)} room=${message.roomCode}`);
          this.options.telemetry.event('net', 'welcome', { room: message.roomCode });
        },
        onRoomState: (message): void => {
          const slots = message.slots.map((slot) => (slot.isTaken ? slot.nickname : '-')).join('|');
          this.diag.write(`net room slots=${slots}`);
          this.options.telemetry.event('net', 'room', { slots });
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
          if (this.roundStart?.gameId !== message.gameId) {
            this.diag.setGame(message.gameId);
            this.options.telemetry.setGame(message.gameId);
          }
          this.diag.write(
            `net roundstart game=${message.gameId} idx=${String(message.roundIndex)} map=${String(message.mapIndex)} score=${String(message.score[0])}:${String(message.score[1])}`,
          );
          this.options.telemetry.event('net', 'roundstart', { idx: message.roundIndex, map: message.mapIndex });
          this.roundStart = message;
          this.roundStartedAt = performance.now();
          this.countdownBeeped = 0;
          hideRoundEnd(this.options.roundEnd);
          // Забытый авто-огонь на старте раунда расстреливает стену перед собой и ловит рикошеты.
          this.setAutoFire(false);
          this.logFlags(true);
          this.prediction = new Prediction(this.side, message.mapIndex, message.tanks, this.lastInputSeq);
          this.effects.reset();
          this.renderer.resetCamera();
          this.hideOverlay();
        },
        onSnapshot: (message, receivedAt): void => {
          if (this.prediction === null) {
            return;
          }
          this.prediction.applySnapshot(message, receivedAt);
          this.diag.markSnapshot(message.gameTick, receivedAt);
          this.logSnapshot(this.prediction, message, receivedAt);
          this.effects.onSnapshot(message.tick, message.tanks);
          for (const event of message.events) {
            this.effects.onEvent(event);
            if (event.kind === 'roundOver') {
              this.onRoundOver(event, message);
            }
          }
          this.sfx.events(message.events);
        },
        onError: (message): void => {
          this.diag.write(`net error code=${String(message.code)} text=${message.text}`);
          this.options.telemetry.event('net', `server error: ${message.text}`, { code: message.code });
          this.showOverlay(message.text, true);
        },
        onDisconnect: (retryInMs): void => {
          if (this.isClosed) {
            return;
          }
          this.diag.write(`net disconnect retry=${String(retryInMs)}`);
          this.options.telemetry.event('net', 'disconnect', { retryInMs });
          this.prediction = null;
          this.roundStart = null;
          this.lastSnapshotAt = null;
          this.showOverlay(`Связь потеряна, переподключаюсь через ${String(Math.round(retryInMs / 1000))} с…`, true);
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
    this.diag.write('close');
    this.diag.close();
    this.options.telemetry.leaveGame();
    this.net.close();
    hideRoundEnd(this.options.roundEnd);
  }

  toggleAutoFire(): boolean {
    const isOn = !this.input.isAutoFiring;
    this.setAutoFire(isOn);
    return isOn;
  }

  private setAutoFire(isOn: boolean): void {
    if (this.input.isAutoFiring === isOn) {
      return;
    }
    this.input.setAutoFire(isOn);
    this.options.onAutoFireChange(isOn);
    this.diag.write(`autofire on=${isOn ? '1' : '0'}`);
  }

  // Строка на каждом старте раунда и при любой смене флажков.
  private logFlags(isRoundStart: boolean): void {
    const line = formatFlags(this.options.settings);
    if (!isRoundStart && this.loggedFlags === line) {
      return;
    }
    this.loggedFlags = line;
    this.diag.write(line);
  }

  // Помощники не добывают информацию: автоведение, предохранитель и линия выстрела знают только о живом
  // противнике в кадре камеры и только во время боя.
  private visibleEnemy(prediction: Prediction, view: WorldView, side: Side): InterpolatedTank | null {
    const enemy = view.tanks[side === 0 ? 1 : 0];
    if (!prediction.isFighting || !enemy.isAlive) {
      return null;
    }
    if (!isInView(this.renderer.currentCamera, enemy)) {
      return null;
    }
    return enemy;
  }

  private aimLineFor(
    prediction: Prediction,
    view: WorldView,
    side: Side,
    enemy: InterpolatedTank | null,
  ): AimLine | null {
    const { settings } = this.options;
    const me = view.tanks[side];
    if (!settings.hasAimLine || !prediction.isFighting || !me.isAlive) {
      return null;
    }
    return computeAimLine({
      walls: view.round.map.walls,
      shooter: { x: me.x, y: me.y, turret: me.turret },
      bulletSpeed: prediction.me.stats.bulletSpeed,
      enemy,
      hasLeadHint: settings.hasLeadHint,
    });
  }

  private logSnapshot(prediction: Prediction, message: SnapshotMessage, receivedAt: number): void {
    const side = this.side ?? 0;
    const enemySide: Side = side === 0 ? 1 : 0;
    const gap = this.lastSnapshotAt === null ? 0 : receivedAt - this.lastSnapshotAt;
    this.lastSnapshotAt = receivedAt;
    this.snapshotsThisSecond++;
    const kinds = message.events.map((event) => event.kind).join(',');
    const parts = [
      `snap rt=${String(message.tick)} gap=${gap.toFixed(0)} ack=${String(message.ackSeq)} pend=${String(prediction.pendingCount)}`,
      `corr=${prediction.lastCorrectionPx.toFixed(1)} me=${formatPoint(prediction.me)} srv=${formatPoint(message.tanks[side])}`,
      `en=${formatPoint(message.tanks[enemySide])} b=${String(message.bullets.length)}`,
    ];
    if (kinds !== '') {
      parts.push(`ev=${kinds}`);
    }
    this.diag.write(parts.join(' '));
  }

  private logCamera(camera: Camera, isSummaryDue: boolean): void {
    const mode = this.renderer.activeCameraMode;
    const logged = this.loggedCamera;
    if (logged !== null) {
      const isModeSame = logged.mode === mode;
      const isHeightSame = Math.abs(camera.height - logged.height) <= logged.height * CAMERA_HEIGHT_LOG_RATIO;
      if (isModeSame && isHeightSame && !isSummaryDue) {
        return;
      }
    }
    this.loggedCamera = { mode, height: camera.height };
    this.diag.write(`cam mode=${mode} x=${camera.x.toFixed(0)} y=${camera.y.toFixed(0)} h=${camera.height.toFixed(0)}`);
  }

  debugState(): {
    side: Side | null;
    gameId: string;
    gameTick: number;
    roundIndex: number;
    score: [number, number];
    nicknames: [string, string];
    isFighting: boolean;
    isAutoFiring: boolean;
    isAutoAiming: boolean;
    isShotGuarded: boolean;
    aimLine: { state: AimLineState; isReturning: boolean } | null;
    rttMs: number;
    serverTick: number;
    me: unknown;
    enemy: { x: number; y: number; heading: number; isAlive: boolean };
    bullets: number;
    pending: number;
    fps: number;
    worstFrameMs: number;
    correctionPx: number;
    camera: { x: number; y: number; height: number };
  } | null {
    if (this.prediction === null || this.roundStart === null || this.side === null) {
      return null;
    }
    const view = this.prediction.view(performance.now());
    const enemy = view.tanks[this.side === 0 ? 1 : 0];
    return {
      side: this.side,
      gameId: this.roundStart.gameId,
      gameTick: this.prediction.latestGameTick,
      roundIndex: this.roundStart.roundIndex,
      score: this.roundStart.score,
      nicknames: this.names(),
      isFighting: this.prediction.isFighting,
      isAutoFiring: this.input.isAutoFiring,
      isAutoAiming: this.input.isAutoAiming,
      isShotGuarded: this.input.isShotGuarded,
      aimLine: this.aimLine === null ? null : { state: this.aimLine.state, isReturning: this.aimLine.isReturning },
      rttMs: this.net.rttMs,
      serverTick: this.net.serverTick,
      me: { ...this.prediction.me, tally: undefined, stats: undefined },
      enemy: { x: enemy.x, y: enemy.y, heading: enemy.heading, isAlive: enemy.isAlive },
      bullets: view.bullets.length,
      pending: this.prediction.pendingCount,
      fps: this.fps,
      worstFrameMs: this.worstFrameMs,
      correctionPx: this.prediction.lastCorrectionPx,
      camera: {
        x: this.renderer.currentCamera.x,
        y: this.renderer.currentCamera.y,
        height: this.renderer.currentCamera.height,
      },
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

  // Счёт в снимке ещё старый: победа этого раунда добавляется здесь, следующий RoundStart принесёт тот же счёт.
  private onRoundOver(event: SnapshotEvent, message: SnapshotMessage): void {
    if (this.side === null || this.roundStart === null) {
      return;
    }
    const score: [number, number] = [this.roundStart.score[0], this.roundStart.score[1]];
    if (message.winner !== null) {
      score[message.winner]++;
    }
    let result: RoundResult = 'draw';
    if (message.winner === this.side) {
      result = 'win';
    } else if (message.winner !== null) {
      result = 'loss';
    }
    showRoundEnd(this.options.roundEnd, {
      result,
      isByTime: (event.flags & EventFlag.ByTime) !== 0,
      score,
      mySide: this.side,
      botLevel: botLevelOf(this.options.roomCode),
    });
  }

  private frame(now: number): void {
    if (this.isClosed) {
      return;
    }
    requestAnimationFrame((next) => {
      this.frame(next);
    });
    const elapsed = Math.min(250, now - this.lastFrame);
    if (now - this.lastFrame > SLOW_FRAME_MS) {
      this.diag.write(`frame ms=${(now - this.lastFrame).toFixed(0)}`);
    }
    this.lastFrame = now;
    this.frames++;
    this.frameTimes.push(elapsed);
    if (this.frameTimes.length > FRAME_HISTORY) {
      this.frameTimes.shift();
    }
    this.worstFrameCandidate = Math.max(this.worstFrameCandidate, elapsed);
    if (now - this.worstFrameWindowStart >= WORST_FRAME_WINDOW_MS) {
      this.worstFrameMs = this.worstFrameCandidate;
      this.worstFrameCandidate = 0;
      this.worstFrameWindowStart = now;
    }
    if (now - this.fpsWindowStart >= 1000) {
      this.fps = (this.frames * 1000) / (now - this.fpsWindowStart);
      this.frames = 0;
      this.fpsWindowStart = now;
    }

    const prediction = this.prediction;
    const roundStart = this.roundStart;
    const side = this.side;
    if (prediction === null || roundStart === null || side === null) {
      return;
    }

    this.logFlags(false);
    this.accumulator += elapsed;
    const frameView = prediction.view(now);
    const enemy = this.visibleEnemy(prediction, frameView, side);
    const aimTarget = enemy === null ? null : { x: enemy.x, y: enemy.y };
    const walls = frameView.round.map.walls;
    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      const me = prediction.me;
      const isShotRisky = isShotReturning(walls, me, me.turret, me.stats.bulletSpeed, enemy);
      const action = quantizeAction(this.input.read(me, aimTarget, isShotRisky));
      const bulletsBefore = prediction.myBulletCount;
      const seq = prediction.predict(action);
      this.lastInputSeq = seq;
      this.net.sendInput(seq, action);
      this.inputsThisSecond++;
      this.diag.write(`in seq=${String(seq)} a=${formatAction(action)}`);
      if (prediction.myBulletCount > bulletsBefore) {
        this.diag.write(`shot seq=${String(seq)} at=${formatPoint(prediction.me)}`);
      }
    }

    const isSummaryDue = now - this.summaryAt >= DIAG_SUMMARY_INTERVAL_MS;
    if (isSummaryDue) {
      this.summaryAt = now;
      const fps = Math.round(this.fps);
      const worst = Math.round(this.worstFrameMs);
      const rtt = Math.round(this.net.rttMs);
      this.diag.write(
        `sec fps=${String(fps)} worst=${String(worst)} rtt=${String(rtt)} pend=${String(prediction.pendingCount)} snaps=${String(this.snapshotsThisSecond)} ins=${String(this.inputsThisSecond)}`,
      );
      this.options.telemetry.event('sec', 'sec', {
        fps,
        worst,
        rtt,
        pend: prediction.pendingCount,
        snaps: this.snapshotsThisSecond,
        ins: this.inputsThisSecond,
      });
      this.snapshotsThisSecond = 0;
      this.inputsThisSecond = 0;
    }

    const view = prediction.view(now);
    this.aimLine = this.aimLineFor(prediction, view, side, enemy);
    this.effects.update(elapsed / 1000, view.tanks);
    this.renderer.draw(
      view,
      {
        names: this.names(),
        score: roundStart.score,
        roundIndex: roundStart.roundIndex,
        gameId: roundStart.gameId,
        gameTick: prediction.latestGameTick,
        mySide: side,
        rttMs: this.net.rttMs,
        serverTick: this.net.serverTick,
        pending: prediction.pendingCount,
        correctionPx: prediction.lastCorrectionPx,
        fps: this.fps,
        worstFrameMs: this.worstFrameMs,
        isMuted: this.sfx.isMuted,
        sticks: this.input.stickStates,
        isAutoAiming: this.input.isAutoAiming,
        isShotGuarded: this.input.isShotGuarded,
        aimLine: this.aimLine,
        frameMs: elapsed,
        frameTimes: this.frameTimes,
      },
      this.overlayFor(now, prediction, roundStart),
    );
    this.logCamera(this.renderer.currentCamera, isSummaryDue);
  }

  private overlayFor(now: number, prediction: Prediction, roundStart: RoundStartMessage): Overlay {
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
    this.options.overlay.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'overlay-title';
    title.textContent = 'Ждём соперника';
    this.options.overlay.append(title);
    renderInvite(this.options.overlay, location.href, browserInviteActions);
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
