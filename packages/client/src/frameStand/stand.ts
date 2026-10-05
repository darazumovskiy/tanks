import { DuelPresenter } from '../duelPresenter.js';
import { FX_SCREENS, type FxScreen } from '../fxLab/scenes.js';
import { buildSelect } from '../labShared.js';
import { worldToScreen } from '../render/camera.js';
import { createDuelEffects, Renderer } from '../render/renderer.js';
import { makeCanvas } from '../render/view.js';
import { showRoundEnd } from '../roundEnd.js';
import { defaultSettings } from '../settings.js';
import { DUEL_FRAMES, SPRITE_PROBE } from './frames.js';
import { NAMES, type DuelFrame, type FrameKind, type FrameScreenId } from './model.js';
import { frameImage, playFrame, type FrameTarget } from './play.js';
import { installSeededRandom } from './seededRandom.js';

// Стенд кадров дуэли (`/?lab=frames`): именованные кадры настоящим рендером в замороженное время — эталоны
// визуальной регрессии. Кадр холста отдаёт свои пиксели; кадр страницы рисуется на холсте боя под настоящими
// итогами раунда. `?frame=` и `?screen=` — кадр при открытии; `?seed=` — случайность каждого показа с этого зерна,
// как в спеке эталонов.

const SPRITE_POLL_MS = 50;
// Центр башни — цвет стороны; без спрайта там тёмный пол.
const SPRITE_MIN_BRIGHTNESS = 120;
const RGB_CHANNELS = 3;
const MS_PER_S = 1000;
const PNG_TYPE = 'image/png';
const PAGE_SCREEN_ID = 'page';
const COARSE_POINTER = '(pointer: coarse)';
const DUEL_PAGE_CLASS = 'duel';

interface FrameInfo {
  id: string;
  kind: FrameKind;
  screens: FrameScreenId[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function elementById(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`нет элемента #${id}`);
  }
  return element;
}

function stageCanvas(): HTMLCanvasElement {
  const element = elementById('stage');
  if (!(element instanceof HTMLCanvasElement)) {
    throw new Error('#stage — не холст');
  }
  return element;
}

// `isWindowSized` — холст страницы боя: размер и плотность берёт из окна, как в игре.
function makeFrameTarget(screen: FxScreen, canvas: HTMLCanvasElement, isWindowSized: boolean): FrameTarget {
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('Canvas 2D недоступен');
  }
  const settings = defaultSettings();
  const effects = createDuelEffects(() => NAMES);
  const viewport = isWindowSized
    ? undefined
    : (): { width: number; height: number; pixelRatio: number } => ({
        width: screen.width,
        height: screen.height,
        pixelRatio: screen.pixelRatio,
      });
  const renderer = new Renderer(canvas, effects, settings, screen.isTouchDevice, viewport);
  const duel = new DuelPresenter(renderer, effects, settings);
  return { screen, canvas, ctx, renderer, effects, settings, duel };
}

function makeScreenTarget(screen: FxScreen): FrameTarget {
  const { canvas } = makeCanvas(1, 1);
  canvas.style.width = `${String(screen.width)}px`;
  canvas.style.height = `${String(screen.height)}px`;
  canvas.className = 'fx-stage-canvas';
  return makeFrameTarget(screen, canvas, false);
}

function windowScreen(): FxScreen {
  return {
    id: PAGE_SCREEN_ID,
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: window.devicePixelRatio,
    isTouchDevice: matchMedia(COARSE_POINTER).matches,
  };
}

// Рендер не рисует танк, пока спрайт не загрузился; у каждого рендера свои спрайты.
function hasSprites(target: FrameTarget): boolean {
  playFrame(target, SPRITE_PROBE);
  return SPRITE_PROBE.tanks.every((pose) => {
    const point = worldToScreen(target.renderer.currentCamera, pose);
    const pixel = target.ctx.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data;
    return Math.max(...pixel.subarray(0, RGB_CHANNELS)) >= SPRITE_MIN_BRIGHTNESS;
  });
}

// Все начертания подключённого набора — до первого кадра: холст не ждёт шрифт и нарисовал бы запасным.
async function waitForAssets(targets: readonly FrameTarget[]): Promise<void> {
  if (document.readyState !== 'complete') {
    await new Promise<void>((resolve) => {
      window.addEventListener(
        'load',
        () => {
          resolve();
        },
        { once: true },
      );
    });
  }
  const faces: FontFace[] = [];
  document.fonts.forEach((face) => {
    faces.push(face);
  });
  if (faces.length === 0) {
    throw new Error('шрифты игры не подключились');
  }
  await Promise.all(faces.map((face) => face.load()));
  await document.fonts.ready;
  while (!targets.every(hasSprites)) {
    await delay(SPRITE_POLL_MS);
  }
}

