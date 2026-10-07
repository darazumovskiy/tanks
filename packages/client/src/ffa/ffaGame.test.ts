import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorld,
  DEFAULT_RULES,
  DEFAULT_STATS,
  deriveStats,
  ffaMap,
  ffaViewReach,
  FFA,
  IDLE_ACTION,
  makeTank,
  normalizeAngle,
  stepWorld,
  TANK_HIT_RADIUS,
  type Action,
  type FfaPlayerState,
  type Tank,
  type World,
} from '@tanks/shared/engine';
import {
  BulletTracker,
  bulletSnapshot,
  decode,
  encode,
  ErrorCode,
  EventFlag,
  FfaInviteMiss,
  FfaPhase,
  MessageType,
  type ClientMessage,
  type FfaSnapshotEvent,
  type FfaSnapshotMessage,
  type InputMessage,
  type ServerMessage,
} from '@tanks/shared/protocol';
import { DiagLog } from '../diag.js';
import { RECONNECT_BASE_MS, type SocketLike } from '../net.js';
import { Effects } from '../render/effects.js';
import type { FfaDrawInput } from '../render/ffaRenderer.js';
import { StampDecals } from '../render/stampDecals.js';
import { enemyLeadPoint } from '../aimLine.js';
import { defaultSettings, type Settings } from '../settings.js';
import { Sfx, SOUND_DURATIONS } from '../sfx.js';
import { Telemetry } from '../telemetry.js';
import { installFakeAudio, type FakeAudio } from '../testing/fakeAudio.js';
import { snapshotOf } from '../testing/ffaServer.js';
import { shownText } from '../testing/hudText.js';
import { FfaGame, type FfaRendererLike, type TokenStore } from './ffaGame.js';
import { PREDICTED_BULLET_ID_BASE } from '../predictedShots.js';
import { EVENT_MAX_WAIT_MS } from '../pictureTime.js';

const ME = 4;
const ENEMY = 5;
const SIZE = 10;
const DEVICE_ID = 'abcdefghjk23456789mnpqrs';
const MAP = ffaMap(SIZE);
const SCREEN = { width: 1280, height: 720, pixelRatio: 1 };
const FRAME_MS = 1000 / 60;
const TICK_MS = 1000 / 30;
// Кадров, за которые картинка чужих (отставание два тика) доходит до тика последнего снимка.
const PICTURE_FRAMES = 6;
// Кадров, за которые сдвиг камеры после выхода в бой выходит из центра и успокаивается.
const CAMERA_SETTLE_FRAMES = 210;
const ZONE = { startRadius: 9000, finalRadius: 9000, startShrink: 1000, endShrink: 1001 };
const SUDDEN_DEATH_AT = 85;
const AIM_TOLERANCE = 0.05;
const CLIENT_INFO = {
  platform: 'desktop' as const,
  shell: 'browser' as const,
  os: 'тест',
  osVersion: '1',
  browser: 'тест',
  browserVersion: '1',
  appVersion: 'test',
  screen: '1280x720',
  dpr: 1,
  touch: false,
};

class FakeSocket implements SocketLike {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: ClientMessage[] = [];
  isClosedByClient = false;

  send(data: Uint8Array): void {
    this.sent.push(decode(data) as ClientMessage);
  }

  close(): void {
    this.isClosedByClient = true;
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  receive(message: ServerMessage): void {
    const bytes = encode(message);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    this.onmessage?.(new MessageEvent('message', { data: buffer }));
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }

  get inputs(): InputMessage[] {
    return this.sent.filter((message): message is InputMessage => message.type === MessageType.Input);
  }
}

class RecordingRenderer implements FfaRendererLike {
  readonly screen = SCREEN;
  floorChunks = 0;
  floorMemoryMb = 0;
  last: FfaDrawInput | null = null;

  draw(input: FfaDrawInput): void {
    this.last = input;
  }
}

interface DiagSent {
  url: string;
  body: string;
}

interface Harness {
  game: FfaGame;
  sockets: FakeSocket[];
  renderer: RecordingRenderer;
  effects: Effects;
  stage: HTMLElement;
  hud: HTMLElement;
  canvas: HTMLCanvasElement;
  settingsPanel: HTMLElement;
  tokens: Map<number, string>;
  calls: string[];
  copied: string[];
  autoFire: boolean[];
  fieldControls: boolean[];
  diagSent: DiagSent[];
  socket: () => FakeSocket;
  frames: (count: number) => void;
  state: () => Record<string, unknown>;
}

let clock = 0;
let pendingFrame: ((now: number) => void) | null = null;

// Страница боя как в index.html: холст, корень интерфейса толпы и панель настроек — соседи.
function makeGame(storedToken = '', isTouch = false, settings: Partial<Settings> = {}, inviteGameId = ''): Harness {
  document.body.innerHTML = '';
  const stage = document.createElement('div');
  const canvas = document.createElement('canvas');
  const hud = document.createElement('div');
  const settingsPanel = document.createElement('div');
  settingsPanel.innerHTML = '<label class="settings-row"><span>Радиус стика</span><input type="range"></label>';
  stage.append(canvas, hud, settingsPanel);
  document.body.append(stage);
  canvas.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, SCREEN.width, SCREEN.height);
  const sockets: FakeSocket[] = [];
  const renderer = new RecordingRenderer();
  const tokens = new Map<number, string>(storedToken === '' ? [] : [[SIZE, storedToken]]);
  const store: TokenStore = {
    read: (size) => tokens.get(size) ?? '',
    write: (size, token) => tokens.set(size, token),
    erase: (size) => tokens.delete(size),
  };
  const calls: string[] = [];
  const copied: string[] = [];
  const autoFire: boolean[] = [];
  const fieldControls: boolean[] = [];
  const diagSent: DiagSent[] = [];
  let effects = null as Effects | null;
  const game = new FfaGame(
    {
      size: SIZE,
      inviteGameId,
      nickname: 'Дима',
      stats: DEFAULT_STATS,
      canvas,
      hud,
      settings: { ...defaultSettings(), hasRicochetGuard: false, ...settings },
      isTouchDevice: isTouch,
      deviceId: DEVICE_ID,
      telemetry: new Telemetry(CLIENT_INFO, { beacon: () => true }),
      onAutoFireChange: (isOn) => autoFire.push(isOn),
      onFieldControlsChange: (isVisible) => fieldControls.push(isVisible),
    },
    {
      url: 'ws://test/ws',
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      createRenderer: () => renderer,
      createEffects: (colorOf, nameOf) => {
        effects = new Effects(new StampDecals(), colorOf, nameOf);
        return effects;
      },
      createSfx: () => new Sfx(() => document.visibilityState === 'hidden'),
      createDiag: (roomCode) =>
        new DiagLog(roomCode, {
          post: (url, body) => {
            diagSent.push({ url, body });
            return Promise.resolve(true);
          },
          beacon: (url, body) => {
            diagSent.push({ url, body });
            return true;
          },
        }),
      now: () => clock,
      requestFrame: (callback) => {
        pendingFrame = callback;
      },
      tokens: store,
      goHome: () => calls.push('home'),
      reload: () => calls.push('reload'),
      pageOrigin: 'https://tanks.test',
      copyText: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    },
  );
  if (effects === null) {
    throw new Error('эффекты не созданы');
  }
  const socket = (): FakeSocket => {
    const latest = sockets[sockets.length - 1];
    if (latest === undefined) {
      throw new Error('нет сокета');
    }
    return latest;
  };
  return {
    game,
    sockets,
    renderer,
    effects,
    stage,
    hud,
    canvas,
    settingsPanel,
    tokens,
    calls,
    copied,
    autoFire,
    fieldControls,
    diagSent,
    socket,
    frames: (count) => {
      for (let index = 0; index < count; index++) {
        clock += FRAME_MS;
        const callback = pendingFrame;
        pendingFrame = null;
        callback?.(clock);
      }
    },
    state: () => game.debugState(),
  };
}

function welcome(playerId = ME, token = 'пропуск', inviteMiss: FfaInviteMiss = FfaInviteMiss.None): ServerMessage {
  return {
    type: MessageType.FfaWelcome,
    playerId,
    token,
    gameId: 'K7QX',
    size: SIZE,
    rules: DEFAULT_RULES,
    inviteMiss,
  };
}

function roster(ids: readonly number[] = [ME, ENEMY]): ServerMessage {
  const names: Readonly<Record<number, string>> = { [ME]: 'Дима', [ENEMY]: 'Вася', 6: 'Робот' };
  return {
    type: MessageType.FfaRoster,
    players: ids.map((id) => ({ id, nickname: names[id] ?? `Т${String(id)}`, stats: DEFAULT_STATS, isBot: id === 6 })),
  };
}

function state(
  phase: (typeof FfaPhase)[keyof typeof FfaPhase],
  ticksLeft: number | null,
  matchIndex = 1,
  players = 2,
): ServerMessage {
  return { type: MessageType.FfaState, phase, ticksLeft, players, capacity: SIZE, minimum: 7, matchIndex };
}

function matchStart(matchIndex = 1): ServerMessage {
  return {
    type: MessageType.FfaMatchStart,
    matchIndex,
    durationSeconds: 120,
    zone: ZONE,
    suddenDeathAt: SUDDEN_DEATH_AT,
  };
}

function tank(id: number, x: number, y: number, heading = 0): Tank {
  return makeTank({ name: '', stats: DEFAULT_STATS }, id, { x, y, heading });
}

function arena(tanks: Tank[]): World {
  return createWorld(MAP, tanks, DEFAULT_RULES, ZONE);
}

function event(
  kind: FfaSnapshotEvent['kind'],
  tankId: number | null,
  x: number,
  y: number,
  by: number | null = null,
): FfaSnapshotEvent {
  return { kind, tank: tankId, by, x, y, value: 0, dx: 1, dy: 0, flags: 0 };
}

// Сервер в тесте: поле боя шагает раз в тик настоящим движком с последней пришедшей командой своего танка.
class TestServer {
  private nextTickAt: number;
  private lastSeq = 0;
  private action: Action = IDLE_ACTION;
  private readSent = 0;
  private readonly tracker = new BulletTracker();

  constructor(
    private readonly harness: Harness,
    readonly world: World,
  ) {
    this.nextTickAt = clock + TICK_MS;
    this.tracker.diff(world.bullets);
  }

  run(frames: number): void {
    for (let index = 0; index < frames; index++) {
      this.harness.frames(1);
      this.takeInputs();
      while (clock >= this.nextTickAt) {
        this.nextTickAt += TICK_MS;
        stepWorld(
          this.world,
          this.world.tanks.map((candidate) => (candidate.id === ME ? this.action : IDLE_ACTION)),
        );
        this.harness
          .socket()
          .receive(snapshotOf(this.world, { ackSeq: this.lastSeq, changes: this.tracker.diff(this.world.bullets) }));
      }
    }
  }

  private takeInputs(): void {
    const inputs = this.harness.socket().inputs;
    for (const input of inputs.slice(this.readSent)) {
      this.lastSeq = input.seq;
      this.action = input.action;
    }
    this.readSent = inputs.length;
  }
}

function enterFight(harness: Harness, world: World, own: FfaPlayerState = 'alive'): void {
  const socket = harness.socket();
  socket.open();
  socket.receive(welcome());
  socket.receive(roster([ME, ENEMY, 6]));
  socket.receive(state(FfaPhase.Fight, 3600));
  socket.receive(matchStart());
  stepWorld(
    world,
    world.tanks.map(() => IDLE_ACTION),
  );
  socket.receive(snapshotOf(world, { state: own }));
  harness.frames(1);
}

