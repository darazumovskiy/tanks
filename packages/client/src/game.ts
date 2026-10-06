import {
  DEFAULT_STATS,
  DT,
  isShotReturning,
  type Action,
  type Field,
  type RoundRules,
  type Side,
  type Stats,
} from '@tanks/shared/engine';
import {
  botLevelOf,
  EventFlag,
  quantizeAction,
  type RoundStartMessage,
  type SnapshotEvent,
  type SnapshotMessage,
} from '@tanks/shared/protocol';
import type { AimLine, AimLineState } from './aimLine.js';
import type { AimLineStyleId } from './render/aimLineStyles.js';
import { DiagLog } from './diag.js';
import { DuelPresenter, duelNames } from './duelPresenter.js';
import { InputReader, type ShotContext, type Viewport } from './input.js';
import { browserInviteActions, renderInvite } from './invite.js';
import { NetClient, websocketUrl, type SocketLike } from './net.js';
import { pictureDebug, type PictureDebug } from './pictureTime.js';
import { Prediction, type InterpolatedTank, type PictureView } from './prediction.js';
import { hideRoundEnd, showRoundEnd, type RoundResult } from './roundEnd.js';
import type { Camera } from './render/camera.js';
import type { Effects } from './render/effects.js';
import { createDuelEffects, Renderer, type Overlay } from './render/renderer.js';
import type { Settings } from './settings.js';
import { Sfx } from './sfx.js';
import { SpareInput } from './spareInput.js';
import type { Telemetry } from './telemetry.js';
import { isShotInZone } from './zoneFire.js';

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

// Зависимости игры от браузера: тесты подставляют сокет, рендер, звук, журнал, часы и кадры.
export type DuelRendererLike = Viewport & Pick<Renderer, 'currentCamera' | 'activeCameraMode' | 'resetCamera' | 'draw'>;

export interface GameDeps {
  url: string;
  createSocket: (url: string) => SocketLike;
  createEffects: (names: () => readonly [string, string]) => Effects;
  createRenderer: (canvas: HTMLCanvasElement, effects: Effects) => DuelRendererLike;
  createSfx: () => Sfx;
  createDiag: (roomCode: string) => DiagLog;
  now: () => number;
  requestFrame: (callback: (now: number) => void) => void;
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
  const guard = formatFlag(settings.hasRicochetGuard);
  const aimLine = formatFlag(settings.hasAimLine);
  const leadHint = formatFlag(settings.hasLeadHint);
  const zoneFire = formatFlag(settings.hasZoneFire);
  return `flags guard=${guard} aimline=${aimLine} leadhint=${leadHint} zonefire=${zoneFire} aimstyle=${settings.aimLineStyle}`;
}

// Связывает сеть, предсказание, ввод, эффекты, звук и рендер; держит цикл кадров и фиксированный шаг ввода.
export class Game {
  private readonly deps: GameDeps;
  private readonly renderer: DuelRendererLike;
  private readonly effects: Effects;
  private readonly duel: DuelPresenter;
  private readonly spareInput = new SpareInput();
  private lastView: PictureView | null = null;
  private readonly input: InputReader;
  private readonly sfx: Sfx;
  private readonly net: NetClient;
  private prediction: Prediction | null = null;
  private side: Side | null = null;
  private roundStart: RoundStartMessage | null = null;
  private roundStartedAt = 0;
  private countdownBeeped = 0;
  private lastInputSeq = 0;
  private accumulator = 0;
  private lastFrame: number;
  private frames = 0;
  private fps = 0;
  private fpsWindowStart: number;
  private readonly frameTimes: number[] = [];
  private worstFrameMs = 0;
  private worstFrameWindowStart: number;
  private worstFrameCandidate = 0;
  private isClosed = false;
  private readonly diag: DiagLog;
  private lastSnapshotAt: number | null = null;
  private snapshotsThisSecond = 0;
  private inputsThisSecond = 0;
  private summaryAt: number;
  private loggedCamera: { mode: string; height: number } | null = null;
  private loggedFlags: string | null = null;
  private aimLine: AimLine | null = null;

