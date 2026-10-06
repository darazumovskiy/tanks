import {
  DT,
  ffaMap,
  IDLE_ACTION,
  isTraceReturning,
  traceShot,
  type Action,
  type FfaMap,
  type FfaSize,
  type Point,
  type Stats,
  type Tank,
} from '@tanks/shared/engine';
import {
  ErrorCode,
  FfaPhase,
  ffaRoomCode,
  quantizeAction,
  type ErrorMessage,
  type FfaMatchStartMessage,
  type FfaSnapshotEvent,
  type FfaSnapshotMessage,
  type FfaWelcomeMessage,
} from '@tanks/shared/protocol';
import { aimLineOnPath, firstTargetOnPath, type AimLine } from '../aimLine.js';
import { AudioMix, mixedSound } from '../audioMix.js';
import { DiagLog } from '../diag.js';
import { InputReader, type ShotContext } from '../input.js';
import { NetClient, websocketUrl, type DisconnectReason, type SocketLike } from '../net.js';
import { EventSchedule, eventPlace, pictureDebug } from '../pictureTime.js';
import { isInView, screenToWorld, type Camera } from '../render/camera.js';
import { Effects } from '../render/effects.js';
import {
  FFA_OTHER_COLOR,
  FFA_OWN_COLOR,
  FfaRenderer,
  type FfaDrawInput,
  type FfaScreen,
} from '../render/ffaRenderer.js';
import { StampDecals } from '../render/stampDecals.js';
import type { Settings } from '../settings.js';
import { Sfx, SOUND_DURATIONS } from '../sfx.js';
import { SpareInput } from '../spareInput.js';
import type { Telemetry } from '../telemetry.js';
import { isPathInZone } from '../zoneFire.js';
import { edgeArrows, visibleEnemies, type EdgeArrow } from './arrows.js';
import { FfaCamera, type FfaAim, type FfaFraming } from './ffaCamera.js';
import { FfaPrediction, type FfaFrameView, type FfaViewTank } from './ffaPrediction.js';
import { FfaFxPolicy } from './fxPolicy.js';
import { ffaInvitePath } from '../ffaRoute.js';
import { FfaHud } from './hud/hud.js';
import { feedText, FfaSession, type FfaScreen as SessionScreen } from './session.js';

export interface FfaGameOptions {
  size: FfaSize;
  // Номер игры из приглашения друга, пусто — любая игра этого размера.
  inviteGameId: string;
  nickname: string;
  stats: Stats;
  // Ввод боя слушает только холст: интерфейс поверх с pointer-events: none пропускает нажатия к нему.
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  settings: Readonly<Settings>;
  isTouchDevice: boolean;
  telemetry: Telemetry;
  onAutoFireChange: (isOn: boolean) => void;
  // Кнопки управления боем нужны, только пока свой танк на поле.
  onFieldControlsChange: (isVisible: boolean) => void;
}

export interface FfaRendererLike {
  readonly screen: FfaScreen;
  readonly floorChunks: number;
  readonly floorMemoryMb: number;
  draw(input: FfaDrawInput): void;
}

// Пропуск общей игры по размеру: переживает перезагрузку страницы в окне возврата.
export interface TokenStore {
  read(size: FfaSize): string;
  write(size: FfaSize, token: string): void;
  erase(size: FfaSize): void;
}

type ColorOf = (id: number) => string;
type NameOf = (id: number) => string;

export interface FfaGameDeps {
  url: string;
  createSocket: (url: string) => SocketLike;
  createRenderer: (canvas: HTMLCanvasElement, effects: Effects, map: FfaMap) => FfaRendererLike;
  createEffects: (colorOf: ColorOf, nameOf: NameOf) => Effects;
  createSfx: () => Sfx;
  createDiag: (roomCode: string) => DiagLog;
  now: () => number;
  requestFrame: (callback: (now: number) => void) => void;
  tokens: TokenStore;
  goHome: () => void;
  reload: () => void;
  // Адрес страницы без пути: из него собирается ссылка «Позвать друга».
  pageOrigin: string;
  copyText: (text: string) => Promise<void>;
}

