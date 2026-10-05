import { KIT, MUZZLE_OFFSET, type FieldSize, type Kit } from '@tanks/shared/engine';
import type { AimLine } from '../aimLine.js';
import { drawAimLine, type AimLineStyle } from './aimLineStyle.js';
import { drawTankSprite, TANK_ART_SCALE, TANK_SPRITE_SIZE, TankArt } from './art.js';
import type { Camera } from './camera.js';
import type { Effects, FxBullet } from './effects.js';
import { BODY_FONT, clamp, easeOut, rgba } from './view.js';

const BACKGROUND_COLOR = '#07080a';

// Кромка за полем: камера может показать пустоту за краем, и она должна выглядеть краем арены, а не фоном холста.
// Внешняя ступень — во всю ширину кромки из сцены; ближе к полю полоса светлеет ступенями: глубина без градиента
// на каждый кадр.
const BORDER_OUTER_FILL = '#0c0e11';
const BORDER_INNER_BANDS: readonly { width: number; fill: string }[] = [
  { width: 320, fill: '#121419' },
  { width: 120, fill: '#191c22' },
];
const BORDER_STRIPE_WIDTH = 28;
const BORDER_STRIPE_DASH = 40;
const BORDER_STRIPE_COLOR = 'rgba(240,180,40,0.22)';
const BORDER_STRIPE_GAP_COLOR = 'rgba(255,255,255,0.05)';
const BORDER_EDGE_COLOR = 'rgba(255,255,255,0.35)';
const BORDER_EDGE_WIDTH = 3;

// Круг зоны не рисуется, пока радиус почти начальный: он ещё за краем поля.
const ZONE_HIDDEN_MARGIN = 20;
const ZONE_FILL_COLOR = '#ff2846';
const ZONE_FILL_ALPHA = 0.13;
const ZONE_FILL_PULSE_ALPHA = 0.04;
const ZONE_FILL_PULSE_SPEED = 4;
const ZONE_EDGE_COLOR = 'rgba(255,90,100,0.95)';
const ZONE_EDGE_WIDTH = 3;
const ZONE_EDGE_GLOW_COLOR = '#ff3050';
const ZONE_EDGE_GLOW_BLUR = 16;
const ZONE_EDGE_DASH: readonly number[] = [22, 12];
const ZONE_EDGE_RUN_SPEED = 40;
const ZONE_FINAL_COLOR = 'rgba(255,90,100,0.3)';
const ZONE_FINAL_WIDTH = 1;

const KIT_COLOR = '#5dffa0';
const KIT_PULSE_SPEED = 5;
const KIT_GLOW_BLUR = 18;
const KIT_GLOW_PULSE_BLUR = 12;
const KIT_FILL = 'rgba(20,60,40,0.85)';
const KIT_BODY_MARGIN = 2;
const KIT_EDGE_WIDTH = 2.5;
const KIT_CROSS_HALF_WIDTH = 3.5;
const KIT_CROSS_HALF_LENGTH = 10;
const KIT_RING_SPIN_SPEED = 1.5;
const KIT_RING_ALPHA = 0.3;
const KIT_RING_PULSE_ALPHA = 0.4;
const KIT_RING_DASH: readonly number[] = [6, 8];
const KIT_RING_MARGIN = 10;
const KIT_RING_PULSE = 3;
const KIT_RESPAWN_ARC_S = 6;
const KIT_RESPAWN_ARC_COLOR = 'rgba(93,255,160,0.35)';
const KIT_RESPAWN_ARC_WIDTH = 3;

const TAG_WIDTH = 56 * TANK_ART_SCALE;
const TAG_OFFSET_Y = 48 * TANK_ART_SCALE;
const TAG_BAR_HEIGHT = 4;
const TAG_BAR_BORDER = 1;
const TAG_BAR_BACK_COLOR = 'rgba(0,0,0,0.6)';
const TAG_FONT = `600 11px ${BODY_FONT}`;
const TAG_LABEL_GAP = 4;
const TAG_LABEL_COLOR = 'rgba(255,255,255,0.85)';
const TAG_SHADOW_COLOR = 'rgba(0,0,0,0.9)';
const TAG_SHADOW_BLUR = 4;
const BOT_MARK = 'БОТ ';
const BOT_MARK_COLOR = 'rgba(244,241,232,0.5)';

// Штрих предохранителя поперёк ствола сразу за дулом своего танка: выстрел сдерживается.
const GUARD_COLOR = '#ff5a6a';
const GUARD_FADE_MS = 120;
const GUARD_OFFSET = MUZZLE_OFFSET + 7;
const GUARD_HALF_LENGTH = 9;
const GUARD_LINE_WIDTH = 3;
const GUARD_ALPHA = 0.95;