function meOf(harness: Harness): { x: number; y: number; turret: number } {
  const me = harness.state().me as { x: number; y: number; turret: number } | null;
  if (me === null) {
    throw new Error('своего танка нет');
  }
  return me;
}

function statusText(harness: Harness): string {
  return shownText(harness.hud);
}

function pointer(kind: string, x: number, y: number, type: 'mouse' | 'touch'): PointerEvent {
  return new PointerEvent(kind, { pointerId: 7, pointerType: type, clientX: x, clientY: y, button: 0, bubbles: true });
}

function setHidden(isHidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', { value: isHidden ? 'hidden' : 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

let audio: FakeAudio;

beforeEach(() => {
  vi.useFakeTimers();
  audio = installFakeAudio();
  clock = 1000;
  pendingFrame = null;
  setHidden(false);
});

afterEach(() => {
  audio.restore();
  vi.useRealTimers();
});

describe('вход и отсчёт', () => {
  it('лобби — игроки, места и минимум; на отсчёте свой танк из снимка стоит, команды уходят с номера 1', () => {
    const harness = makeGame();
    const socket = harness.socket();
    socket.open();
    expect(socket.sent[0]).toMatchObject({ type: MessageType.Join, roomCode: 'ffa10', token: '', isBot: false });
    socket.receive(welcome());
    socket.receive(roster());
    socket.receive(state(FfaPhase.Lobby, null, 0));
    harness.frames(1);
    expect(harness.state()).toMatchObject({ screen: 'lobby', players: 2, capacity: SIZE, minimum: 7, playerId: ME });
    expect(statusText(harness)).toContain('2 / 10');
    expect(statusText(harness)).toContain('Ещё 5 смельчаков — и в бой');
    expect(harness.tokens.get(SIZE)).toBe('пропуск');
    socket.receive(state(FfaPhase.Countdown, 90));
    socket.receive(matchStart());
    const world = arena([tank(ENEMY, 900, 600), tank(ME, 500, 600)]);
    socket.receive(snapshotOf(world));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    harness.frames(6);
    expect(harness.state()).toMatchObject({
      screen: 'countdown',
      me: { x: 500, y: 600 },
      others: [{ id: ENEMY, x: 900, y: 600, isAlive: true }],
    });
    expect(socket.inputs[0]).toMatchObject({ seq: 1, action: { throttle: 1 } });
    expect(socket.inputs.map((input) => input.seq)).toEqual([1, 2, 3]);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  });

  it('вход в идущий матч: снаряды из полного списка видны сразу; свой танк появляется по spawn, команды с 1', () => {
    const harness = makeGame();
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster());
    socket.receive(state(FfaPhase.Fight, 3000));
    socket.receive(matchStart());
    const world = arena([tank(ENEMY, 900, 300)]);
    world.tick = 300;
    stepWorld(world, [{ ...IDLE_ACTION, isFiring: true }]);
    const bullet = world.bullets[0];
    if (bullet === undefined) {
      throw new Error('снаряда нет');
    }
    socket.receive({ type: MessageType.FfaBullets, bullets: [{ ...bullet }] });
    stepWorld(world, [IDLE_ACTION]);
    socket.receive(snapshotOf(world, { state: 'waiting' }));
    harness.frames(4);
    expect(harness.state()).toMatchObject({ bullets: 1, me: null, screen: 'dead' });
    expect(socket.inputs).toHaveLength(0);
    world.tanks.push(tank(ME, 1200, 700));
    stepWorld(
      world,
      world.tanks.map(() => IDLE_ACTION),
    );
    socket.receive(snapshotOf(world, { events: [event('spawn', ME, 1200, 700)] }));
    harness.frames(4);
    expect(harness.state()).toMatchObject({ screen: 'fight', me: { x: 1200, y: 700 } });
    expect(socket.inputs[0]?.seq).toBe(1);
  });
});

describe('мышь в бою толпы на 1280 × 720', () => {
  // Курсор там, где под ним после успокоения камеры окажется враг: точка прицела — танк + сдвиг(c) + c.
  function cursorOver(me: { x: number; y: number }, target: { x: number; y: number }): { x: number; y: number } {
    const dx = target.x - me.x;
    const dy = target.y - me.y;
    const angle = Math.atan2(dy, dx);
    const toEdge = Math.min(
      FFA.viewWidth / 2 / Math.abs(Math.cos(angle)),
      FFA.viewHeight / 2 / Math.abs(Math.sin(angle)),
    );
    const offset = Math.hypot(dx, dy) / (1 + ffaViewReach(angle) / toEdge);
    const pixelsPerUnit = SCREEN.height / FFA.viewHeight;
    return {
      x: SCREEN.width / 2 + Math.cos(angle) * offset * pixelsPerUnit,
      y: SCREEN.height / 2 + Math.sin(angle) * offset * pixelsPerUnit,
    };
  }

  it.each([
    ['впереди в 120', 120, 0],
    ['позади в 120', -120, 0],
    ['сверху в 120', 0, -120],
    ['снизу в 120', 0, 120],
    ['впереди в 400', 400, 0],
    ['позади в 400', -400, 0],
    ['сверху в 400', 0, -400],
    ['снизу в 400', 0, 400],
  ])('враг %s: за 2 с башня смотрит на врага ±0,05 рад', (_name, dx, dy) => {
    const harness = makeGame();
    const world = arena([tank(ME, 1100, 650), tank(ENEMY, 1100 + dx, 650 + dy)]);
    enterFight(harness, world);
    const server = new TestServer(harness, world);
    const cursor = cursorOver({ x: 1100, y: 650 }, { x: 1100 + dx, y: 650 + dy });
    harness.canvas.dispatchEvent(pointer('pointermove', cursor.x, cursor.y, 'mouse'));
    server.run(120);
    const me = meOf(harness);
    const wanted = Math.atan2(650 + dy - me.y, 1100 + dx - me.x);
    expect(Math.abs(normalizeAngle(me.turret - wanted))).toBeLessThanOrEqual(AIM_TOLERANCE);
    expect(harness.state().aimSource).toBe('mouse');
  });

  it('танк едет при неподвижной мыши — башня на точку под курсором ±0,05 рад', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 500, 450), tank(ENEMY, 1900, 1200)]);
    enterFight(harness, world);
    const server = new TestServer(harness, world);
    harness.canvas.dispatchEvent(pointer('pointermove', 900, 200, 'mouse'));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    server.run(90);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    const me = meOf(harness);
    const mouse = harness.state().mouseWorld as { x: number; y: number };
    expect(me.x).toBeGreaterThan(650);
    const wanted = Math.atan2(mouse.y - me.y, mouse.x - me.x);
    expect(Math.abs(normalizeAngle(me.turret - wanted))).toBeLessThanOrEqual(AIM_TOLERANCE);
  });
});

describe('камера на старте и после появления, курсор в углу экрана', () => {
  const EASE_IN_FRAMES = 90;
  const MAX_SHIFT_STEP = 800 / 60 + 1e-6;

  function shiftOf(harness: Harness): { x: number; y: number } {
    const me = meOf(harness);
    const center = harness.state().viewCenter as { x: number; y: number };
    return { x: center.x - me.x, y: center.y - me.y };
  }

  function aimAtCorner(harness: Harness): void {
    harness.canvas.dispatchEvent(pointer('pointermove', 1200, 60, 'mouse'));
  }

  // Сдвиг по кадрам выхода из центра: с нуля, без рывков и откатов, к концу выхода — полный.
  function expectEaseIn(harness: Harness): void {
    const lengths: number[] = [];
    for (let frame = 0; frame < CAMERA_SETTLE_FRAMES; frame++) {
      harness.frames(1);
      const shift = shiftOf(harness);
      lengths.push(Math.hypot(shift.x, shift.y));
    }
    const full = lengths[lengths.length - 1] ?? 0;
    expect(full).toBeGreaterThan(150);
    expect(lengths[0]).toBeLessThan(1);
    for (let frame = 1; frame < lengths.length; frame++) {
      const step = (lengths[frame] ?? 0) - (lengths[frame - 1] ?? 0);
      expect(step).toBeGreaterThanOrEqual(-1e-6);
      expect(step).toBeLessThanOrEqual(MAX_SHIFT_STEP);
    }
    const middle = lengths[EASE_IN_FRAMES / 2 - 1] ?? 0;
    expect(middle).toBeGreaterThan(full / 3);
    expect(middle).toBeLessThan((full * 2) / 3);
    expect(lengths[EASE_IN_FRAMES]).toBeCloseTo(full, 1);
  }

  it('отсчёт — свой танк точно в центре экрана; старт боя — сдвиг к курсору выходит из нуля за 1,5 с', () => {
    const harness = makeGame();
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster());
    socket.receive(state(FfaPhase.Countdown, 90));
    socket.receive(matchStart());
    socket.receive(snapshotOf(arena([tank(ME, 1100, 650), tank(ENEMY, 2000, 1200)])));
    aimAtCorner(harness);
    for (let frame = 0; frame < 60; frame++) {
      harness.frames(1);
      const camera = harness.state().camera as { x: number; y: number; width: number; height: number };
      expect(shiftOf(harness)).toEqual({ x: 0, y: 0 });
      expect(camera.x + camera.width / 2).toBeCloseTo(1100, 9);
      expect(camera.y + camera.height / 2).toBeCloseTo(650, 9);
    }
    socket.receive(state(FfaPhase.Fight, 3600));
    expectEaseIn(harness);
    expect(harness.state().aimSource).toBe('mouse');
  });

  it('возрождение: сдвиг снова выходит из нуля на новом месте', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 1100, 650), tank(ENEMY, 2000, 1200)]);
    enterFight(harness, world);
    aimAtCorner(harness);
    harness.frames(CAMERA_SETTLE_FRAMES);
    expect(Math.hypot(shiftOf(harness).x, shiftOf(harness).y)).toBeGreaterThan(150);
    const own = world.tanks.find((candidate) => candidate.id === ME);
    if (own === undefined) {
      throw new Error('своего танка нет');
    }
    own.isAlive = false;
    own.hp = 0;
    step(world);
    harness.socket().receive(snapshotOf(world, { state: 'wreck', killerId: ENEMY }));
    harness.frames(30);
    expect(harness.state().screen).toBe('dead');
    own.isAlive = true;
    own.hp = own.stats.maxHp;
    own.x = 600;
    own.y = 1100;
    step(world);
    harness.socket().receive(snapshotOf(world, { events: [event('spawn', ME, 600, 1100)] }));
    expectEaseIn(harness);
    expect(meOf(harness)).toMatchObject({ x: 600, y: 1100 });
  });

  it('гибель и появление без кадра между ними (вкладка была скрыта): сдвиг выходит из нуля', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 1100, 650), tank(ENEMY, 2000, 1200)]);
    enterFight(harness, world);
    aimAtCorner(harness);
    harness.frames(CAMERA_SETTLE_FRAMES);
    const own = world.tanks.find((candidate) => candidate.id === ME);
    if (own === undefined) {
      throw new Error('своего танка нет');
    }
    own.isAlive = false;
    own.hp = 0;
    step(world);
    harness.socket().receive(snapshotOf(world, { state: 'wreck', killerId: ENEMY }));
    own.isAlive = true;
    own.hp = own.stats.maxHp;
    own.x = 600;
    own.y = 1100;
    step(world);
    harness.socket().receive(snapshotOf(world, { events: [event('spawn', ME, 600, 1100)] }));
    expectEaseIn(harness);
  });

  it('следующий матч без кадра между боем и новым боем: сдвиг выходит из нуля', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 1100, 650), tank(ENEMY, 2000, 1200)]);
    enterFight(harness, world);
    aimAtCorner(harness);
    harness.frames(CAMERA_SETTLE_FRAMES);
    const socket = harness.socket();
    socket.receive(state(FfaPhase.Results, 150));
    socket.receive(state(FfaPhase.Countdown, 90, 2));
    socket.receive(matchStart(2));
    const next = arena([tank(ME, 600, 1100), tank(ENEMY, 2000, 1200)]);
    socket.receive(snapshotOf(next));
    socket.receive(state(FfaPhase.Fight, 3600, 2));
    expectEaseIn(harness);
    expect(meOf(harness)).toMatchObject({ x: 600, y: 1100 });
  });

  it('вход в идущий матч: сдвиг выходит из нуля с появлением своего танка', () => {
    const harness = makeGame();
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster());
    socket.receive(state(FfaPhase.Fight, 3000));
    socket.receive(matchStart());
    const world = arena([tank(ENEMY, 2000, 1200)]);
    world.tick = 300;
    socket.receive(snapshotOf(world, { state: 'waiting' }));
    aimAtCorner(harness);
    harness.frames(4);
    world.tanks.push(tank(ME, 1100, 650));
    step(world);
    socket.receive(snapshotOf(world, { events: [event('spawn', ME, 1100, 650)] }));
    expectEaseIn(harness);
  });
});

