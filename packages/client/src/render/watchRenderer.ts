import { ARENA } from '@tanks/shared/engine';
import type { WorldView } from '../prediction.js';
import { defaultSettings } from '../settings.js';
import type { AimLineStyle } from './aimLineStyle.js';
import { aimLineStyleById } from './aimLineStyles.js';
import type { Camera } from './camera.js';
import { DuelHud, type DuelHudInfo } from './duelHud.js';
import type { Effects } from './effects.js';
import { FieldRenderer } from './field.js';
import { duelScene, type Overlay } from './renderer.js';
import { ScreenLayers, screenOf, type Screen } from './screenLayers.js';
import { SIDE_COLORS } from './view.js';
import type { WatchStyle } from './watchStyle.js';

export interface WatchHudInfo extends DuelHudInfo {
  frameMs: number;
}

// Полная плотность экрана телефона, как у дуэли.
const MAX_PIXEL_RATIO = 4;

interface Viewport {
  width: number;
  height: number;
  pixelRatio: number;
}

// Поле целиком в холсте с отступами: масштаб — наибольший, при котором поле входит, остаток делится поровну.
function fieldCamera(screen: Screen, style: WatchStyle): Camera {
  const { u, pixelRatio } = screen;
  const top = style.fieldTopInset * u;
  const side = style.fieldSideInset * u;
  const bottom = style.fieldBottomInset * u;
  const room = { width: screen.width - side * 2, height: screen.height - top - bottom };
  const scale = Math.min(room.width / ARENA.width, room.height / ARENA.height) * pixelRatio;
  const width = (screen.width * pixelRatio) / scale;
  const height = (screen.height * pixelRatio) / scale;
  const left = side + (room.width - (ARENA.width * scale) / pixelRatio) / 2;
  const above = top + (room.height - (ARENA.height * scale) / pixelRatio) / 2;
  return { x: -(left * pixelRatio) / scale, y: -(above * pixelRatio) / scale, width, height, scale };
}

// Кадр боя ботов из частей рендера дуэли: поле целиком над панелью управления, панели здоровья, таймер и счёт,
// отсчёт, объявления, вспышка экрана. Без линии выстрела, стрелки на противника, стиков и строки отладки.
export class WatchRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly field: FieldRenderer;
  private readonly hud: DuelHud;
  private readonly layers: ScreenLayers;
  private readonly aimLineStyle: AimLineStyle;
  private pixelRatio = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    effects: Effects,
    private readonly style: WatchStyle,
  ) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('Canvas 2D недоступен');
    }
    const settings = defaultSettings();
    this.ctx = ctx;
    this.field = new FieldRenderer(ctx, effects, SIDE_COLORS);
    this.hud = new DuelHud(ctx, effects);
    this.layers = new ScreenLayers(ctx, effects, settings);
    this.aimLineStyle = aimLineStyleById(settings.aimLineStyle).style;
    this.resize();
    window.addEventListener('resize', () => {
      this.resize();
    });
  }

  // Холст занимает экран над панелью: размер — его собственный, не окна.
  private viewport(): Viewport {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight, pixelRatio: window.devicePixelRatio };
  }

  private resize(): void {
    const { width, height, pixelRatio } = this.viewport();
    this.pixelRatio = Math.min(pixelRatio, MAX_PIXEL_RATIO);
    this.canvas.width = Math.round(width * this.pixelRatio);
    this.canvas.height = Math.round(height * this.pixelRatio);
  }

  draw(view: WorldView, hud: WatchHudInfo, overlay: Overlay): void {
    const screen = screenOf(this.canvas, this.pixelRatio);
    this.field.draw(duelScene(view, { names: hud.names, mySide: hud.mySide, aimLine: null, isShotGuarded: false }), {
      camera: fieldCamera(screen, this.style),
      pixelRatio: this.pixelRatio,
      frameMs: hud.frameMs,
      aimLineStyle: this.aimLineStyle,
    });
    this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    this.hud.drawPanels(view, hud, screen);
    this.layers.drawAnnouncements(screen);
    if (overlay?.kind === 'countdown') {
      this.hud.drawCountdown(view, hud, screen, overlay.elapsedS, overlay.totalS);
    }
    this.layers.drawFlash(screen);
  }
}
