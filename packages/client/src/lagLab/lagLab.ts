import { compileArenaBotScript, createBrain } from '@tanks/bots';
import parallaxSource from '@tanks/bots/parallax.js?raw';
import {
  BULLET_RADIUS,
  DT,
  isShotReturning,
  MUZZLE_OFFSET,
  shotCarry,
  TANK_RADIUS,
  type Field,
  type RoundRules,
  type Tank,
} from '@tanks/shared/engine';
import { BOT_LEVEL_INFO, quantizeAction, type TankSnapshot } from '@tanks/shared/protocol';
import { computeAimLine, type AimLine } from '../aimLine.js';
import { InputReader, type ShotContext } from '../input.js';
import { buildSelect } from '../labShared.js';
import type { InterpolatedTank, WorldView } from '../prediction.js';
import { isInView, worldToScreen, type Camera } from '../render/camera.js';
import { DuelFxPolicy, duelFxEvent, duelFxTanks } from '../render/fxEvent.js';
import { createDuelEffects, Renderer, type HudInfo } from '../render/renderer.js';
import { defaultSettings, SettingsStore, type Settings } from '../settings.js';
import { Sfx } from '../sfx.js';
import { deviceSound } from '../soundSetting.js';
import { mountSoundToggle } from '../soundToggle.js';
import { StepClock } from '../watch/stepClock.js';
import { isShotInZone } from '../zoneFire.js';
import {
  DEFAULT_LAG_KNOBS,
  LAG_BOT_LEVELS,
  LAG_CAP_MS,
  LAG_MODES,
  LAG_RTT_MS,
  LagStand,
  lagViewAt,
  type CompensatedHit,
  type LagCounters,
  type LagDebugState,
  type LagKnobs,
  type LagMode,
  type LagPicture,
  type TankPose,
  type VictimCircles,
} from './lagStand.js';
import './lagLab.css';

// Стенд задержки (`/?lab=lag`): дуэль с ботом лестницы без сервера, мир лаборатории — судья с компенсацией задержки
// стрелка. Плашка сверху раскрывает ручки, плашка снизу — счётчики, на поле — метки попаданий компенсацией.

const MODE_TITLES: Readonly<Record<LagMode, string>> = { victim: 'В тебя стреляет лагер', shooter: 'Лагер — ты' };
const MS_PER_S = 1000;
const MS_PER_TICK = DT * MS_PER_S;
const SOUND_KEY_CODE = 'KeyM';
const CLOSE_KEY_CODE = 'Escape';
const OPEN_CLASS = 'is-open';
const STATS_WINDOW_MS = 1000;
const HIT_DISTANCE = TANK_RADIUS + BULLET_RADIUS;
const TANK_WIDTH = 2 * TANK_RADIUS;
const SPEED_NORMAL = 1;

// На поле — только бледная точка настоящего попадания: метка не должна закрывать то, что игрок увидел бы в бою.
const MARK = {
  lifeMs: 1500,
  pointColor: '#fff2c4',
  pointAlpha: 0.45,
  text: 'без компенсации — мимо',
} as const;
const ALERT_CLASS = 'lag-alert';

const PAUSE_KEY_CODE = 'KeyP';
const PAUSE_TITLES = { running: 'Пауза (P)', paused: 'Продолжить (P)' } as const;

interface CircleStyle {
  title: string;
  color: string;
  lineWidthPx: number;
  dash: readonly number[];
}

type CircleId = 'shooterView' | 'serverView';

// Цвет кружка — он же маркер в его переключателе: кружки не должны путаться.
const CIRCLES: Readonly<Record<CircleId, CircleStyle>> = {
  shooterView: { title: 'Где тебя видит стрелок', color: 'rgba(96,214,255,0.85)', lineWidthPx: 2, dash: [6, 4] },
  serverView: { title: 'Где тебя проверяет сервер', color: 'rgba(244,241,232,0.7)', lineWidthPx: 2, dash: [2, 4] },
};
const CIRCLE_IDS: readonly CircleId[] = ['shooterView', 'serverView'];
const CIRCLES_HINT =
  'Пули у тебя рисуются в твоём времени: попадание — когда пуля коснулась твоего танка. Кружки — для наглядности.';

