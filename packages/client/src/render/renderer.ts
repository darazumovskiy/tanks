import { ARENA, KIT, ROUND_SECONDS, ZONE, type Side } from '@tanks/shared/engine';
import type { WorldView } from '../prediction.js';
import type { Settings } from '../settings.js';
import { stickMagnitude } from '../steering.js';
import type { StickState } from '../touch.js';
import { drawTankSprite, TankArt } from './art.js';
import { edgeMarker, frameCamera, screenToWorld, type Camera } from './camera.js';
import { createCameraStrategy, type CameraMode, type CameraStrategy } from './cameraStrategy.js';
import type { Effects } from './effects.js';
import { floorFor } from './floor.js';
import { BODY_FONT, HEAD_FONT, SIDE_COLORS, clamp, easeOut } from './view.js';

export interface HudInfo {
  names: [string, string];
  score: [number, number];
  roundIndex: number;
  mySide: Side;
  rttMs: number;
  serverTick: number;
  pending: number;
  correctionPx: number;
  fps: number;
  worstFrameMs: number;
  isMuted: boolean;
  sticks: readonly StickState[];
  frameMs: number;
  frameTimes: readonly number[];
}

export type Overlay =
  | { kind: 'countdown'; elapsedS: number; totalS: number }
  | { kind: 'roundEnd'; winner: Side | null; reason: string; elapsedS: number }
  | null;

const ZONE_START_RADIUS = Math.hypot(ARENA.width / 2, ARENA.height / 2) + 60;
// Полная плотность экрана телефона (на Xiaomi 14T Pro — 3,25): замер на устройстве — 120 к/с, худший кадр 8 мс.
const MAX_PIXEL_RATIO = 4;

// Интерфейс размечен в CSS-пикселях под экран телефона высотой 390; на больших экранах растёт, но не больше чем в полтора раза.
const UI_BASE_HEIGHT = 390;
const UI_MAX_SCALE = 1.5;
const UI_MARGIN = 12;
const PLATE_WIDTH = 120;
const PLATE_BAR_HEIGHT = 7;
const MARKER_INSET = 36;
const MARKER_SIZE = 10;
const ANNOUNCE_SCALE = 0.6;
const FRAME_GRAPH_HEIGHT = 36;
const FRAME_GRAPH_BAR_WIDTH = 2;
const FRAME_BUDGET_MS = 1000 / 60;

// Кромка за полем: камера может показать пустоту до половины экрана, и она должна выглядеть краем арены,
// а не фоном холста. Полоса шире любой возможной пустоты.
const BORDER_WIDTH = 600;
// Полоса темнеет от поля наружу ступенями: даёт глубину, не требуя градиента на каждый кадр.
const BORDER_BANDS: readonly { width: number; fill: string }[] = [
  { width: BORDER_WIDTH, fill: '#0c0e11' },
  { width: 320, fill: '#121419' },
  { width: 120, fill: '#191c22' },
];
const BORDER_STRIPE_WIDTH = 28;
const BORDER_STRIPE_DASH = 40;
const BORDER_STRIPE_COLOR = 'rgba(240,180,40,0.22)';
const BORDER_STRIPE_GAP_COLOR = 'rgba(255,255,255,0.05)';
const BORDER_EDGE_COLOR = 'rgba(255,255,255,0.35)';
const BORDER_EDGE_WIDTH = 3;

const STICK_KNOB_RATIO = 0.42;
const STICK_BASE_COLOR = 'rgba(244,241,232,0.18)';
const STICK_EDGE_COLOR = 'rgba(244,241,232,0.45)';
const STICK_KNOB_COLOR = 'rgba(244,241,232,0.75)';
const FIRE_RING_IDLE_COLOR = 'rgba(232,130,90,0.35)';
const FIRE_RING_ACTIVE_COLOR = 'rgba(232,130,90,0.95)';

interface Screen {
  width: number;
  height: number;
  u: number;
}

