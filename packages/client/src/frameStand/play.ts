import { DEFAULT_RULES, DEFAULT_STATS, DUEL_COUNTDOWN_TICKS, TICK_RATE } from '@tanks/shared/engine';
import { MessageType, type RoundStartMessage } from '@tanks/shared/protocol';
import { countdownSeconds, type DuelPresenter, type DuelReadout } from '../duelPresenter.js';
import { cropAround, type Target } from '../fxLab/frame.js';
import { thumbSticks } from '../labShared.js';
import type { WorldView } from '../prediction.js';
import { makeCanvas } from '../render/view.js';
import { defaultSettings } from '../settings.js';
import type { StickState } from '../touch.js';
import { historyS, NAMES, tanksSnapshot, viewAt, type DuelFrame, type FrameCrop } from './model.js';

export interface FrameTarget extends Target {
  duel: DuelPresenter;
}

const MS_PER_S = 1000;
const FRAME_MS = 16;
const FRAME_S = FRAME_MS / MS_PER_S;
// Последние шаги рисуются: линия выстрела и отметка предохранителя доходят до полного вида, камера встаёт.
const DRAWN_FRAMES = 40;
// Шаг старше любой частицы, всплывающей цифры и объявления: гасит всё, что осталось от прошлого кадра.
const FLUSH_S = 10;
// Время эффектов в момент снимка: пульс аптечек, бег штрихов зоны и линии — всегда в одной фазе.
const EFFECTS_TIME_S = 12.5;
const GAME_ID = 'K7QX';
// Таймкод игры: каждый прошлый раунд засчитан этой длительностью, плюс время текущего.
const PAST_ROUND_S = 95;
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
const READOUT: DuelReadout = {
  rttMs: 46,
  correctionPx: 0.4,
  fps: 60,
  worstFrameMs: 19,
  isMuted: false,
  frameTimes: FRAME_TIMES,
};

function roundStartOf(frame: DuelFrame): RoundStartMessage {
  return {
    type: MessageType.RoundStart,
    gameId: GAME_ID,
    roundIndex: frame.roundIndex,
    mapIndex: frame.mapIndex,
    countdownTicks: DUEL_COUNTDOWN_TICKS,
    score: frame.score,
    rules: { ...DEFAULT_RULES },
    tanks: [
      { nickname: NAMES[0], stats: { ...DEFAULT_STATS } },
      { nickname: NAMES[1], stats: { ...DEFAULT_STATS } },
    ],
  };
}

// Местное время с начала раунда к моменту `t`: у кадра отсчёта — по остатку отсчёта, у остальных — отсчёт и время
// раунда.
function sinceRoundStartS(frame: DuelFrame, roundStart: RoundStartMessage, t: number): number {
  const countdownS = countdownSeconds(roundStart.countdownTicks);
  if (frame.countdownLeftS === null) {
    return countdownS + frame.roundTimeS + t;
  }
  return countdownS - frame.countdownLeftS + t;
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

function drawStep(target: FrameTarget, frame: DuelFrame, t: number, view: WorldView): void {
  const roundStart = roundStartOf(frame);
  const isFighting = frame.phase === 'fight';
  target.duel.draw({
    view,
    roundStart,
    sinceRoundStartS: sinceRoundStartS(frame, roundStart, t),
    gameTick: Math.round((frame.roundIndex * PAST_ROUND_S + frame.roundTimeS) * TICK_RATE),
    mySide: frame.mySide,
    isFighting,
    visibleEnemy: target.duel.visibleEnemy(view, frame.mySide, isFighting),
    frameMs: FRAME_MS,
    readout: READOUT,
    controls: {
      sticks: sticksFor(frame, target),
      isShotGuarded: frame.isShotGuarded,
      isZoneFiring: false,
      isReversing: frame.isReversing,
    },
  });
}

// Время шага в секундах до снимка (отрицательное); последний шаг — сам снимок.
function timeOf(step: number, steps: number): number {
  return ((step - steps) * FRAME_MS) / MS_PER_S;
}

// Последний тик сервера к моменту `t`: по номеру тика эффекты кладут следы гусениц и гасят подпалины.
function tickAt(frame: DuelFrame, t: number): number {
  return Math.floor((Math.round((frame.roundTimeS + t) * MS_PER_S) * TICK_RATE) / MS_PER_S);
}

// Проигрывает кадр через ту же проводку дуэли, что игра: снимки сервера по тикам и события — в эффекты, затем шаг
// эффектов и рисование. Перед этим всё, что осталось от прошлого кадра, гасится, поэтому кадр не зависит ни от часов,
// ни от порядка показа.
export function playFrame(target: FrameTarget, frame: DuelFrame): void {
  const { effects, settings, duel } = target;
  Object.assign(settings, defaultSettings(), frame.settings);
  const steps = Math.max(DRAWN_FRAMES, Math.ceil(historyS(frame) / FRAME_S) + 1);
  // Режим камеры из настроек меняет стратегию только при рисовании: кадр-заготовка делает это до сброса камеры.
  drawStep(target, frame, timeOf(0, steps), viewAt(frame, timeOf(0, steps)));
  effects.update(FLUSH_S, []);
  duel.startRound();
  effects.time = EFFECTS_TIME_S - (steps + 1) * FRAME_S;
  let tick = tickAt(frame, timeOf(0, steps));
  const pending = [...frame.events].sort((a, b) => b.ageS - a.ageS);
  for (let step = 0; step <= steps; step++) {
    const t = timeOf(step, steps);
    for (; tick <= tickAt(frame, t); tick++) {
      duel.applySnapshot(tick, tanksSnapshot(viewAt(frame, tick / TICK_RATE - frame.roundTimeS)), []);
    }
    while (pending[0] !== undefined && -pending[0].ageS <= t) {
      duel.applyEvent(pending[0].event);
      pending.shift();
    }
    const view = viewAt(frame, t);
    duel.update(FRAME_S, view);
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
