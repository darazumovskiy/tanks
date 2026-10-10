import {
  createFfaMatch,
  DEFAULT_RULES,
  DEFAULT_STATS,
  deriveStats,
  ffaMap,
  NO_CARRY,
  TICK_RATE,
  zoneRadiusAt,
  type FfaSize,
  type ZonePlan,
} from '@tanks/shared/engine';
import { computeAimLine, type AimLine } from '../aimLine.js';
import { edgeArrows, visibleEnemies, type EdgeArrow } from '../ffa/arrows.js';
import { FfaCamera, type FfaAim } from '../ffa/ffaCamera.js';
import type { FfaFrameView, FfaViewTank } from '../ffa/ffaPrediction.js';
import { FfaFxPolicy } from '../ffa/fxPolicy.js';
import { FfaHud } from '../ffa/hud/hud.js';
import { FX_SCREENS, type FxScreen } from '../fxLab/scenes.js';
import { buildSelect } from '../labShared.js';
import { worldToScreen, type Camera } from '../render/camera.js';
import { Effects } from '../render/effects.js';
import { FFA_OWN_COLOR, FFA_OTHER_COLOR, FfaRenderer } from '../render/ffaRenderer.js';
import { FLOOR_FRAME_BUDGET_MS } from '../render/floorChunks.js';
import { StampDecals } from '../render/stampDecals.js';
import { makeCanvas } from '../render/view.js';
import { defaultSettings } from '../settings.js';
import { FFA_FRAMES, FFA_SPRITE_PROBE, type FfaStandFrame, type StandTank } from './ffaFrames.js';
import { NO_NET_WARNING } from '../netWarning.js';
import { FFA_HUD_FRAMES, type FfaHudFrame } from './ffaHudFrames.js';
import { checkFloor } from './floorChecks.js';
import { waitForFonts } from './fonts.js';
import { installSeededRandom } from './seededRandom.js';

// Стенд кадров толпы (`/?lab=frames&set=ffa`): именованные кадры настоящим рендером толпы через те же камеру,
// правила эффектов и рисование, что игра, в замороженное время — эталоны визуальной регрессии. Кадр страницы —
// поле на холсте боя во весь экран и настоящий интерфейс матча поверх.
// `window.tanksFfaFrames`: `frames`, `ready()`, `show(frameId, screenId)`, `snapshot()`, `floorChecks()` — сверки
// пола кусками. `?seed=` — случайность каждого показа с этого зерна.

const MS_PER_S = 1000;
const FRAME_MS = 16;
const FRAME_S = FRAME_MS / MS_PER_S;
// Последние шаги рисуются: камера встаёт, снаряды набирают след.
const DRAWN_FRAMES = 40;
// Шаг старше любой частицы и объявления: гасит всё, что осталось от прошлого кадра.
const FLUSH_S = 10;
// Время эффектов в момент снимка: пульс аптечек и бег штрихов зоны — всегда в одной фазе.
const EFFECTS_TIME_S = 12.5;
const SPRITE_POLL_MS = 50;
const SPRITE_MIN_BRIGHTNESS = 120;
const RGB_CHANNELS = 3;
const CROP_FRACTION = 0.5;
const PNG_TYPE = 'image/png';
const BULLET_SPEED = deriveStats(DEFAULT_STATS).bulletSpeed;
const MAX_HP = deriveStats(DEFAULT_STATS).maxHp;
const READOUT = {
  gameId: 'K7QX',
  fps: 60,
  worstFrameMs: 19,
  rttMs: 46,
  correctionPx: 0.4,
  isMuted: false,
  netWarning: NO_NET_WARNING,
};
const OWN_PALETTE_SUFFIX = '-own';
const COARSE_POINTER = '(pointer: coarse)';
const PAGE_CLASSES = ['duel', 'ffa'];
const NO_ACTIONS = {
  invite: (): Promise<void> => Promise.resolve(),
  leave: (): void => undefined,
  rejoin: (): void => undefined,
  reload: (): void => undefined,
};

interface StandFrameInfo {
  id: string;
  kind: 'canvas' | 'page';
  screens: string[];
}