interface Mark {
  hit: CompensatedHit;
  bornAt: number;
}

// Последний нарисованный кадр: по нему сквозная проверка меряет, не заходят ли снаряды в танки.
interface DrawnFrame {
  tanks: { x: number; y: number; isAlive: boolean }[];
  bullets: { id: number; owner: number; x: number; y: number }[];
}

function drawnFrameOf(view: WorldView): DrawnFrame {
  return {
    tanks: view.tanks.map((tank) => ({ x: tank.x, y: tank.y, isAlive: tank.isAlive })),
    bullets: view.bullets.map((bullet) => ({ id: bullet.id, owner: bullet.owner, x: bullet.x, y: bullet.y })),
  };
}

interface LabDebugState {
  isShooterViewShown: boolean;
  isServerViewShown: boolean;
  isPaused: boolean;
  isMuted: boolean;
  marks: number;
  drawn: DrawnFrame | null;
}

interface LabElements {
  chipMode: HTMLElement;
  chipRest: HTMLElement;
  chip: HTMLButtonElement;
  panel: HTMLElement;
  note: HTMLElement;
  mode: HTMLSelectElement;
  rtt: HTMLSelectElement;
  cap: HTMLSelectElement;
  bot: HTMLSelectElement;
  circles: HTMLElement;
  circleToggles: Record<CircleId, HTMLButtonElement>;
  pause: HTMLButtonElement;
  pauseBanner: HTMLElement;
  readout: HTMLElement;
}

const parallax = compileArenaBotScript(parallaxSource);

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  created.className = className;
  created.textContent = text;
  return created;
}

function labeledField(title: string, select: HTMLSelectElement): HTMLLabelElement {
  const label = element('label', 'lag-field');
  label.append(element('span', 'lag-field-title', title), select);
  select.className = 'lag-select';
  return label;
}

function formatDecimal(value: number): string {
  return value.toFixed(1).replace('.', ',');
}

function msOfTicks(ticks: number): number {
  return Math.round(ticks * MS_PER_TICK);
}

function buildPage(root: HTMLElement): { elements: LabElements; canvas: HTMLCanvasElement } {
  root.hidden = false;
  root.replaceChildren();
  root.classList.add('lag-lab');
  document.body.classList.add('duel');
  const canvas = element('canvas', 'lag-canvas');
  const chip = element('button', 'lag-chip');
  chip.type = 'button';
  chip.setAttribute('aria-expanded', 'false');
  const chipMode = element('span', 'lag-chip-mode');
  const chipRest = element('span', 'lag-chip-rest');
  chip.append(chipMode, chipRest, element('span', 'lag-chip-caret', '▾'));
  const mode = buildSelect(
    LAG_MODES.map((id) => ({ id })),
    (item) => MODE_TITLES[item.id],
  );
  const rtt = buildSelect(
    LAG_RTT_MS.map((ms) => ({ id: String(ms) })),
    (item) => `${item.id} мс`,
  );
  const cap = buildSelect(
    LAG_CAP_MS.map((ms) => ({ id: String(ms) })),
    (item) => (item.id === '0' ? '0 — без компенсации' : `${item.id} мс`),
  );
  const bot = buildSelect(
    LAG_BOT_LEVELS.map((level) => ({ id: String(level), level })),
    (item) => `${item.id} · ${BOT_LEVEL_INFO[item.level].name}`,
  );
  const circleToggle = (id: CircleId): HTMLButtonElement => {
    const toggle = element('button', 'lag-toggle', CIRCLES[id].title);
    toggle.type = 'button';
    toggle.setAttribute('aria-pressed', 'false');
    toggle.style.setProperty('--circle-color', CIRCLES[id].color);
    return toggle;
  };
  const circleToggles = { shooterView: circleToggle('shooterView'), serverView: circleToggle('serverView') };
  const toggles = element('div', 'lag-toggles');
  toggles.append(circleToggles.shooterView, circleToggles.serverView);
  const circles = element('div', 'lag-circles');
  circles.append(toggles, element('p', 'lag-hint', CIRCLES_HINT));
  const note = element('p', 'lag-note');
  const panel = element('div', 'lag-panel');
  panel.hidden = true;
  const fields = element('div', 'lag-fields');
  fields.append(
    labeledField('Режим', mode),
    labeledField('Задержка стрелка', rtt),
    labeledField('Предел компенсации', cap),
    labeledField('Бот', bot),
  );
  panel.append(fields, note, circles);
  const pause = element('button', 'lag-pause');
  pause.type = 'button';
  pause.setAttribute('aria-pressed', 'false');
  pause.setAttribute('aria-label', PAUSE_TITLES.running);
  pause.title = PAUSE_TITLES.running;
  const sound = element('button', 'sound-toggle lag-sound');
  mountSoundToggle(sound, deviceSound());
  const bar = element('div', 'lag-bar');
  bar.append(chip, pause, sound);
  const top = element('div', 'lag-top');
  top.append(bar, panel);
  const pauseBanner = element('div', 'lag-paused', 'Пауза');
  pauseBanner.hidden = true;
  const readout = element('div', 'lag-readout');
  readout.setAttribute('aria-live', 'polite');
  root.append(canvas, pauseBanner, top, readout);
  return {
    canvas,
    elements: {
      chipMode,
      chipRest,
      chip,
      panel,
      note,
      mode,
      rtt,
      cap,
      bot,
      circles,
      circleToggles,
      pause,
      pauseBanner,
      readout,
    },
  };
}