// Пол в координатах поля; окно камеры — для пола, который рисуется кусками.
type DrawFloor = (ctx: CanvasRenderingContext2D, camera: Camera) => void;
// Слой режима на поле поверх танков: в координатах поля, под той же тряской, что танки.
type DrawFieldLayer = (ctx: CanvasRenderingContext2D) => void;

interface SceneZone {
  x: number;
  y: number;
  radius: number;
  startRadius: number;
  finalRadius: number;
}

export interface SceneTank {
  id: number;
  x: number;
  y: number;
  heading: number;
  turret: number;
  hp: number;
  maxHp: number;
  isAlive: boolean;
  color: string;
  alpha: number;
  label: string;
  isBot: boolean;
}

export interface FieldScene {
  field: FieldSize;
  borderWidth: number;
  floor: DrawFloor;
  zone: SceneZone;
  kits: readonly Kit[];
  // Подбитые рисуются под живыми; внутри каждой группы — в порядке списка.
  tanks: readonly SceneTank[];
  bullets: readonly FxBullet[];
  aimLine: AimLine | null;
  ownTankId: number | null;
  isShotGuarded: boolean;
  fieldLayer: DrawFieldLayer | null;
}

// Длительность кадра — для плавного появления линии выстрела и отметки предохранителя.
interface FieldFrame {
  camera: Camera;
  pixelRatio: number;
  frameMs: number;
  aimLineStyle: AimLineStyle;
}

// Мир через камеру: кромка, пол, следы и подпалины, аптечки, зона, танки, линия выстрела, снаряды, частицы, подписи,
// отметка предохранителя, всплывающие цифры. Общий для дуэли и толпы: всё, что зависит от режима, приходит сценой.
export class FieldRenderer {
  private readonly arts = new Map<string, TankArt>();
  private guardGlow = 0;
  private aimLineGlow = 0;
  // Последняя линия остаётся на время угасания после выключения или гибели.
  private lastAimLine: AimLine | null = null;

