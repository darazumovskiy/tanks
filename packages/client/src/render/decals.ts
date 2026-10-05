import type { FieldSize } from '@tanks/shared/engine';
import type { Camera } from './camera.js';
import { makeCanvas } from './view.js';

// Следы гусениц и подпалины под танками: эффекты кладут их в слой, рендер поля рисует слой под аптечками.
// Окно камеры — для слоя, который рисует только видимое.
export interface DecalLayer {
  clear(): void;
  tread(x: number, y: number, heading: number): void;
  scorch(x: number, y: number, radius: number, alpha: number): void;
  fade(): void;
  draw(ctx: CanvasRenderingContext2D, camera: Camera): void;
}

const TREAD_COLOR = 'rgba(0,0,0,0.2)';
// Гусеницы — по бокам корпуса, след ложится за кормой.
const TREAD_SIDE_OFFSETS = [-17, 17];
const TREAD_BACK = 14;
const FADE_COLOR = 'rgba(0,0,0,0.05)';

export function drawTread(g: CanvasRenderingContext2D, x: number, y: number, heading: number): void {
  const px = -Math.sin(heading);
  const py = Math.cos(heading);
  g.fillStyle = TREAD_COLOR;
  for (const offset of TREAD_SIDE_OFFSETS) {
    g.save();
    g.translate(x + px * offset - Math.cos(heading) * TREAD_BACK, y + py * offset - Math.sin(heading) * TREAD_BACK);
    g.rotate(heading);
    g.fillRect(-4, -4.5, 8, 9);
    g.restore();
  }
}

export function drawScorch(g: CanvasRenderingContext2D, x: number, y: number, radius: number, alpha: number): void {
  const gradient = g.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, `rgba(0,0,0,${String(alpha)})`);
  gradient.addColorStop(0.6, `rgba(10,8,6,${String(alpha * 0.5)})`);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gradient;
  g.beginPath();
  g.arc(x, y, radius, 0, Math.PI * 2);
  g.fill();
}

// Холст во всё поле: следы копятся на нём и выцветают все разом.
export class FieldDecals implements DecalLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(private readonly size: FieldSize) {
    const made = makeCanvas(size.width, size.height);
    this.canvas = made.canvas;
    this.ctx = made.ctx;
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.size.width, this.size.height);
  }

  tread(x: number, y: number, heading: number): void {
    drawTread(this.ctx, x, y, heading);
  }

  scorch(x: number, y: number, radius: number, alpha: number): void {
    drawScorch(this.ctx, x, y, radius, alpha);
  }

  fade(): void {
    const g = this.ctx;
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = FADE_COLOR;
    g.fillRect(0, 0, this.size.width, this.size.height);
    g.restore();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.drawImage(this.canvas, 0, 0);
  }
}