const TOKEN_KEY_PREFIX = 'tanks.ffaToken.';
const TICK_MS = DT * 1000;
const MAX_FRAME_MS = 250;
const FRAME_HISTORY = 120;
const SECOND_MS = 1000;
const VIEW_MARGIN = 100;
const EMPTY_VIEW: FfaFrameView = {
  tanks: [],
  bullets: [],
  kits: [],
  zoneRadius: 0,
  clock: { myTick: 0, othersTick: 0, me: null, others: [] },
};

// Помощники кадра: линия выстрела с номером танка «на нём» и стрелки на врагов за кадром.
interface FieldHelpers {
  aimLine: AimLine | null;
  aimTargetId: number | null;
  arrows: EdgeArrow[];
}

const NO_HELPERS: FieldHelpers = { aimLine: null, aimTargetId: null, arrows: [] };

function sessionTokens(storage: Storage): TokenStore {
  return {
    read: (size) => storage.getItem(`${TOKEN_KEY_PREFIX}${String(size)}`) ?? '',
    write: (size, token) => {
      storage.setItem(`${TOKEN_KEY_PREFIX}${String(size)}`, token);
    },
    erase: (size) => {
      storage.removeItem(`${TOKEN_KEY_PREFIX}${String(size)}`);
    },
  };
}

// Бой толпы: связывает сеть, сессию, предсказание, ввод, камеру, рендер, интерфейс матча, эффекты и звук; держит
// цикл кадров и фиксированный шаг ввода.
export class FfaGame {
  private readonly deps: FfaGameDeps;
  private readonly map: FfaMap;
  private readonly roomCode: string;
  private readonly renderer: FfaRendererLike;
  private readonly effects: Effects;
  private readonly sfx: Sfx;
  private readonly input: InputReader;
  private readonly camera = new FfaCamera();
  private readonly fxPolicy = new FfaFxPolicy();
  private readonly audioMix = new AudioMix(SOUND_DURATIONS);
  private readonly events = new EventSchedule<FfaSnapshotEvent>();
  private readonly spareInput = new SpareInput();
  private readonly diag: DiagLog;
  private readonly hud: FfaHud;
  private session: FfaSession;
  private net: NetClient;
  private prediction: FfaPrediction | null = null;
  private framing: FfaFraming | null = null;
  private frameView: FfaFrameView = EMPTY_VIEW;
  private helpers: FieldHelpers = NO_HELPERS;
  private seq = 0;
  private accumulator = 0;
  private lastFrame: number;
  private frames = 0;
  private fps = 0;
  private fpsWindowStart: number;
  private readonly frameTimes: number[] = [];
  private worstFrameMs = 0;
  private worstFrameCandidate = 0;
  private summaryAt: number;
  private snapshotsThisSecond = 0;
  private inputsThisSecond = 0;
  private isHidden = false;
  private isClosed = false;
  private hasFieldControls: boolean | null = null;