function readKnobs(elements: LabElements): LagKnobs {
  const mode = LAG_MODES.find((id) => id === elements.mode.value) ?? DEFAULT_LAG_KNOBS.mode;
  const level = LAG_BOT_LEVELS.find((value) => String(value) === elements.bot.value) ?? DEFAULT_LAG_KNOBS.botLevel;
  return { mode, rttMs: Number(elements.rtt.value), capMs: Number(elements.cap.value), botLevel: level };
}

function writeKnobs(elements: LabElements, knobs: Readonly<LagKnobs>): void {
  elements.mode.value = knobs.mode;
  elements.rtt.value = String(knobs.rttMs);
  elements.cap.value = String(knobs.capMs);
  elements.bot.value = String(knobs.botLevel);
}

function describeKnobs(elements: LabElements, stand: LagStand): void {
  const { knobs } = stand;
  const viewMs = msOfTicks(stand.viewLag);
  const compensationMs = msOfTicks(stand.compensation);
  elements.chipMode.textContent = MODE_TITLES[knobs.mode];
  elements.chipRest.textContent = `${String(knobs.rttMs)} мс · предел ${String(knobs.capMs)} · ${BOT_LEVEL_INFO[knobs.botLevel].name}`;
  elements.note.textContent =
    knobs.mode === 'victim'
      ? `Стрелок видит тебя на ${String(viewMs)} мс позже. Сервер верит его прицелу на ${String(compensationMs)} мс назад.`
      : `Ты видишь бота на ${String(viewMs)} мс позже. Сервер засчитывает твой выстрел на ${String(compensationMs)} мс назад.`;
  elements.circles.hidden = knobs.mode !== 'victim';
}

function stat(value: string, label: string): HTMLElement {
  const item = element('span', 'lag-stat');
  item.append(element('b', 'lag-stat-value', value), ` ${label}`);
  return item;
}

