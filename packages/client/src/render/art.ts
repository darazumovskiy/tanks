import type { Side } from '@tanks/shared/engine';
import { SIDE_COLORS } from './view.js';

export interface TankArt {
  body: HTMLImageElement;
  turret: HTMLImageElement;
}

// Вид сверху, носом вправо, сетка 64×64, центр вращения (32, 32) — тот же контракт, что у ботов tank-arena.
// Растр заготавливается крупным: камера приближает танк, и при 64 px он бы мылился.
const SPRITE_RASTER_PX = 256;
const SVG_ROOT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${String(SPRITE_RASTER_PX)}" height="${String(SPRITE_RASTER_PX)}">`;

function bodySvg(color: string, dark: string): string {
  return `${SVG_ROOT}
  <rect x="6" y="8" width="52" height="11" rx="3" fill="#24262b"/>
  <rect x="6" y="45" width="52" height="11" rx="3" fill="#24262b"/>
  <g stroke="#3b3e45" stroke-width="2">
    <path d="M10 9v9M16 9v9M22 9v9M28 9v9M34 9v9M40 9v9M46 9v9M52 9v9"/>
    <path d="M10 46v9M16 46v9M22 46v9M28 46v9M34 46v9M40 46v9M46 46v9M52 46v9"/>
  </g>
  <path d="M10 17h40l6 6v18l-6 6H10z" fill="${color}" stroke="${dark}" stroke-width="2"/>
  <path d="M14 21h32l4 4v14l-4 4H14z" fill="rgba(255,255,255,0.14)"/>
  <rect x="12" y="29" width="6" height="6" fill="${dark}"/>
</svg>`;
}

function turretSvg(color: string, dark: string): string {
  return `${SVG_ROOT}
  <rect x="32" y="29" width="30" height="6" rx="1.5" fill="#55585f" stroke="#2c2e33" stroke-width="1.5"/>
  <rect x="56" y="27.5" width="7" height="9" rx="1.5" fill="#3a3c42"/>
  <circle cx="32" cy="32" r="12" fill="${color}" stroke="${dark}" stroke-width="2"/>
  <circle cx="29" cy="29" r="4" fill="rgba(255,255,255,0.35)"/>
</svg>`;
}

function darken(hex: string): string {
  const raw = hex.replace('#', '');
  const value = parseInt(raw, 16);
  const scale = (channel: number): number => Math.round(channel * 0.45);
  const r = scale((value >> 16) & 255);
  const g = scale((value >> 8) & 255);
  const b = scale(value & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function loadSvg(svg: string): HTMLImageElement {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return image;
}

export function loadTankArt(side: Side): TankArt {
  const color = SIDE_COLORS[side];
  const dark = darken(color);
  return { body: loadSvg(bodySvg(color, dark)), turret: loadSvg(turretSvg(color, dark)) };
}

export interface SpriteOptions {
  flash?: number;
  recoil?: number;
  isDead?: boolean;
  hasShadow?: boolean;
}

export function drawTankSprite(
  ctx: CanvasRenderingContext2D,
  art: TankArt,
  x: number,
  y: number,
  heading: number,
  turret: number,
  size: number,
  options: SpriteOptions = {},
): void {
  const flash = options.flash ?? 0;
  const recoil = options.recoil ?? 0;
  const isDead = options.isDead ?? false;
  ctx.save();
  ctx.translate(x, y);
  if (options.hasShadow !== false) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.filter = `blur(${String(size * 0.08)}px)`;
    ctx.beginPath();
    ctx.ellipse(size * 0.06, size * 0.1, size * 0.42, size * 0.36, heading, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  if (isDead) {
    ctx.filter = 'grayscale(1) brightness(0.3)';
  } else if (flash > 0) {
    ctx.filter = `brightness(${String(1 + flash * 2.5)})`;
  }
  ctx.save();
  ctx.rotate(heading);
  if (art.body.complete && art.body.naturalWidth > 0) {
    ctx.drawImage(art.body, -size / 2, -size / 2, size, size);
  }
  ctx.restore();
  ctx.save();
  ctx.rotate(turret + (isDead ? 0.5 : 0));
  ctx.translate(-recoil * size * 0.08, 0);
  if (art.turret.complete && art.turret.naturalWidth > 0) {
    ctx.drawImage(art.turret, -size / 2, -size / 2, size, size);
  }
  ctx.restore();
  ctx.restore();
}