  constructor(
    private readonly options: FfaGameOptions,
    deps: Partial<FfaGameDeps> = {},
  ) {
    this.deps = {
      url: deps.url ?? websocketUrl(),
      createSocket: deps.createSocket ?? ((url): SocketLike => new WebSocket(url)),
      createRenderer:
        deps.createRenderer ??
        ((canvas, effects, map): FfaRendererLike => new FfaRenderer(canvas, effects, options.settings, map)),
      createEffects:
        deps.createEffects ?? ((colorOf, nameOf): Effects => new Effects(new StampDecals(), colorOf, nameOf)),
      createSfx: deps.createSfx ?? ((): Sfx => new Sfx()),
      createDiag: deps.createDiag ?? ((roomCode): DiagLog => new DiagLog(roomCode)),
      now: deps.now ?? ((): number => performance.now()),
      requestFrame:
        deps.requestFrame ??
        ((callback): void => {
          requestAnimationFrame(callback);
        }),
      tokens: deps.tokens ?? sessionTokens(sessionStorage),
      goHome:
        deps.goHome ??
        ((): void => {
          location.assign('/');
        }),
      reload:
        deps.reload ??
        ((): void => {
          location.reload();
        }),
      pageOrigin: deps.pageOrigin ?? location.origin,
      copyText: deps.copyText ?? ((text): Promise<void> => navigator.clipboard.writeText(text)),
    };
    this.map = ffaMap(options.size);
    this.roomCode = ffaRoomCode(options.size);
    this.session = new FfaSession(options.size);
    const now = this.deps.now();
    this.lastFrame = now;
    this.fpsWindowStart = now;
    this.summaryAt = now;
    this.diag = this.deps.createDiag(this.roomCode);
    this.diag.write(
      `device ua=${navigator.userAgent} screen=${String(innerWidth)}x${String(innerHeight)} dpr=${String(devicePixelRatio)} touch=${options.isTouchDevice ? '1' : '0'} mode=ffa size=${String(options.size)}`,
    );
    this.effects = this.deps.createEffects(
      (id) => (id === this.session.playerId ? FFA_OWN_COLOR : FFA_OTHER_COLOR),
      (id) => this.session.nameOf(id),
    );
    this.renderer = this.deps.createRenderer(options.canvas, this.effects, this.map);
    this.sfx = this.deps.createSfx();
    this.input = new InputReader(
      options.canvas,
      { toWorld: (clientX, clientY) => this.toWorld(clientX, clientY) },
      options.settings,
      {
        now: this.deps.now,
        isMouseScreenAnchored: true,
        onGuard: (event): void => {
          this.diag.write(`guard ${event}`);
        },
      },
    );
    this.hud = new FfaHud(
      options.hud,
      {
        invite: () => this.deps.copyText(`${this.deps.pageOrigin}${this.invitePath()}`),
        leave: () => {
          this.leave();
        },
        rejoin: (isWithToken) => {
          this.restart(isWithToken);
        },
        reload: () => {
          this.deps.reload();
        },
      },
      options.isTouchDevice,
    );
    this.bindPage();
    this.net = this.connect();
    this.deps.requestFrame((next) => {
      this.frame(next);
    });
  }

  close(): void {
    this.isClosed = true;
    this.diag.write('close');
    this.diag.close();
    this.options.telemetry.leaveGame();
    this.net.close();
  }

  toggleAutoFire(): boolean {
    const isOn = !this.input.isAutoFiring;
    this.setAutoFire(isOn);
    return isOn;
  }

  debugState(): Record<string, unknown> {
    const session = this.session;
    const prediction = this.prediction;
    const me = prediction?.me ?? null;
    const camera = this.framing?.camera ?? null;
    const view = this.frameView;
    const score = session.score();
    const mouseWorld = this.input.mouseWorld;
    return {
      mode: 'ffa',
      screen: session.screen(),
      playerId: session.playerId,
      gameId: session.gameId,
      size: this.options.size,
      phase: session.phase,
      matchIndex: session.stateMatchIndex,
      players: session.players,
      capacity: session.capacity,
      minimum: session.minimum,
      tick: session.tick,
      timeLeftS: session.timeLeftS,
      isFinal: session.isFinal,
      self: session.self === null ? null : { ...session.self },
      me:
        me === null
          ? null
          : {
              x: me.x,
              y: me.y,
              heading: me.heading,
              turret: me.turret,
              speed: me.speed,
              hp: me.hp,
              isAlive: me.isAlive,
              shieldLeft: me.shieldLeft,
            },
      tanks: prediction?.tanksOnField.length ?? 0,
      tanksInView: camera === null ? 0 : view.tanks.filter((tank) => isInView(camera, tank)).length,
      others: view.tanks
        .filter((tank) => tank.id !== session.playerId)
        .map((tank) => ({ id: tank.id, x: tank.x, y: tank.y, isAlive: tank.isAlive })),
      bullets: view.bullets.length,
      pending: prediction?.pendingCount ?? 0,
      correctionPx: prediction?.lastCorrectionPx ?? 0,
      rttMs: this.net.rttMs,
      camera: camera === null ? null : { x: camera.x, y: camera.y, width: camera.width, height: camera.height },
      viewCenter: this.framing === null ? null : { ...this.framing.viewCenter },
      aimSource: this.input.isMouseAiming ? 'mouse' : 'turret',
      mouseWorld: mouseWorld === null ? null : { ...mouseWorld },
      score: score === null ? null : { ...score },
      feed: session.hud(this.deps.now(), this.hud.layout).feed.map(feedText),
      spectating: session.spectating,
      arrows: this.helpers.arrows.map((arrow) => ({ ...arrow })),
      aimLine:
        this.helpers.aimLine === null
          ? null
          : { state: this.helpers.aimLine.state, targetId: this.helpers.aimTargetId },
      voices: this.audioMix.activeCount(this.deps.now()),
      isAutoFiring: this.input.isAutoFiring,
      floorChunks: this.renderer.floorChunks,
      floorMemoryMb: this.renderer.floorMemoryMb,
      fps: this.fps,
      worstFrameMs: this.worstFrameMs,
      picture: pictureDebug(view.clock, prediction?.latestTick ?? 0, view.bullets),
    };
  }

