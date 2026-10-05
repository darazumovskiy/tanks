import {
  createRound,
  DEFAULT_RULES,
  DEFAULT_STATS,
  deriveStats,
  TICK_RATE,
  type Round,
  type Side,
} from '@tanks/shared/engine';
import {
  EventFlag,
  MessageType,
  type RoundStartMessage,
  type SnapshotEvent,
  type TankSnapshot,
} from '@tanks/shared/protocol';
import { describe, expect, it } from 'vitest';
import { countdownSeconds, DuelPresenter, type DuelFrameInput } from './duelPresenter.js';
import type { InterpolatedTank, WorldView } from './prediction.js';
import type { Camera } from './render/camera.js';
import type { DecalLayer } from './render/decals.js';
import { Effects, type FxEvent, type FxEventOptions, type FxTank } from './render/effects.js';
import type { HudInfo, Overlay } from './render/renderer.js';
import { defaultSettings, type Settings } from './settings.js';

const FIELD_CAMERA: Camera = { x: 0, y: 0, width: 1600, height: 900, scale: 1 };
// Окно у левого края верхней полосы: противник справа на ней не виден.
const NARROW_CAMERA: Camera = { x: 0, y: 0, width: 400, height: 225, scale: 1 };
const COUNTDOWN_TICKS = 3 * TICK_RATE;
const COUNTDOWN_S = 3;
const FULL_HP = deriveStats(DEFAULT_STATS).maxHp;
// На верхней полосе «Полигона» между танками стен нет.
const LANE_ME = { x: 240, y: 100, heading: 0, turret: 0 };
const LANE_ENEMY = { x: 1180, y: 100, heading: Math.PI, turret: Math.PI };
const READOUT = { rttMs: 46, correctionPx: 0.4, fps: 60, worstFrameMs: 19, isMuted: true, frameTimes: [16, 17] };
const CONTROLS = { sticks: [], isShotGuarded: true, isZoneFiring: false, isReversing: true };

interface FakeRenderer {
  currentCamera: Camera;
  resetCamera: () => void;
  draw: (view: WorldView, hud: HudInfo, overlay: Overlay) => void;
  drawn: { hud: HudInfo; overlay: Overlay }[];
}

function fakeRenderer(log: string[], camera = FIELD_CAMERA): FakeRenderer {
  const drawn: FakeRenderer['drawn'] = [];
  return {
    currentCamera: camera,
    resetCamera: (): void => {
      log.push('resetCamera');
    },
    draw: (_view, hud, overlay): void => {
      drawn.push({ hud, overlay });
    },
    drawn,
  };
}

interface RecordedEffects {
  reset: () => void;
  onSnapshot: (tick: number, tanks: readonly TankSnapshot[]) => void;
  onEvent: (event: FxEvent, options: FxEventOptions) => void;
  update: (dt: number, tanks: readonly FxTank[]) => void;
  events: { event: FxEvent; options: FxEventOptions }[];
  updates: FxTank[][];
}

function recordedEffects(log: string[]): RecordedEffects {
  const events: RecordedEffects['events'] = [];
  const updates: RecordedEffects['updates'] = [];
  return {
    reset: (): void => {
      log.push('reset');
    },
    onSnapshot: (tick): void => {
      log.push(`snapshot ${String(tick)}`);
    },
    onEvent: (event, options): void => {
      log.push(`event ${event.kind}`);
      events.push({ event, options });
    },
    update: (_dt, tanks): void => {
      updates.push([...tanks]);
    },
    events,
    updates,
  };
}

function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...defaultSettings(), ...overrides };
}

function tankView(round: Round, side: Side): InterpolatedTank {
  const tank = round.tanks[side];
  return {
    x: tank.x,
    y: tank.y,
    heading: tank.heading,
    turret: tank.turret,
    speed: tank.speed,
    hp: tank.hp,
    maxHp: tank.stats.maxHp,
    isAlive: tank.isAlive,
  };
}

function laneView(
  enemyOverrides: Partial<InterpolatedTank> = {},
  meOverrides: Partial<InterpolatedTank> = {},
): WorldView {
  const round = createRound(0, [
    { name: 'Дима', stats: { ...DEFAULT_STATS } },
    { name: 'Бублик', stats: { ...DEFAULT_STATS } },
  ]);
  Object.assign(round.tanks[0], LANE_ME);
  Object.assign(round.tanks[1], LANE_ENEMY);
  return {
    round,
    tanks: [
      { ...tankView(round, 0), ...meOverrides },
      { ...tankView(round, 1), ...enemyOverrides },
    ],
    bullets: [],
  };
}