function renderReadout(readout: HTMLElement, mode: LagMode, counters: LagCounters, isAlertOn: boolean): void {
  const key = `${mode} ${JSON.stringify(counters)} ${String(isAlertOn)}`;
  if (readout.dataset.key === key) {
    return;
  }
  readout.dataset.key = key;
  if (mode === 'shooter') {
    const accuracy = counters.accuracy === null ? '—' : `${String(Math.round(counters.accuracy * 100))}%`;
    readout.replaceChildren(
      stat(String(counters.shots), 'выстрелов'),
      stat(String(counters.hits), 'попаданий'),
      stat(accuracy, 'меткость'),
    );
    return;
  }
  const items = [stat(String(counters.hitsTaken), 'по тебе попали'), stat(String(counters.compensatedHits), MARK.text)];
  if (counters.averageMissPx !== null) {
    const gap = Math.max(0, counters.averageMissPx - HIT_DISTANCE) / TANK_WIDTH;
    items.push(stat(`≈ ${formatDecimal(gap)}`, 'корпуса мимо на экране'));
  }
  if (isAlertOn) {
    items.push(element('span', ALERT_CLASS, MARK.text));
  }
  readout.replaceChildren(...items);
}

function tankSnapshot(tank: InterpolatedTank): TankSnapshot {
  return {
    x: tank.x,
    y: tank.y,
    heading: tank.heading,
    turret: tank.turret,
    speed: tank.speed,
    hp: tank.hp,
    reloadLeft: 0,
    isAlive: tank.isAlive,
  };
}

// Зона считается только при включённом флаге: без него трассировка пути на каждом тике не нужна.
function shotContextOf(
  settings: Readonly<Settings>,
  field: Field,
  rules: Readonly<RoundRules>,
  me: Tank,
  enemy: InterpolatedTank | null,
): ShotContext {
  const bulletSpeed = me.stats.bulletSpeed;
  const carry = shotCarry(me, rules.shotInheritPercent);
  const isInZone =
    settings.hasZoneFire &&
    isShotInZone({
      field,
      shooter: { x: me.x, y: me.y, turret: me.turret },
      bulletSpeed,
      carry,
      targets: enemy === null ? [] : [enemy],
    });
  return { isReturning: isShotReturning(field, me, me.turret, bulletSpeed, carry, enemy), isInZone };
}

function outlineTank(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  pose: TankPose,
  pixelRatio: number,
  style: { color: string; lineWidthPx: number; dash: readonly number[] },
): void {
  const center = worldToScreen(camera, pose);
  const radius = TANK_RADIUS * camera.scale;
  const muzzle = MUZZLE_OFFSET * camera.scale;
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.lineWidthPx * pixelRatio;
  ctx.setLineDash(style.dash.map((part) => part * pixelRatio));
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(center.x, center.y);
  ctx.lineTo(center.x + Math.cos(pose.turret) * muzzle, center.y + Math.sin(pose.turret) * muzzle);
  ctx.stroke();
}

function drawMark(ctx: CanvasRenderingContext2D, camera: Camera, mark: Mark, now: number): void {
  const progress = (now - mark.bornAt) / MARK.lifeMs;
  const point = worldToScreen(camera, mark.hit.point);
  ctx.globalAlpha = MARK.pointAlpha * (1 - progress);
  ctx.fillStyle = MARK.pointColor;
  ctx.beginPath();
  ctx.arc(point.x, point.y, BULLET_RADIUS * camera.scale, 0, Math.PI * 2);
  ctx.fill();
}

function stageViewport(): { width: number; height: number; pixelRatio: number } {
  return { width: window.innerWidth, height: window.innerHeight, pixelRatio: window.devicePixelRatio };
}

function randomSeed(): number {
  const [seed = 0] = crypto.getRandomValues(new Uint32Array(1));
  return seed;
}

