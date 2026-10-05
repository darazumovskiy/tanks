import { TICK_RATE, type Side } from '@tanks/shared/engine';
import { computeAimLine, type AimLine } from '../aimLine.js';
import { cropAround, type Target } from '../fxLab/frame.js';
import { labHud, thumbSticks } from '../labShared.js';
import type { WorldView } from '../prediction.js';
import { isInView, type Camera } from '../render/camera.js';
import type { HudInfo, Overlay } from '../render/renderer.js';
import { makeCanvas } from '../render/view.js';
import { defaultSettings, type Settings } from '../settings.js';
import type { StickState } from '../touch.js';
import { historyS, NAMES, tanksSnapshot, viewAt, type DuelFrame, type FrameCrop } from './model.js';

// Проигрывает кадр на рендере так же, как игра: снимки сервера по тикам и события — в эффекты, затем шаг эффектов
// и рисование. Перед этим всё, что осталось от прошлого кадра, гасится, поэтому кадр не зависит ни от часов, ни от
// порядка показа.

const MS_PER_S = 1000;
const FRAME_MS = 16;
const FRAME_S = FRAME_MS / MS_PER_S;
// Последние шаги рисуются: линия выстрела и отметка предохранителя доходят до полного вида, камера встаёт.
const DRAWN_FRAMES = 40;
// Шаг старше любой частицы, всплывающей цифры и объявления: гасит всё, что осталось от прошлого кадра.
const FLUSH_S = 10;
// Время эффектов в момент снимка: пульс аптечек, бег штрихов зоны и линии — всегда в одной фазе.
const EFFECTS_TIME_S = 12.5;
const COUNTDOWN_S = 3;
const GAME_ID = 'K7QX';
// Таймкод игры: каждый прошлый раунд засчитан этой длительностью, плюс время текущего.
const PAST_ROUND_S = 95;
const DEBUG_READOUT = { rttMs: 46, serverTick: 0, pending: 1, correctionPx: 0.4, fps: 60, worstFrameMs: 19 };
// График кадров: ровные кадры с лёгким разбросом и редкие провалы за двойной бюджет.
const FRAME_GRAPH_LENGTH = 120;
const FRAME_GRAPH_BASE_MS = 16.2;
const FRAME_GRAPH_JITTER_STEPS = 5;
const FRAME_GRAPH_JITTER_MS = 0.6;
const FRAME_GRAPH_SPIKE_EVERY = 37;
const FRAME_GRAPH_SPIKE_MS = 26;
const FRAME_TIMES: readonly number[] = Array.from(
  { length: FRAME_GRAPH_LENGTH },
  (_, index) =>
    FRAME_GRAPH_BASE_MS +
    (index % FRAME_GRAPH_JITTER_STEPS) * FRAME_GRAPH_JITTER_MS +
    (index % FRAME_GRAPH_SPIKE_EVERY === 0 ? FRAME_GRAPH_SPIKE_MS : 0),
);

function enemyOf(side: Side): Side {
  return side === 0 ? 1 : 0;
}

// Как в бою: линия только во время боя у живого танка, противник — только живой и в кадре камеры.
function aimLineFor(frame: DuelFrame, view: WorldView, camera: Camera, settings: Readonly<Settings>): AimLine | null {
  const me = view.tanks[frame.mySide];
  const isFighting = frame.phase === 'fight';
  if (!settings.hasAimLine || !isFighting || !me.isAlive) {
    return null;
  }
  const enemy = view.tanks[enemyOf(frame.mySide)];
  const isEnemyVisible = enemy.isAlive && isInView(camera, enemy);
  return computeAimLine({
    field: view.round.map,
    shooter: { x: me.x, y: me.y, turret: me.turret },
    bulletSpeed: view.round.tanks[frame.mySide].stats.bulletSpeed,
    enemy: isEnemyVisible ? enemy : null,
    hasLeadHint: settings.hasLeadHint,
  });
}

function sticksFor(frame: DuelFrame, target: Target): StickState[] {
  const bases = thumbSticks(target.screen.width, target.screen.height, target.settings);
  return frame.sticks.flatMap((pose) => {
    const base = bases.find((stick) => stick.role === pose.role);
    if (base === undefined) {
      return [];
    }
    return [{ ...base, dx: pose.dx, dy: pose.dy, isActive: true, isFiring: pose.isFiring }];
  });
}