  private connect(): NetClient {
    const { size } = this.options;
    return new NetClient(
      this.deps.url,
      {
        onFfaWelcome: (message) => {
          this.onWelcome(message);
        },
        onFfaState: (message, receivedAt) => {
          this.session.onState(message, receivedAt);
          this.diag.write(
            `net state phase=${String(message.phase)} left=${String(message.ticksLeft)} players=${String(message.players)}/${String(message.capacity)} min=${String(message.minimum)} match=${String(message.matchIndex)}`,
          );
          this.options.telemetry.event('net', 'state', { phase: message.phase, players: message.players });
        },
        onFfaRoster: (message) => {
          this.session.onRoster(message);
        },
        onFfaMatchStart: (message) => {
          this.onMatchStart(message);
        },
        onFfaSnapshot: (message, receivedAt) => {
          this.onSnapshot(message, receivedAt);
        },
        onFfaScore: (message) => {
          this.session.onScore(message);
          this.fxPolicy.noteScore(message.rows);
        },
        onFfaBullets: (message) => {
          this.prediction?.resetBullets(message.bullets);
        },
        onError: (message) => {
          this.onError(message);
        },
        onDisconnect: (retryInMs, reason) => {
          this.onDisconnect(retryInMs, reason);
        },
      },
      {
        roomCode: this.roomCode,
        nickname: this.options.nickname,
        stats: this.options.stats,
        token: this.deps.tokens.read(size),
        gameId: this.options.inviteGameId,
      },
      { createSocket: this.deps.createSocket, now: this.deps.now },
    );
  }

  // Новое соединение: номера команд снова с единицы, неподтверждённое и снимки старого соединения забыты.
  private onWelcome(message: FfaWelcomeMessage): void {
    const outcome = this.session.onWelcome(message, this.deps.now());
    this.deps.tokens.write(this.options.size, message.token);
    this.seq = 0;
    this.spareInput.reset();
    this.prediction?.resetConnection();
    if (outcome === 'lost') {
      this.prediction = null;
      this.resetMatchEffects();
    }
    if (outcome === 'returned') {
      this.camera.snap();
    }
    this.diag.setGame(message.gameId);
    this.diag.write(`net welcome id=${String(message.playerId)} game=${message.gameId} outcome=${outcome}`);
    this.options.telemetry.setGame(message.gameId);
    this.options.telemetry.event('net', 'welcome', { room: this.roomCode, outcome });
  }

