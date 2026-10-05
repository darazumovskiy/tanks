import { ARENA, type Side } from '@tanks/shared/engine';
import type { AimLine } from '../aimLine.js';
import type { WorldView } from '../prediction.js';
import type { Settings } from '../settings.js';
import type { StickState } from '../touch.js';
import type { AimLineStyle } from './aimLineStyle.js';
import { aimLineStyleById } from './aimLineStyles.js';
import { frameCamera, screenToWorld, type Camera } from './camera.js';
import { createCameraStrategy, type CameraMode, type CameraStrategy } from './cameraStrategy.js';
import { FieldDecals } from './decals.js';
import { DuelHud, type DuelHudInfo } from './duelHud.js';
import { Effects } from './effects.js';
import { FieldRenderer, type FieldScene, type SceneTank } from './field.js';
import { floorFor } from './floor.js';
import { ScreenLayers, screenOf, type DebugReadout } from './screenLayers.js';
import { SIDE_COLORS } from './view.js';

export interface HudInfo extends DuelHudInfo, DebugReadout {
  sticks: readonly StickState[];
  isShotGuarded: boolean;
  isZoneFiring: boolean;
  isReversing: boolean;
  aimLine: AimLine | null;
  frameMs: number;
  frameTimes: readonly number[];
}

export type Overlay = { kind: 'countdown'; elapsedS: number; totalS: number } | null;

// Полная плотность экрана телефона (на Xiaomi 14T Pro — 3,25): замер на устройстве — 120 к/с, худший кадр 8 мс.
const MAX_PIXEL_RATIO = 4;
// Кромка шире любой пустоты за полем, которую показывает камера дуэли.
const BORDER_WIDTH = 600;
const OPAQUE = 1;

// Номер танка дуэли — его сторона.
function duelSide(id: number): Side {
  return id === 1 ? 1 : 0;
}

function sideColor(id: number): string {
  return SIDE_COLORS[duelSide(id)];
}

// Эффекты дуэли: цвет и имя — по стороне, следы копятся на холсте поля.
export function createDuelEffects(names: () => readonly [string, string]): Effects {
  return new Effects(new FieldDecals(ARENA), sideColor, (id) => names()[duelSide(id)]);
}

function sceneTank(view: WorldView, hud: HudInfo, side: Side): SceneTank {
  const tank = view.tanks[side];
  return {
    id: side,
    x: tank.x,
    y: tank.y,
    heading: tank.heading,
    turret: tank.turret,
    hp: tank.hp,
    maxHp: view.round.tanks[side].stats.maxHp,
    isAlive: tank.isAlive,
    color: sideColor(side),
    alpha: OPAQUE,
    label: hud.names[side],
    isBot: false,
  };
}

function duelScene(view: WorldView, hud: HudInfo): FieldScene {
  const { round } = view;
  return {
    field: ARENA,
    borderWidth: BORDER_WIDTH,
    floor: (ctx) => {
      ctx.drawImage(floorFor(round.mapIndex), 0, 0, ARENA.width, ARENA.height);
    },
    zone: {
      x: round.zone.x,
      y: round.zone.y,
      radius: round.zone.radius,
      startRadius: round.zonePlan.startRadius,
      finalRadius: round.zonePlan.finalRadius,
    },
    kits: round.kits,
    tanks: [sceneTank(view, hud, 0), sceneTank(view, hud, 1)],
    bullets: view.bullets.map((bullet) => ({
      id: bullet.id,
      x: bullet.x,
      y: bullet.y,
      color: sideColor(bullet.owner),
    })),
    aimLine: hud.aimLine,
    ownTankId: hud.mySide,
    isShotGuarded: hud.isShotGuarded,
    fieldLayer: null,
  };
}