// Собирает кадр: мир через камеру за своим танком (пол, следы, аптечки, зона, танки, снаряды, частицы),
// затем в экранных координатах — панели, стрелка на противника, объявления, оверлеи, отладка, стики.
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly art: [TankArt, TankArt] = [new TankArt(0), new TankArt(1)];
  private pixelRatio = 1;
  private camera: Camera;
  private strategy: CameraStrategy;
  private strategyMode: CameraMode;

  // На компьютере поле показывается целиком; на устройстве с касанием камеру ведёт стратегия из настроек.
  // `viewport` — размер холста в CSS-пикселях и плотность; по умолчанию окно браузера (лаборатория задаёт своё).
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly effects: Effects,
    private readonly settings: Readonly<Settings>,
    private readonly isTouchDevice: boolean,
    private readonly viewport: () => { width: number; height: number; pixelRatio: number } = windowViewport,
  ) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('Canvas 2D недоступен');
    }
    this.ctx = ctx;
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

  private screen(): Screen {
    const width = this.canvas.width / this.pixelRatio;
    const height = this.canvas.height / this.pixelRatio;
    return { width, height, u: clamp(height / UI_BASE_HEIGHT, 1, UI_MAX_SCALE) };
  }

  draw(view: WorldView, hud: HudInfo, overlay: Overlay): void {
    const { ctx } = this;
    this.camera = this.frameBattle(view, hud.mySide, hud.frameMs);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#07080a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.drawWorld(view, hud);

    const screen = this.screen();
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    this.drawHud(view, hud, screen);
    this.drawEnemyMarker(view, hud, screen);
    this.drawAnnouncements(screen);
    if (overlay?.kind === 'countdown') {
      this.drawCountdown(view, hud, screen, overlay.elapsedS, overlay.totalS);
    } else if (overlay?.kind === 'roundEnd') {
      this.drawRoundEnd(hud, screen, overlay.winner, overlay.reason, overlay.elapsedS);
    }
    if (this.effects.flashScreen > 0) {
      ctx.fillStyle = `rgba(255,235,210,${String(this.effects.flashScreen * 0.6)})`;
      ctx.fillRect(0, 0, screen.width, screen.height);
    }
    this.drawDebug(hud, screen);
    if (this.settings.showFrameGraph) {
      this.drawFrameGraph(hud.frameTimes, screen);
    }
    this.drawSticks(hud.sticks);
  }

  // Столбик — длительность кадра; линия — бюджет 60 к/с; красные столбики вышли за бюджет вдвое.
  private drawFrameGraph(frameTimes: readonly number[], screen: Screen): void {
    const { ctx } = this;
    const width = frameTimes.length * FRAME_GRAPH_BAR_WIDTH;
    const x0 = UI_MARGIN;
    const y0 = screen.height - 24 - FRAME_GRAPH_HEIGHT;
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

  private drawWorld(view: WorldView, hud: HudInfo): void {
    const { ctx, camera } = this;
    const shakeX = (Math.random() - 0.5) * this.effects.shake;
    const shakeY = (Math.random() - 0.5) * this.effects.shake;
    ctx.save();
    ctx.setTransform(camera.scale, 0, 0, camera.scale, -camera.x * camera.scale, -camera.y * camera.scale);
    ctx.translate(shakeX, shakeY);
    this.drawBorder();
    ctx.drawImage(floorFor(view.round.mapIndex), 0, 0, ARENA.width, ARENA.height);
    this.effects.drawDecals(ctx);
    this.drawKits(view);
    this.drawZone(view);
    for (const side of [0, 1] as const) {
      if (!view.tanks[side].isAlive) {
        this.drawTank(view, side);
      }
    }
    for (const side of [0, 1] as const) {
      if (view.tanks[side].isAlive) {
        this.drawTank(view, side);
      }
    }
    this.effects.drawBullets(ctx, view.bullets);
    this.effects.drawParticles(ctx);
    for (const side of [0, 1] as const) {
      if (view.tanks[side].isAlive) {
        this.drawTankTag(view, side, hud.names[side]);
      }
    }
    this.effects.drawPopups(ctx);
    ctx.restore();
  }

  // Полоса за полем, предупредительная штриховка вдоль края и светлая линия границы. Рисуется в координатах
  // поля под полом; пол закрывает внутреннюю половину штрихов, поэтому они отступают наружу.
  private drawBorder(): void {
    const { ctx } = this;
    ctx.save();
    for (const band of BORDER_BANDS) {
      ctx.fillStyle = band.fill;
      ctx.fillRect(-band.width, -band.width, ARENA.width + band.width * 2, ARENA.height + band.width * 2);
    }
    const inset = BORDER_STRIPE_WIDTH / 2;
    ctx.lineWidth = BORDER_STRIPE_WIDTH;
    ctx.strokeStyle = BORDER_STRIPE_GAP_COLOR;
    ctx.strokeRect(-inset, -inset, ARENA.width + inset * 2, ARENA.height + inset * 2);
    ctx.strokeStyle = BORDER_STRIPE_COLOR;
    ctx.setLineDash([BORDER_STRIPE_DASH, BORDER_STRIPE_DASH]);
    ctx.strokeRect(-inset, -inset, ARENA.width + inset * 2, ARENA.height + inset * 2);
    ctx.setLineDash([]);
    ctx.lineWidth = BORDER_EDGE_WIDTH;
    ctx.strokeStyle = BORDER_EDGE_COLOR;
    ctx.strokeRect(
      -BORDER_EDGE_WIDTH / 2,
      -BORDER_EDGE_WIDTH / 2,
      ARENA.width + BORDER_EDGE_WIDTH,
      ARENA.height + BORDER_EDGE_WIDTH,
    );
    ctx.restore();
  }

  private drawKits(view: WorldView): void {
    const { ctx } = this;
    const time = this.effects.time;
    for (const kit of view.round.kits) {
      if (kit.isActive) {
        const pulse = 0.5 + 0.5 * Math.sin(time * 5);
        ctx.save();
        ctx.translate(kit.x, kit.y);
        ctx.shadowColor = '#5dffa0';
        ctx.shadowBlur = 18 + pulse * 12;
        ctx.fillStyle = 'rgba(20,60,40,0.85)';
        ctx.beginPath();
        ctx.arc(0, 0, KIT.radius + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#5dffa0';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#5dffa0';
        ctx.fillRect(-3.5, -10, 7, 20);
        ctx.fillRect(-10, -3.5, 20, 7);
        ctx.rotate(time * 1.5);
        ctx.strokeStyle = `rgba(93,255,160,${String(0.3 + pulse * 0.4)})`;
        ctx.setLineDash([6, 8]);
        ctx.beginPath();
        ctx.arc(0, 0, KIT.radius + 10 + pulse * 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      } else if (kit.respawnIn < 6) {
        ctx.save();
        ctx.strokeStyle = 'rgba(93,255,160,0.35)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(kit.x, kit.y, KIT.radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - kit.respawnIn / 6));
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawZone(view: WorldView): void {
    const { ctx } = this;
    const zone = view.round.zone;
    if (zone.radius > ZONE_START_RADIUS - 20) {
      return;
    }
    const time = this.effects.time;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, ARENA.width, ARENA.height);
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2, true);
    ctx.fillStyle = `rgba(255,40,70,${String(0.13 + 0.04 * Math.sin(time * 4))})`;
    ctx.fill('evenodd');
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,90,100,0.95)';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#ff3050';
    ctx.shadowBlur = 16;
    ctx.setLineDash([22, 12]);
    ctx.lineDashOffset = -time * 40;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,90,100,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, ZONE.finalRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawTank(view: WorldView, side: Side): void {
    const tank = view.tanks[side];
    const fx = this.effects.tankFx[side];
    drawTankSprite(this.ctx, this.art[side], tank.x, tank.y, tank.heading, tank.turret, 64, {
      flash: fx.flash,
      recoil: fx.recoil,
      isDead: !tank.isAlive,
    });
  }

  private drawTankTag(view: WorldView, side: Side, name: string): void {
    const { ctx } = this;
    const tank = view.tanks[side];
    const maxHp = view.round.tanks[side].stats.maxHp;
    const width = 56;
    const x = tank.x - width / 2;
    const y = tank.y - 48;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 1, y - 1, width + 2, 6);
    ctx.fillStyle = SIDE_COLORS[side];
    ctx.fillRect(x, y, width * clamp(tank.hp / maxHp, 0, 1), 4);
    ctx.font = `600 11px ${BODY_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 4;
    ctx.fillText(name, tank.x, y - 4);
    ctx.restore();
  }

  // Свой танк — слева, противник — справа, независимо от стороны в комнате; цвета — по стороне.
  private drawHud(view: WorldView, hud: HudInfo, screen: Screen): void {
    const { ctx } = this;
    const { u } = screen;
    const enemySide: Side = hud.mySide === 0 ? 1 : 0;
    this.drawPlate(view, hud, screen, hud.mySide, false);
    this.drawPlate(view, hud, screen, enemySide, true);

    const left = Math.max(0, ROUND_SECONDS - view.round.time);
    const minutes = Math.floor(left / 60);
    const seconds = Math.floor(left % 60);
    const isZoneOn = view.round.time >= ZONE.startShrink;
    const centerX = screen.width / 2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = `${String(22 * u)}px ${HEAD_FONT}`;
    ctx.fillStyle = isZoneOn ? '#ff5a6a' : '#f2f2f2';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 6 * u;
    ctx.fillText(`${String(minutes)}:${String(seconds).padStart(2, '0')}`, centerX, 28 * u);
    ctx.font = `${String(14 * u)}px ${HEAD_FONT}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = SIDE_COLORS[hud.mySide];
    ctx.fillText(String(hud.score[hud.mySide]), centerX - 8 * u, 46 * u);
    ctx.textAlign = 'left';
    ctx.fillStyle = SIDE_COLORS[enemySide];
    ctx.fillText(String(hud.score[enemySide]), centerX + 8 * u, 46 * u);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(':', centerX, 46 * u);
    ctx.font = `600 ${String(9 * u)}px ${BODY_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(`РАУНД ${String(hud.roundIndex + 1)} · ${view.round.map.name.toUpperCase()}`, centerX, 58 * u);
    ctx.restore();
  }

  private drawPlate(view: WorldView, hud: HudInfo, screen: Screen, side: Side, isRight: boolean): void {
    const { ctx } = this;
    const { u } = screen;
    const color = SIDE_COLORS[side];
    const tank = view.tanks[side];
    const maxHp = view.round.tanks[side].stats.maxHp;
    const fx = this.effects.tankFx[side];
    const width = PLATE_WIDTH * u;
    const x = isRight ? screen.width - UI_MARGIN * u - width : UI_MARGIN * u;
    const barY = 26 * u;
    const barHeight = PLATE_BAR_HEIGHT * u;
    const k = clamp(tank.hp / maxHp, 0, 1);
    const ghost = clamp((fx.ghostHp ?? tank.hp) / maxHp, 0, 1);
    ctx.save();
    ctx.textAlign = isRight ? 'right' : 'left';
    ctx.font = `700 ${String(13 * u)}px ${BODY_FONT}`;
    ctx.fillStyle = tank.isAlive ? '#fff' : 'rgba(255,255,255,0.45)';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4 * u;
    ctx.fillText(hud.names[side], isRight ? x + width : x, 19 * u);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x, barY, width, barHeight);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(isRight ? x + width * (1 - ghost) : x, barY, width * ghost, barHeight);
    ctx.fillStyle = color;
    ctx.fillRect(isRight ? x + width * (1 - k) : x, barY, width * k, barHeight);
    ctx.font = `600 ${String(10 * u)}px ${BODY_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(
      `${String(Math.ceil(tank.hp))} / ${String(maxHp)}`,
      isRight ? x + width : x,
      barY + barHeight + 12 * u,
    );
    ctx.restore();
  }

  private drawEnemyMarker(view: WorldView, hud: HudInfo, screen: Screen): void {
    const enemySide: Side = hud.mySide === 0 ? 1 : 0;
    const enemy = view.tanks[enemySide];
    if (!enemy.isAlive) {
      return;
    }
    const marker = edgeMarker(this.camera, enemy, MARKER_INSET * screen.u * this.pixelRatio);
    if (marker === null) {
      return;
    }
    const { ctx } = this;
    const { u } = screen;
    const x = marker.x / this.pixelRatio;
    const y = marker.y / this.pixelRatio;
    const size = MARKER_SIZE * u;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(marker.angle);
    ctx.fillStyle = SIDE_COLORS[enemySide];
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 6 * u;
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.8, -size * 0.7);
    ctx.lineTo(-size * 0.8, size * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = `600 ${String(10 * u)}px ${BODY_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 4 * u;
    const labelX = clamp(x, 30 * u, screen.width - 30 * u);
    const labelY = y + (y > screen.height / 2 ? -size - 6 * u : size + 14 * u);
    ctx.fillText(hud.names[enemySide], labelX, labelY);
    ctx.restore();
  }

  private drawAnnouncements(screen: Screen): void {
    const { ctx } = this;
    const scale = screen.u * ANNOUNCE_SCALE;
    ctx.save();
    ctx.setTransform(this.pixelRatio * scale, 0, 0, this.pixelRatio * scale, 0, 0);
    this.effects.drawAnnouncements(ctx, screen.width / scale, (screen.height * 0.3) / scale);
    ctx.restore();
  }

  private drawCountdown(view: WorldView, hud: HudInfo, screen: Screen, elapsedS: number, totalS: number): void {
    const { ctx } = this;
    const { u, width, height } = screen;
    ctx.save();
    ctx.fillStyle = 'rgba(5,6,8,0.55)';
    ctx.fillRect(0, 0, width, height);
    const titleY = height * 0.3;
    ctx.textAlign = 'center';
    ctx.font = `600 ${String(14 * u)}px ${BODY_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(`РАУНД ${String(hud.roundIndex + 1)}`, width / 2, titleY);
    ctx.font = `${String(36 * u)}px ${HEAD_FONT}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(view.round.map.name.toUpperCase(), width / 2, titleY + 42 * u);
    ctx.font = `700 ${String(14 * u)}px ${BODY_FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = SIDE_COLORS[0];
    ctx.fillText(`◀ ${hud.names[0]}`, UI_MARGIN * 2 * u, titleY + 42 * u);
    ctx.textAlign = 'right';
    ctx.fillStyle = SIDE_COLORS[1];
    ctx.fillText(`${hud.names[1]} ▶`, width - UI_MARGIN * 2 * u, titleY + 42 * u);
    const left = totalS - elapsedS;
    const number = Math.ceil(left);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    if (number >= 1) {
      const fraction = 1 - (left - Math.floor(left));
      ctx.globalAlpha = 1 - fraction * 0.7;
      ctx.font = `${String(Math.round(100 * u * (1.3 - easeOut(fraction) * 0.3)))}px ${HEAD_FONT}`;
      ctx.fillText(String(number), width / 2, height * 0.78);
    } else {
      ctx.font = `${String(80 * u)}px ${HEAD_FONT}`;
      ctx.fillText('БОЙ!', width / 2, height * 0.78);
    }
    ctx.restore();
  }

  private drawRoundEnd(hud: HudInfo, screen: Screen, winner: Side | null, reason: string, elapsedS: number): void {
    const { ctx } = this;
    const { u, width, height } = screen;
    const enter = easeOut(elapsedS / 0.35);
    const color = winner === null ? '#cfcfcf' : SIDE_COLORS[winner];
    const bandHeight = 100 * u;
    const y = height / 2 - bandHeight / 2;
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${String(0.35 * enter)})`;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(8,9,12,0.9)';
    ctx.fillRect(0, y, width * enter, bandHeight);
    ctx.fillStyle = color;
    ctx.fillRect(0, y, width * enter, 3 * u);
    ctx.fillRect(width * (1 - enter), y + bandHeight - 3 * u, width * enter, 3 * u);
    ctx.globalAlpha = enter;
    ctx.textAlign = 'center';
    ctx.font = `${String(44 * u)}px ${HEAD_FONT}`;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 20 * u;
    ctx.fillText(winner === null ? 'НИЧЬЯ' : hud.names[winner].toUpperCase(), width / 2, y + 54 * u);
    ctx.shadowBlur = 0;
    ctx.font = `700 ${String(13 * u)}px ${BODY_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(reason, width / 2, y + 80 * u);
    ctx.restore();
  }

  private drawDebug(hud: HudInfo, screen: Screen): void {
    const { ctx } = this;
    ctx.save();
    ctx.font = `10px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(244,241,232,0.55)';
    const sound = hud.isMuted ? 'звук выкл · M' : 'M — звук';
    ctx.fillText(
      `${hud.fps.toFixed(0)} к/с · худший кадр ${hud.worstFrameMs.toFixed(0)} мс · задержка ${hud.rttMs.toFixed(0)} мс · поправка ${hud.correctionPx.toFixed(1)} px · ${sound}`,
      UI_MARGIN,
      screen.height - 8,
    );
    ctx.restore();
  }

  // Стики живут в CSS-пикселях окна, поэтому рисуются поверх кадра без масштаба поля.
  private drawSticks(sticks: readonly StickState[]): void {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.lineWidth = 2;
    for (const stick of sticks) {
      const radius = stick.radiusPx;
      ctx.fillStyle = STICK_BASE_COLOR;
      ctx.strokeStyle = STICK_EDGE_COLOR;
      ctx.beginPath();
      ctx.arc(stick.baseX, stick.baseY, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = STICK_EDGE_COLOR;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.arc(stick.baseX, stick.baseY, radius * stick.deadZone, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (stick.role === 'aim') {
        const isFiring = stickMagnitude(stick) >= stick.fireRing;
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

function windowViewport(): { width: number; height: number; pixelRatio: number } {
  return { width: window.innerWidth, height: window.innerHeight, pixelRatio: window.devicePixelRatio };
}