  private onMatchStart(message: FfaMatchStartMessage): void {
    const outcome = this.session.onMatchStart(message);
    const myId = this.session.playerId;
    if (myId !== null && (outcome === 'new' || this.prediction === null)) {
      this.prediction = new FfaPrediction(this.map, this.session.rules, message.zone, myId, (id) => ({
        name: this.session.nameOf(id),
        stats: this.session.statsOf(id),
      }));
    }
    if (outcome === 'new') {
      this.resetMatchEffects();
    }
    this.diag.write(`net matchstart idx=${String(message.matchIndex)} outcome=${outcome}`);
    this.options.telemetry.event('net', 'matchstart', { idx: message.matchIndex });
  }

  private onSnapshot(message: FfaSnapshotMessage, receivedAt: number): void {
    if (!this.session.acceptSnapshot(message, receivedAt)) {
      return;
    }
    const prediction = this.prediction;
    if (prediction !== null) {
      prediction.applySnapshot(message, receivedAt);
      for (const { predictedId, serverId } of prediction.takeConfirmedBullets()) {
        this.effects.renameTrail(predictedId, serverId);
      }
    }
    this.spareInput.noteSnapshot(message.ackSeq, message.hasSpareInput);
    this.diag.markSnapshot(message.gameTick, receivedAt);
    this.snapshotsThisSecond++;
    const camera = this.framing?.camera ?? null;
    if (camera === null) {
      return;
    }
    const myId = this.session.playerId;
    this.effects.onSnapshot(
      message.tick,
      message.tanks.filter((tank) => isInView(camera, tank)),
    );
    for (const event of message.events) {
      if (event.kind === 'spawn' && event.tank === myId) {
        this.camera.snap();
        this.setAutoFire(false);
      }
      const tank = message.tanks.find((candidate) => candidate.id === event.tank) ?? null;
      this.events.add(event, message.tick, eventPlace(event.kind, tank, myId), receivedAt);
    }
  }

  // События, до места которых дошла картинка: эффекты, тряска, объявления и звук по правилам толпы.
  private releaseEvents(view: FfaFrameView, camera: Camera, now: number): void {
    const myId = this.session.playerId;
    const listener = this.listener();
    const drawnTank = (id: number): FfaViewTank | null => view.tanks.find((tank) => tank.id === id) ?? null;
    for (const { event, tick } of this.events.release(view.clock, drawnTank, now)) {
      const options = this.fxPolicy.optionsFor(event, myId, camera);
      if (options !== null) {
        this.effects.onEvent(event, options);
      }
      const sound = this.fxPolicy.soundFor(event, camera, tick);
      if (sound !== null) {
        this.audioMix.play(mixedSound(event, sound.name, myId), listener, now, (volume) =>
          this.sfx.play(sound.name, sound.pan, sound.volume * volume),
        );
      }
    }
  }

  private onError(message: ErrorMessage): void {
    this.session.onError(message.code);
    if (message.code === ErrorCode.Idle) {
      this.deps.tokens.erase(this.options.size);
    }
    this.diag.write(`net error code=${String(message.code)} text=${message.text}`);
    this.options.telemetry.event('net', `server error: ${message.text}`, { code: message.code });
  }

  private onDisconnect(retryInMs: number, reason: DisconnectReason): void {
    if (this.isClosed) {
      return;
    }
    this.session.onDisconnect();
    this.diag.write(`net disconnect retry=${String(retryInMs)} reason=${reason}`);
    this.options.telemetry.event('net', 'disconnect', { retryInMs, reason });
  }

  private resetMatchEffects(): void {
    this.effects.reset();
    this.fxPolicy.reset();
    this.events.clear();
    this.camera.snap();
  }

  private setAutoFire(isOn: boolean): void {
    if (this.input.isAutoFiring === isOn) {
      return;
    }
    this.input.setAutoFire(isOn);
    this.options.onAutoFireChange(isOn);
    this.diag.write(`autofire on=${isOn ? '1' : '0'}`);
  }