function roundStart(): RoundStartMessage {
  return {
    type: MessageType.RoundStart,
    gameId: 'K7QX',
    roundIndex: 2,
    mapIndex: 0,
    countdownTicks: COUNTDOWN_TICKS,
    score: [1, 0],
    rules: { ...DEFAULT_RULES },
    tanks: [
      { nickname: 'Дима', stats: { ...DEFAULT_STATS } },
      { nickname: 'Бублик', stats: { ...DEFAULT_STATS } },
    ],
  };
}

function frameInput(overrides: Partial<DuelFrameInput> = {}): DuelFrameInput {
  const view = laneView();
  return {
    view,
    roundStart: roundStart(),
    sinceRoundStartS: 40,
    gameTick: 1234,
    mySide: 0,
    isFighting: true,
    visibleEnemy: view.tanks[1],
    frameMs: 16,
    readout: READOUT,
    controls: CONTROLS,
    ...overrides,
  };
}

function duelEvent(kind: SnapshotEvent['kind'], side: Side | null, flags = 0): SnapshotEvent {
  return { kind, side, x: 300, y: 200, value: 28, dx: 1, dy: 0, flags };
}

function snapshotTanks(): TankSnapshot[] {
  return [0, 1].map(() => ({ x: 0, y: 0, heading: 0, turret: 0, speed: 0, hp: 140, reloadLeft: 0, isAlive: true }));
}

class FakeDecals implements DecalLayer {
  clears = 0;

  clear(): void {
    this.clears++;
  }

  tread(): void {
    return undefined;
  }

  scorch(): void {
    return undefined;
  }

  fade(): void {
    return undefined;
  }

  draw(): void {
    return undefined;
  }
}

describe('старт раунда', () => {
  it('сбрасывает эффекты со слоем следов и камеру', () => {
    const log: string[] = [];
    const decals = new FakeDecals();
    const effects = new Effects(
      decals,
      () => '#ffffff',
      () => '',
    );
    const presenter = new DuelPresenter(fakeRenderer(log), effects, defaultSettings());
    presenter.startRound();
    expect(decals.clears).toBe(1);
    expect(log).toEqual(['resetCamera']);
  });

  it('первая кровь в новом раунде объявляется снова', () => {
    const log: string[] = [];
    const effects = recordedEffects(log);
    const presenter = new DuelPresenter(fakeRenderer(log), effects, defaultSettings());
    presenter.applyEvent(duelEvent('hit', 1));
    presenter.applyEvent(duelEvent('hit', 0));
    presenter.startRound();
    presenter.applyEvent(duelEvent('hit', 0));
    expect(effects.events.map(({ options }) => options.announcement)).toEqual(['firstBlood', null, 'firstBlood']);
    expect(log).toEqual(['event hit', 'event hit', 'reset', 'resetCamera', 'event hit']);
  });
});

describe('снимок сервера', () => {
  it('сначала снимок, затем его события по порядку — переведённые, с тряской и объявлениями дуэли', () => {
    const log: string[] = [];
    const effects = recordedEffects(log);
    const presenter = new DuelPresenter(fakeRenderer(log), effects, defaultSettings());
    presenter.applySnapshot(12, snapshotTanks(), [
      duelEvent('shot', 0),
      duelEvent('hit', 1, EventFlag.Ricochet),
      duelEvent('death', 1),
    ]);
    expect(log).toEqual(['snapshot 12', 'event shot', 'event hit', 'event death']);
    expect(effects.events).toEqual([
      {
        event: { kind: 'shot', tank: 0, by: null, x: 300, y: 200, value: 28, dx: 1, dy: 0, flags: 0 },
        options: { shake: 2.5, flash: 0, announcement: null },
      },
      {
        event: { kind: 'hit', tank: 1, by: 0, x: 300, y: 200, value: 28, dx: 1, dy: 0, flags: EventFlag.Ricochet },
        options: { shake: 9, flash: 0, announcement: 'firstBlood' },
      },
      {
        event: { kind: 'death', tank: 1, by: null, x: 300, y: 200, value: 28, dx: 1, dy: 0, flags: 0 },
        options: { shake: 26, flash: 0.55, announcement: null },
      },
    ]);
  });

  it('настоящие эффекты: гибель трясёт и вспыхивает экраном с силой дуэли', () => {
    const effects = new Effects(
      new FakeDecals(),
      () => '#ffffff',
      () => '',
    );
    const presenter = new DuelPresenter(fakeRenderer([]), effects, defaultSettings());
    presenter.applySnapshot(2, snapshotTanks(), [duelEvent('death', 0)]);
    expect(effects.shake).toBe(26);
    expect(effects.flashScreen).toBe(0.55);
  });

  it('шаг эффектов получает танки с номерами сторон по порядку', () => {
    const log: string[] = [];
    const effects = recordedEffects(log);
    const presenter = new DuelPresenter(fakeRenderer(log), effects, defaultSettings());
    presenter.update(0.016, laneView({ hp: 40 }));
    expect(effects.updates).toEqual([
      [
        expect.objectContaining({ id: 0, x: LANE_ME.x, y: LANE_ME.y, hp: FULL_HP, maxHp: FULL_HP, isAlive: true }),
        expect.objectContaining({ id: 1, x: LANE_ENEMY.x, y: LANE_ENEMY.y, hp: 40, maxHp: FULL_HP, isAlive: true }),
      ],
    ]);
  });
});

