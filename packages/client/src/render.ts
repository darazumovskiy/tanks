import { ARENA, BULLET_RADIUS, KIT, TANK_RADIUS, ZONE, type Side } from '@tanks/shared/engine';
import type { WorldView } from './prediction.js';

export const SIDE_COLORS: readonly [string, string] = ['#e8825a', '#4fc3c9'];
const BODY_LENGTH = 52;
const BODY_WIDTH = 36;
const BARREL_LENGTH = 34;

export interface HudInfo {
  names: [string, string];
  score: [number, number];
  rttMs: number;
  serverTick: number;
  pending: number;
  correctionPx: number;
  fps: number;
}

// Рисует поле целиком, вписанное в окно с сохранением пропорций 16:9.
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('Canvas 2D недоступен');
    }
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => {
      this.resize();
    });
  }

  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * (this.canvas.width / rect.width);
    const py = (clientY - rect.top) * (this.canvas.height / rect.height);
    return { x: (px - this.offsetX) / this.scale, y: (py - this.offsetY) / this.scale };
  }

  private resize(): void {
    const ratio = window.devicePixelRatio;
    this.canvas.width = Math.floor(window.innerWidth * ratio);
    this.canvas.height = Math.floor(window.innerHeight * ratio);
    this.scale = Math.min(this.canvas.width / ARENA.width, this.canvas.height / ARENA.height);
    this.offsetX = (this.canvas.width - ARENA.width * this.scale) / 2;
    this.offsetY = (this.canvas.height - ARENA.height * this.scale) / 2;
  }

  draw(view: WorldView, hud: HudInfo): void {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0f0d';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);

    this.drawField(view);
    this.drawZone(view);
    this.drawKits(view);
    for (const bullet of view.bullets) {
      ctx.fillStyle = SIDE_COLORS[bullet.owner];
      ctx.beginPath();
      ctx.arc(bullet.x, bullet.y, BULLET_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const side of [0, 1] as const) {
      this.drawTank(view, side, hud.names[side]);
    }
    this.drawHud(hud);
  }

  private drawField(view: WorldView): void {
    const { ctx } = this;
    ctx.fillStyle = '#1a2420';
    ctx.fillRect(0, 0, ARENA.width, ARENA.height);
    ctx.strokeStyle = '#243229';
    ctx.lineWidth = 1;
    for (let x = 0; x <= ARENA.width; x += 100) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ARENA.height);
      ctx.stroke();
    }
    for (let y = 0; y <= ARENA.height; y += 100) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(ARENA.width, y);
      ctx.stroke();
    }
    ctx.fillStyle = '#5b6a5e';
    for (const wall of view.round.map.walls) {
      ctx.fillRect(wall.x, wall.y, wall.w, wall.h);
    }
  }

  private drawZone(view: WorldView): void {
    const { ctx } = this;
    const zone = view.round.zone;
    const isShrinking = zone.radius < Math.hypot(ARENA.width / 2, ARENA.height / 2) + 60;
    if (!isShrinking) {
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, ARENA.width, ARENA.height);
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(180, 60, 40, 0.25)';
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = '#d9643f';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(217, 100, 63, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, ZONE.finalRadius, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawKits(view: WorldView): void {
    const { ctx } = this;
    for (const kit of view.round.kits) {
      if (!kit.isActive) {
        continue;
      }
      ctx.fillStyle = '#3fcf6a';
      ctx.beginPath();
      ctx.arc(kit.x, kit.y, KIT.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(kit.x - 3, kit.y - 10, 6, 20);
      ctx.fillRect(kit.x - 10, kit.y - 3, 20, 6);
    }
  }

  private drawTank(view: WorldView, side: Side, name: string): void {
    const { ctx } = this;
    const tank = view.tanks[side];
    const color = SIDE_COLORS[side];
    ctx.save();
    ctx.translate(tank.x, tank.y);
    ctx.rotate(tank.heading);
    ctx.fillStyle = tank.isAlive ? color : '#444';
    ctx.fillRect(-BODY_LENGTH / 2, -BODY_WIDTH / 2, BODY_LENGTH, BODY_WIDTH);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-BODY_LENGTH / 2, -BODY_WIDTH / 2, BODY_LENGTH, 6);
    ctx.fillRect(-BODY_LENGTH / 2, BODY_WIDTH / 2 - 6, BODY_LENGTH, 6);
    ctx.restore();

    ctx.save();
    ctx.translate(tank.x, tank.y);
    ctx.rotate(tank.turret);
    ctx.fillStyle = tank.isAlive ? '#f4f1e8' : '#666';
    ctx.fillRect(0, -4, BARREL_LENGTH, 8);
    ctx.beginPath();
    ctx.arc(0, 0, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const maxHp = view.round.tanks[side].stats.maxHp;
    const barWidth = 60;
    const barY = tank.y - TANK_RADIUS - 18;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(tank.x - barWidth / 2, barY, barWidth, 7);
    ctx.fillStyle = color;
    ctx.fillRect(tank.x - barWidth / 2, barY, (barWidth * Math.max(0, tank.hp)) / maxHp, 7);
    ctx.fillStyle = '#f4f1e8';
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(name, tank.x, barY - 6);
  }

  private drawHud(hud: HudInfo): void {
    const { ctx } = this;
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = SIDE_COLORS[0];
    ctx.fillText(String(hud.score[0]), ARENA.width / 2 - 40, 40);
    ctx.fillStyle = '#f4f1e8';
    ctx.fillText(':', ARENA.width / 2, 40);
    ctx.fillStyle = SIDE_COLORS[1];
    ctx.fillText(String(hud.score[1]), ARENA.width / 2 + 40, 40);

    ctx.font = '13px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(244,241,232,0.8)';
    const lines = [
      `задержка ${hud.rttMs.toFixed(0)} мс`,
      `тик сервера ${String(hud.serverTick)}`,
      `неподтверждённых команд ${String(hud.pending)}`,
      `поправка ${hud.correctionPx.toFixed(1)} px`,
      `${hud.fps.toFixed(0)} к/с`,
    ];
    lines.forEach((line, index) => {
      ctx.fillText(line, 12, ARENA.height - 12 - (lines.length - 1 - index) * 16);
    });
  }
}