describe('обрыв и возврат', () => {
  function fighting(): { harness: Harness; world: World } {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)]);
    enterFight(harness, world);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    harness.frames(6);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    return { harness, world };
  }

  it('сокет закрылся — экран связи, ввод не уходит; возврат с пропуском — команды с 1, неподтверждённых нет', () => {
    const { harness, world } = fighting();
    const first = harness.socket();
    expect(first.inputs.length).toBeGreaterThan(0);
    first.drop();
    harness.frames(10);
    expect(statusText(harness)).toContain('СВЯЗЬ ПРОПАЛА');
    expect(harness.state().pending).toBe(first.inputs.length);
    const sentWhileDown = first.inputs.length;
    vi.advanceTimersByTime(1000);
    const second = harness.socket();
    expect(second).not.toBe(first);
    second.open();
    expect(second.sent[0]).toMatchObject({ type: MessageType.Join, token: 'пропуск' });
    second.receive(welcome());
    second.receive(roster());
    second.receive(state(FfaPhase.Fight, 3000));
    second.receive(matchStart());
    expect(harness.state().pending).toBe(0);
    stepWorld(
      world,
      world.tanks.map(() => IDLE_ACTION),
    );
    second.receive(snapshotOf(world));
    harness.frames(4);
    expect(statusText(harness)).toContain('ВЕРНУЛИСЬ!');
    expect(harness.state().screen).toBe('fight');
    expect(second.inputs[0]?.seq).toBe(1);
    expect(first.inputs).toHaveLength(sentWhileDown);
  });

  it('сокет молчит 4 с — закрыт клиентом, экран связи, переподключение', () => {
    const { harness } = fighting();
    const first = harness.socket();
    vi.advanceTimersByTime(4000);
    expect(first.isClosedByClient).toBe(true);
    harness.frames(1);
    expect(statusText(harness)).toContain('СВЯЗЬ ПРОПАЛА');
    vi.advanceTimersByTime(1000);
    expect(harness.sockets).toHaveLength(2);
  });

  it('другой номер игрока — «НЕ УСПЕЛИ» и чистый старт: лента и счёт пусты', () => {
    const { harness, world } = fighting();
    const first = harness.socket();
    first.receive(
      score([
        [ME, 0],
        [ENEMY, 1],
      ]),
    );
    step(world);
    first.receive(snapshotOf(world, { events: [event('death', 6, 900, 650, ENEMY)] }));
    expect(harness.state().feed).toHaveLength(1);
    expect(harness.state().score).not.toBeNull();
    first.drop();
    vi.advanceTimersByTime(1000);
    const second = harness.socket();
    second.open();
    second.receive(welcome(9, 'новый'));
    harness.frames(1);
    expect(harness.state()).toMatchObject({
      playerId: 9,
      me: null,
      tanks: 0,
      screen: 'connecting',
      feed: [],
      score: null,
    });
    expect(statusText(harness)).toContain('НЕ УСПЕЛИ');
    expect(harness.tokens.get(SIZE)).toBe('новый');
  });

  it('возврат в тот же матч сохраняет ленту, следы и эффекты', () => {
    const { harness, world } = fighting();
    const first = harness.socket();
    first.receive(
      score([
        [ME, 0],
        [ENEMY, 0],
      ]),
    );
    step(world);
    first.receive(snapshotOf(world, { events: [event('death', 6, 900, 650, ME)] }));
    harness.frames(PICTURE_FRAMES);
    const reset = vi.spyOn(harness.effects, 'reset');
    first.drop();
    vi.advanceTimersByTime(1000);
    const second = harness.socket();
    second.open();
    second.receive(welcome());
    second.receive(roster([ME, ENEMY, 6]));
    second.receive(state(FfaPhase.Fight, 3000));
    second.receive(matchStart());
    second.receive({ type: MessageType.FfaBullets, bullets: [] });
    step(world);
    second.receive(snapshotOf(world));
    harness.frames(2);
    expect(reset).not.toHaveBeenCalled();
    expect(harness.state().feed).toEqual(['Дима ✕ Робот']);
  });

  it('возврат после начала финала — финал по тику без события; возврат подбитым — «подбит» по убийце', () => {
    const harness = makeGame('старый');
    const world = arena([tank(ENEMY, 1400, 650), tank(ME, 600, 650)]);
    const own = world.tanks[1];
    if (own !== undefined) {
      own.isAlive = false;
      own.hp = 0;
    }
    world.tick = SUDDEN_DEATH_AT * 30 + 5;
    const socket = harness.socket();
    socket.open();
    expect(socket.sent[0]).toMatchObject({ token: 'старый' });
    socket.receive(welcome());
    socket.receive(roster());
    socket.receive(state(FfaPhase.Fight, 900));
    socket.receive(matchStart());
    socket.receive(snapshotOf(world, { state: 'wreck', killerId: ENEMY, isOut: true }));
    harness.frames(2);
    expect(harness.state()).toMatchObject({ isFinal: true, screen: 'dead', self: { killerId: ENEMY } });
    expect(statusText(harness)).toContain('ТЫ ВЫБЫЛ');
    world.tick = 100;
    const early = makeGame('старый');
    early.socket().open();
    early.socket().receive(welcome());
    early.socket().receive(roster());
    early.socket().receive(state(FfaPhase.Fight, 900));
    early.socket().receive(matchStart());
    early.socket().receive(snapshotOf(world, { state: 'wreck', killerId: ENEMY }));
    early.frames(2);
    expect(early.state()).toMatchObject({ isFinal: false, screen: 'dead' });
    expect(statusText(early)).toContain('ТЕБЯ ПОДБИЛ Вася');
  });
});

describe('журнал клиента', () => {
  function sentWith(harness: Harness, text: string): DiagSent {
    const found = harness.diagSent.filter((sent) => sent.body.includes(text)).at(-1);
    if (found === undefined) {
      throw new Error(`строка «${text}» не отправлена`);
    }
    return found;
  }

  async function reconnect(harness: Harness, message: ServerMessage): Promise<void> {
    harness.socket().drop();
    await vi.advanceTimersByTimeAsync(1000);
    const next = harness.socket();
    next.open();
    next.receive(message);
    await vi.advanceTimersByTimeAsync(1000);
  }

  it('источник — номер игрока: неотправленное до входа уходит в журнал комнаты с номером, дальше — в журнал игры', async () => {
    const harness = makeGame();
    harness.socket().open();
    harness.socket().receive(welcome());
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentWith(harness, ' device ').url).toBe(`/log?key=room-ffa${String(SIZE)}&src=C${String(ME)}`);
    expect(sentWith(harness, ' net welcome id=4 ').url).toBe(`/log?key=K7QX&src=C${String(ME)}`);
  });

  it('строка устройства кончается номером устройства', async () => {
    const harness = makeGame();
    harness.socket().open();
    harness.socket().receive(welcome());
    await vi.advanceTimersByTimeAsync(1000);
    const line = sentWith(harness, ' device ')
      .body.split('\n')
      .find((text) => text.includes(' device '));
    expect(line).toMatch(new RegExp(` mode=ffa size=${String(SIZE)} dev=${DEVICE_ID}$`));
  });

  it('возврат тем же номером — источник прежний; место ушло — строки идут под новым номером до закрытия', async () => {
    const harness = makeGame();
    harness.socket().open();
    harness.socket().receive(welcome());
    await reconnect(harness, welcome());
    expect(sentWith(harness, 'outcome=returned').url).toBe(`/log?key=K7QX&src=C${String(ME)}`);
    await reconnect(harness, welcome(9, 'новый'));
    expect(sentWith(harness, 'outcome=lost').url).toBe('/log?key=K7QX&src=C9');
    harness.game.close();
    expect(sentWith(harness, ' close').url).toBe('/log?key=K7QX&src=C9');
  });
});

describe('вкладка скрылась', () => {
  it('одна команда «стоп», звук молчит; вернулась — ввод и звук снова идут', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 900, 650)]);
    enterFight(harness, world);
    const socket = harness.socket();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    harness.frames(6);
    const before = socket.inputs.length;
    expect(before).toBeGreaterThan(0);
    setHidden(true);
    expect(socket.inputs).toHaveLength(before + 1);
    expect(socket.inputs.at(-1)?.action).toEqual(IDLE_ACTION);
    harness.frames(20);
    expect(socket.inputs).toHaveLength(before + 1);
    stepWorld(
      world,
      world.tanks.map(() => IDLE_ACTION),
    );
    socket.receive(snapshotOf(world, { events: [event('shot', ENEMY, 930, 650)] }));
    expect(audio.outputs).toHaveLength(0);
    setHidden(false);
    harness.frames(6);
    expect(socket.inputs.length).toBeGreaterThan(before + 1);
    stepWorld(
      world,
      world.tanks.map(() => IDLE_ACTION),
    );
    socket.receive(snapshotOf(world, { events: [event('shot', ENEMY, 930, 650)] }));
    harness.frames(PICTURE_FRAMES);
    expect(audio.outputs.length).toBeGreaterThan(0);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  });

  it('события, пришедшие в скрытую вкладку, после возврата не играются — ни звука, ни эффектов; новые играются', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 900, 650)]);
    enterFight(harness, world);
    const socket = harness.socket();
    window.dispatchEvent(new MouseEvent('mousedown'));
    harness.frames(6);
    const onEvent = vi.spyOn(harness.effects, 'onEvent');
    setHidden(true);
    for (let index = 0; index < 30; index++) {
      step(world);
      clock += TICK_MS;
      socket.receive(
        snapshotOf(world, { events: [event('shot', ENEMY, 930, 650), event('hit', ENEMY, 890, 650, ME)] }),
      );
    }
    setHidden(false);
    harness.frames(PICTURE_FRAMES * 3);
    expect(onEvent).not.toHaveBeenCalled();
    expect(audio.outputs).toHaveLength(0);
    step(world);
    socket.receive(snapshotOf(world, { events: [event('shot', ENEMY, 930, 650), event('hit', ENEMY, 890, 650, ME)] }));
    harness.frames(PICTURE_FRAMES);
    expect(onEvent.mock.calls.map(([fx]) => fx.kind)).toEqual(['shot', 'hit']);
    expect(audio.outputs.length).toBeGreaterThan(0);
  });

  it('вкладка пробыла скрытой долго — первый кадр после возврата не нагоняет пропущенное пачкой команд', () => {
    const harness = makeGame();
    enterFight(harness, arena([tank(ME, 600, 650), tank(ENEMY, 900, 650)]));
    const socket = harness.socket();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    harness.frames(6);
    setHidden(true);
    clock += 2000;
    setHidden(false);
    const before = socket.inputs.length;
    harness.frames(1);
    expect(socket.inputs.length - before).toBeLessThanOrEqual(1);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  });
});