  // Спрайты цветов палитры заготавливаются сразу: картинка грузится не мгновенно, а танк без спрайта не рисуется.
  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly effects: Effects,
    palette: readonly string[],
  ) {
    for (const color of palette) {
      this.artOf(color);
    }
  }

  draw(scene: FieldScene, frame: FieldFrame): void {
    const { ctx } = this;
    const { camera } = frame;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BACKGROUND_COLOR;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const shakeX = (Math.random() - 0.5) * this.effects.shake;
    const shakeY = (Math.random() - 0.5) * this.effects.shake;
    ctx.save();
    ctx.setTransform(camera.scale, 0, 0, camera.scale, -camera.x * camera.scale, -camera.y * camera.scale);
    ctx.translate(shakeX, shakeY);
    this.drawBorder(scene, camera);
    scene.floor(ctx, camera);
    this.effects.drawDecals(ctx, camera);
    this.drawKits(scene.kits);
    this.drawZone(scene);
    for (const tank of scene.tanks) {
      if (!tank.isAlive) {
        this.drawTank(tank);
      }
    }
    for (const tank of scene.tanks) {
      if (tank.isAlive) {
        this.drawTank(tank);
      }
    }
    if (scene.fieldLayer !== null) {
      scene.fieldLayer(ctx);
    }
    this.drawAimLine(scene.aimLine, frame);
    this.effects.drawBullets(ctx, scene.bullets);
    this.effects.drawParticles(ctx);
    for (const tank of scene.tanks) {
      if (tank.isAlive) {
        this.drawTankTag(tank);
      }
    }
    this.drawGuardMark(scene, frame.frameMs);
    this.effects.drawPopups(ctx);
    ctx.restore();
  }

  private artOf(color: string): TankArt {
    const known = this.arts.get(color);
    if (known !== undefined) {
      return known;
    }
    const art = new TankArt(color);
    this.arts.set(color, art);
    return art;
  }

  // Полоса за полем, предупредительная штриховка вдоль края и светлая линия границы. Рисуется в координатах
  // поля под полом; пол закрывает внутреннюю половину штрихов, поэтому они отступают наружу. Окно целиком
  // внутри поля — рисовать нечего, экономим три заливки на кадр.
  private drawBorder(scene: FieldScene, camera: Camera): void {
    const { ctx } = this;
    const { width, height } = scene.field;
    const isInsideField =
      camera.x >= 0 && camera.y >= 0 && camera.x + camera.width <= width && camera.y + camera.height <= height;
    if (isInsideField) {
      return;
    }
    ctx.save();
    const bands = [{ width: scene.borderWidth, fill: BORDER_OUTER_FILL }, ...BORDER_INNER_BANDS];
    for (const band of bands) {
      ctx.fillStyle = band.fill;
      ctx.fillRect(-band.width, -band.width, width + band.width * 2, height + band.width * 2);
    }
    const inset = BORDER_STRIPE_WIDTH / 2;
    ctx.lineWidth = BORDER_STRIPE_WIDTH;
    ctx.strokeStyle = BORDER_STRIPE_GAP_COLOR;
    ctx.strokeRect(-inset, -inset, width + inset * 2, height + inset * 2);
    ctx.strokeStyle = BORDER_STRIPE_COLOR;
    ctx.setLineDash([BORDER_STRIPE_DASH, BORDER_STRIPE_DASH]);
    ctx.strokeRect(-inset, -inset, width + inset * 2, height + inset * 2);
    ctx.setLineDash([]);
    ctx.lineWidth = BORDER_EDGE_WIDTH;
    ctx.strokeStyle = BORDER_EDGE_COLOR;
    ctx.strokeRect(
      -BORDER_EDGE_WIDTH / 2,
      -BORDER_EDGE_WIDTH / 2,
      width + BORDER_EDGE_WIDTH,
      height + BORDER_EDGE_WIDTH,
    );
    ctx.restore();
  }

  private drawKits(kits: readonly Kit[]): void {
    const { ctx } = this;
    const time = this.effects.time;
    for (const kit of kits) {
      if (kit.isActive) {
        const pulse = 0.5 + 0.5 * Math.sin(time * KIT_PULSE_SPEED);
        ctx.save();
        ctx.translate(kit.x, kit.y);
        ctx.shadowColor = KIT_COLOR;
        ctx.shadowBlur = KIT_GLOW_BLUR + pulse * KIT_GLOW_PULSE_BLUR;
        ctx.fillStyle = KIT_FILL;
        ctx.beginPath();
        ctx.arc(0, 0, KIT.radius + KIT_BODY_MARGIN, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = KIT_COLOR;
        ctx.lineWidth = KIT_EDGE_WIDTH;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = KIT_COLOR;
        ctx.fillRect(
          -KIT_CROSS_HALF_WIDTH,
          -KIT_CROSS_HALF_LENGTH,
          KIT_CROSS_HALF_WIDTH * 2,
          KIT_CROSS_HALF_LENGTH * 2,
        );
        ctx.fillRect(
          -KIT_CROSS_HALF_LENGTH,
          -KIT_CROSS_HALF_WIDTH,
          KIT_CROSS_HALF_LENGTH * 2,
          KIT_CROSS_HALF_WIDTH * 2,
        );
        ctx.rotate(time * KIT_RING_SPIN_SPEED);
        ctx.strokeStyle = rgba(KIT_COLOR, KIT_RING_ALPHA + pulse * KIT_RING_PULSE_ALPHA);
        ctx.setLineDash(KIT_RING_DASH);
        ctx.beginPath();
        ctx.arc(0, 0, KIT.radius + KIT_RING_MARGIN + pulse * KIT_RING_PULSE, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      } else if (kit.respawnIn < KIT_RESPAWN_ARC_S) {
        ctx.save();
        ctx.strokeStyle = KIT_RESPAWN_ARC_COLOR;
        ctx.lineWidth = KIT_RESPAWN_ARC_WIDTH;
        ctx.beginPath();
        ctx.arc(
          kit.x,
          kit.y,
          KIT.radius,
          -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * (1 - kit.respawnIn / KIT_RESPAWN_ARC_S),
        );
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Заливка снаружи круга — по полю, тонкое кольцо — там, где зона остановится.
  private drawZone(scene: FieldScene): void {
    const { ctx } = this;
    const { zone, field } = scene;
    if (zone.radius > zone.startRadius - ZONE_HIDDEN_MARGIN) {
      return;
    }
    const time = this.effects.time;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, field.width, field.height);
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2, true);
    ctx.fillStyle = rgba(
      ZONE_FILL_COLOR,
      ZONE_FILL_ALPHA + ZONE_FILL_PULSE_ALPHA * Math.sin(time * ZONE_FILL_PULSE_SPEED),
    );
    ctx.fill('evenodd');
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
    ctx.strokeStyle = ZONE_EDGE_COLOR;
    ctx.lineWidth = ZONE_EDGE_WIDTH;
    ctx.shadowColor = ZONE_EDGE_GLOW_COLOR;
    ctx.shadowBlur = ZONE_EDGE_GLOW_BLUR;
    ctx.setLineDash(ZONE_EDGE_DASH);
    ctx.lineDashOffset = -time * ZONE_EDGE_RUN_SPEED;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = ZONE_FINAL_COLOR;
    ctx.lineWidth = ZONE_FINAL_WIDTH;
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.finalRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawTank(tank: SceneTank): void {
    const { ctx } = this;
    const fx = this.effects.tankFx(tank.id);
    ctx.save();
    ctx.globalAlpha = tank.alpha;
    drawTankSprite(ctx, this.artOf(tank.color), tank.x, tank.y, tank.heading, tank.turret, TANK_SPRITE_SIZE, {
      flash: fx.flash,
      recoil: fx.recoil,
      isDead: !tank.isAlive,
    });
    ctx.restore();
  }

  private drawAimLine(line: AimLine | null, frame: FieldFrame): void {
    const style = frame.aimLineStyle;
    const step = frame.frameMs / style.fadeMs;
    this.aimLineGlow = clamp(this.aimLineGlow + (line === null ? -step : step), 0, 1);
    if (line !== null) {
      this.lastAimLine = line;
    }
    const shown = this.lastAimLine;
    if (this.aimLineGlow <= 0 || shown === null) {
      return;
    }
    drawAimLine(this.ctx, shown, style, {
      timeS: this.effects.time,
      scale: frame.camera.scale / frame.pixelRatio,
      glow: easeOut(this.aimLineGlow),
    });
  }

  private drawTankTag(tank: SceneTank): void {
    const { ctx } = this;
    const x = tank.x - TAG_WIDTH / 2;
    const y = tank.y - TAG_OFFSET_Y;
    ctx.save();
    ctx.globalAlpha = tank.alpha;
    ctx.fillStyle = TAG_BAR_BACK_COLOR;
    ctx.fillRect(
      x - TAG_BAR_BORDER,
      y - TAG_BAR_BORDER,
      TAG_WIDTH + TAG_BAR_BORDER * 2,
      TAG_BAR_HEIGHT + TAG_BAR_BORDER * 2,
    );
    ctx.fillStyle = tank.color;
    ctx.fillRect(x, y, TAG_WIDTH * clamp(tank.hp / tank.maxHp, 0, 1), TAG_BAR_HEIGHT);
    ctx.font = TAG_FONT;
    ctx.textAlign = 'center';
    ctx.fillStyle = TAG_LABEL_COLOR;
    ctx.shadowColor = TAG_SHADOW_COLOR;
    ctx.shadowBlur = TAG_SHADOW_BLUR;
    this.drawTagLabel(tank, y - TAG_LABEL_GAP);
    ctx.restore();
  }

  // Отметка бота стоит перед ником приглушённым тоном; вместе они по центру над танком.
  private drawTagLabel(tank: SceneTank, y: number): void {
    const { ctx } = this;
    if (!tank.isBot) {
      ctx.fillText(tank.label, tank.x, y);
      return;
    }
    const markWidth = ctx.measureText(BOT_MARK).width;
    const left = tank.x - (markWidth + ctx.measureText(tank.label).width) / 2;
    ctx.textAlign = 'left';
    ctx.fillText(tank.label, left + markWidth, y);
    ctx.fillStyle = BOT_MARK_COLOR;
    ctx.fillText(BOT_MARK, left, y);
  }

  private drawGuardMark(scene: FieldScene, frameMs: number): void {
    const step = frameMs / GUARD_FADE_MS;
    this.guardGlow = clamp(this.guardGlow + (scene.isShotGuarded ? step : -step), 0, 1);
    if (this.guardGlow <= 0) {
      return;
    }
    const me = scene.tanks.find((tank) => tank.id === scene.ownTankId);
    if (me?.isAlive !== true) {
      return;
    }
    const { ctx } = this;
    const eased = easeOut(this.guardGlow);
    ctx.save();
    ctx.translate(me.x, me.y);
    ctx.rotate(me.turret);
    ctx.strokeStyle = rgba(GUARD_COLOR, GUARD_ALPHA * eased);
    ctx.lineWidth = GUARD_LINE_WIDTH;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(GUARD_OFFSET, -GUARD_HALF_LENGTH * eased);
    ctx.lineTo(GUARD_OFFSET, GUARD_HALF_LENGTH * eased);
    ctx.stroke();
    ctx.restore();
  }
}