  constructor(
    private readonly options: GameOptions,
    deps: Partial<GameDeps> = {},
  ) {
    this.deps = {
      url: deps.url ?? websocketUrl(),
      createSocket: deps.createSocket ?? ((url): SocketLike => new WebSocket(url)),
      createEffects: deps.createEffects ?? createDuelEffects,
      createRenderer:
        deps.createRenderer ??
        ((canvas, effects): DuelRendererLike => new Renderer(canvas, effects, options.settings, options.isTouchDevice)),
      createSfx: deps.createSfx ?? ((): Sfx => new Sfx()),
      createDiag: deps.createDiag ?? ((roomCode): DiagLog => new DiagLog(roomCode)),
      now: deps.now ?? ((): number => performance.now()),
      requestFrame:
        deps.requestFrame ??
        ((callback): void => {
          requestAnimationFrame(callback);
        }),
    };
    const startedAt = this.deps.now();
    this.lastFrame = startedAt;
    this.fpsWindowStart = startedAt;
    this.worstFrameWindowStart = startedAt;
    this.summaryAt = startedAt;
    this.sfx = this.deps.createSfx();
    this.diag = this.deps.createDiag(options.roomCode);
    this.diag.write(
      `device ua=${navigator.userAgent} screen=${String(innerWidth)}x${String(innerHeight)} dpr=${String(devicePixelRatio)} touch=${options.isTouchDevice ? '1' : '0'}`,
    );
    const effects = this.deps.createEffects(() => this.names());
    this.effects = effects;
    this.renderer = this.deps.createRenderer(options.canvas, effects);
    this.duel = new DuelPresenter(this.renderer, effects, options.settings);
    this.input = new InputReader(options.canvas, this.renderer, options.settings, {
      now: this.deps.now,
      onGuard: (event): void => {
        this.diag.write(`guard ${event}`);
      },
    });
    this.bindPage();
    this.net = new NetClient(
      this.deps.url,
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
            this.lastView = null;
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
          this.roundStartedAt = this.deps.now();
          this.countdownBeeped = 0;
          hideRoundEnd(this.options.roundEnd);
          // Забытый авто-огонь на старте раунда расстреливает стену перед собой и ловит рикошеты.
          this.setAutoFire(false);
          this.logFlags(true);
          this.lastView = null;
          this.prediction = new Prediction(
            this.side,
            message.mapIndex,
            message.tanks,
            this.lastInputSeq,
            message.rules,
          );
          this.duel.startRound();
          this.hideOverlay();
        },
        onSnapshot: (message, receivedAt): void => {
          if (this.prediction === null) {
            return;
          }
          this.prediction.applySnapshot(message, receivedAt);
          for (const { predictedId, serverId } of this.prediction.takeConfirmedBullets()) {
            this.effects.renameTrail(predictedId, serverId);
          }
          this.spareInput.noteSnapshot(message.ackSeq, message.hasSpareInput);
          this.diag.markSnapshot(message.gameTick, receivedAt);
          this.logSnapshot(this.prediction, message, receivedAt);
          this.duel.applySnapshot(message.tick, message.tanks, message.events, receivedAt, this.side);
          for (const event of message.events) {
            if (event.kind === 'roundOver') {
              this.onRoundOver(event, message);
            }
          }
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
          this.lastView = null;
          this.roundStart = null;
          this.lastSnapshotAt = null;
          this.showOverlay(`Связь потеряна, переподключаюсь через ${String(Math.round(retryInMs / 1000))} с…`, true);
        },
      },
      {
        roomCode: options.roomCode,
        nickname: options.nickname,
        stats: options.stats ?? { ...DEFAULT_STATS },
        token: '',
        gameId: '',
      },
      { createSocket: this.deps.createSocket, now: this.deps.now },
    );
    this.showOverlay('Подключаюсь…', false);
    this.deps.requestFrame((now) => {
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

  // Строка флажков и полный снимок настроек — на каждом старте раунда и при любой смене настроек.
  private logFlags(isRoundStart: boolean): void {
    const settingsLine = `settings ${JSON.stringify(this.options.settings)}`;
    if (!isRoundStart && this.loggedFlags === settingsLine) {
      return;
    }
    this.loggedFlags = settingsLine;
    this.diag.write(formatFlags(this.options.settings));
    this.diag.write(settingsLine);
  }

  // Зона считается только при включённом флаге: без него трассировка пути на каждом тике не нужна.
  private shotContextFor(prediction: Prediction, field: Field, enemy: InterpolatedTank | null): ShotContext {
    const me = prediction.me;
    const bulletSpeed = me.stats.bulletSpeed;
    const isInZone =
      this.options.settings.hasZoneFire &&
      isShotInZone({
        field,
        shooter: { x: me.x, y: me.y, turret: me.turret },
        bulletSpeed,
        targets: enemy === null ? [] : [enemy],
      });
    return { isReturning: isShotReturning(field, me, me.turret, bulletSpeed, enemy), isInZone };
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
    rules: RoundRules;
    nicknames: [string, string];
    isFighting: boolean;
    isAutoFiring: boolean;
    isShotGuarded: boolean;
    isZoneFiring: boolean;
    isReversing: boolean;
    aimLine: { state: AimLineState; isReturning: boolean } | null;
    aimLineStyle: AimLineStyleId;
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
    picture: PictureDebug | null;
  } | null {
    if (this.prediction === null || this.roundStart === null || this.side === null) {
      return null;
    }
    const view = this.prediction.view(this.deps.now());
    const enemy = view.tanks[this.side === 0 ? 1 : 0];
    return {
      side: this.side,
      gameId: this.roundStart.gameId,
      gameTick: this.prediction.latestGameTick,
      roundIndex: this.roundStart.roundIndex,
      score: this.roundStart.score,
      rules: this.roundStart.rules,
      nicknames: this.names(),
      isFighting: this.prediction.isFighting,
      isAutoFiring: this.input.isAutoFiring,
      isShotGuarded: this.input.isShotGuarded,
      isZoneFiring: this.input.isZoneFiring,
      isReversing: this.input.isReversing,
      aimLine: this.aimLine === null ? null : { state: this.aimLine.state, isReturning: this.aimLine.isReturning },
      aimLineStyle: this.options.settings.aimLineStyle,
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
      picture:
        this.lastView === null
          ? null
          : pictureDebug(this.lastView.clock, this.prediction.latestTick, this.lastView.bullets),
    };
  }

  private names(): [string, string] {
    if (this.roundStart === null) {
      return ['', ''];
    }
    return duelNames(this.roundStart);
  }

  // Вкладка вернулась из фона: события, накопленные, пока цикл кадров стоял, не играются.
  private bindPage(): void {
    document.addEventListener('visibilitychange', () => {
      this.duel.clearEvents();
    });
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
    this.deps.requestFrame((next) => {
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
    const enemy = this.duel.visibleEnemy(frameView, side, prediction.isFighting);
    const field = frameView.round.map;
    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      if (this.spareInput.shouldSkip(prediction.lastSeq + 1)) {
        this.diag.write(`in skip next=${String(prediction.lastSeq + 1)}`);
        continue;
      }
      const action = quantizeAction(this.input.read(prediction.me, this.shotContextFor(prediction, field, enemy)));
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
    this.lastView = view;
    this.sfx.events(this.duel.releaseEvents(view, now));
    this.duel.update(elapsed / 1000, view);
    const drawn = this.duel.draw({
      view,
      roundStart,
      sinceRoundStartS: (now - this.roundStartedAt) / 1000,
      gameTick: prediction.latestGameTick,
      mySide: side,
      isFighting: prediction.isFighting,
      visibleEnemy: enemy,
      frameMs: elapsed,
      readout: {
        rttMs: this.net.rttMs,
        correctionPx: prediction.lastCorrectionPx,
        fps: this.fps,
        worstFrameMs: this.worstFrameMs,
        isMuted: this.sfx.isMuted,
        frameTimes: this.frameTimes,
      },
      controls: {
        sticks: this.input.stickStates,
        isShotGuarded: this.input.isShotGuarded,
        isZoneFiring: this.input.isZoneFiring,
        isReversing: this.input.isReversing,
      },
    });
    this.aimLine = drawn.aimLine;
    this.beepCountdown(drawn.overlay);
    this.logCamera(this.renderer.currentCamera, isSummaryDue);
  }

  private beepCountdown(overlay: Overlay): void {
    if (overlay === null) {
      return;
    }
    const secondsLeft = Math.ceil(overlay.totalS - overlay.elapsedS);
    if (secondsLeft >= 1 && secondsLeft !== this.countdownBeeped) {
      this.countdownBeeped = secondsLeft;
      this.sfx.play('beep');
    } else if (secondsLeft < 1 && this.countdownBeeped !== -1) {
      this.countdownBeeped = -1;
      this.sfx.play('go');
    }
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