describe('повторные и устаревшие сообщения', () => {
  it('повторный старт того же матча не сбрасывает эффекты и камеру; снимок с меньшим тиком пропущен; ушедший — в кэше имён', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 900, 650)]);
    enterFight(harness, world);
    for (let tick = 0; tick < 10; tick++) {
      stepWorld(
        world,
        world.tanks.map(() => IDLE_ACTION),
      );
    }
    const socket = harness.socket();
    socket.receive(snapshotOf(world));
    harness.frames(CAMERA_SETTLE_FRAMES);
    const reset = vi.spyOn(harness.effects, 'reset');
    const cameraBefore = harness.state().camera;
    socket.receive(matchStart(1));
    harness.frames(1);
    expect(reset).not.toHaveBeenCalled();
    expect(harness.state().camera).toEqual(cameraBefore);
    const latestTick = world.tick;
    const stale = structuredClone(world);
    stale.tick = latestTick - 5;
    const staleMe = stale.tanks.find((candidate) => candidate.id === ME);
    if (staleMe !== undefined) {
      staleMe.x = 100;
    }
    socket.receive(snapshotOf(stale));
    harness.frames(1);
    expect(harness.state()).toMatchObject({ tick: latestTick, me: { x: 600 } });
    socket.receive(roster([ME]));
    stepWorld(
      world,
      world.tanks.map(() => IDLE_ACTION),
    );
    socket.receive(snapshotOf(world, { events: [event('death', 6, 900, 650, ENEMY)] }));
    expect(harness.state().feed).toEqual(['Вася ✕ Робот']);
    socket.receive(matchStart(2));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('окончательные ошибки', () => {
  it('выкинуло — пропуск стёрт, «Вернуться в бой» входит без пропуска; «На главную» уводит со страницы', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650)]);
    enterFight(harness, world);
    harness.socket().receive({ type: MessageType.Error, code: ErrorCode.Idle, text: 'выкинуло' });
    harness.frames(1);
    expect(harness.state().screen).toBe('idle');
    expect(harness.tokens.has(SIZE)).toBe(false);
    const buttons = [...harness.hud.querySelectorAll<HTMLButtonElement>('.ffa-fatal button')];
    expect(statusText(harness)).toBe(
      'ВЫКИНУЛО ЗА БЕЗДЕЙСТВИЕ Танк стоял слишком долго — место отдали другому. Вернуться в бой На главную',
    );
    expect(buttons.map((button) => button.textContent)).toEqual(['Вернуться в бой', 'На главную']);
    buttons[0]?.click();
    expect(harness.sockets).toHaveLength(2);
    harness.socket().open();
    expect(harness.socket().sent[0]).toMatchObject({ type: MessageType.Join, token: '' });
    harness.socket().receive({ type: MessageType.Error, code: ErrorCode.Replaced, text: 'занято' });
    harness.frames(1);
    const replaced = [...harness.hud.querySelectorAll<HTMLButtonElement>('.ffa-fatal button')];
    expect(replaced.map((button) => button.textContent)).toEqual(['Играть здесь', 'На главную']);
    replaced[1]?.click();
    expect(harness.calls).toEqual(['home']);
  });

  it('обновление — «Обновить» перезагружает страницу', () => {
    const harness = makeGame();
    harness.socket().open();
    harness.socket().receive({ type: MessageType.Error, code: ErrorCode.BadProtocolVersion, text: 'старый' });
    harness.frames(1);
    expect(harness.state().screen).toBe('update');
    expect(statusText(harness)).toBe('ВЫШЛО ОБНОВЛЕНИЕ Перезагрузи — и в бой. Обновить');
    harness.hud.querySelector<HTMLButtonElement>('.ffa-fatal button')?.click();
    expect(harness.calls).toEqual(['reload']);
  });
});

describe('ввод боя — только с холста', () => {
  function element(root: ParentNode, selector: string): Element {
    const found = root.querySelector(selector);
    if (found === null) {
      throw new Error(`нет элемента ${selector}`);
    }
    return found;
  }

  it('лобби: своего танка нет — «АВТО» и стики скрыты, касание поля стик не рисует; «Выйти» нажимается', () => {
    const harness = makeGame();
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster());
    socket.receive(state(FfaPhase.Lobby, null, 0));
    harness.frames(1);
    expect(harness.fieldControls).toEqual([false]);
    harness.canvas.dispatchEvent(pointer('pointerdown', 200, 300, 'touch'));
    harness.frames(1);
    expect(harness.renderer.last?.controls.sticks).toEqual([]);
    window.dispatchEvent(pointer('pointerup', 200, 300, 'touch'));
    const exit = element(harness.hud, '.ffa-lobby .ffa-button:not(.is-primary)');
    expect(exit.textContent).toBe('Выйти');
    (exit as HTMLButtonElement).click();
    expect(harness.calls).toEqual(['home']);
  });

  it('в бою: строка панели настроек и карточка интерфейса не стреляют и стик не рождают; холст — да; подбит — управление скрыто', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)]);
    enterFight(harness, world);
    const socket = harness.socket();
    expect(harness.fieldControls).toEqual([true]);
    const row = element(harness.settingsPanel, 'span');
    const card = element(harness.hud, '.ffa-scoreboard');
    for (const target of [row, card]) {
      target.dispatchEvent(pointer('pointerdown', 900, 300, 'touch'));
      window.dispatchEvent(pointer('pointerup', 900, 300, 'touch'));
      target.dispatchEvent(pointer('pointerdown', 900, 300, 'mouse'));
      harness.frames(4);
      window.dispatchEvent(pointer('pointerup', 900, 300, 'mouse'));
    }
    expect(socket.inputs.length).toBeGreaterThan(0);
    expect(socket.inputs.some((input) => input.action.isFiring)).toBe(false);
    harness.canvas.dispatchEvent(pointer('pointerdown', 200, 300, 'touch'));
    harness.frames(1);
    expect(harness.renderer.last?.controls.sticks.map((stick) => stick.role)).toEqual(['move']);
    harness.canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 8, pointerType: 'mouse', button: 0 }));
    harness.frames(4);
    expect(socket.inputs.some((input) => input.action.isFiring)).toBe(true);
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 8, pointerType: 'mouse', button: 0 }));
    const own = world.tanks.find((candidate) => candidate.id === ME);
    if (own !== undefined) {
      own.isAlive = false;
      own.hp = 0;
    }
    world.tick++;
    socket.receive(snapshotOf(world, { state: 'wreck', killerId: ENEMY }));
    harness.frames(1);
    expect(harness.fieldControls).toEqual([true, false]);
    expect(harness.renderer.last?.controls.sticks).toEqual([]);
    window.dispatchEvent(pointer('pointerup', 200, 300, 'touch'));
  });
});

function score(rows: readonly (readonly [number, number])[]): ServerMessage {
  return {
    type: MessageType.FfaScore,
    rows: rows.map(([id, kills]) => ({ id, kills, deaths: 0, damageDealt: 0, damageTaken: 0 })),
  };
}

function step(world: World): void {
  stepWorld(
    world,
    world.tanks.map(() => IDLE_ACTION),
  );
}

describe('экран в толпе не трясётся', () => {
  it('P1 своё первое убийство матча, свой выстрел и своя гибель: ни «ПЕРВАЯ КРОВЬ», ни тряски, ни вспышки', () => {
    const harness = makeGame();
    const onEvent = vi.spyOn(harness.effects, 'onEvent');
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster([ME, ENEMY, 6]));
    socket.receive(state(FfaPhase.Fight, 3000));
    socket.receive(matchStart());
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 900, 650), tank(6, 1000, 650)]);
    step(world);
    socket.receive(snapshotOf(world));
    harness.frames(1);
    step(world);
    socket.receive(
      snapshotOf(world, {
        events: [event('shot', ME, 640, 650), event('death', 6, 1000, 650, ME), event('death', ME, 600, 650, ENEMY)],
      }),
    );
    harness.frames(PICTURE_FRAMES);
    expect(onEvent.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(onEvent.mock.calls.map(([, options]) => options.announcement)).toEqual(onEvent.mock.calls.map(() => null));
    expect(harness.effects.shake).toBe(0);
    expect(harness.effects.flashScreen).toBe(0);
  });
});

describe('экраны вокруг боя', () => {
  it('итоги: окно камеры стоит, где было в бою', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)]);
    enterFight(harness, world);
    harness.frames(30);
    const cameraBefore = harness.state().camera;
    harness.socket().receive(state(FfaPhase.Results, 300));
    harness.frames(30);
    expect(harness.state().screen).toBe('results');
    expect(harness.state().camera).toEqual(cameraBefore);
  });

  it('отсчёт: «Высаживаемся с началом боя», пока свой танк не жив на поле, даже если он уже в снимке', () => {
    const harness = makeGame();
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster());
    socket.receive(state(FfaPhase.Countdown, 90));
    socket.receive(matchStart());
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)]);
    socket.receive(snapshotOf(world, { state: 'waiting' }));
    harness.frames(1);
    expect(statusText(harness)).toContain('Высаживаемся с началом боя');
    socket.receive(snapshotOf(world, { state: 'alive' }));
    harness.frames(1);
    expect(statusText(harness)).toBe('3');
  });

  it('место в бою — среди строк счёта матча, а не игроков игры', () => {
    const harness = makeGame();
    enterFight(harness, arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)]));
    harness.socket().receive(
      score([
        [ME, 2],
        [ENEMY, 0],
        [6, 0],
      ]),
    );
    harness.frames(1);
    expect(harness.state().players).toBe(2);
    expect(statusText(harness)).toContain('1-й из 3');
  });

  it('строка отладки у игрока без админ-режима: игра, кадры за секунду и худший кадр', () => {
    const harness = makeGame();
    enterFight(harness, arena([tank(ME, 600, 650)]));
    const secondOfFrames = Math.ceil(1000 / FRAME_MS) + 1;
    harness.frames(secondOfFrames);
    const readout = harness.renderer.last?.readout;
    expect(readout?.gameId).toBe('K7QX');
    expect(readout?.fps).toBeGreaterThan(0);
    expect(readout?.worstFrameMs).toBeGreaterThanOrEqual(FRAME_MS - 1);
  });

  it('отладка показывает куски пола и их память от рендера', () => {
    const harness = makeGame();
    enterFight(harness, arena([tank(ME, 600, 650)]));
    harness.renderer.floorChunks = 41;
    harness.renderer.floorMemoryMb = 33.5;
    expect(harness.state()).toMatchObject({ floorChunks: 41, floorMemoryMb: 33.5 });
  });
});

describe('свой снаряд', () => {
  it('подтверждённый выстрел переносит хвост с номера предсказания на номер сервера', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 1400, 1000)]);
    enterFight(harness, world);
    const rename = vi.spyOn(harness.effects, 'renameTrail');
    const server = new TestServer(harness, world);
    harness.canvas.dispatchEvent(pointer('pointerdown', 640, 360, 'mouse'));
    server.run(20);
    window.dispatchEvent(pointer('pointerup', 640, 360, 'mouse'));
    expect(rename).toHaveBeenCalled();
    const [predictedId, serverId] = rename.mock.calls[0] ?? [];
    expect(predictedId).toBeGreaterThanOrEqual(PREDICTED_BULLET_ID_BASE);
    expect(serverId).toBe(world.bullets.find((bullet) => bullet.owner === ME)?.id ?? 1);
  });
});

