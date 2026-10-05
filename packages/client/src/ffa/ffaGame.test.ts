import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorld,
  DEFAULT_RULES,
  DEFAULT_STATS,
  ffaMap,
  ffaViewReach,
  FFA,
  IDLE_ACTION,
  makeTank,
  normalizeAngle,
  stepWorld,
  type Action,
  type FfaPlayerState,
  type Tank,
  type World,
} from '@tanks/shared/engine';
import {
  BulletTracker,
  decode,
  encode,
  ErrorCode,
  FfaPhase,
  MessageType,
  type ClientMessage,
  type FfaSnapshotEvent,
  type InputMessage,
  type ServerMessage,
} from '@tanks/shared/protocol';
import { DiagLog } from '../diag.js';
import type { SocketLike } from '../net.js';
import { Effects } from '../render/effects.js';
import type { FfaDrawInput } from '../render/ffaRenderer.js';
import { StampDecals } from '../render/stampDecals.js';
import { defaultSettings } from '../settings.js';
import { Sfx } from '../sfx.js';
import { Telemetry } from '../telemetry.js';
import { installFakeAudio, type SoundOutput } from '../testing/fakeAudio.js';
import { snapshotOf } from '../testing/ffaServer.js';
import { FfaGame, type FfaRendererLike, type TokenStore } from './ffaGame.js';
import { PREDICTED_BULLET_ID_BASE } from './ffaPrediction.js';

const ME = 4;
const ENEMY = 5;
const SIZE = 10;
const MAP = ffaMap(SIZE);
const SCREEN = { width: 1280, height: 720, pixelRatio: 1 };
const FRAME_MS = 1000 / 60;
const TICK_MS = 1000 / 30;
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
  last: FfaDrawInput | null = null;

  draw(input: FfaDrawInput): void {
    this.last = input;
  }
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
  fieldControls: boolean[];
  socket: () => FakeSocket;
  frames: (count: number) => void;
  state: () => Record<string, unknown>;
}

let clock = 0;
let pendingFrame: ((now: number) => void) | null = null;

// Страница боя как в index.html: холст, корень интерфейса толпы и панель настроек — соседи.
function makeGame(storedToken = '', isAdmin = false): Harness {
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
  const fieldControls: boolean[] = [];
  let effects = null as Effects | null;
  const game = new FfaGame(
    {
      size: SIZE,
      nickname: 'Дима',
      stats: DEFAULT_STATS,
      canvas,
      hud,
      settings: { ...defaultSettings(), hasRicochetGuard: false },
      isTouchDevice: false,
      isAdmin,
      telemetry: new Telemetry(CLIENT_INFO, { beacon: () => true }),
      onAutoFireChange: () => undefined,
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
      createDiag: (roomCode) => new DiagLog(roomCode, { post: () => Promise.resolve(true), beacon: () => true }),
      now: () => clock,
      requestFrame: (callback) => {
        pendingFrame = callback;
      },
      tokens: store,
      goHome: () => calls.push('home'),
      reload: () => calls.push('reload'),
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
    fieldControls,
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

function welcome(playerId = ME, token = 'пропуск'): ServerMessage {
  return { type: MessageType.FfaWelcome, playerId, token, gameId: 'K7QX', size: SIZE, rules: DEFAULT_RULES };
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
): ServerMessage {
  return { type: MessageType.FfaState, phase, ticksLeft, players: 2, capacity: SIZE, minimum: 7, matchIndex };
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
  return harness.hud.textContent;
}

function pointer(kind: string, x: number, y: number, type: 'mouse' | 'touch'): PointerEvent {
  return new PointerEvent(kind, { pointerId: 7, pointerType: type, clientX: x, clientY: y, button: 0, bubbles: true });
}

function setHidden(isHidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', { value: isHidden ? 'hidden' : 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

let audio: { outputs: SoundOutput[]; restore: () => void };

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
    expect(harness.state()).toMatchObject({ screen: 'countdown', me: { x: 500, y: 600 } });
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

  it('возврат в тот же матч сохраняет ленту, следы, эффекты и первую кровь', () => {
    const { harness, world } = fighting();
    const first = harness.socket();
    const onEvent = vi.spyOn(harness.effects, 'onEvent');
    first.receive(
      score([
        [ME, 0],
        [ENEMY, 0],
      ]),
    );
    step(world);
    first.receive(snapshotOf(world, { events: [event('death', 6, 900, 650, ME)] }));
    expect(onEvent.mock.calls.map(([, options]) => options.announcement)).toContain('firstBlood');
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
    onEvent.mockClear();
    step(world);
    second.receive(snapshotOf(world, { events: [event('death', ENEMY, 900, 650, ME)] }));
    expect(onEvent.mock.calls.map(([, options]) => options.announcement)).not.toContain('firstBlood');
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
    socket.receive(snapshotOf(world, { state: 'wreck', killerId: ENEMY }));
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
    expect(audio.outputs.length).toBeGreaterThan(0);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
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
    harness.frames(30);
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
    const buttons = [...harness.hud.querySelectorAll('button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['Вернуться в бой', 'На главную']);
    buttons[0]?.click();
    expect(harness.sockets).toHaveLength(2);
    harness.socket().open();
    expect(harness.socket().sent[0]).toMatchObject({ type: MessageType.Join, token: '' });
    harness.socket().receive({ type: MessageType.Error, code: ErrorCode.Replaced, text: 'занято' });
    harness.frames(1);
    const replaced = [...harness.hud.querySelectorAll('button')];
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
    harness.hud.querySelector('button')?.click();
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
    const exit = element(harness.hud, 'button');
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
    const card = element(harness.hud, '.ffa-status');
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

describe('первая кровь', () => {
  function announcementsAfterOwnKill(rowsAtJoin: readonly (readonly [number, number])[]): unknown[] {
    const harness = makeGame();
    const onEvent = vi.spyOn(harness.effects, 'onEvent');
    const socket = harness.socket();
    socket.open();
    socket.receive(welcome());
    socket.receive(roster([ME, ENEMY, 6]));
    socket.receive(state(FfaPhase.Fight, 3000));
    socket.receive(matchStart());
    socket.receive(score(rowsAtJoin));
    const world = arena([tank(ME, 600, 650), tank(ENEMY, 900, 650), tank(6, 1000, 650)]);
    step(world);
    socket.receive(snapshotOf(world));
    harness.frames(1);
    step(world);
    socket.receive(snapshotOf(world, { events: [event('death', 6, 1000, 650, ME)] }));
    return onEvent.mock.calls.map(([, options]) => options.announcement);
  }

  it('вошедший в идущий матч, где уже убивали, своё первое убийство «ПЕРВОЙ КРОВЬЮ» не объявляет', () => {
    expect(
      announcementsAfterOwnKill([
        [ENEMY, 1],
        [ME, 0],
        [6, 0],
      ]),
    ).not.toContain('firstBlood');
  });

  it('в матче без убийств своё первое убийство — «ПЕРВАЯ КРОВЬ»', () => {
    expect(
      announcementsAfterOwnKill([
        [ENEMY, 0],
        [ME, 0],
        [6, 0],
      ]),
    ).toContain('firstBlood');
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

  it('строка отладки: игроку — только игра и таймкод, админу — полная', () => {
    const player = makeGame();
    enterFight(player, arena([tank(ME, 600, 650)]));
    expect(player.renderer.last?.isFullReadout).toBe(false);
    const admin = makeGame('', true);
    enterFight(admin, arena([tank(ME, 600, 650)]));
    expect(admin.renderer.last?.isFullReadout).toBe(true);
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