function hudFor(frame: DuelFrame, target: Target, aimLine: AimLine | null): HudInfo {
  return {
    ...labHud(sticksFor(frame, target), FRAME_MS, aimLine),
    ...DEBUG_READOUT,
    names: NAMES,
    score: frame.score,
    roundIndex: frame.roundIndex,
    gameId: GAME_ID,
    gameTick: Math.round((frame.roundIndex * PAST_ROUND_S + frame.roundTimeS) * TICK_RATE),
    mySide: frame.mySide,
    isMuted: false,
    isShotGuarded: frame.isShotGuarded,
    isReversing: frame.isReversing,
    frameTimes: FRAME_TIMES,
  };
}

function overlayAt(frame: DuelFrame, t: number): Overlay {
  if (frame.countdownLeftS === null) {
    return null;
  }
  return { kind: 'countdown', elapsedS: COUNTDOWN_S - frame.countdownLeftS + t, totalS: COUNTDOWN_S };
}

function drawStep(target: Target, frame: DuelFrame, t: number, view: WorldView): void {
  const aimLine = aimLineFor(frame, view, target.renderer.currentCamera, target.settings);
  target.renderer.draw(view, hudFor(frame, target, aimLine), overlayAt(frame, t));
}

// Время шага в секундах до снимка (отрицательное); последний шаг — сам снимок.
function timeOf(step: number, steps: number): number {
  return ((step - steps) * FRAME_MS) / MS_PER_S;
}

// Последний тик сервера к моменту `t`: по номеру тика эффекты кладут следы гусениц и гасят подпалины.
function tickAt(frame: DuelFrame, t: number): number {
  return Math.floor((Math.round((frame.roundTimeS + t) * MS_PER_S) * TICK_RATE) / MS_PER_S);
}

export function playFrame(target: Target, frame: DuelFrame): void {
  const { renderer, effects, settings } = target;
  Object.assign(settings, defaultSettings(), frame.settings);
  const steps = Math.max(DRAWN_FRAMES, Math.ceil(historyS(frame) / FRAME_S) + 1);
  // Режим камеры из настроек меняет стратегию только при рисовании: кадр-заготовка делает это до сброса камеры.
  drawStep(target, frame, timeOf(0, steps), viewAt(frame, timeOf(0, steps)));
  effects.update(FLUSH_S, []);
  effects.reset();
  renderer.resetCamera();
  effects.time = EFFECTS_TIME_S - (steps + 1) * FRAME_S;
  let tick = tickAt(frame, timeOf(0, steps));
  const pending = [...frame.events].sort((a, b) => b.ageS - a.ageS);
  for (let step = 0; step <= steps; step++) {
    const t = timeOf(step, steps);
    for (; tick <= tickAt(frame, t); tick++) {
      effects.onSnapshot(tick, tanksSnapshot(viewAt(frame, tick / TICK_RATE - frame.roundTimeS)));
    }
    while (pending[0] !== undefined && -pending[0].ageS <= t) {
      effects.onEvent(pending[0].event);
      pending.shift();
    }
    const view = viewAt(frame, t);
    effects.update(FRAME_S, view.tanks);
    if (steps - step <= DRAWN_FRAMES) {
      drawStep(target, frame, t, view);
    }
  }
}

function cropScreen(source: HTMLCanvasElement, crop: Extract<FrameCrop, { kind: 'screen' }>): HTMLCanvasElement {
  const x = Math.round(source.width * crop.left);
  const y = Math.round(source.height * crop.top);
  const width = Math.round(source.width * crop.right) - x;
  const height = Math.round(source.height * crop.bottom) - y;
  const { canvas, ctx } = makeCanvas(width, height);
  ctx.drawImage(source, x, y, width, height, 0, 0, width, height);
  return canvas;
}

// Сравниваемая картинка кадра: холст целиком или его часть.
export function frameImage(target: Target, frame: DuelFrame): HTMLCanvasElement {
  const { crop } = frame;
  if (crop === null) {
    return target.canvas;
  }
  if (crop.kind === 'focus') {
    return cropAround(target, crop);
  }
  return cropScreen(target.canvas, crop);
}
