import { gameTimecode } from '@tanks/shared/protocol';
import type { Settings } from '../settings.js';
import type { StickState } from '../touch.js';
import type { Effects } from './effects.js';
import { clamp } from './view.js';

// Интерфейс размечен в CSS-пикселях под экран телефона высотой 390; на больших экранах растёт, но не больше чем в полтора раза.
const UI_BASE_HEIGHT = 390;
const UI_MAX_SCALE = 1.5;
export const UI_MARGIN = 12;
const ANNOUNCE_SCALE = 0.6;
const ANNOUNCE_Y_SHARE = 0.3;
const SCREEN_FLASH_ALPHA = 0.6;
const DEBUG_BOTTOM_OFFSET = 8;
const GAME_STAMP_FONT_PX = 11;
const FRAME_GRAPH_BOTTOM_OFFSET = 24;
const FRAME_GRAPH_HEIGHT = 36;
const FRAME_GRAPH_BAR_WIDTH = 2;
const FRAME_BUDGET_MS = 1000 / 60;

const STICK_KNOB_RATIO = 0.42;
const STICK_BASE_COLOR = 'rgba(244,241,232,0.18)';
const STICK_EDGE_COLOR = 'rgba(244,241,232,0.45)';
const STICK_KNOB_COLOR = 'rgba(244,241,232,0.75)';
const FIRE_RING_IDLE_COLOR = 'rgba(232,130,90,0.35)';
const FIRE_RING_ACTIVE_COLOR = 'rgba(232,130,90,0.95)';
const REVERSE_EDGE_COLOR = 'rgba(120,200,230,0.9)';

// Экран в CSS-пикселях: размеры, масштаб интерфейса `u` и плотность холста.
export interface Screen {
  width: number;
  height: number;
  u: number;
  pixelRatio: number;
}

export function screenOf(canvas: HTMLCanvasElement, pixelRatio: number): Screen {
  const width = canvas.width / pixelRatio;
  const height = canvas.height / pixelRatio;
  return { width, height, u: clamp(height / UI_BASE_HEIGHT, 1, UI_MAX_SCALE), pixelRatio };
}

export interface DebugReadout {
  gameId: string;
  gameTick: number;
  fps: number;
  worstFrameMs: number;
  rttMs: number;
  correctionPx: number;
  isMuted: boolean;
}

function edgeColor(isFiring: boolean, isReversing: boolean): string {
  if (isFiring) {
    return FIRE_RING_ACTIVE_COLOR;
  }
  if (isReversing) {
    return REVERSE_EDGE_COLOR;
  }
  return STICK_EDGE_COLOR;
}

