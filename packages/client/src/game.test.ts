import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRound,
  DEFAULT_RULES,
  DEFAULT_STATS,
  IDLE_ACTION,
  stepRound,
  type Action,
  type Round,
} from '@tanks/shared/engine';
import {
  decode,
  encode,
  MessageType,
  type ClientMessage,
  type InputMessage,
  type ServerMessage,
  type SnapshotEvent,
  type SnapshotMessage,
} from '@tanks/shared/protocol';
import { DiagLog } from './diag.js';
import { Game, type DuelRendererLike } from './game.js';
import type { SocketLike } from './net.js';
import type { Camera } from './render/camera.js';
import { Effects } from './render/effects.js';
import { PREDICTED_BULLET_ID_BASE } from './predictedShots.js';
import { StampDecals } from './render/stampDecals.js';
import { defaultSettings } from './settings.js';
import { Sfx } from './sfx.js';
import { Telemetry } from './telemetry.js';
import { installFakeAudio, type FakeAudio } from './testing/fakeAudio.js';

const FRAME_MS = 1000 / 60;
const TICK_MS = 1000 / 30;
// Кадров, за которые картинка противника (отставание два тика) доходит до тика последнего снимка.
const PICTURE_FRAMES = 6;
const MAP_INDEX = 0;
const DEVICE_ID = 'abcdefghjk23456789mnpqrs';
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

  send(data: Uint8Array): void {
    this.sent.push(decode(data) as ClientMessage);
  }

  close(): void {
    this.readyState = 3;
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

  get inputs(): InputMessage[] {
    return this.sent.filter((message): message is InputMessage => message.type === MessageType.Input);
  }
}

const CAMERA: Camera = { x: 0, y: 0, width: 1600, height: 900, scale: 0.8 };

class FakeRenderer implements DuelRendererLike {
  readonly currentCamera = CAMERA;
  readonly activeCameraMode = 'fixed' as DuelRendererLike['activeCameraMode'];

  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    return { x: clientX, y: clientY };
  }

  resetCamera(): void {
    return undefined;
  }

  draw(): void {
    return undefined;
  }
}

// mine — действие своего танка на сервере в этом тике.
interface Harness {
  socket: FakeSocket;
  sfx: Sfx;
  diag: DiagLog;
  effects: Effects;
  round: Round;
  frames: (count: number) => void;
  snapshot: (details?: { events?: SnapshotEvent[]; hasSpareInput?: boolean; mine?: Action }) => void;
}

let clock = 1000;
let pendingFrame: ((now: number) => void) | null = null;
let audio: FakeAudio;
const games: Game[] = [];