export function showLagLab(root: HTMLElement): void {
  const { elements, canvas } = buildPage(root);
  const settings = new SettingsStore(localStorage, defaultSettings(), { isAdmin: false }).value;
  const isTouchDevice = matchMedia('(pointer: coarse)').matches;
  const stand = new LagStand(DEFAULT_LAG_KNOBS, (level, random) => createBrain(level, random, parallax), randomSeed());
  writeKnobs(elements, DEFAULT_LAG_KNOBS);
  const effects = createDuelEffects(() => stand.names);
  const renderer = new Renderer(canvas, effects, settings, isTouchDevice, stageViewport);
  const input = new InputReader(canvas, renderer, settings);
  const fxPolicy = new DuelFxPolicy();
  const sfx = new Sfx();
  const clock = new StepClock();
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('Canvas 2D недоступен');
  }
  let previous: LagPicture | null = null;
  let lastView: WorldView | null = null;
  let marks: Mark[] = [];
  const shownCircles: Record<CircleId, boolean> = { shooterView: false, serverView: false };
  let isPaused = false;
  // Время боя для меток: на паузе стоит, метки не гаснут.
  let fightMs = 0;
  let lastFrame = performance.now();
  let windowStart = lastFrame;
  let framesInWindow = 0;
  let worstInWindowMs = 0;
  let fps = 0;
  let worstFrameMs = 0;

  const countFrame = (now: number, frameMs: number): void => {
    framesInWindow++;
    worstInWindowMs = Math.max(worstInWindowMs, frameMs);
    if (now - windowStart < STATS_WINDOW_MS) {
      return;
    }
    fps = (framesInWindow * MS_PER_S) / (now - windowStart);
    worstFrameMs = worstInWindowMs;
    framesInWindow = 0;
    worstInWindowMs = 0;
    windowStart = now;
  };

  const restartView = (): void => {
    previous = null;
    marks = [];
    effects.reset();
    fxPolicy.reset();
    renderer.resetCamera();
  };

  const setPaused = (isOn: boolean): void => {
    isPaused = isOn;
    const title = isOn ? PAUSE_TITLES.paused : PAUSE_TITLES.running;
    elements.pause.setAttribute('aria-pressed', String(isOn));
    elements.pause.setAttribute('aria-label', title);
    elements.pause.title = title;
    elements.pauseBanner.hidden = !isOn;
    if (isOn) {
      // Тряска берёт случайный сдвиг каждый кадр: на паузе кадр дрожал бы.
      effects.shake = 0;
    }
  };

  // Ручку меняют, чтобы играть с новыми настройками: смена на паузе снимает паузу.
  const applyKnobs = (): void => {
    stand.setKnobs(readKnobs(elements));
    clock.reset();
    restartView();
    describeKnobs(elements, stand);
    setPaused(false);
  };

  const setPanelOpen = (isOpen: boolean): void => {
    elements.panel.hidden = !isOpen;
    elements.chip.classList.toggle(OPEN_CLASS, isOpen);
    elements.chip.setAttribute('aria-expanded', String(isOpen));
  };

  for (const select of [elements.mode, elements.rtt, elements.cap, elements.bot]) {
    select.addEventListener('change', () => {
      // Стрелки и WASD управляют танком: список с фокусом перехватил бы их.
      select.blur();
      applyKnobs();
    });
  }
  elements.chip.addEventListener('click', () => {
    setPanelOpen(elements.panel.hidden);
  });
  for (const id of CIRCLE_IDS) {
    const toggle = elements.circleToggles[id];
    toggle.addEventListener('click', () => {
      shownCircles[id] = !shownCircles[id];
      toggle.setAttribute('aria-pressed', String(shownCircles[id]));
      toggle.blur();
    });
  }
  elements.pause.addEventListener('click', () => {
    setPaused(!isPaused);
    elements.pause.blur();
  });
  window.addEventListener('keydown', (event) => {
    if (event.code === CLOSE_KEY_CODE) {
      setPanelOpen(false);
    }
    if (event.code === SOUND_KEY_CODE && !event.repeat) {
      sfx.toggle();
    }
    if (event.code === PAUSE_KEY_CODE && !event.repeat) {
      setPaused(!isPaused);
    }
  });
  canvas.addEventListener('pointerdown', () => {
    setPanelOpen(false);
  });
  for (const type of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(type, () => {
      sfx.unlock();
    });
  }
  describeKnobs(elements, stand);

  const visibleEnemy = (view: WorldView): InterpolatedTank | null => {
    const enemy = view.tanks[1];
    if (!enemy.isAlive || !isInView(renderer.currentCamera, enemy)) {
      return null;
    }
    return enemy;
  };

  const stepOnce = (enemy: InterpolatedTank | null): void => {
    const me = stand.controlledTank;
    const action = quantizeAction(
      input.read(me, shotContextOf(settings, stand.round.map, stand.round.rules, me, enemy)),
    );
    const before = stand.picture;
    const step = stand.step(action);
    if (step.isNewRound) {
      restartView();
      return;
    }
    previous = before;
    effects.onSnapshot(stand.round.tick, stand.picture.tanks.map(tankSnapshot));
    for (const event of step.events) {
      effects.onEvent(duelFxEvent(event), fxPolicy.optionsFor(event));
    }
    sfx.events(step.events);
    if (step.compensatedHit !== null) {
      marks.push({ hit: step.compensatedHit, bornAt: fightMs });
    }
  };

  const aimLineOf = (view: WorldView, enemy: InterpolatedTank | null): AimLine | null => {
    const me = view.tanks[0];
    if (!settings.hasAimLine || !me.isAlive) {
      return null;
    }
    return computeAimLine({
      field: view.round.map,
      shooter: { x: me.x, y: me.y, turret: me.turret },
      bulletSpeed: view.round.tanks[0].stats.bulletSpeed,
      carry: shotCarry(me, view.round.rules.shotInheritPercent),
      targets: enemy === null ? [] : [enemy],
      hasLeadHint: settings.hasLeadHint,
    });
  };

  const drawOverlay = (circles: VictimCircles | null): void => {
    const camera = renderer.currentCamera;
    const pixelRatio = canvas.width / Math.max(1, canvas.clientWidth);
    marks = marks.filter((mark) => fightMs - mark.bornAt < MARK.lifeMs);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const id of CIRCLE_IDS) {
      if (shownCircles[id] && circles !== null) {
        outlineTank(ctx, camera, circles[id], pixelRatio, CIRCLES[id]);
      }
    }
    for (const mark of marks) {
      drawMark(ctx, camera, mark, fightMs);
    }
    ctx.restore();
  };

  const draw = (frameMs: number): void => {
    const { view, circles } = lagViewAt(previous, stand.picture, clock.fraction);
    lastView = view;
    const enemy = visibleEnemy(view);
    effects.update(isPaused ? 0 : frameMs / MS_PER_S, duelFxTanks(view));
    const hud: HudInfo = {
      names: stand.names,
      score: stand.score,
      roundIndex: stand.roundIndex,
      gameId: '',
      gameTick: stand.round.tick,
      mySide: 0,
      rttMs: stand.knobs.rttMs,
      correctionPx: 0,
      fps,
      worstFrameMs,
      isMuted: sfx.isMuted,
      sticks: input.stickStates,
      isShotGuarded: input.isShotGuarded,
      isZoneFiring: input.isZoneFiring,
      isReversing: input.isReversing,
      aimLine: aimLineOf(view, enemy),
      frameMs,
      frameTimes: [],
    };
    renderer.draw(view, hud, null);
    drawOverlay(circles);
    renderReadout(elements.readout, stand.knobs.mode, stand.counters, marks.length > 0);
  };

  // На паузе часы кадра не копят время: после паузы бой идёт с того же места, без догоняющих шагов.
  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    const frameMs = now - lastFrame;
    lastFrame = now;
    countFrame(now, frameMs);
    if (!isPaused) {
      fightMs += Math.max(0, frameMs);
      const steps = clock.advance(frameMs, SPEED_NORMAL);
      for (let step = 0; step < steps; step++) {
        const { view } = lagViewAt(previous, stand.picture, 1);
        stepOnce(visibleEnemy(view));
      }
    }
    draw(Math.max(0, frameMs));
  };

  Object.assign(window, {
    tanksLab: {
      debugState: (): LagDebugState & LabDebugState => ({
        ...stand.debugState(),
        isShooterViewShown: shownCircles.shooterView,
        isServerViewShown: shownCircles.serverView,
        isPaused,
        isMuted: sfx.isMuted,
        marks: marks.length,
        drawn: lastView === null ? null : drawnFrameOf(lastView),
      }),
    },
  });
  requestAnimationFrame(frame);
}
