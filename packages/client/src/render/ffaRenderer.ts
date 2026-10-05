import type { FfaMap, Kit, ZonePlan } from '@tanks/shared/engine';
import type { FfaFrameView, FfaViewBullet, FfaViewTank } from '../ffa/ffaPrediction.js';
import type { Settings } from '../settings.js';
import type { StickState } from '../touch.js';
import { aimLineStyleById } from './aimLineStyles.js';
import { isInView, type Camera } from './camera.js';
import type { Effects, FxBullet } from './effects.js';
import { FieldRenderer, type FieldScene, type SceneTank } from './field.js';
import { ScreenLayers, screenOf, type DebugReadout } from './screenLayers.js';
import { ShieldRings, type ShieldRing } from './shieldRings.js';
import { TiledFloor } from './tiledFloor.js';
import { BODY_FONT, rgba, SIDE_COLORS } from './view.js';

// Свой танк и свои снаряды — акцент, все чужие — цвет противника; бот — тот же цвет с отметкой у ника.
export const FFA_OWN_COLOR = SIDE_COLORS[0];
export const FFA_OTHER_COLOR = SIDE_COLORS[1];
const FFA_PALETTE: readonly string[] = [FFA_OWN_COLOR, FFA_OTHER_COLOR];
// Кромка шире половины окна обзора со сдвигом: за краем большой карты камера не упирается в пустоту.
const BORDER_WIDTH = 1200;
// Рисуется только то, что в окне камеры с этим запасом.
const CULL_MARGIN = 100;
const MAX_PIXEL_RATIO = 4;

// Кольцо неуязвимости — черновой вид: ореол и ядро цветом танка; у своего ядро — дуга остатка по часовой с
// верха поверх бледного полного кольца.
const SHIELD_RADIUS = 38;
const SHIELD_HALO_WIDTH = 7;
const SHIELD_HALO_ALPHA = 0.18;
const SHIELD_CORE_WIDTH = 2;
const SHIELD_CORE_ALPHA = 0.85;
const SHIELD_TRACK_ALPHA = 0.25;
const SHIELD_ARC_START = -Math.PI / 2;
// Подпись под своим танком, пока он неуязвим: размеры — в точках экрана.
const SHIELD_HINT = 'Неуязвим, пока не выстрелишь';
const SHIELD_HINT_FONT_PX = 12;
const SHIELD_HINT_GAP_PX = 14;
const SHIELD_HINT_OUTLINE_PX = 3;
const SHIELD_HINT_ALPHA = 0.9;
const TEXT_COLOR = '#f4f1e8';
const TEXT_OUTLINE_COLOR = '#07080a';
const TEXT_OUTLINE_ALPHA = 0.7;
const FULL_TURN = Math.PI * 2;

export interface FfaTankLabel {
  label: string;
  isBot: boolean;
}

export interface FfaControls {
  sticks: readonly StickState[];
  isShotGuarded: boolean;
  isZoneFiring: boolean;
  isReversing: boolean;
}

export interface FfaDrawInput {
  view: FfaFrameView;
  myId: number | null;
  camera: Camera;
  // null — матч ещё не начался: зоны нет, круг скрыт.
  zonePlan: Readonly<ZonePlan> | null;
  labelOf: (id: number) => FfaTankLabel;
  controls: FfaControls;
  readout: DebugReadout;
  // Полная строка отладки — только админу; игрок видит игру и таймкод.
  isFullReadout: boolean;
  frameMs: number;
  frameTimes: readonly number[];
}

// Экран в точках холста и плотность.
export interface FfaScreen {
  width: number;
  height: number;
  pixelRatio: number;
}

export interface Viewport {
  width: number;
  height: number;
  pixelRatio: number;
}

function windowViewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight, pixelRatio: window.devicePixelRatio };
}

// Проявление и угасание — по сглаженной кривой, не линейно.
function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function colorOf(id: number, myId: number | null): string {
  return id === myId ? FFA_OWN_COLOR : FFA_OTHER_COLOR;
}

