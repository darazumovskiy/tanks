import { installSeededRandom } from '../frameStand/seededRandom.js';
import { LAB_NAMES, labHud, thumbSticks } from '../labShared.js';
import type { AimLineStyle } from '../render/aimLineStyle.js';
import { worldToScreen } from '../render/camera.js';
import type { Effects, FxEventOptions } from '../render/effects.js';
import { duelFxEvent, duelFxTanks } from '../render/fxEvent.js';
import { createDuelEffects, Renderer } from '../render/renderer.js';
import { makeCanvas } from '../render/view.js';
import { defaultSettings, type Settings } from '../settings.js';
import { buildSceneFrame, LAB_FRAME_S, type FxScene, type FxScreen } from './scenes.js';

// Кадр лаборатории: настоящий рендер на холст размером с экран, служебные кадры перед снимком (линия успевает
// появиться, камера встаёт, снаряд набирает след), кадрирование вокруг линии в масштабе 1:1 пикселей экрана.

const WARMUP_FRAMES = 12;
const WARMUP_FRAME_MS = 16;
// Частицы выстрела повторяются от показа к показу.
const LAB_RANDOM_SEED = 7;
// Выстрел без тряски: кадр сравнивают по пикселям.
const STILL_SHOT: FxEventOptions = { shake: 0, flash: 0, announcement: null, hasParticles: true, ownKillCount: null };
// Ячейка листа и просмотра — половина экрана вокруг линии: толщина и свечение видны как есть.
const CROP_FRACTION = 0.5;

export interface Target {
  screen: FxScreen;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  renderer: Renderer;
  effects: Effects;
  settings: Settings;
}

export function makeTarget(screen: FxScreen): Target {
  const { canvas, ctx } = makeCanvas(1, 1);
  canvas.style.width = `${String(screen.width)}px`;
  canvas.style.height = `${String(screen.height)}px`;
  canvas.className = 'fx-stage-canvas';
  const settings = defaultSettings();
  const effects = createDuelEffects(() => LAB_NAMES);
  const renderer = new Renderer(canvas, effects, settings, screen.isTouchDevice, () => ({
    width: screen.width,
    height: screen.height,
    pixelRatio: screen.pixelRatio,
  }));
  return { screen, canvas, ctx, renderer, effects, settings };
}

export function renderFrame(target: Target, scene: FxScene, style: AimLineStyle, timeS: number): void {
  const { renderer, effects, screen, settings } = target;
  renderer.setAimLineStyle(style);
  renderer.resetCamera();
  effects.reset();
  installSeededRandom(LAB_RANDOM_SEED);
  const sticks = thumbSticks(screen.width, screen.height, settings);
  for (let index = 0; index < WARMUP_FRAMES; index++) {
    const framesLeft = WARMUP_FRAMES - 1 - index;
    const frame = buildSceneFrame(scene, framesLeft);
    if (frame.shot !== null) {
      effects.onEvent(duelFxEvent(frame.shot), STILL_SHOT);
    }
    effects.update(LAB_FRAME_S, duelFxTanks(frame.view));
    effects.time = timeS - (framesLeft * WARMUP_FRAME_MS) / 1000;
    renderer.draw(frame.view, labHud(sticks, WARMUP_FRAME_MS, frame.aimLine), null);
  }
}

// Середина первого отрезка линии — то, что сравнивают; без линии — свой танк.
export function sceneFocus(scene: FxScene): { x: number; y: number } {
  const [first] = buildSceneFrame(scene).aimLine.segments;
  if (first === undefined) {
    return { x: scene.me.x, y: scene.me.y };
  }
  return { x: (first.x1 + first.x2) / 2, y: (first.y1 + first.y2) / 2 };
}

export function cropAround(target: Target, focus: { x: number; y: number }): HTMLCanvasElement {
  const width = Math.round(target.canvas.width * CROP_FRACTION);
  const height = Math.round(target.canvas.height * CROP_FRACTION);
  const center = worldToScreen(target.renderer.currentCamera, focus);
  const x = Math.round(Math.min(Math.max(0, center.x - width / 2), target.canvas.width - width));
  const y = Math.round(Math.min(Math.max(0, center.y - height / 2), target.canvas.height - height));
  const { canvas, ctx } = makeCanvas(width, height);
  ctx.drawImage(target.canvas, x, y, width, height, 0, 0, width, height);
  return canvas;
}

// Кадр варианта в сцене, уже кадрированный.
export function renderCrop(target: Target, scene: FxScene, style: AimLineStyle, timeS: number): HTMLCanvasElement {
  renderFrame(target, scene, style, timeS);
  return cropAround(target, sceneFocus(scene));
}
