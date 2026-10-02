import { ARENA, KIT, ROUND_SECONDS, ZONE, type Side } from '@tanks/shared/engine';
import type { WorldView } from '../prediction.js';
import { drawTankSprite, loadTankArt, type TankArt } from './art.js';
import type { Effects } from './effects.js';
import { floorFor } from './floor.js';
import { BODY_FONT, HEAD_FONT, OX, OY, SIDE_COLORS, VIEW_H, VIEW_W, clamp, easeOut, rgba } from './view.js';

export interface HudInfo {
  names: [string, string];
  score: [number, number];
  roundIndex: number;
  rttMs: number;
  serverTick: number;
  pending: number;
  correctionPx: number;
  fps: number;
  isMuted: boolean;
}

export type Overlay =
  | { kind: 'countdown'; elapsedS: number; totalS: number }
  | { kind: 'roundEnd'; winner: Side | null; reason: string; elapsedS: number }
  | null;

const ZONE_START_RADIUS = Math.hypot(ARENA.width / 2, ARENA.height / 2) + 60;

// Собирает кадр: пол, следы, аптечки, зона, танки, снаряды, частицы, панели игроков, объявления и оверлеи.
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly art: [TankArt, TankArt] = [loadTankArt(0), loadTankArt(1)];
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly effects: Effects,
  ) {
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

  // Координаты окна → координаты поля боя.
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * (this.canvas.width / rect.width);
    const py = (clientY - rect.top) * (this.canvas.height / rect.height);
    return { x: (px - this.offsetX) / this.scale - OX, y: (py - this.offsetY) / this.scale - OY };
  }

  private resize(): void {
    const ratio = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.round(window.innerWidth * ratio);
    this.canvas.height = Math.round(window.innerHeight * ratio);
    this.scale = Math.min(this.canvas.width / VIEW_W, this.canvas.height / VIEW_H);
    this.offsetX = (this.canvas.width - VIEW_W * this.scale) / 2;
    this.offsetY = (this.canvas.height - VIEW_H * this.scale) / 2;
  }

  draw(view: WorldView, hud: HudInfo, overlay: Overlay): void {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#07080a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);
    ctx.fillStyle = '#0c0d10';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    this.drawArena(view, hud);
    this.drawHud(view, hud);
    this.effects.drawAnnouncements(ctx, VIEW_W, OY + 150);
    if (overlay?.kind === 'countdown') {
      this.drawCountdown(view, hud, overlay.elapsedS, overlay.totalS);
    } else if (overlay?.kind === 'roundEnd') {
      this.drawRoundEnd(hud, overlay.winner, overlay.reason, overlay.elapsedS);
    }
    if (this.effects.flashScreen > 0) {
      ctx.fillStyle = `rgba(255,235,210,${String(this.effects.flashScreen * 0.6)})`;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    this.drawDebug(hud);
  }

  private drawArena(view: WorldView, hud: HudInfo): void {
    const { ctx } = this;
    const shakeX = (Math.random() - 0.5) * this.effects.shake;
    const shakeY = (Math.random() - 0.5) * this.effects.shake;
    ctx.save();
    ctx.translate(OX + shakeX, OY + shakeY);
    ctx.drawImage(floorFor(view.round.mapIndex), 0, 0);
    this.effects.drawDecals(ctx);
    this.drawKits(view);
    this.drawZone(view);
    const order: Side[] = view.tanks[0].isAlive ? [1, 0] : [0, 1];
    for (const side of order) {
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
    const width = 58;
    const x = tank.x - width / 2;
    const y = tank.y - 50;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 1, y - 1, width + 2, 7);
    ctx.fillStyle = SIDE_COLORS[side];
    ctx.fillRect(x, y, width * clamp(tank.hp / maxHp, 0, 1), 5);
    ctx.font = `600 13px ${BODY_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 4;
    ctx.fillText(name, tank.x, y - 5);
    ctx.restore();
  }

  private drawHud(view: WorldView, hud: HudInfo): void {
    const { ctx } = this;
    const top = ctx.createLinearGradient(0, 0, 0, 160);
    top.addColorStop(0, '#15171b');
    top.addColorStop(1, '#0c0d10');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, VIEW_W, 160);
    for (const side of [0, 1] as const) {
      this.drawPlate(view, hud, side);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `600 18px ${BODY_FONT}`;
    ctx.fillText(`РАУНД ${String(hud.roundIndex + 1)} · ${view.round.map.name.toUpperCase()}`, VIEW_W / 2, 44);
    const left = Math.max(0, ROUND_SECONDS - view.round.time);
    const minutes = Math.floor(left / 60);
    const seconds = Math.floor(left % 60);
    const isZoneOn = view.round.time >= ZONE.startShrink;
    ctx.font = `64px ${HEAD_FONT}`;
    ctx.fillStyle = isZoneOn ? '#ff5a6a' : '#f2f2f2';
    ctx.fillText(`${String(minutes)}:${String(seconds).padStart(2, '0')}`, VIEW_W / 2, 112);
    ctx.font = `600 16px ${BODY_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText(hud.isMuted ? 'звук выключен · M' : 'M — звук', VIEW_W / 2, 142);
  }

  private drawPlate(view: WorldView, hud: HudInfo, side: Side): void {
    const { ctx } = this;
    const isRight = side === 1;
    const dir = isRight ? -1 : 1;
    const edge = isRight ? VIEW_W - 60 : 60;
    const color = SIDE_COLORS[side];
    const tank = view.tanks[side];
    const maxHp = view.round.tanks[side].stats.maxHp;
    const fx = this.effects.tankFx[side];
    ctx.save();
    const bar = ctx.createLinearGradient(edge, 0, edge + dir * 700, 0);
    bar.addColorStop(0, rgba(color, 0.35));
    bar.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = bar;
    ctx.fillRect(isRight ? edge - 700 : edge, 20, 700, 120);
    ctx.fillStyle = color;
    ctx.fillRect(isRight ? edge - 6 : edge, 20, 6, 120);
    drawTankSprite(ctx, this.art[side], edge + dir * 70, 80, isRight ? Math.PI : 0, isRight ? Math.PI : 0, 96, {
      hasShadow: false,
      isDead: !tank.isAlive,
      flash: fx.flash,
    });
    const textX = edge + dir * 140;
    ctx.textAlign = isRight ? 'right' : 'left';
    ctx.fillStyle = '#fff';
    ctx.font = `40px ${HEAD_FONT}`;
    ctx.fillText(hud.names[side], textX, 70);
    ctx.fillStyle = color;
    ctx.font = `700 17px ${BODY_FONT}`;
    const stats = view.round.tanks[side].stats;
    ctx.fillText(
      `БРОНЯ ${String(stats.armor)} · ДВИГАТЕЛЬ ${String(stats.engine)} · ОРУДИЕ ${String(stats.gun)} · ПЕРЕЗАРЯДКА ${String(stats.reload)}`,
      textX,
      98,
    );
    const barWidth = 440;
    const barX = isRight ? textX - barWidth : textX;
    const barY = 112;
    const k = clamp(tank.hp / maxHp, 0, 1);
    const ghost = clamp((fx.ghostHp ?? tank.hp) / maxHp, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(barX, barY, barWidth, 16);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(isRight ? barX + barWidth * (1 - ghost) : barX, barY, barWidth * ghost, 16);
    ctx.fillStyle = color;
    ctx.fillRect(isRight ? barX + barWidth * (1 - k) : barX, barY, barWidth * k, 16);
    ctx.font = `600 15px ${BODY_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(
      `${String(Math.ceil(tank.hp))} / ${String(maxHp)}`,
      isRight ? barX - 12 : barX + barWidth + 12,
      barY + 14,
    );

    ctx.textAlign = 'center';
    ctx.font = `56px ${HEAD_FONT}`;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.fillText(String(hud.score[side]), VIEW_W / 2 + dir * -130, 100);
    ctx.restore();
  }

  private drawCountdown(view: WorldView, hud: HudInfo, elapsedS: number, totalS: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = 'rgba(5,6,8,0.55)';
    ctx.fillRect(OX, OY, ARENA.width, ARENA.height);
    ctx.textAlign = 'center';
    ctx.font = `600 24px ${BODY_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(`РАУНД ${String(hud.roundIndex + 1)}`, VIEW_W / 2, OY + 300);
    ctx.font = `72px ${HEAD_FONT}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(view.round.map.name.toUpperCase(), VIEW_W / 2, OY + 380);
    ctx.font = `700 22px ${BODY_FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = SIDE_COLORS[0];
    ctx.fillText(`◀ ${hud.names[0]}`, OX + 40, OY + 380);
    ctx.textAlign = 'right';
    ctx.fillStyle = SIDE_COLORS[1];
    ctx.fillText(`${hud.names[1]} ▶`, OX + ARENA.width - 40, OY + 380);
    const left = totalS - elapsedS;
    const number = Math.ceil(left);
    if (number >= 1) {
      const fraction = 1 - (left - Math.floor(left));
      ctx.textAlign = 'center';
      ctx.globalAlpha = 1 - fraction * 0.7;
      ctx.font = `${String(Math.round(200 * (1.3 - easeOut(fraction) * 0.3)))}px ${HEAD_FONT}`;
      ctx.fillStyle = '#fff';
      ctx.fillText(String(number), VIEW_W / 2, OY + 600);
    } else {
      ctx.textAlign = 'center';
      ctx.font = `160px ${HEAD_FONT}`;
      ctx.fillStyle = '#fff';
      ctx.fillText('БОЙ!', VIEW_W / 2, OY + 600);
    }
    ctx.restore();
  }

  private drawRoundEnd(hud: HudInfo, winner: Side | null, reason: string, elapsedS: number): void {
    const { ctx } = this;
    const enter = easeOut(elapsedS / 0.35);
    const color = winner === null ? '#cfcfcf' : SIDE_COLORS[winner];
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${String(0.35 * enter)})`;
    ctx.fillRect(OX, OY, ARENA.width, ARENA.height);
    const height = 190;
    const y = OY + ARENA.height / 2 - height / 2;
    ctx.fillStyle = 'rgba(8,9,12,0.9)';
    ctx.fillRect(0, y, VIEW_W * enter, height);
    ctx.fillStyle = color;
    ctx.fillRect(0, y, VIEW_W * enter, 6);
    ctx.fillRect(VIEW_W * (1 - enter), y + height - 6, VIEW_W * enter, 6);
    ctx.globalAlpha = enter;
    ctx.textAlign = 'center';
    ctx.font = `92px ${HEAD_FONT}`;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 30;
    ctx.fillText(winner === null ? 'НИЧЬЯ' : hud.names[winner].toUpperCase(), VIEW_W / 2, y + 108);
    ctx.shadowBlur = 0;
    ctx.font = `700 24px ${BODY_FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(reason, VIEW_W / 2, y + 152);
    ctx.restore();
  }

  private drawDebug(hud: HudInfo): void {
    const { ctx } = this;
    ctx.save();
    ctx.font = `13px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(244,241,232,0.6)';
    const lines = [
      `задержка ${hud.rttMs.toFixed(0)} мс · тик ${String(hud.serverTick)} · неподтверждённых ${String(hud.pending)} · поправка ${hud.correctionPx.toFixed(1)} px · ${hud.fps.toFixed(0)} к/с`,
    ];
    lines.forEach((line, index) => {
      ctx.fillText(line, OX, VIEW_H - 14 - index * 16);
    });
    ctx.restore();
  }
}