interface StandTarget {
  screen: FxScreen;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  renderer: FfaRenderer;
  effects: Effects;
  camera: FfaCamera;
  fxPolicy: FfaFxPolicy;
  frame: FfaStandFrame;
  lastCamera: Camera | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

// План зоны карты, как его строит сервер для полной игры этого размера.
function fullGameZone(size: FfaSize): ZonePlan {
  const setups = Array.from({ length: size }, (_, index) => ({ id: index + 1, name: '', stats: DEFAULT_STATS }));
  return createFfaMatch(ffaMap(size), setups, 1, DEFAULT_RULES).world.zonePlan;
}

// Часы пола стенда: каждый кусок стоит полбюджета кадра — за кадр ровно два на любой машине, кадры повторяемы.
function chunkCostClock(): () => number {
  let elapsedMs = 0;
  return () => {
    elapsedMs += FLOOR_FRAME_BUDGET_MS / 2;
    return elapsedMs;
  };
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

function makeScreenTarget(screen: FxScreen, isOwnPaletteOnly: boolean): StandTarget {
  const { canvas } = makeCanvas(1, 1);
  canvas.style.width = `${String(screen.width)}px`;
  canvas.style.height = `${String(screen.height)}px`;
  canvas.className = 'fx-stage-canvas';
  return makeTarget(screen, canvas, isOwnPaletteOnly);
}

// Холст страницы боя: размер и плотность — из окна, как в игре.
function makePageTarget(): StandTarget {
  const screen: FxScreen = {
    id: 'page',
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: window.devicePixelRatio,
    isTouchDevice: matchMedia(COARSE_POINTER).matches,
  };
  return makeTarget(screen, stageCanvas(), false);
}

function makeTarget(screen: FxScreen, canvas: HTMLCanvasElement, isOwnPaletteOnly: boolean): StandTarget {
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('Canvas 2D недоступен');
  }
  const effects = new Effects(
    new StampDecals(),
    (id) => (id === target.frame.myId ? FFA_OWN_COLOR : FFA_OTHER_COLOR),
    (id) => target.frame.tanks.find((tank) => tank.id === id)?.name ?? '',
  );
  const palette = isOwnPaletteOnly ? [FFA_OWN_COLOR] : undefined;
  const renderer = new FfaRenderer(
    canvas,
    effects,
    defaultSettings(),
    ffaMap(FFA_SPRITE_PROBE.size),
    () => ({ width: screen.width, height: screen.height, pixelRatio: screen.pixelRatio }),
    palette,
    chunkCostClock(),
  );
  const target: StandTarget = {
    screen,
    canvas,
    ctx,
    renderer,
    effects,
    camera: new FfaCamera(),
    fxPolicy: new FfaFxPolicy(),
    frame: FFA_SPRITE_PROBE,
    lastCamera: null,
  };
  return target;
}

function viewTank(tank: StandTank): FfaViewTank {
  return {
    id: tank.id,
    x: tank.x,
    y: tank.y,
    heading: tank.heading,
    turret: tank.turret,
    speed: 0,
    hp: tank.hp ?? MAX_HP,
    maxHp: MAX_HP,
    isAlive: tank.isAlive ?? true,
    shieldLeft: tank.shieldLeft ?? 0,
    presence: tank.presence ?? 1,
  };
}

// Мир кадра к моменту `t` (секунды до снимка, отрицательные): снаряды летят к своим точкам кадра.
function viewAt(frame: FfaStandFrame, zone: ZonePlan, t: number): FfaFrameView {
  const map = ffaMap(frame.size);
  return {
    tanks: frame.tanks.map(viewTank),
    bullets: frame.bullets.map((bullet, index) => ({
      id: index + 1,
      owner: bullet.owner,
      x: bullet.x + Math.cos(bullet.angle) * BULLET_SPEED * t,
      y: bullet.y + Math.sin(bullet.angle) * BULLET_SPEED * t,
      tick: 0,
    })),
    kits: frame.hasKits ? map.kits.map((kit) => ({ x: kit.x, y: kit.y, isActive: true, respawnIn: 0 })) : [],
    zoneRadius: frame.zoneTimeS === null ? 0 : zoneRadiusAt(zone, frame.zoneTimeS),
    clock: { myTick: 0, othersTick: 0, me: null, others: [] },
  };
}

// Линия выстрела и стрелки кадра — теми же функциями, что в бою: цели — живые чужие в окне камеры.
function helpersOf(
  frame: FfaStandFrame,
  view: FfaFrameView,
  camera: Camera,
  pixelRatio: number,
): { aimLine: AimLine | null; arrows: EdgeArrow[] } {
  const me = view.tanks.find((tank) => tank.id === frame.myId);
  if (!frame.hasHelpers || me === undefined) {
    return { aimLine: null, arrows: [] };
  }
  const targets = visibleEnemies(view.tanks, frame.myId, camera);
  return {
    aimLine: computeAimLine({
      field: ffaMap(frame.size),
      shooter: { x: me.x, y: me.y, turret: me.turret },
      bulletSpeed: BULLET_SPEED,
      carry: NO_CARRY,
      targets,
      hasLeadHint: false,
    }),
    arrows: edgeArrows({ me, myId: frame.myId, tanks: view.tanks, camera, pixelRatio }),
  };
}

function framingInput(frame: FfaStandFrame): { focus: { x: number; y: number }; aim: FfaAim } {
  const own = frame.tanks.find((tank) => tank.id === frame.myId);
  if (own === undefined) {
    return { focus: frame.focus, aim: { kind: 'none' } };
  }
  return { focus: own, aim: { kind: 'turret', angle: own.turret } };
}

// Проигрывает кадр через ту же камеру и те же правила эффектов, что игра; перед этим гасит всё прошлое.
function playFrame(target: StandTarget, frame: FfaStandFrame, zone: ZonePlan): void {
  const { effects, camera, fxPolicy, renderer } = target;
  target.frame = frame;
  const oldest = Math.max(0, ...frame.events.map((timed) => timed.ageS));
  const steps = Math.max(DRAWN_FRAMES, Math.ceil(oldest / FRAME_S) + 1);
  effects.update(FLUSH_S, []);
  effects.reset();
  camera.snap();
  effects.time = EFFECTS_TIME_S - (steps + 1) * FRAME_S;
  const pending = [...frame.events].sort((a, b) => b.ageS - a.ageS);
  const { focus, aim } = framingInput(frame);
  const labels = new Map(frame.tanks.map((tank) => [tank.id, { label: tank.name, isBot: tank.isBot === true }]));
  for (let step = 0; step <= steps; step++) {
    const t = ((step - steps) * FRAME_MS) / MS_PER_S;
    const framing = camera.update(focus, aim, renderer.screen, FRAME_MS);
    target.lastCamera = framing.camera;
    while (pending[0] !== undefined && -pending[0].ageS <= t) {
      const options = fxPolicy.optionsFor(
        pending[0].event,
        frame.myId,
        framing.camera,
        pending[0].ownKillCount ?? null,
      );
      if (options !== null) {
        effects.onEvent(pending[0].event, options);
      }
      pending.shift();
    }
    const view = viewAt(frame, zone, t);
    effects.update(
      FRAME_S,
      view.tanks.map((tank) => ({ ...tank, bulletSpeed: BULLET_SPEED, shotInheritPercent: 0 })),
    );
    if (steps - step > DRAWN_FRAMES) {
      continue;
    }
    const isFloorRestart = frame.floorFrames !== null && steps - step === frame.floorFrames - 1;
    if (isFloorRestart) {
      renderer.clearFloor();
    }
    renderer.draw({
      view,
      myId: frame.myId,
      camera: framing.camera,
      zonePlan: frame.zoneTimeS === null ? null : zone,
      labelOf: (id) => labels.get(id) ?? { label: '', isBot: false },
      ...helpersOf(frame, view, framing.camera, renderer.screen.pixelRatio),
      controls: { sticks: [], isShotGuarded: false, isZoneFiring: false, isReversing: false },
      readout: { ...READOUT, gameTick: Math.round((frame.zoneTimeS ?? 0) * TICK_RATE) },
      frameMs: FRAME_MS,
      frameTimes: [],
    });
  }
}

function frameImage(target: StandTarget, frame: FfaStandFrame): HTMLCanvasElement {
  const crop = frame.crop;
  const camera = target.lastCamera;
  if (crop === null || camera === null) {
    return target.canvas;
  }
  const width = Math.round(target.canvas.width * CROP_FRACTION);
  const height = Math.round(target.canvas.height * CROP_FRACTION);
  const center = worldToScreen(camera, crop);
  const x = Math.round(Math.min(Math.max(0, center.x - width / 2), target.canvas.width - width));
  const y = Math.round(Math.min(Math.max(0, center.y - height / 2), target.canvas.height - height));
  const { canvas, ctx } = makeCanvas(width, height);
  ctx.drawImage(target.canvas, x, y, width, height, 0, 0, width, height);
  return canvas;
}

// Рендер не рисует танк, пока спрайт его цвета не загрузился: в центре башни обоих танков — цвет танка.
function hasSprites(target: StandTarget, zone: ZonePlan): boolean {
  playFrame(target, FFA_SPRITE_PROBE, zone);
  const camera = target.lastCamera;
  if (camera === null) {
    return false;
  }
  return FFA_SPRITE_PROBE.tanks.every((tank) => {
    const point = worldToScreen(camera, tank);
    const pixel = target.ctx.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data;
    return Math.max(...pixel.subarray(0, RGB_CHANNELS)) >= SPRITE_MIN_BRIGHTNESS;
  });
}

async function waitForAssets(targets: readonly StandTarget[], zone: ZonePlan): Promise<void> {
  await waitForFonts();
  while (!targets.every((target) => hasSprites(target, zone))) {
    await delay(SPRITE_POLL_MS);
  }
}

function targetKey(screenId: string, isOwnPaletteOnly: boolean): string {
  return isOwnPaletteOnly ? `${screenId}${OWN_PALETTE_SUFFIX}` : screenId;
}

// Как при входе в бой толпы: холст во весь экран, кнопки боя поверх, лаборатории не видно.
function enterFfaPage(root: HTMLElement, frame: FfaHudFrame, isTouchDevice: boolean): void {
  root.hidden = true;
  document.body.classList.add(...PAGE_CLASSES);
  stageCanvas().hidden = false;
  elementById('menu').hidden = false;
  elementById('settings-toggle').hidden = false;
  elementById('autofire').hidden = !isTouchDevice || !frame.hasFieldControls;
}

// Интерфейс кадра: сессия из сообщений сервера; зритель смотрит за целью среди живых танков поля.
function renderHud(hud: FfaHud, frame: FfaHudFrame): void {
  const { session, now } = frame.build();
  if (session.screen(now) === 'spectator') {
    session.followSpectator(frame.scene.tanks.filter((tank) => tank.isAlive !== false).map((tank) => tank.id));
  }
  hud.render(session.hud(now, hud.layout), now);
}

export function showFfaFrameStand(root: HTMLElement): void {
  const firstFrame = FFA_FRAMES[0];
  if (firstFrame === undefined) {
    return;
  }
  const query = new URLSearchParams(location.search);
  const seed = query.get('seed');
  let reseed: (() => void) | null = null;
  if (seed !== null) {
    reseed = installSeededRandom(Number(seed));
  }
  const zone = fullGameZone(firstFrame.size);
  const targets = new Map<string, StandTarget>();
  for (const screen of FX_SCREENS) {
    targets.set(targetKey(screen.id, false), makeScreenTarget(screen, false));
    targets.set(targetKey(screen.id, true), makeScreenTarget(screen, true));
  }
  const pageTarget = makePageTarget();
  const hud = new FfaHud(elementById('ffa-hud'), NO_ACTIONS, pageTarget.screen.isTouchDevice);
  const ready = waitForAssets([...targets.values(), pageTarget], zone);

  root.hidden = false;
  root.innerHTML = '';
  const frameSelect = buildSelect(FFA_FRAMES, (frame) => `${frame.id} · ${frame.title}`);
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
  let shown: HTMLCanvasElement | null = null;

  const showPage = (frame: FfaHudFrame): void => {
    enterFfaPage(root, frame, pageTarget.screen.isTouchDevice);
    playFrame(pageTarget, frame.scene, zone);
    shown = pageTarget.canvas;
    renderHud(hud, frame);
  };

  const show = (frameId: string, screenId: string): void => {
    const hudFrame = FFA_HUD_FRAMES.find((candidate) => candidate.id === frameId);
    if (hudFrame !== undefined) {
      if (!hudFrame.screens.some((id) => id === screenId)) {
        throw new Error(`кадр ${frameId} не снимается на экране ${screenId}`);
      }
      reseed?.();
      showPage(hudFrame);
      return;
    }
    const frame = FFA_FRAMES.find((candidate) => candidate.id === frameId);
    const target = frame === undefined ? undefined : targets.get(targetKey(screenId, frame.isOwnPaletteOnly));
    if (frame === undefined || target === undefined) {
      throw new Error(`нет кадра ${frameId} или экрана ${screenId}`);
    }
    if (!frame.screens.some((id) => id === screenId)) {
      throw new Error(`кадр ${frameId} не снимается на экране ${screenId}`);
    }
    reseed?.();
    playFrame(target, frame, zone);
    const image = frameImage(target, frame);
    image.style.width = `${String(image.width / target.screen.pixelRatio)}px`;
    stage.replaceChildren(image);
    shown = image;
    info.textContent = `${frame.id} · ${screenId} · ${frame.title}`;
  };

  const showSelected = (): void => {
    const frame = FFA_FRAMES.find((candidate) => candidate.id === frameSelect.value) ?? firstFrame;
    if (!frame.screens.some((id) => id === screenSelect.value)) {
      screenSelect.value = frame.screens[0] ?? screenSelect.value;
    }
    show(frame.id, screenSelect.value);
  };
  for (const select of [frameSelect, screenSelect]) {
    select.addEventListener('change', showSelected);
  }
  void ready.then(showSelected, (error: unknown) => {
    info.textContent = String(error);
  });

  const frames: StandFrameInfo[] = [
    ...FFA_FRAMES.map((frame): StandFrameInfo => ({ id: frame.id, kind: 'canvas', screens: [...frame.screens] })),
    ...FFA_HUD_FRAMES.map((frame): StandFrameInfo => ({ id: frame.id, kind: 'page', screens: [...frame.screens] })),
  ];
  Object.assign(window, {
    tanksFfaFrames: {
      frames,
      ready: (): Promise<void> => ready,
      show,
      snapshot: (): string => {
        if (shown === null) {
          throw new Error('кадр ещё не показан');
        }
        return shown.toDataURL(PNG_TYPE);
      },
      floorChecks: checkFloor,
    },
  });
}