// Экранные слои поверх поля, общие для дуэли и толпы: объявления, вспышка экрана, отладка, график кадров, стики.
// Рисуются в CSS-пикселях: перед вызовом холст масштабирован на плотность экрана.
export class ScreenLayers {
  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly effects: Effects,
    private readonly settings: Readonly<Settings>,
  ) {}

  drawAnnouncements(screen: Screen): void {
    const { ctx } = this;
    const scale = screen.u * ANNOUNCE_SCALE;
    ctx.save();
    ctx.setTransform(screen.pixelRatio * scale, 0, 0, screen.pixelRatio * scale, 0, 0);
    this.effects.drawAnnouncements(ctx, screen.width / scale, (screen.height * ANNOUNCE_Y_SHARE) / scale);
    ctx.restore();
  }

  drawFlash(screen: Screen): void {
    const flash = this.effects.flashScreen;
    if (flash <= 0) {
      return;
    }
    this.ctx.fillStyle = `rgba(255,235,210,${String(flash * SCREEN_FLASH_ALPHA)})`;
    this.ctx.fillRect(0, 0, screen.width, screen.height);
  }

  drawDebug(readout: DebugReadout, screen: Screen): void {
    const { ctx } = this;
    ctx.save();
    ctx.font = `10px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(244,241,232,0.55)';
    const sound = readout.isMuted ? 'звук выкл · M' : 'M — звук';
    ctx.fillText(
      `${readout.gameId} ${gameTimecode(readout.gameTick)} · ${readout.fps.toFixed(0)} к/с · худший кадр ${readout.worstFrameMs.toFixed(0)} мс · задержка ${readout.rttMs.toFixed(0)} мс · поправка ${readout.correctionPx.toFixed(1)} px · ${sound}`,
      UI_MARGIN,
      screen.height - DEBUG_BOTTOM_OFFSET,
    );
    ctx.restore();
  }

  // Только игра и таймкод: по ним игрок называет момент, когда рассказывает о сбое.
  drawGameStamp(readout: DebugReadout, screen: Screen): void {
    const { ctx } = this;
    ctx.save();
    ctx.font = `${String(GAME_STAMP_FONT_PX)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(244,241,232,0.55)';
    ctx.fillText(`${readout.gameId} ${gameTimecode(readout.gameTick)}`, UI_MARGIN, screen.height - DEBUG_BOTTOM_OFFSET);
    ctx.restore();
  }

  // Столбик — длительность кадра; линия — бюджет 60 к/с; красные столбики вышли за бюджет вдвое.
  drawFrameGraph(frameTimes: readonly number[], screen: Screen): void {
    if (!this.settings.showFrameGraph) {
      return;
    }
    const { ctx } = this;
    const width = frameTimes.length * FRAME_GRAPH_BAR_WIDTH;
    const x0 = UI_MARGIN;
    const y0 = screen.height - FRAME_GRAPH_BOTTOM_OFFSET - FRAME_GRAPH_HEIGHT;
    const scale = FRAME_GRAPH_HEIGHT / (FRAME_BUDGET_MS * 3);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x0, y0, width, FRAME_GRAPH_HEIGHT);
    frameTimes.forEach((ms, index) => {
      const height = Math.min(FRAME_GRAPH_HEIGHT, ms * scale);
      ctx.fillStyle = ms > FRAME_BUDGET_MS * 2 ? 'rgba(255,90,100,0.9)' : 'rgba(93,255,160,0.7)';
      ctx.fillRect(x0 + index * FRAME_GRAPH_BAR_WIDTH, y0 + FRAME_GRAPH_HEIGHT - height, FRAME_GRAPH_BAR_WIDTH, height);
    });
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + FRAME_GRAPH_HEIGHT - FRAME_BUDGET_MS * scale);
    ctx.lineTo(x0 + width, y0 + FRAME_GRAPH_HEIGHT - FRAME_BUDGET_MS * scale);
    ctx.stroke();
    ctx.restore();
  }

  // Стики живут в CSS-пикселях окна, поэтому рисуются поверх кадра без масштаба поля.
  // С огнём по цели стик подсвечивается, только когда зона пропускает выстрелы; стик корпуса — на заднем ходу.
  drawSticks(sticks: readonly StickState[], isZoneFiring: boolean, isReversing: boolean, screen: Screen): void {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(screen.pixelRatio, 0, 0, screen.pixelRatio, 0, 0);
    ctx.lineWidth = 2;
    const isZoneOpen = !this.settings.hasZoneFire || isZoneFiring;
    for (const stick of sticks) {
      const radius = stick.radiusPx;
      const isFiring = stick.isFiring && isZoneOpen;
      // Без кольца стреляет само касание — огонь показывает контур основания.
      const isEdgeFiring = isFiring && stick.fireRing === null;
      const isEdgeReversing = stick.role === 'move' && isReversing;
      const isEdgeLit = isEdgeFiring || isEdgeReversing;
      ctx.fillStyle = STICK_BASE_COLOR;
      ctx.strokeStyle = edgeColor(isEdgeFiring, isEdgeReversing);
      ctx.lineWidth = isEdgeLit ? 4 : 2;
      ctx.beginPath();
      ctx.arc(stick.baseX, stick.baseY, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = STICK_EDGE_COLOR;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.arc(stick.baseX, stick.baseY, radius * stick.deadZone, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (stick.role === 'aim' && stick.fireRing !== null) {
        ctx.strokeStyle = isFiring ? FIRE_RING_ACTIVE_COLOR : FIRE_RING_IDLE_COLOR;
        ctx.lineWidth = isFiring ? 4 : 2;
        ctx.beginPath();
        ctx.arc(stick.baseX, stick.baseY, radius * stick.fireRing, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 2;
      }
      ctx.fillStyle = STICK_KNOB_COLOR;
      ctx.beginPath();
      ctx.arc(
        stick.baseX + stick.dx * radius,
        stick.baseY + stick.dy * radius,
        radius * STICK_KNOB_RATIO,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.restore();
  }
}