  private bindPage(): void {
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
    this.options.canvas.addEventListener('pointerdown', () => {
      this.switchSpectator();
    });
    // Вкладка скрылась — одна команда «стоп»: танк не едет туда, куда держали газ, пока игрока нет. Вернулась —
    // отсчёт кадров с этого мгновения, иначе первый кадр нагонит пропущенное пачкой команд; события, накопленные
    // в фоне, не играются.
    document.addEventListener('visibilitychange', () => {
      const isHidden = document.visibilityState === 'hidden';
      if (isHidden && !this.isHidden) {
        this.sendStop();
      }
      this.isHidden = isHidden;
      this.accumulator = 0;
      this.lastFrame = this.deps.now();
      this.events.clear();
    });
  }

  private ownTankInPlay(): Tank | null {
    const me = this.prediction?.me ?? null;
    const phase = this.session.phase;
    const isMatchRunning = phase === FfaPhase.Countdown || phase === FfaPhase.Fight;
    const isOnline = this.net.isConnected && !this.session.hasFatalError;
    if (me === null || !me.isAlive || !isMatchRunning || !isOnline) {
      return null;
    }
    return me;
  }

  private sendStop(): void {
    const prediction = this.prediction;
    if (prediction === null || this.ownTankInPlay() === null) {
      return;
    }
    this.sendInput(prediction, IDLE_ACTION);
  }

  private sendInput(prediction: FfaPrediction, action: Action): void {
    this.seq++;
    prediction.predict(this.seq, action);
    this.net.sendInput(this.seq, action);
    this.inputsThisSecond++;
  }

  // Громкость звука — от своего танка на поле; у зрителя — от его цели; иначе (подбит, ждёт) — от точки камеры.
  private listener(): Point {
    const me = this.prediction?.me ?? null;
    if (me !== null && this.ownTankInPlay() !== null) {
      return me;
    }
    const target = this.frameView.tanks.find((tank) => tank.id === this.session.spectating);
    if (this.session.screen() === 'spectator' && target !== undefined) {
      return target;
    }
    return this.framing?.viewCenter ?? { x: this.map.width / 2, y: this.map.height / 2 };
  }

  // Цели помощников — живые чужие в окне камеры последнего кадра: то, что игрок видит. Цель предохранителя
  // считается и при выключенной линии.
  private shotContext(me: Tank): ShotContext {
    const { settings } = this.options;
    const targets = this.lastFrameTargets();
    const bulletSpeed = me.stats.bulletSpeed;
    const path = traceShot(this.map, me, me.turret, bulletSpeed).segments;
    const isReturning = settings.hasRicochetGuard && isTraceReturning(path, me, firstTargetOnPath(path, targets));
    const isInZone = settings.hasZoneFire && isPathInZone(path, { shooter: me, bulletSpeed, targets });
    return { isReturning, isInZone };
  }

  private lastFrameTargets(): FfaViewTank[] {
    const camera = this.framing?.camera ?? null;
    if (camera === null) {
      return [];
    }
    return visibleEnemies(this.frameView.tanks, this.session.playerId, camera);
  }