describe('интерфейс матча', () => {
  const SECOND_FRAMES = 60;

  function hudPart(harness: Harness, selector: string): HTMLElement {
    const found = harness.hud.querySelector<HTMLElement>(selector);
    if (found === null) {
      throw new Error(`нет элемента ${selector}`);
    }
    return found;
  }

  function isShown(harness: Harness, selector: string): boolean {
    return hudPart(harness, selector).classList.contains('is-shown');
  }

  function partText(harness: Harness, selector: string): string {
    return shownText(hudPart(harness, selector));
  }

  function click(harness: Harness, selector: string, label: string): void {
    const target = [...harness.hud.querySelectorAll<HTMLButtonElement>(`${selector} button`)].find(
      (candidate) => candidate.textContent === label,
    );
    if (target === undefined) {
      throw new Error(`нет кнопки «${label}» в ${selector}`);
    }
    target.click();
  }

  function selfSnapshot(
    world: World,
    own: Partial<FfaSnapshotMessage['self']>,
    events: FfaSnapshotEvent[] = [],
  ): FfaSnapshotMessage {
    const message = snapshotOf(world, { events });
    return { ...message, self: { ...message.self, ...own } };
  }

  function scoreRows(rows: readonly [number, number, number][]): ServerMessage {
    return {
      type: MessageType.FfaScore,
      rows: rows.map(([id, kills, deaths]) => ({ id, kills, deaths, damageDealt: 0, damageTaken: 0 })),
    };
  }

  function lobbyGame(players: number): Harness {
    const harness = makeGame();
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster([ENEMY, ME, 6]));
    socket.receive(state(FfaPhase.Lobby, null, 0, players));
    harness.frames(1);
    return harness;
  }

  it('U1 лобби: меньше минимума, отметка минимума, состав с ботом, свой ник первым', () => {
    const harness = lobbyGame(3);
    expect(isShown(harness, '.ffa-lobby')).toBe(true);
    expect(partText(harness, '.ffa-lobby .ffa-title')).toBe('СОБИРАЕМ ТОЛПУ');
    expect(partText(harness, '.ffa-lobby-count')).toBe('3 / 10');
    expect(partText(harness, '.ffa-lobby-status')).toBe('Ещё 4 смельчака — и в бой');
    expect(hudPart(harness, '.ffa-progress-fill').style.width).toBe('30%');
    expect(hudPart(harness, '.ffa-progress-mark').style.left).toBe('70%');
    const chips = [...harness.hud.querySelectorAll<HTMLElement>('.ffa-roster .ffa-nick:not(.ffa-roster-more)')];
    expect(chips.map((chip) => shownText(chip))).toEqual(['Дима', 'Вася', 'БОТ Робот']);
    expect(chips.map((chip) => chip.classList.contains('is-me'))).toEqual([true, false, false]);
    expect(isShown(harness, '.ffa-scoreboard')).toBe(false);
  });

  it('U1 лобби: старт по местным часам; полная игра — «Полный сбор»', () => {
    const harness = lobbyGame(3);
    harness.socket().receive(state(FfaPhase.Lobby, 210, 0, 7));
    harness.frames(1);
    expect(partText(harness, '.ffa-lobby-status')).toBe('Старт через 7');
    harness.frames(2 * SECOND_FRAMES);
    expect(partText(harness, '.ffa-lobby-status')).toBe('Старт через 5');
    harness.socket().receive(state(FfaPhase.Lobby, 0, 0, 10));
    harness.frames(1);
    expect(partText(harness, '.ffa-lobby-status')).toBe('Полный сбор — поехали!');
    expect(hudPart(harness, '.ffa-progress-fill').classList.contains('is-ready')).toBe(true);
  });

  it('U1 «Позвать друга» копирует ссылку на эту игру и говорит об этом 2 с; «Выйти» закрывает соединение', async () => {
    const harness = lobbyGame(3);
    click(harness, '.ffa-lobby', 'Позвать друга');
    expect(harness.copied).toEqual(['https://tanks.test/ffa/10/K7QX']);
    await Promise.resolve();
    harness.frames(1);
    expect(isShown(harness, '.ffa-lobby-copied')).toBe(true);
    expect(partText(harness, '.ffa-lobby-copied')).toBe('Ссылка у тебя — кидай другу');
    harness.frames(2 * SECOND_FRAMES);
    expect(isShown(harness, '.ffa-lobby-copied')).toBe(false);
    click(harness, '.ffa-lobby', 'Выйти');
    expect(harness.socket().sent.at(-1)).toEqual({ type: MessageType.Leave });
    expect(harness.socket().isClosedByClient).toBe(true);
    expect(harness.calls).toEqual(['home']);
    expect(harness.tokens.get(SIZE)).toBe('пропуск');
  });

  it('P6 «⌂» в бою и «Выйти» на итогах: Leave, затем сокет закрыт и главная; пропуск остаётся', () => {
    const fight = makeGame();
    enterFight(fight, arena([tank(ME, 600, 650)]));
    fight.game.leave();
    expect(fight.socket().sent.at(-1)).toEqual({ type: MessageType.Leave });
    expect(fight.socket().isClosedByClient).toBe(true);
    expect(fight.calls).toEqual(['home']);
    expect(fight.tokens.get(SIZE)).toBe('пропуск');

    const results = makeGame();
    enterFight(results, arena([tank(ME, 600, 650)]));
    results.socket().receive(state(FfaPhase.Results, 150));
    results.frames(1);
    click(results, '.ffa-results', 'Выйти');
    expect(results.socket().sent.filter((message) => message.type === MessageType.Leave)).toHaveLength(1);
    expect(results.socket().isClosedByClient).toBe(true);
    expect(results.calls).toEqual(['home']);
  });

  it('U1a вход по приглашению: номер игры уходит в каждый вход; попал куда звали — плашки нет', () => {
    const harness = makeGame('', false, {}, 'ZZ9Q');
    const socket = harness.socket();
    socket.open();
    expect(socket.sent[0]).toMatchObject({ type: MessageType.Join, gameId: 'ZZ9Q' });
    socket.receive(welcome());
    socket.receive(roster([ENEMY, ME, 6]));
    socket.receive(state(FfaPhase.Lobby, null, 0, 3));
    harness.frames(1);
    expect(isShown(harness, '.ffa-invite')).toBe(false);
    socket.drop();
    vi.advanceTimersByTime(RECONNECT_BASE_MS);
    harness.socket().open();
    expect(harness.socket().sent[0]).toMatchObject({ type: MessageType.Join, gameId: 'ZZ9Q', token: 'пропуск' });
  });

  it.each([
    [FfaInviteMiss.Full, 'ИГРА ДРУГА ПОЛНА Ты в соседней — зови сюда'],
    [FfaInviteMiss.Gone, 'ТОЙ ИГРЫ УЖЕ НЕТ Все разошлись — вот новая'],
  ])('U1a приглашение мимо (%i): плашка с причиной в лобби и в бою, гаснет через 8 с после входа', (miss, text) => {
    const harness = makeGame('', false, {}, 'ZZ9Q');
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome(ME, 'пропуск', miss));
    socket.receive(roster([ENEMY, ME, 6]));
    socket.receive(state(FfaPhase.Lobby, null, 0, 3));
    harness.frames(1);
    expect(harness.state().screen).toBe('lobby');
    expect(isShown(harness, '.ffa-invite')).toBe(true);
    expect(partText(harness, '.ffa-invite')).toBe(text);
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)]);
    socket.receive(state(FfaPhase.Fight, 3600));
    socket.receive(matchStart());
    step(world);
    socket.receive(snapshotOf(world));
    harness.frames(5 * SECOND_FRAMES);
    expect(harness.state().screen).toBe('fight');
    expect(isShown(harness, '.ffa-invite')).toBe(true);
    harness.frames(3 * SECOND_FRAMES);
    expect(isShown(harness, '.ffa-invite')).toBe(false);
  });

  it('U1a связь пропала — баннер связи на месте плашки приглашения', () => {
    const harness = makeGame('', false, {}, 'ZZ9Q');
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome(ME, 'пропуск', FfaInviteMiss.Full));
    socket.receive(roster([ENEMY, ME, 6]));
    socket.receive(state(FfaPhase.Lobby, null, 0, 3));
    harness.frames(1);
    socket.drop();
    harness.frames(1);
    expect(isShown(harness, '.ffa-connection')).toBe(true);
    expect(isShown(harness, '.ffa-invite')).toBe(false);
  });

  it('U2 отсчёт: 3, 2, 1, «В БОЙ!» по местным часам; «В БОЙ!» держится и после начала боя, потом гаснет', () => {
    const harness = makeGame();
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster());
    socket.receive(state(FfaPhase.Countdown, 90));
    socket.receive(matchStart());
    socket.receive(snapshotOf(arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)])));
    harness.frames(1);
    expect(partText(harness, '.ffa-countdown')).toBe('3');
    harness.frames(66);
    expect(partText(harness, '.ffa-countdown')).toBe('2');
    harness.frames(SECOND_FRAMES);
    expect(partText(harness, '.ffa-countdown')).toBe('1');
    harness.frames(SECOND_FRAMES);
    expect(partText(harness, '.ffa-countdown')).toBe('В БОЙ!');
    socket.receive(state(FfaPhase.Fight, 3600));
    harness.frames(30);
    expect(isShown(harness, '.ffa-countdown')).toBe(true);
    harness.frames(30);
    expect(isShown(harness, '.ffa-countdown')).toBe(false);
  });

  it('U3 табло: таймер из тика, место среди строк матча, счёт, лидер; на первом месте — «Ты лидер!»', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)]);
    enterFight(harness, world);
    world.tick = 30 * 18;
    harness.socket().receive(snapshotOf(world));
    harness.socket().receive(
      scoreRows([
        [ENEMY, 3, 1],
        [ME, 1, 2],
        [6, 1, 0],
      ]),
    );
    harness.frames(1);
    expect(partText(harness, '.ffa-timer')).toBe('1:42');
    expect(partText(harness, '.ffa-place')).toBe('3-й из 3 подбил 1 · погиб 2');
    expect(partText(harness, '.ffa-leader')).toBe('Лидер: Вася · 3');
    harness.socket().receive(
      scoreRows([
        [ENEMY, 3, 1],
        [ME, 4, 2],
      ]),
    );
    harness.frames(1);
    expect(partText(harness, '.ffa-leader')).toBe('Ты лидер!');
    expect(partText(harness, '.ffa-place')).toBe('1-й из 2 подбил 4 · погиб 2');
  });

  it('U4 лента: свои строки выделены, значки по виду, бот выбыл, на телефоне 3 строки, на компьютере 4; строка гаснет через 5 с', () => {
    for (const [isTouch, rows] of [
      [true, 3],
      [false, 4],
    ] as const) {
      const harness = makeGame('', isTouch);
      const world = arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)]);
      enterFight(harness, world);
      const deaths = [
        event('death', 6, 900, 650, ME),
        { ...event('death', ENEMY, 900, 650, 6), flags: EventFlag.Ricochet },
        { ...event('death', 6, 900, 650, 6), flags: EventFlag.Self | EventFlag.Ricochet },
        { ...event('death', ENEMY, 900, 650, null), flags: EventFlag.Zone },
        event('death', 6, 900, 650, 77),
        { ...event('death', 6, 900, 650, null), flags: EventFlag.Out },
      ];
      for (const death of deaths) {
        step(world);
        harness.socket().receive(snapshotOf(world, { events: [death] }));
      }
      harness.frames(1);
      const shown = [...harness.hud.querySelectorAll<HTMLElement>('.ffa-feed-row')];
      expect(shown).toHaveLength(rows);
      expect(shown.map((row) => shownText(row)).slice(0, 3)).toEqual([
        'Робот выбыл',
        'Неизвестный танкист Робот',
        'Вася сгорел в зоне',
      ]);
      expect(shown.map((row) => row.querySelector('.ffa-feed-icon')?.getAttribute('data-cause'))).toEqual(
        ['out', 'bullet', 'zone', 'self'].slice(0, rows),
      );
      harness.frames(5 * SECOND_FRAMES);
      expect(harness.hud.querySelectorAll('.ffa-feed-row')).toHaveLength(0);
      expect(isShown(harness, '.ffa-feed')).toBe(false);
    }
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)]);
    enterFight(harness, world);
    step(world);
    harness.socket().receive(snapshotOf(world, { events: [event('death', 6, 9, 9, ME)] }));
    harness.frames(1);
    const own = hudPart(harness, '.ffa-feed-row');
    expect(own.classList.contains('is-my-kill')).toBe(true);
    expect(own.querySelector('.ffa-feed-name.is-me')?.textContent).toBe('Дима');
  });

  it('U5 «тебя подбил»: игрок и бот, отсчёт до появления; появился — карточка скрыта, авто-огонь выключен', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)]);
    enterFight(harness, world);
    harness.game.toggleAutoFire();
    step(world);
    harness
      .socket()
      .receive(
        selfSnapshot(world, { state: 'wreck', killerId: ENEMY, ticksLeft: 60 }, [event('death', ME, 600, 650, ENEMY)]),
      );
    harness.frames(1);
    expect(isShown(harness, '.ffa-death')).toBe(true);
    expect(partText(harness, '.ffa-death')).toBe('ТЕБЯ ПОДБИЛ Вася Снова в бою через 4');
    step(world);
    harness.socket().receive(selfSnapshot(world, { state: 'waiting', killerId: 6, ticksLeft: 25 }));
    harness.frames(1);
    expect(partText(harness, '.ffa-death-title')).toBe('БОТ Робот');
    expect(partText(harness, '.ffa-death-respawn')).toBe('Снова в бою через 1');
    step(world);
    harness.socket().receive(snapshotOf(world, { events: [event('spawn', ME, 600, 650)] }));
    harness.frames(1);
    expect(isShown(harness, '.ffa-death')).toBe(false);
    expect(harness.autoFire).toEqual([true, false]);
  });

  it('U6 финал наступил, пока подбит: «ТЫ ВЫБЫЛ» без отсчёта, после обломков — зритель с той же карточкой', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)]);
    enterFight(harness, world);
    world.tick = SUDDEN_DEATH_AT * 30 - 3;
    harness
      .socket()
      .receive(
        selfSnapshot(world, { state: 'wreck', killerId: ENEMY, ticksLeft: 60 }, [event('death', ME, 600, 650, ENEMY)]),
      );
    harness.frames(1);
    expect(partText(harness, '.ffa-death-respawn')).toBe('Снова в бою через 4');
    world.tick = SUDDEN_DEATH_AT * 30;
    harness
      .socket()
      .receive(
        selfSnapshot(world, { state: 'wreck', killerId: ENEMY, ticksLeft: 57, isOut: true }, [
          event('suddenDeath', null, 0, 0),
        ]),
      );
    harness.frames(1);
    expect(partText(harness, '.ffa-death')).toBe('ТЫ ВЫБЫЛ Финал без возрождений — смотрим, кто кого');
    world.tick += 60;
    world.tanks = world.tanks.filter((candidate) => candidate.id !== ME);
    harness.socket().receive(selfSnapshot(world, { state: 'spectator', killerId: ENEMY, ticksLeft: 0 }));
    harness.frames(2);
    expect(harness.state().screen).toBe('spectator');
    expect(partText(harness, '.ffa-death-title')).toBe('ТЫ ВЫБЫЛ');
    expect(isShown(harness, '.ffa-final')).toBe(false);
  });

  it('U8 финал: «ФИНАЛ ЧЕРЕЗ 5…1» по времени матча, событие — «ФИНАЛ!» на 2 с; вошедший в финал — «финал уже идёт»', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)]);
    enterFight(harness, world);
    harness.socket().receive(roster([ME, ENEMY]));
    world.tick = (SUDDEN_DEATH_AT - 5) * 30;
    harness.socket().receive(snapshotOf(world));
    harness.frames(1);
    expect(partText(harness, '.ffa-final')).toBe('ФИНАЛ ЧЕРЕЗ 5 Потом без возрождений');
    world.tick = SUDDEN_DEATH_AT * 30 - 20;
    harness.socket().receive(snapshotOf(world));
    harness.frames(1);
    expect(partText(harness, '.ffa-final')).toBe('ФИНАЛ ЧЕРЕЗ 1 Потом без возрождений');
    world.tick = SUDDEN_DEATH_AT * 30;
    harness.socket().receive(snapshotOf(world, { events: [event('suddenDeath', null, 0, 0)] }));
    harness.frames(1);
    expect(partText(harness, '.ffa-final')).toBe('ФИНАЛ! Подбили — смотришь до конца');
    harness.frames(2 * SECOND_FRAMES);
    expect(isShown(harness, '.ffa-final')).toBe(false);
    const late = makeGame();
    const socket = late.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster());
    socket.receive(state(FfaPhase.Fight, 600));
    socket.receive(matchStart());
    const field = arena([tank(ENEMY, 1400, 650)]);
    field.tick = SUDDEN_DEATH_AT * 30 + 60;
    socket.receive(snapshotOf(field, { state: 'spectator' }));
    late.frames(1);
    expect(partText(late, '.ffa-death')).toBe('ФИНАЛ УЖЕ ИДЁТ Следующий матч — твой');
    expect(isShown(late, '.ffa-final')).toBe(false);
    socket.receive(score([[ENEMY, 1]]));
    socket.receive(state(FfaPhase.Results, 300));
    late.frames(1);
    expect(partText(late, '.ffa-results-title')).toBe('СЛЕДУЮЩИЙ МАТЧ — ТВОЙ');
    expect([...late.hud.querySelectorAll('.ffa-results-row')].map((row) => shownText(row))).toEqual(['1 Вася 1 0 —']);
  });

  it('U9 зритель: за убийцей; касание — следующий по таблице; цель погибла — следующий; живых нет — центр карты', () => {
    const harness = makeGame('', true);
    const world = arena([tank(ENEMY, 1400, 650), tank(6, 500, 300), tank(7, 1700, 1000)]);
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster([ME, ENEMY, 6, 7]));
    socket.receive(state(FfaPhase.Fight, 600));
    socket.receive(matchStart());
    socket.receive(
      scoreRows([
        [7, 5, 0],
        [ENEMY, 3, 0],
        [6, 1, 0],
        [ME, 0, 1],
      ]),
    );
    for (let index = 0; index < 4; index++) {
      step(world);
      socket.receive(selfSnapshot(world, { state: 'spectator', killerId: ENEMY }));
    }
    harness.frames(10);
    const centerOf = (): { x: number; y: number } => harness.state().viewCenter as { x: number; y: number };
    expect(harness.state().spectating).toBe(ENEMY);
    expect(isShown(harness, '.ffa-death')).toBe(true);
    expect(isShown(harness, '.ffa-spectator')).toBe(false);
    for (let elapsed = 0; elapsed < 4 * SECOND_FRAMES; elapsed += 10) {
      step(world);
      socket.receive(selfSnapshot(world, { state: 'spectator', killerId: ENEMY }));
      harness.frames(10);
    }
    expect(isShown(harness, '.ffa-death')).toBe(false);
    expect(partText(harness, '.ffa-spectator')).toBe('Смотришь за: Вася коснись — следующий');
    expect(Math.abs(centerOf().x - 1400)).toBeLessThanOrEqual(250);
    expect(harness.fieldControls).toEqual([false]);
    expect(harness.renderer.last?.controls.sticks).toEqual([]);
    harness.canvas.dispatchEvent(pointer('pointerdown', 300, 300, 'touch'));
    harness.frames(1);
    expect(harness.state().spectating).toBe(6);
    expect(partText(harness, '.ffa-spectator-name')).toBe('БОТ Робот');
    expect(Math.abs(centerOf().x - 500)).toBeLessThanOrEqual(250);
    window.dispatchEvent(pointer('pointerup', 300, 300, 'touch'));
    const target = world.tanks.find((candidate) => candidate.id === 6);
    if (target !== undefined) {
      target.isAlive = false;
      target.hp = 0;
    }
    for (let index = 0; index < 4; index++) {
      step(world);
      socket.receive(selfSnapshot(world, { state: 'spectator', killerId: ENEMY }));
    }
    harness.frames(10);
    expect(harness.state().spectating).toBe(7);
    world.tanks = [];
    for (let index = 0; index < 4; index++) {
      step(world);
      socket.receive(selfSnapshot(world, { state: 'spectator', killerId: ENEMY }));
    }
    harness.frames(30);
    expect(harness.state().spectating).toBeNull();
    expect(centerOf()).toEqual({ x: MAP.width / 2, y: MAP.height / 2 });
    expect(isShown(harness, '.ffa-spectator')).toBe(false);
  });

  it('U9 на компьютере подсказка зрителя — про клик', () => {
    const harness = makeGame();
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster());
    socket.receive(state(FfaPhase.Fight, 600));
    socket.receive(matchStart());
    socket.receive(selfSnapshot(arena([tank(ENEMY, 1400, 650)]), { state: 'spectator', killerId: ENEMY }));
    harness.frames(4);
    expect(partText(harness, '.ffa-spectator-hint')).toBe('клик — следующий');
  });

  it('U10 «Ты тут?»: отсчёт, пока сервер его присылает; перестал — карточка гаснет', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)]);
    enterFight(harness, world);
    step(world);
    harness.socket().receive(selfSnapshot(world, { idleTicksLeft: 265 }));
    harness.frames(1);
    expect(isShown(harness, '.ffa-idle')).toBe(true);
    expect(partText(harness, '.ffa-idle')).toBe('ТЫ ТУТ? Шевельнись — иначе выкинет через 9');
    step(world);
    harness.socket().receive(snapshotOf(world));
    harness.frames(1);
    expect(isShown(harness, '.ffa-idle')).toBe(false);
  });

  it('U12 итоги → следующий матч: итоги держатся до старта матча, затем отсчёт, нулевой счёт, пустые лента и табло', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)]);
    enterFight(harness, world);
    const socket = harness.socket();
    socket.receive(
      scoreRows([
        [ENEMY, 3, 1],
        [ME, 1, 2],
      ]),
    );
    step(world);
    socket.receive(snapshotOf(world, { events: [event('death', 6, 9, 9, ME)] }));
    socket.receive(state(FfaPhase.Results, 150, 1, 7));
    harness.frames(1);
    expect(partText(harness, '.ffa-results-title')).toBe('В СЛЕДУЮЩИЙ РАЗ');
    expect(partText(harness, '.ffa-results-next')).toBe('Следующий матч через 5');
    harness.frames(3 * SECOND_FRAMES);
    expect(partText(harness, '.ffa-results-next')).toBe('Следующий матч через 2');
    socket.receive(state(FfaPhase.Countdown, 90, 2, 7));
    harness.frames(1);
    expect(harness.state().screen).toBe('results');
    expect(isShown(harness, '.ffa-results')).toBe(true);
    socket.receive(matchStart(2));
    socket.receive(
      scoreRows([
        [ENEMY, 0, 0],
        [ME, 0, 0],
      ]),
    );
    socket.receive(snapshotOf(arena([tank(ME, 600, 650), tank(ENEMY, 1400, 650)])));
    harness.frames(1);
    expect(harness.state()).toMatchObject({ screen: 'countdown', feed: [], score: { place: 1, kills: 0, deaths: 0 } });
    expect(isShown(harness, '.ffa-results')).toBe(false);
    expect(partText(harness, '.ffa-countdown')).toBe('3');
    socket.receive(state(FfaPhase.Fight, 3600, 2, 7));
    harness.frames(SECOND_FRAMES);
    expect(harness.state()).toMatchObject({ screen: 'fight', feed: [] });
    expect(isShown(harness, '.ffa-feed')).toBe(false);
    expect(partText(harness, '.ffa-place')).toBe('1-й из 2 подбил 0 · погиб 0');
  });

  it('U12 игроков меньше минимума — «Ждём, пока соберёмся», затем лобби', () => {
    const harness = makeGame();
    enterFight(harness, arena([tank(ME, 600, 650)]));
    harness.socket().receive(state(FfaPhase.Results, 450, 1, 3));
    harness.frames(1);
    expect(partText(harness, '.ffa-results-next')).toBe('Ждём, пока соберёмся');
    harness.socket().receive(state(FfaPhase.Lobby, null, 1, 3));
    harness.frames(1);
    expect(isShown(harness, '.ffa-results')).toBe(false);
    expect(isShown(harness, '.ffa-lobby')).toBe(true);
  });

  it('U14 занято: сам не переподключается; «Играть здесь» входит с пропуском', () => {
    const harness = makeGame();
    enterFight(harness, arena([tank(ME, 600, 650)]));
    harness.socket().receive({ type: MessageType.Error, code: ErrorCode.Replaced, text: 'занято' });
    harness.socket().drop();
    vi.advanceTimersByTime(10_000);
    harness.frames(1);
    expect(harness.sockets).toHaveLength(1);
    expect(statusText(harness)).toBe(
      'ТЫ ИГРАЕШЬ В ДРУГОМ МЕСТЕ Бой открыт в другой вкладке или на другом устройстве. Играть здесь На главную',
    );
    click(harness, '.ffa-fatal', 'Играть здесь');
    expect(harness.sockets).toHaveLength(2);
    harness.socket().open();
    expect(harness.socket().sent[0]).toMatchObject({ type: MessageType.Join, token: 'пропуск' });
  });

  it('U16 «ВЕРНУЛИСЬ!» гаснет через 2 с', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 600, 650)]);
    enterFight(harness, world);
    harness.socket().drop();
    harness.frames(1);
    expect(partText(harness, '.ffa-connection')).toBe('СВЯЗЬ ПРОПАЛА Держим место, возвращаемся…');
    vi.advanceTimersByTime(1000);
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(state(FfaPhase.Fight, 3000));
    socket.receive(matchStart());
    step(world);
    socket.receive(snapshotOf(world));
    harness.frames(1);
    expect(partText(harness, '.ffa-connection')).toBe('ВЕРНУЛИСЬ!');
    harness.frames(2 * SECOND_FRAMES);
    expect(isShown(harness, '.ffa-connection')).toBe(false);
  });

  it('U17 вход на итогах — итоги матча, в котором тебя нет: «СЛЕДУЮЩИЙ МАТЧ — ТВОЙ»', () => {
    const harness = makeGame();
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster([ME, ENEMY, 6]));
    socket.receive(state(FfaPhase.Results, 300, 1, 8));
    socket.receive(matchStart());
    socket.receive(
      scoreRows([
        [6, 4, 0],
        [ENEMY, 2, 3],
      ]),
    );
    harness.frames(1);
    expect(partText(harness, '.ffa-results-title')).toBe('СЛЕДУЮЩИЙ МАТЧ — ТВОЙ');
    expect(hudPart(harness, '.ffa-results-place').hidden).toBe(true);
    expect([...harness.hud.querySelectorAll('.ffa-results-row')].map((row) => shownText(row))).toEqual([
      '1 БОТ Робот 4 0 —',
      '2 Вася 2 3 ×0,7',
    ]);
  });

  it.each([
    [ErrorCode.BadMessage, 'плохое сообщение'],
    [ErrorCode.RoomFull, 'мест нет'],
  ])('U22 ошибка %i — «ЧТО-ТО ПОШЛО НЕ ТАК»; «Ещё раз» входит с пропуском; «На главную» уводит', (code, text) => {
    const harness = makeGame();
    enterFight(harness, arena([tank(ME, 600, 650)]));
    harness.socket().receive({ type: MessageType.Error, code, text });
    harness.frames(1);
    expect(harness.state().screen).toBe('error');
    expect(statusText(harness)).toBe('ЧТО-ТО ПОШЛО НЕ ТАК Сервер нас не понял. Попробуем ещё раз? Ещё раз На главную');
    click(harness, '.ffa-fatal', 'Ещё раз');
    harness.socket().open();
    expect(harness.socket().sent[0]).toMatchObject({ type: MessageType.Join, token: 'пропуск' });
    harness.socket().receive({ type: MessageType.Error, code, text });
    harness.frames(1);
    click(harness, '.ffa-fatal', 'На главную');
    expect(harness.calls).toEqual(['home']);
  });
});