// Как при входе в бой: холст на весь экран, кнопки боя поверх, лаборатории не видно.
function enterDuelPage(root: HTMLElement, isTouchDevice: boolean): void {
  root.hidden = true;
  document.body.classList.add(DUEL_PAGE_CLASS);
  stageCanvas().hidden = false;
  elementById('menu').hidden = false;
  elementById('settings-toggle').hidden = false;
  elementById('autofire').hidden = !isTouchDevice;
}

// Появление, свечение и конфетти итогов останавливаются на возрасте кадра.
function freezeAnimations(ageS: number): void {
  for (const animation of document.getAnimations()) {
    animation.pause();
    animation.currentTime = ageS * MS_PER_S;
  }
}

export function showFrameStand(root: HTMLElement): void {
  const canvasFrames = DUEL_FRAMES.filter((frame) => frame.kind === 'canvas');
  const firstFrame = canvasFrames[0];
  if (firstFrame === undefined) {
    return;
  }
  const query = new URLSearchParams(location.search);
  const seed = query.get('seed');
  let reseed: (() => void) | null = null;
  if (seed !== null) {
    reseed = installSeededRandom(Number(seed));
  }
  const targets = new Map(FX_SCREENS.map((screen) => [screen.id, makeScreenTarget(screen)]));
  const pageTarget = makeFrameTarget(windowScreen(), stageCanvas(), true);
  const ready = waitForAssets([...targets.values(), pageTarget]);

  root.hidden = false;
  root.innerHTML = '';
  const frameSelect = buildSelect(canvasFrames, (frame) => `${frame.id} · ${frame.title}`);
  const screenSelect = buildSelect(
    FX_SCREENS,
    (screen) => `${screen.id} (${String(screen.width)}×${String(screen.height)})`,
  );
  const controls = document.createElement('div');
  controls.className = 'lab-controls';
  controls.append(frameSelect, screenSelect);
  const stage = document.createElement('div');
  const info = document.createElement('pre');
  root.append(controls, stage, info);

  let shown: HTMLCanvasElement = pageTarget.canvas;

  const showPage = (frame: DuelFrame): void => {
    enterDuelPage(root, pageTarget.screen.isTouchDevice);
    playFrame(pageTarget, frame);
    shown = pageTarget.canvas;
    if (frame.roundEnd === null) {
      return;
    }
    showRoundEnd(elementById('round-end'), frame.roundEnd.info);
    freezeAnimations(frame.roundEnd.ageS);
  };

  const show = (frameId: string, screenId: string): void => {
    const frame = DUEL_FRAMES.find((candidate) => candidate.id === frameId);
    const target = targets.get(screenId);
    if (frame === undefined || target === undefined) {
      throw new Error(`нет кадра ${frameId} или экрана ${screenId}`);
    }
    if (!frame.screens.some((id) => id === screenId)) {
      throw new Error(`кадр ${frameId} не снимается на экране ${screenId}`);
    }
    reseed?.();
    if (frame.kind === 'page') {
      showPage(frame);
      return;
    }
    playFrame(target, frame);
    shown = frameImage(target, frame);
    shown.style.width = `${String(shown.width / target.screen.pixelRatio)}px`;
    stage.replaceChildren(shown);
    info.textContent = `${frame.id} · ${screenId} · ${frame.title}`;
  };

  const showSelected = (): void => {
    const frame = canvasFrames.find((candidate) => candidate.id === frameSelect.value) ?? firstFrame;
    const isScreenAllowed = frame.screens.some((id) => id === screenSelect.value);
    if (!isScreenAllowed) {
      screenSelect.value = frame.screens[0] ?? screenSelect.value;
    }
    show(frame.id, screenSelect.value);
  };

  for (const select of [frameSelect, screenSelect]) {
    select.addEventListener('change', showSelected);
  }
  const queryFrame = DUEL_FRAMES.find((frame) => frame.id === query.get('frame'));
  const queryScreen = query.get('screen');
  if (queryFrame?.kind === 'canvas') {
    frameSelect.value = queryFrame.id;
  }
  if (queryScreen !== null) {
    screenSelect.value = queryScreen;
  }
  void ready.then(
    () => {
      if (queryFrame?.kind === 'page') {
        showPage(queryFrame);
        return;
      }
      showSelected();
    },
    (error: unknown) => {
      info.textContent = String(error);
    },
  );

  const frames: FrameInfo[] = DUEL_FRAMES.map((frame) => ({
    id: frame.id,
    kind: frame.kind,
    screens: [...frame.screens],
  }));
  Object.assign(window, {
    tanksFrames: {
      frames,
      ready: (): Promise<void> => ready,
      show,
      snapshot: (): string => shown.toDataURL(PNG_TYPE),
    },
  });
}