function setHidden(isHidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', { value: isHidden ? 'hidden' : 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

function snapshotOf(round: Round, ackSeq: number, events: SnapshotEvent[], hasSpareInput: boolean): SnapshotMessage {
  return {
    type: MessageType.Snapshot,
    tick: round.tick,
    gameTick: round.tick,
    ackSeq,
    hasSpareInput,
    isOver: round.isOver,
    winner: round.winner,
    endReason: round.endReason,
    zoneRadius: round.zone.radius,
    tanks: [round.tanks[0], round.tanks[1]].map((tank) => ({
      x: tank.x,
      y: tank.y,
      heading: tank.heading,
      turret: tank.turret,
      speed: tank.speed,
      hp: tank.hp,
      reloadLeft: tank.reloadLeft,
      isAlive: tank.isAlive,
    })) as SnapshotMessage['tanks'],
    bullets: round.bullets.map((bullet) => ({
      id: bullet.id,
      owner: bullet.owner === 0 ? 0 : 1,
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
      bouncesLeft: bullet.bouncesLeft,
      hasBounced: bullet.hasBounced,
      age: bullet.age,
    })),
    kits: round.kits.map((kit) => ({ isActive: kit.isActive, respawnIn: kit.respawnIn })),
    events,
  };
}

// Дуэль за стороной 0 до первого снимка боя: приветствие, старт раунда, снимок тика 1.
function startDuel(): Harness {
  document.body.innerHTML = '';
  const canvas = document.createElement('canvas');
  const overlay = document.createElement('div');
  const roundEnd = document.createElement('div');
  document.body.append(canvas, overlay, roundEnd);
  let socket: FakeSocket | null = null;
  let effects: Effects | null = null;
  const sfx = new Sfx(() => document.visibilityState === 'hidden');
  const diag = new DiagLog('test', { post: () => Promise.resolve(true), beacon: () => true });
  const game = new Game(
    {
      roomCode: 'test',
      nickname: 'Дима',
      canvas,
      overlay,
      roundEnd,
      onAutoFireChange: () => undefined,
      settings: { ...defaultSettings(), hasRicochetGuard: false },
      isTouchDevice: false,
      deviceId: DEVICE_ID,
      telemetry: new Telemetry(CLIENT_INFO, { beacon: () => true }),
    },
    {
      url: 'ws://test/ws',
      createSocket: () => {
        socket = new FakeSocket();
        return socket;
      },
      createEffects: (names) => {
        effects = new Effects(
          new StampDecals(),
          () => '#ffffff',
          (id) => names()[id === 0 ? 0 : 1],
        );
        return effects;
      },
      createRenderer: () => new FakeRenderer(),
      createSfx: () => sfx,
      createDiag: () => diag,
      now: () => clock,
      requestFrame: (callback) => {
        pendingFrame = callback;
      },
    },
  );
  games.push(game);
  const opened = socket as FakeSocket | null;
  const created = effects as Effects | null;
  if (opened === null || created === null) {
    throw new Error('сокет или эффекты не созданы');
  }
  opened.open();
  const round = createRound(MAP_INDEX, [
    { name: 'Дима', stats: DEFAULT_STATS },
    { name: 'Бублик', stats: DEFAULT_STATS },
  ]);
  opened.receive({ type: MessageType.Welcome, side: 0, roomCode: 'test' });
  opened.receive({
    type: MessageType.RoundStart,
    gameId: 'K7QX',
    roundIndex: 0,
    mapIndex: MAP_INDEX,
    countdownTicks: 0,
    score: [0, 0],
    rules: { ...DEFAULT_RULES },
    tanks: [
      { nickname: 'Дима', stats: { ...DEFAULT_STATS } },
      { nickname: 'Бублик', stats: { ...DEFAULT_STATS } },
    ],
  });
  const harness: Harness = {
    socket: opened,
    sfx,
    diag,
    effects: created,
    round,
    frames: (count) => {
      for (let index = 0; index < count; index++) {
        clock += FRAME_MS;
        const frame = pendingFrame;
        pendingFrame = null;
        frame?.(clock);
      }
    },
    snapshot: (details = {}) => {
      stepRound(round, [details.mine ?? IDLE_ACTION, IDLE_ACTION]);
      opened.receive(
        snapshotOf(round, opened.inputs.at(-1)?.seq ?? 0, details.events ?? [], details.hasSpareInput ?? false),
      );
    },
  };
  harness.snapshot();
  harness.frames(PICTURE_FRAMES);
  return harness;
}

function enemyHit(round: Round): SnapshotEvent {
  const enemy = round.tanks[1];
  return { kind: 'hit', side: 1, x: enemy.x - 20, y: enemy.y, value: 28, dx: 1, dy: 0, flags: 0 };
}

beforeEach(() => {
  audio = installFakeAudio();
  clock = 1000;
  pendingFrame = null;
  setHidden(false);
});

afterEach(() => {
  for (const game of games.splice(0)) {
    game.close();
  }
  audio.restore();
  vi.restoreAllMocks();
});

describe('проводка дуэли', () => {
  it('строка устройства в журнале кончается номером устройства', () => {
    const write = vi.spyOn(DiagLog.prototype, 'write');
    startDuel();
    const device = write.mock.calls.map(([line]) => line).find((line) => line.startsWith('device '));
    expect(device).toMatch(new RegExp(` touch=0 dev=${DEVICE_ID}$`));
  });

  it('снимок с запасом команд — один шаг ввода пропущен: команда не уходит, в журнале `in skip`', () => {
    const inputsOver = (hasSpareInput: boolean): { inputs: number; skips: string[] } => {
      const harness = startDuel();
      const write = vi.spyOn(harness.diag, 'write');
      harness.snapshot({ hasSpareInput });
      const before = harness.socket.inputs.length;
      harness.frames(30);
      const seqs = harness.socket.inputs.slice(before).map((input) => input.seq);
      expect(seqs).toEqual(seqs.map((_seq, index) => (seqs[0] ?? 0) + index));
      const skips = write.mock.calls.map(([line]) => line).filter((line) => line.startsWith('in skip'));
      return { inputs: harness.socket.inputs.length - before, skips };
    };
    const plain = inputsOver(false);
    const spare = inputsOver(true);
    expect(spare.inputs).toBe(plain.inputs - 1);
    expect(plain.skips).toEqual([]);
    expect(spare.skips).toHaveLength(1);
    expect(spare.skips[0]).toMatch(/^in skip next=\d+$/);
  });

  it('попадание по противнику уходит в звук не в кадре снимка, а когда до него дошла картинка противника', () => {
    const harness = startDuel();
    for (let index = 0; index < 10; index++) {
      harness.snapshot();
      harness.frames(2);
    }
    const events = vi.spyOn(harness.sfx, 'events');
    harness.snapshot({ events: [enemyHit(harness.round)] });
    harness.frames(1);
    const played = (): string[] => events.mock.calls.flatMap(([due]) => due.map((event) => event.kind));
    expect(played()).toEqual([]);
    harness.frames(PICTURE_FRAMES);
    expect(played()).toEqual(['hit']);
  });

  it('события, пришедшие в скрытую вкладку, после возврата не играются; новые — играются', () => {
    const harness = startDuel();
    const events = vi.spyOn(harness.sfx, 'events');
    setHidden(true);
    for (let index = 0; index < 30; index++) {
      clock += TICK_MS;
      harness.snapshot({ events: [enemyHit(harness.round)] });
    }
    setHidden(false);
    harness.frames(PICTURE_FRAMES * 3);
    const played = (): string[] => events.mock.calls.flatMap(([due]) => due.map((event) => event.kind));
    expect(played()).toEqual([]);
    expect(audio.outputs).toHaveLength(0);
    harness.snapshot({ events: [enemyHit(harness.round)] });
    harness.frames(PICTURE_FRAMES);
    expect(played()).toEqual(['hit']);
  });

  it('свой выстрел подтверждён: хвост снаряда переходит с номера предсказания на номер сервера', () => {
    const harness = startDuel();
    const rename = vi.spyOn(harness.effects, 'renameTrail');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    harness.frames(2);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
    const shot = harness.socket.inputs.find((input) => input.action.isFiring);
    if (shot === undefined) {
      throw new Error('выстрел не ушёл');
    }
    harness.snapshot({ mine: shot.action });
    const serverId = harness.round.bullets.find((bullet) => bullet.owner === 0)?.id;
    expect(serverId).toBeDefined();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith(shot.seq + PREDICTED_BULLET_ID_BASE, serverId);
  });
});