describe('противник для помощников', () => {
  it('живой противник в кадре камеры во время боя', () => {
    const presenter = new DuelPresenter(fakeRenderer([]), recordedEffects([]), defaultSettings());
    expect(presenter.visibleEnemy(laneView(), 0, true)).toMatchObject({ x: LANE_ENEMY.x, y: LANE_ENEMY.y });
    expect(presenter.visibleEnemy(laneView(), 1, true)).toMatchObject({ x: LANE_ME.x, y: LANE_ME.y });
  });

  it('подбитого, невидимого и до начала боя — нет', () => {
    const presenter = new DuelPresenter(fakeRenderer([]), recordedEffects([]), defaultSettings());
    expect(presenter.visibleEnemy(laneView({ isAlive: false }), 0, true)).toBeNull();
    expect(presenter.visibleEnemy(laneView(), 0, false)).toBeNull();
    const narrow = new DuelPresenter(fakeRenderer([], NARROW_CAMERA), recordedEffects([]), defaultSettings());
    expect(narrow.visibleEnemy(laneView(), 0, true)).toBeNull();
  });
});

describe('кадр дуэли', () => {
  it('интерфейс собирается из старта раунда, показаний и управления', () => {
    const renderer = fakeRenderer([]);
    const presenter = new DuelPresenter(renderer, recordedEffects([]), settingsWith({ hasAimLine: false }));
    presenter.draw(frameInput({ mySide: 1, frameMs: 21 }));
    expect(renderer.drawn[0]?.hud).toEqual({
      names: ['Дима', 'Бублик'],
      score: [1, 0],
      roundIndex: 2,
      gameId: 'K7QX',
      gameTick: 1234,
      mySide: 1,
      ...READOUT,
      ...CONTROLS,
      aimLine: null,
      frameMs: 21,
    });
  });

  it('линия выстрела «на нём», когда видимый противник на пути; без видимого противника — линия без цели', () => {
    const renderer = fakeRenderer([]);
    const presenter = new DuelPresenter(renderer, recordedEffects([]), settingsWith({ hasAimLine: true }));
    const drawn = presenter.draw(frameInput());
    expect(drawn.aimLine?.state).toBe('onTarget');
    expect(renderer.drawn[0]?.hud.aimLine).toBe(drawn.aimLine);
    const blind = presenter.draw(frameInput({ visibleEnemy: null }));
    expect(blind.aimLine?.state).toBe('none');
    expect(blind.aimLine?.segments.length).toBeGreaterThan(0);
  });

  it('линии нет без настройки, до начала боя и у подбитого своего танка', () => {
    const off = new DuelPresenter(fakeRenderer([]), recordedEffects([]), settingsWith({ hasAimLine: false }));
    expect(off.draw(frameInput()).aimLine).toBeNull();
    const presenter = new DuelPresenter(fakeRenderer([]), recordedEffects([]), settingsWith({ hasAimLine: true }));
    expect(presenter.draw(frameInput({ isFighting: false })).aimLine).toBeNull();
    expect(presenter.draw(frameInput({ view: laneView({}, { isAlive: false }) })).aimLine).toBeNull();
  });

  it('отсчёт — из тиков старта раунда: до начала боя и ещё чуть-чуть после нуля', () => {
    const renderer = fakeRenderer([]);
    const presenter = new DuelPresenter(renderer, recordedEffects([]), defaultSettings());
    expect(countdownSeconds(COUNTDOWN_TICKS)).toBe(COUNTDOWN_S);
    const overlayAt = (sinceRoundStartS: number, isFighting: boolean): Overlay =>
      presenter.draw(frameInput({ sinceRoundStartS, isFighting })).overlay;
    expect(overlayAt(0.5, false)).toEqual({ kind: 'countdown', elapsedS: 0.5, totalS: COUNTDOWN_S });
    expect(overlayAt(3.5, false)).toEqual({ kind: 'countdown', elapsedS: 3.5, totalS: COUNTDOWN_S });
    expect(overlayAt(3.6, false)).toBeNull();
    expect(overlayAt(1, true)).toBeNull();
    expect(renderer.drawn.map((drawn) => drawn.overlay)).toEqual([
      { kind: 'countdown', elapsedS: 0.5, totalS: COUNTDOWN_S },
      { kind: 'countdown', elapsedS: 3.5, totalS: COUNTDOWN_S },
      null,
      null,
    ]);
  });
});