// Кадр толпы: общий рендер поля с полом большой карты, следами-отметками и кольцом неуязвимости поверх танков,
// затем экранные слои. Танки, снаряды и аптечки — только в окне камеры с запасом.
export class FfaRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly field: FieldRenderer;
  private readonly layers: ScreenLayers;
  private readonly floor: TiledFloor;
  private readonly shields = new ShieldRings();
  private pixelRatio = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    effects: Effects,
    private readonly settings: Readonly<Settings>,
    private readonly map: FfaMap,
    private readonly viewport: () => Viewport = windowViewport,
    palette: readonly string[] = FFA_PALETTE,
    floorClock: () => number = () => performance.now(),
  ) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('Canvas 2D недоступен');
    }
    this.ctx = ctx;
    this.field = new FieldRenderer(ctx, effects, palette);
    this.layers = new ScreenLayers(ctx, effects, settings);
    this.floor = new TiledFloor(map, floorClock);
    this.resize();
    window.addEventListener('resize', () => {
      this.resize();
    });
  }

  get screen(): FfaScreen {
    return { width: this.canvas.width, height: this.canvas.height, pixelRatio: this.pixelRatio };
  }

  get floorChunks(): number {
    return this.floor.chunkCount;
  }

  get floorMemoryMb(): number {
    return this.floor.memoryMb;
  }

  // Следующий кадр собирает пол кусками с нуля, как после перестановки камеры.
  clearFloor(): void {
    this.floor.clear();
  }

  draw(input: FfaDrawInput): void {
    const { camera } = input;
    this.field.draw(this.scene(input), {
      camera,
      pixelRatio: this.pixelRatio,
      frameMs: input.frameMs,
      aimLineStyle: aimLineStyleById(this.settings.aimLineStyle).style,
    });
    const screen = screenOf(this.canvas, this.pixelRatio);
    this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    this.layers.drawAnnouncements(screen);
    this.layers.drawFlash(screen);
    if (input.isFullReadout) {
      this.layers.drawDebug(input.readout, screen);
    } else {
      this.layers.drawGameStamp(input.readout, screen);
    }
    this.layers.drawFrameGraph(input.frameTimes, screen);
    const { controls } = input;
    this.layers.drawSticks(controls.sticks, controls.isZoneFiring, controls.isReversing, screen);
  }

  private scene(input: FfaDrawInput): FieldScene {
    const { camera, view, myId } = input;
    const visible = view.tanks.filter((tank) => isInView(camera, tank, CULL_MARGIN));
    const plan = input.zonePlan;
    const map = this.map;
    return {
      field: { width: map.width, height: map.height },
      borderWidth: BORDER_WIDTH,
      floor: (ctx, floorCamera) => {
        this.floor.draw(ctx, floorCamera);
      },
      zone: {
        x: map.width / 2,
        y: map.height / 2,
        radius: plan === null ? 0 : view.zoneRadius,
        startRadius: plan?.startRadius ?? 0,
        finalRadius: plan?.finalRadius ?? 0,
      },
      kits: view.kits.filter((kit: Kit) => isInView(camera, kit, CULL_MARGIN)),
      tanks: visible.map((tank) => this.sceneTank(tank, input)),
      bullets: view.bullets
        .filter((bullet) => isInView(camera, bullet, CULL_MARGIN))
        .map((bullet: FfaViewBullet): FxBullet => ({ ...bullet, color: colorOf(bullet.owner, myId) })),
      aimLine: null,
      ownTankId: myId,
      isShotGuarded: input.controls.isShotGuarded,
      fieldLayer: (ctx) => {
        this.drawShields(ctx, visible, myId, this.shields.update(visible, myId, input.frameMs), camera.scale);
      },
    };
  }

  private sceneTank(tank: FfaViewTank, input: FfaDrawInput): SceneTank {
    const { label, isBot } = input.labelOf(tank.id);
    return {
      id: tank.id,
      x: tank.x,
      y: tank.y,
      heading: tank.heading,
      turret: tank.turret,
      hp: tank.hp,
      maxHp: tank.maxHp,
      isAlive: tank.isAlive,
      color: colorOf(tank.id, input.myId),
      alpha: smoothstep(tank.presence),
      label,
      isBot,
    };
  }

  private drawShields(
    ctx: CanvasRenderingContext2D,
    tanks: readonly FfaViewTank[],
    myId: number | null,
    rings: readonly ShieldRing[],
    scale: number,
  ): void {
    ctx.save();
    for (const ring of rings) {
      const tank = tanks.find((candidate) => candidate.id === ring.id);
      if (tank?.isAlive !== true) {
        continue;
      }
      const color = colorOf(tank.id, myId);
      const alpha = ring.alpha * smoothstep(tank.presence);
      ctx.beginPath();
      ctx.arc(tank.x, tank.y, SHIELD_RADIUS, 0, FULL_TURN);
      ctx.lineWidth = SHIELD_HALO_WIDTH;
      ctx.strokeStyle = rgba(color, SHIELD_HALO_ALPHA * alpha);
      ctx.stroke();
      ctx.lineWidth = SHIELD_CORE_WIDTH;
      if (ring.share === null) {
        ctx.strokeStyle = rgba(color, SHIELD_CORE_ALPHA * alpha);
        ctx.stroke();
        continue;
      }
      ctx.strokeStyle = rgba(color, SHIELD_TRACK_ALPHA * alpha);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tank.x, tank.y, SHIELD_RADIUS, SHIELD_ARC_START, SHIELD_ARC_START + FULL_TURN * ring.share);
      ctx.strokeStyle = rgba(color, SHIELD_CORE_ALPHA * alpha);
      ctx.stroke();
      this.drawShieldHint(ctx, tank, alpha, scale);
    }
    ctx.restore();
  }

  // Подпись в координатах поля, размеры поделены на масштаб камеры: на экране она одного размера при любом окне.
  private drawShieldHint(ctx: CanvasRenderingContext2D, tank: FfaViewTank, alpha: number, scale: number): void {
    const y = tank.y + SHIELD_RADIUS + SHIELD_HINT_GAP_PX / scale;
    ctx.font = `600 ${String(SHIELD_HINT_FONT_PX / scale)}px ${BODY_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = SHIELD_HINT_OUTLINE_PX / scale;
    ctx.strokeStyle = rgba(TEXT_OUTLINE_COLOR, TEXT_OUTLINE_ALPHA * alpha);
    ctx.strokeText(SHIELD_HINT, tank.x, y);
    ctx.fillStyle = rgba(TEXT_COLOR, SHIELD_HINT_ALPHA * alpha);
    ctx.fillText(SHIELD_HINT, tank.x, y);
  }

  private resize(): void {
    const { width, height, pixelRatio } = this.viewport();
    this.pixelRatio = Math.min(pixelRatio, MAX_PIXEL_RATIO);
    this.canvas.width = Math.round(width * this.pixelRatio);
    this.canvas.height = Math.round(height * this.pixelRatio);
  }
}