  private stepInput(elapsed: number): void {
    const prediction = this.prediction;
    const me = this.ownTankInPlay();
    if (prediction === null || me === null || this.isHidden) {
      this.accumulator = 0;
      return;
    }
    this.accumulator += elapsed;
    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      if (this.spareInput.shouldSkip(this.seq + 1)) {
        continue;
      }
      this.sendInput(prediction, quantizeAction(this.input.read(me, this.shotContext(me))));
    }
  }

  // Доля экрана под точкой окна; null — холст ещё не на странице.
  private screenShare(clientX: number, clientY: number): Point | null {
    const rect = this.options.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }
    return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
  }

  private toWorld(clientX: number, clientY: number): Point {
    const camera = this.framing?.camera;
    const share = this.screenShare(clientX, clientY);
    if (camera === undefined || share === null) {
      return { x: this.map.width / 2, y: this.map.height / 2 };
    }
    const { width, height } = this.renderer.screen;
    return screenToWorld(camera, { x: share.x * width, y: share.y * height });
  }

  private aimOf(me: Tank): FfaAim {
    const cursor = this.input.mouseScreen;
    const share = cursor === null ? null : this.screenShare(cursor.x, cursor.y);
    if (this.input.isMouseAiming && share !== null) {
      return { kind: 'mouse', cursor: share };
    }
    return { kind: 'turret', angle: me.turret };
  }

  // Свой танк на поле — камера на нём; подбит и на итогах — окно стоит, где было; зритель — за целью; иначе центр
  // карты.
  private frameCamera(view: FfaFrameView, screen: SessionScreen, elapsed: number): FfaFraming {
    const size = this.renderer.screen;
    const me = this.prediction?.me ?? null;
    const isOwnOnField = me !== null && me.isAlive && (screen === 'fight' || screen === 'countdown');
    if (isOwnOnField) {
      return this.camera.update(me, this.aimOf(me), size, elapsed);
    }
    if ((screen === 'dead' || screen === 'results') && this.framing !== null) {
      return this.framing;
    }
    if (screen === 'spectator') {
      const target = this.spectatorTarget(view);
      if (target !== null) {
        return this.camera.update(target, { kind: 'turret', angle: target.turret }, size, elapsed);
      }
    }
    return this.camera.update({ x: this.map.width / 2, y: this.map.height / 2 }, { kind: 'none' }, size, elapsed);
  }

  // Смена цели переставляет камеру сразу.
  private spectatorTarget(view: FfaFrameView): FfaFrameView['tanks'][number] | null {
    const alive = view.tanks.filter((tank) => tank.isAlive);
    const previous = this.session.spectating;
    const targetId = this.session.followSpectator(alive.map((tank) => tank.id));
    if (targetId !== previous) {
      this.camera.snap();
    }
    return alive.find((tank) => tank.id === targetId) ?? null;
  }

  // Касание или клик по полю у зрителя — следующий живой по таблице.
  private switchSpectator(): void {
    if (this.session.screen() !== 'spectator') {
      return;
    }
    const aliveIds = this.frameView.tanks.filter((tank) => tank.isAlive).map((tank) => tank.id);
    const previous = this.session.spectating;
    if (this.session.nextSpectator(aliveIds) !== previous) {
      this.camera.snap();
    }
  }

  private frame(now: number): void {
    if (this.isClosed) {
      return;
    }
    this.deps.requestFrame((next) => {
      this.frame(next);
    });
    const elapsed = Math.min(MAX_FRAME_MS, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;
    this.countFrame(now, elapsed);
    this.stepInput(elapsed);
    const view = this.prediction?.view(now) ?? EMPTY_VIEW;
    const screen = this.session.screen();
    const hasFieldControls = this.ownTankInPlay() !== null;
    this.showFieldControls(hasFieldControls);
    const framing = this.frameCamera(view, screen, elapsed);
    this.framing = framing;
    this.frameView = view;
    const { camera } = framing;
    this.releaseEvents(view, camera, now);
    this.helpers = this.fieldHelpers(view, screen, camera);
    this.effects.update(
      elapsed / SECOND_MS,
      view.tanks.filter((tank) => isInView(camera, tank, VIEW_MARGIN)),
    );
    this.renderer.draw({
      view,
      myId: this.session.playerId,
      camera,
      zonePlan: this.session.match?.zone ?? null,
      labelOf: (id) => ({ label: this.session.nameOf(id), isBot: this.session.isBot(id) }),
      aimLine: this.helpers.aimLine,
      arrows: this.helpers.arrows,
      controls: {
        sticks: hasFieldControls ? this.input.stickStates : [],
        isShotGuarded: this.input.isShotGuarded,
        isZoneFiring: this.input.isZoneFiring,
        isReversing: this.input.isReversing,
      },
      readout: {
        gameId: this.session.gameId ?? '',
        gameTick: this.diag.gameTick(now),
        fps: this.fps,
        worstFrameMs: this.worstFrameMs,
        rttMs: this.net.rttMs,
        correctionPx: this.prediction?.lastCorrectionPx ?? 0,
        isMuted: this.sfx.isMuted,
      },
      frameMs: elapsed,
      frameTimes: this.frameTimes,
    });
    this.hud.render(this.session.hud(now, this.hud.layout), now);
    this.writeSummary(now);
  }

  // Стрелки и линия — только в бою, пока свой танк на поле; упреждение в толпе не показывается.
  private fieldHelpers(view: FfaFrameView, screen: SessionScreen, camera: Camera): FieldHelpers {
    const me = this.prediction?.me ?? null;
    if (me === null || !me.isAlive || screen !== 'fight') {
      return NO_HELPERS;
    }
    const myId = this.session.playerId;
    const arrows = edgeArrows({ me, myId, tanks: view.tanks, camera, pixelRatio: this.renderer.screen.pixelRatio });
    if (!this.options.settings.hasAimLine) {
      return { aimLine: null, aimTargetId: null, arrows };
    }
    const targets = visibleEnemies(view.tanks, myId, camera);
    const bulletSpeed = me.stats.bulletSpeed;
    const path = traceShot(this.map, me, me.turret, bulletSpeed).segments;
    const aimLine = aimLineOnPath(path, { shooter: me, bulletSpeed, targets, hasLeadHint: false });
    if (aimLine.state !== 'onTarget') {
      return { aimLine, aimTargetId: null, arrows };
    }
    return { aimLine, aimTargetId: firstTargetOnPath(path, targets)?.id ?? null, arrows };
  }

  private showFieldControls(isVisible: boolean): void {
    if (this.hasFieldControls === isVisible) {
      return;
    }
    this.hasFieldControls = isVisible;
    this.options.onFieldControlsChange(isVisible);
  }

  private countFrame(now: number, elapsed: number): void {
    this.frames++;
    this.frameTimes.push(elapsed);
    if (this.frameTimes.length > FRAME_HISTORY) {
      this.frameTimes.shift();
    }
    this.worstFrameCandidate = Math.max(this.worstFrameCandidate, elapsed);
    if (now - this.fpsWindowStart >= SECOND_MS) {
      this.fps = (this.frames * SECOND_MS) / (now - this.fpsWindowStart);
      this.worstFrameMs = this.worstFrameCandidate;
      this.worstFrameCandidate = 0;
      this.frames = 0;
      this.fpsWindowStart = now;
    }
  }

  private writeSummary(now: number): void {
    if (now - this.summaryAt < SECOND_MS) {
      return;
    }
    this.summaryAt = now;
    const fps = Math.round(this.fps);
    const worst = Math.round(this.worstFrameMs);
    const rtt = Math.round(this.net.rttMs);
    const pend = this.prediction?.pendingCount ?? 0;
    this.diag.write(
      `sec fps=${String(fps)} worst=${String(worst)} rtt=${String(rtt)} pend=${String(pend)} snaps=${String(this.snapshotsThisSecond)} ins=${String(this.inputsThisSecond)}`,
    );
    this.options.telemetry.event('sec', 'sec', {
      fps,
      worst,
      rtt,
      pend,
      snaps: this.snapshotsThisSecond,
      ins: this.inputsThisSecond,
    });
    this.snapshotsThisSecond = 0;
    this.inputsThisSecond = 0;
  }

  private restart(isWithToken: boolean): void {
    this.net.close();
    if (!isWithToken) {
      this.deps.tokens.erase(this.options.size);
    }
    this.session = new FfaSession(this.options.size);
    this.prediction = null;
    this.resetMatchEffects();
    this.net = this.connect();
  }

  // До приветствия номера игры ещё нет — ссылка на игру этого размера.
  private invitePath(): string {
    const gameId = this.session.gameId;
    if (gameId === null) {
      return `/ffa/${String(this.options.size)}`;
    }
    return ffaInvitePath(this.options.size, gameId);
  }

  private leave(): void {
    this.close();
    this.deps.goHome();
  }
}