describe('помощники боя', () => {
  interface ArrowState {
    id: number;
  }

  it('стрелки на живых чужих за кадром и линия «на нём» с номером цели в отладке; без линии — стрелки остаются', () => {
    const harness = makeGame();
    enterFight(
      harness,
      arena([tank(ME, 300, 1000), tank(8, 500, 700), tank(ENEMY, 700, 1000), tank(6, 2200, 200), tank(7, 2200, 1200)]),
    );
    harness.frames(2);
    expect((harness.state().arrows as ArrowState[]).map((arrow) => arrow.id)).toEqual([7, 6]);
    expect(harness.state().aimLine).toEqual({ state: 'onTarget', targetId: ENEMY });
    expect(harness.renderer.last?.aimLine?.state).toBe('onTarget');
    expect(harness.renderer.last?.arrows.map((arrow) => arrow.id)).toEqual([7, 6]);

    const lineOff = makeGame('', false, { hasAimLine: false });
    enterFight(lineOff, arena([tank(ME, 300, 1000), tank(ENEMY, 700, 1000), tank(6, 2200, 200)]));
    lineOff.frames(2);
    expect(lineOff.state().aimLine).toBeNull();
    expect((lineOff.state().arrows as ArrowState[]).map((arrow) => arrow.id)).toEqual([6]);
  });

  it('линия без цели на пути — «ничего» без номера; свой танк подбит — ни линии, ни стрелок', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 300, 1000), tank(ENEMY, 700, 1200), tank(6, 2200, 200)]);
    enterFight(harness, world);
    harness.frames(2);
    expect(harness.state().aimLine).toEqual({ state: 'none', targetId: null });
    const own = world.tanks.find((candidate) => candidate.id === ME);
    if (own !== undefined) {
      own.isAlive = false;
      own.hp = 0;
    }
    world.tick++;
    harness.socket().receive(snapshotOf(world, { state: 'wreck', killerId: ENEMY }));
    harness.frames(2);
    expect(harness.state().aimLine).toBeNull();
    expect(harness.state().arrows).toEqual([]);
    expect(harness.renderer.last?.aimLine).toBeNull();
  });

  it('отсчёт со своим живым танком — ни линии, ни стрелок; начался бой — появились', () => {
    const harness = makeGame();
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster([ME, ENEMY, 6]));
    socket.receive(state(FfaPhase.Countdown, 90));
    socket.receive(matchStart());
    socket.receive(snapshotOf(arena([tank(ME, 300, 1000), tank(ENEMY, 700, 1000), tank(6, 2200, 200)])));
    harness.frames(2);
    expect(harness.state()).toMatchObject({ screen: 'countdown', aimLine: null, arrows: [] });
    expect(harness.renderer.last?.aimLine).toBeNull();
    expect(harness.renderer.last?.arrows).toEqual([]);
    socket.receive(state(FfaPhase.Fight, 3600));
    harness.frames(2);
    expect(harness.state()).toMatchObject({ screen: 'fight', aimLine: { state: 'onTarget', targetId: ENEMY } });
    expect((harness.state().arrows as ArrowState[]).map((arrow) => arrow.id)).toEqual([6]);
  });

  it('зритель — ни линии, ни стрелок: враги в кадре цели и за ним', () => {
    const harness = makeGame();
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster([ME, ENEMY, 6, 7]));
    socket.receive(state(FfaPhase.Fight, 600));
    socket.receive(matchStart());
    const world = arena([tank(ENEMY, 300, 1000), tank(6, 700, 1000), tank(7, 2200, 200)]);
    socket.receive(snapshotOf(world, { state: 'spectator', killerId: ENEMY }));
    harness.frames(2);
    expect(harness.state()).toMatchObject({ screen: 'spectator', aimLine: null, arrows: [] });
    expect(harness.renderer.last?.aimLine).toBeNull();
    expect(harness.renderer.last?.arrows).toEqual([]);
  });

  // Башня вверх: окно камеры сдвинуто вверх на 126 и кончается в 576 над танком; оба врага ближе предела огня по цели.
  it('огонь по цели открыт по живому чужому в окне камеры; враг на пути за окном огня не открывает', () => {
    const fired = (enemyY: number): boolean => {
      const harness = makeGame('', false, { hasZoneFire: true });
      enterFight(harness, arena([tank(ME, 1800, 1000, -Math.PI / 2), tank(ENEMY, 1800, enemyY)]));
      harness.game.toggleAutoFire();
      harness.frames(6);
      return harness.socket().inputs.some((input) => input.action.isFiring);
    };
    expect(fired(600)).toBe(true);
    expect(fired(400)).toBe(false);
  });

  // Выстрел в край карты вернётся в свой корпус; враг между танком и краем примет снаряд на себя.
  it('предохранитель при выключенной линии учитывает первый танк на пути: враг перед стеной — выстрел не сдержан', () => {
    const shoot = (tanks: Tank[]): { isFiring: boolean; isGuarded: boolean } => {
      const harness = makeGame('', false, { hasRicochetGuard: true, hasAimLine: false });
      enterFight(harness, arena(tanks));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
      harness.frames(6);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
      return {
        isFiring: harness.socket().inputs.some((input) => input.action.isFiring),
        isGuarded: harness.renderer.last?.controls.isShotGuarded ?? false,
      };
    };
    expect(shoot([tank(ME, 260, 1000, Math.PI), tank(ENEMY, 120, 1000)])).toEqual({ isFiring: true, isGuarded: false });
    expect(shoot([tank(ME, 260, 1000, Math.PI), tank(ENEMY, 260, 400)])).toEqual({ isFiring: false, isGuarded: true });
  });

  it('«упреждаю» в толпе не показывается даже с флажком упреждения', () => {
    const harness = makeGame('', false, { hasLeadHint: true });
    const crossing = tank(ENEMY, 700, 900, Math.PI / 2);
    crossing.speed = 150;
    const world = arena([tank(ME, 300, 1000), crossing]);
    enterFight(harness, world);
    harness.frames(2);
    const seen = snapshotOf(world).tanks.find((candidate) => candidate.id === ENEMY);
    if (seen === undefined) {
      throw new Error('врага нет в снимке');
    }
    const lead = enemyLeadPoint({ x: 300, y: 1000 }, seen, deriveStats(DEFAULT_STATS).bulletSpeed);
    expect(Math.abs((lead?.y ?? 0) - 1000)).toBeLessThan(TANK_HIT_RADIUS);
    expect(Math.abs(seen.y - 1000)).toBeGreaterThan(TANK_HIT_RADIUS);
    expect(harness.state().aimLine).toEqual({ state: 'none', targetId: null });
  });
});