// Кадр дуэли: камера по стратегии из настроек, мир через камеру — общим рендером поля, затем в экранных
// координатах — панели, стрелка на противника, объявления, отсчёт, вспышка, отладка, стики.
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly field: FieldRenderer;
  private readonly hud: DuelHud;
  private readonly layers: ScreenLayers;
  private pixelRatio = 1;
  private camera: Camera;
  private strategy: CameraStrategy;
  private strategyMode: CameraMode;
  // Стиль из настроек игрока; лаборатория подменяет его напрямую.
  private aimLineStyleOverride: AimLineStyle | null = null;

  // На компьютере поле показывается целиком; на устройстве с касанием камеру ведёт стратегия из настроек.
  // `viewport` — размер холста в CSS-пикселях и плотность; по умолчанию окно браузера (лаборатория задаёт своё).
  constructor(
    private readonly canvas: HTMLCanvasElement,
    effects: Effects,
    private readonly settings: Readonly<Settings>,
    private readonly isTouchDevice: boolean,
    private readonly viewport: () => { width: number; height: number; pixelRatio: number } = windowViewport,
  ) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('Canvas 2D недоступен');
    }
    this.ctx = ctx;
    this.field = new FieldRenderer(ctx, effects, SIDE_COLORS);
    this.hud = new DuelHud(ctx, effects);
    this.layers = new ScreenLayers(ctx, effects, settings);
    this.strategyMode = this.cameraMode();
    this.strategy = createCameraStrategy(this.strategyMode, settings);
    this.resize();
    this.camera = frameCamera({ x: ARENA.width / 2, y: ARENA.height / 2 }, canvas.width, canvas.height, ARENA.height);
    window.addEventListener('resize', () => {
      this.resize();
    });
  }

  // Новый раунд — танки появляются в другом месте, камера не должна ехать к ним через всё поле.
  resetCamera(): void {
    this.strategy.reset();
  }

  get currentCamera(): Camera {
    return this.camera;
  }

  get activeCameraMode(): CameraMode {
    return this.strategyMode;
  }

  setAimLineStyle(style: AimLineStyle): void {
    this.aimLineStyleOverride = style;
  }

  private aimLineStyle(): AimLineStyle {
    return this.aimLineStyleOverride ?? aimLineStyleById(this.settings.aimLineStyle).style;
  }

  private cameraMode(): CameraMode {
    return this.isTouchDevice ? this.settings.cameraMode : 'field';
  }

  // Режим сменили в панели посреди боя — новая стратегия продолжает с текущего окна, камера переезжает плавно.
  private currentStrategy(): CameraStrategy {
    const mode = this.cameraMode();
    if (mode !== this.strategyMode) {
      this.strategy = createCameraStrategy(mode, this.settings);
      this.strategy.adopt(this.camera);
      this.strategyMode = mode;
    }
    return this.strategy;
  }

  private frameBattle(view: WorldView, mySide: Side, frameMs: number): Camera {
    const me = view.tanks[mySide];
    const enemy = view.tanks[mySide === 0 ? 1 : 0];
    return this.currentStrategy().update(
      {
        me,
        enemy: enemy.isAlive ? enemy : null,
        canvasWidth: this.canvas.width,
        canvasHeight: this.canvas.height,
      },
      frameMs,
    );
  }

  // Координаты окна → координаты поля боя через текущее положение камеры.
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * (this.canvas.width / rect.width);
    const py = (clientY - rect.top) * (this.canvas.height / rect.height);
    return screenToWorld(this.camera, { x: px, y: py });
  }

  private resize(): void {
    const { width, height, pixelRatio } = this.viewport();
    this.pixelRatio = Math.min(pixelRatio, MAX_PIXEL_RATIO);
    this.canvas.width = Math.round(width * this.pixelRatio);
    this.canvas.height = Math.round(height * this.pixelRatio);
  }

  draw(view: WorldView, hud: HudInfo, overlay: Overlay): void {
    this.camera = this.frameBattle(view, hud.mySide, hud.frameMs);
    this.field.draw(duelScene(view, hud), {
      camera: this.camera,
      pixelRatio: this.pixelRatio,
      frameMs: hud.frameMs,
      aimLineStyle: this.aimLineStyle(),
    });
    const screen = screenOf(this.canvas, this.pixelRatio);
    this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    this.hud.drawPanels(view, hud, screen);
    this.hud.drawEnemyMarker(view, hud, screen, this.camera);
    this.layers.drawAnnouncements(screen);
    if (overlay?.kind === 'countdown') {
      this.hud.drawCountdown(view, hud, screen, overlay.elapsedS, overlay.totalS);
    }
    this.layers.drawFlash(screen);
    this.layers.drawDebug(hud, screen);
    this.layers.drawFrameGraph(hud.frameTimes, screen);
    this.layers.drawSticks(hud.sticks, hud.isZoneFiring, hud.isReversing, screen);
  }
}

function windowViewport(): { width: number; height: number; pixelRatio: number } {
  return { width: window.innerWidth, height: window.innerHeight, pixelRatio: window.devicePixelRatio };
}