describe('звук толпы', () => {
  const SHOT_GAIN = 0.32;

  function gains(): number[] {
    return audio.outputs.map((output) => output.gain);
  }

  function unlockedGame(): Harness {
    const harness = makeGame();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ' }));
    return harness;
  }

  // Башня вправо: точка камеры — в 240 правее танка.
  it('свой танк на поле — громкость от него; вне кадра — тишина', () => {
    const harness = unlockedGame();
    const world = arena([tank(ME, 300, 1000), tank(ENEMY, 700, 1200)]);
    enterFight(harness, world);
    step(world);
    harness.socket().receive(
      snapshotOf(world, {
        events: [event('shot', ENEMY, 300, 1000), event('shot', ENEMY, 540, 1000), event('shot', ENEMY, 2200, 200)],
      }),
    );
    harness.frames(PICTURE_FRAMES);
    expect(gains()).toEqual([SHOT_GAIN, SHOT_GAIN * (1 - (0.75 * 240) / 918)]);
  });

  it('свой танк подбит — громкость от точки камеры', () => {
    const harness = unlockedGame();
    const world = arena([tank(ME, 300, 1000), tank(ENEMY, 700, 1200)]);
    enterFight(harness, world);
    harness.frames(CAMERA_SETTLE_FRAMES);
    const own = world.tanks.find((candidate) => candidate.id === ME);
    if (own !== undefined) {
      own.isAlive = false;
      own.hp = 0;
    }
    step(world);
    harness.socket().receive(snapshotOf(world, { state: 'wreck', killerId: ENEMY }));
    harness.frames(1);
    const center = harness.state().viewCenter as { x: number; y: number };
    step(world);
    harness.socket().receive(
      snapshotOf(world, {
        state: 'wreck',
        killerId: ENEMY,
        events: [event('shot', ENEMY, center.x, center.y), event('shot', ENEMY, center.x - 459, center.y)],
      }),
    );
    harness.frames(PICTURE_FRAMES);
    expect(gains()).toEqual([SHOT_GAIN, SHOT_GAIN * 0.625]);
  });

  it('зритель — громкость от цели, а не от точки камеры', () => {
    const harness = unlockedGame();
    const world = arena([tank(ENEMY, 1400, 650)]);
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster([ME, ENEMY]));
    socket.receive(state(FfaPhase.Fight, 600));
    socket.receive(matchStart());
    for (let index = 0; index < 4; index++) {
      step(world);
      socket.receive(snapshotOf(world, { state: 'spectator', killerId: ENEMY }));
    }
    harness.frames(10);
    expect(harness.state().spectating).toBe(ENEMY);
    const center = harness.state().viewCenter as { x: number; y: number };
    expect(center.x).toBeCloseTo(1640, 0);
    step(world);
    socket.receive(
      snapshotOf(world, {
        state: 'spectator',
        killerId: ENEMY,
        events: [event('shot', 6, 1400, 650), event('shot', 6, center.x, center.y)],
      }),
    );
    harness.frames(PICTURE_FRAMES);
    expect(gains()).toEqual([SHOT_GAIN, SHOT_GAIN * (1 - (0.75 * Math.hypot(center.x - 1400, center.y - 650)) / 918)]);
  });

  it('не больше 8 голосов: девятый чужой молчит, свой вытесняет самый старый чужой; отзвучавшие освобождают место', () => {
    const harness = unlockedGame();
    const world = arena([tank(ME, 300, 1000), tank(ENEMY, 700, 1200)]);
    enterFight(harness, world);
    step(world);
    const others = Array.from({ length: 12 }, () => event('shot', ENEMY, 700, 1200));
    harness.socket().receive(snapshotOf(world, { events: others }));
    harness.frames(PICTURE_FRAMES);
    expect(audio.outputs).toHaveLength(8);
    expect(harness.state().voices).toBe(8);
    step(world);
    harness.socket().receive(snapshotOf(world, { events: [event('shot', ME, 300, 1000)] }));
    harness.frames(1);
    expect(audio.outputs).toHaveLength(9);
    expect(audio.released).toEqual([audio.outputs[0]]);
    expect(harness.state().voices).toBe(8);
    clock += SOUND_DURATIONS.shot * 1000;
    expect(harness.state().voices).toBe(0);
  });
});

describe('картинка совпадает с сервером', () => {
  const ENEMY_GAS: Action = { ...IDLE_ACTION, throttle: 1 };

  function enemyDrives(world: World): void {
    stepWorld(
      world,
      world.tanks.map((candidate) => (candidate.id === ENEMY ? ENEMY_GAS : IDLE_ACTION)),
    );
  }

  it('попадание по чужому танку — не в кадре снимка, а когда до него дошла картинка; точка — на нарисованном танке', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 300, 1000), tank(ENEMY, 700, 1000)]);
    enterFight(harness, world);
    const socket = harness.socket();
    for (let index = 0; index < 10; index++) {
      enemyDrives(world);
      socket.receive(snapshotOf(world));
      harness.frames(2);
    }
    const onEvent = vi.spyOn(harness.effects, 'onEvent');
    const hits = (): FfaSnapshotEvent[] =>
      onEvent.mock.calls.map(([fx]) => fx as FfaSnapshotEvent).filter((fx) => fx.kind === 'hit');
    enemyDrives(world);
    const enemyOnServer = world.tanks.find((candidate) => candidate.id === ENEMY) ?? tank(ENEMY, 0, 0);
    const hit = event('hit', ENEMY, enemyOnServer.x - 20, enemyOnServer.y + 5, ME);
    socket.receive(snapshotOf(world, { events: [hit] }));
    harness.frames(1);
    expect(hits()).toEqual([]);
    let waited = 1;
    while (hits().length === 0 && waited < PICTURE_FRAMES * 2) {
      harness.frames(1);
      waited++;
    }
    expect(waited).toBeGreaterThan(1);
    const drawn = (harness.state().others as { id: number; x: number; y: number }[]).find(
      (other) => other.id === ENEMY,
    );
    expect(drawn?.x).toBeLessThan(enemyOnServer.x);
    // Точка события в протоколе — f32: совпадение до тысячных.
    expect(hits()[0]?.x).toBeCloseTo(hit.x + (drawn?.x ?? NaN) - enemyOnServer.x, 3);
    expect(hits()[0]?.y).toBeCloseTo(hit.y + (drawn?.y ?? NaN) - enemyOnServer.y, 3);
  });

  it('F4 свой выстрел убил чужой танк в кадре — эффекты гибели получают номер своего фрага, когда дошла картинка', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 300, 1000), tank(ENEMY, 700, 1000)]);
    enterFight(harness, world);
    const socket = harness.socket();
    for (let index = 0; index < 10; index++) {
      step(world);
      socket.receive(snapshotOf(world));
      harness.frames(2);
    }
    const onEvent = vi.spyOn(harness.effects, 'onEvent');
    const enemy = world.tanks.find((candidate) => candidate.id === ENEMY) ?? tank(ENEMY, 0, 0);
    enemy.isAlive = false;
    enemy.hp = 0;
    step(world);
    socket.receive(snapshotOf(world, { events: [event('death', ENEMY, enemy.x, enemy.y, ME)] }));
    for (let waited = 0; waited < PICTURE_FRAMES * 2 && onEvent.mock.calls.length === 0; waited++) {
      harness.frames(1);
    }
    expect(onEvent.mock.calls.map(([fx, options]) => [fx.kind, options.ownKillCount])).toEqual([['death', 1]]);
  });

  it('попадание по своему танку — в первом же кадре', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 300, 1000), tank(ENEMY, 700, 1000)]);
    enterFight(harness, world);
    const onEvent = vi.spyOn(harness.effects, 'onEvent');
    step(world);
    harness.socket().receive(snapshotOf(world, { events: [event('hit', ME, 320, 1000, ENEMY)] }));
    harness.frames(1);
    expect(onEvent.mock.calls.map(([fx]) => fx.kind)).toEqual(['hit']);
  });

  it('смертельное попадание по своему танку — в первом же кадре, хотя своего танка на поле уже нет', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 1300, 650), tank(ENEMY, 1700, 650)]);
    enterFight(harness, world);
    const onEvent = vi.spyOn(harness.effects, 'onEvent');
    const me = world.tanks.find((candidate) => candidate.id === ME) ?? tank(ME, 0, 0);
    me.isAlive = false;
    me.hp = 0;
    step(world);
    harness
      .socket()
      .receive(
        snapshotOf(world, { events: [event('hit', ME, 1320, 650, ENEMY), event('death', ME, 1300, 650, ENEMY)] }),
      );
    harness.frames(1);
    expect(onEvent.mock.calls.map(([fx]) => fx.kind)).toEqual(['hit', 'death']);
  });

  it('событие у чужого танка, которое не сыграло за 500 мс (кадры стояли), выброшено молча', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 300, 1000), tank(ENEMY, 700, 1000)]);
    enterFight(harness, world);
    harness.frames(6);
    const onEvent = vi.spyOn(harness.effects, 'onEvent');
    step(world);
    harness.socket().receive(snapshotOf(world, { events: [event('hit', ENEMY, 690, 1000, ME)] }));
    clock += EVENT_MAX_WAIT_MS;
    harness.frames(PICTURE_FRAMES);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('кадр в отладке: тики своего танка и чужих, свой танк и снаряды с тиком картинки', () => {
    const harness = makeGame();
    const world = arena([tank(ME, 300, 1000), tank(ENEMY, 700, 1000, Math.PI)]);
    enterFight(harness, world);
    stepWorld(
      world,
      world.tanks.map((candidate) => (candidate.id === ENEMY ? { ...IDLE_ACTION, isFiring: true } : IDLE_ACTION)),
    );
    harness
      .socket()
      .receive(snapshotOf(world, { changes: { births: world.bullets.map(bulletSnapshot), bounces: [], deaths: [] } }));
    harness.frames(PICTURE_FRAMES);
    const picture = harness.state().picture as {
      myTick: number;
      othersTick: number;
      me: { x: number; y: number } | null;
      bullets: { id: number; owner: number; tick: number }[];
    };
    expect(picture.me).toEqual({ x: 300, y: 1000 });
    expect(picture.myTick).toBeGreaterThanOrEqual(picture.othersTick);
    expect(picture.bullets).toEqual([expect.objectContaining({ owner: ENEMY, tick: picture.othersTick })]);
  });

  function inputsAfterSnapshot(hasSpareInput: boolean): number {
    const harness = makeGame();
    const world = arena([tank(ME, 300, 1000), tank(ENEMY, 700, 1000)]);
    enterFight(harness, world);
    const socket = harness.socket();
    harness.frames(10);
    step(world);
    socket.receive(snapshotOf(world, { ackSeq: socket.inputs.length, hasSpareInput }));
    const before = socket.inputs.length;
    harness.frames(20);
    step(world);
    socket.receive(snapshotOf(world, { ackSeq: before, hasSpareInput }));
    harness.frames(20);
    return socket.inputs.length - before;
  }

  it('снимок с запасом команд — пропущен ровно один шаг ввода; повтор флага до подтверждения — без пропуска', () => {
    expect(inputsAfterSnapshot(true)).toBe(inputsAfterSnapshot(false) - 1);
  });
});
