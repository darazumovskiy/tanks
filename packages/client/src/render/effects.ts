import { ARENA, type Side } from '@tanks/shared/engine';
import { EventFlag, type SnapshotEvent, type TankSnapshot } from '@tanks/shared/protocol';
import { BODY_FONT, HEAD_FONT, SIDE_COLORS, easeOut, lerp, makeCanvas, rgba } from './view.js';

type ParticleKind = 'spark' | 'smoke' | 'flash' | 'ring' | 'fire' | 'debris';

interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  drag: number;
  width: number;
  rot: number;
  vr: number;
}

interface Popup {
  text: string;
  x: number;
  y: number;
  color: string;
  size: number;
  life: number;
  max: number;
}

interface Announcement {
  text: string;
  sub: string;
  color: string;
  life: number;
  max: number;
}

export interface TankFx {
  flash: number;
  recoil: number;
  ghostHp: number | null;
  smokeTimer: number;
}

interface TrailPoint {
  x: number;
  y: number;
}

const MAX_PARTICLES = 1400;
const TRAIL_LENGTH = 80;

function particle(partial: Partial<Particle> & Pick<Particle, 'kind' | 'x' | 'y' | 'max'>): Particle {
  return {
    vx: 0,
    vy: 0,
    life: 0,
    size: 4,
    color: '255,255,255',
    drag: 0,
    width: 2,
    rot: 0,
    vr: 0,
    ...partial,
  };
}

// Визуальный слой поверх симуляции: частицы, следы гусениц и подпалины, всплывающие цифры, объявления, тряска.
export class Effects {
  private particles: Particle[] = [];
  private popups: Popup[] = [];
  private announcements: Announcement[] = [];
  private readonly trails = new Map<number, TrailPoint[]>();
  private readonly decals: HTMLCanvasElement;
  private readonly decalCtx: CanvasRenderingContext2D;
  private hasFirstBlood = false;
  shake = 0;
  flashScreen = 0;
  time = 0;
  readonly tankFx: [TankFx, TankFx] = [
    { flash: 0, recoil: 0, ghostHp: null, smokeTimer: 0 },
    { flash: 0, recoil: 0, ghostHp: null, smokeTimer: 0 },
  ];

  constructor(private readonly names: () => [string, string]) {
    const made = makeCanvas(ARENA.width, ARENA.height);
    this.decals = made.canvas;
    this.decalCtx = made.ctx;
  }

  reset(): void {
    this.decalCtx.clearRect(0, 0, ARENA.width, ARENA.height);
    this.particles = [];
    this.popups = [];
    this.trails.clear();
    this.hasFirstBlood = false;
    for (const fx of this.tankFx) {
      fx.flash = 0;
      fx.recoil = 0;
      fx.ghostHp = null;
      fx.smokeTimer = 0;
    }
  }

  // Вызывается на каждый снимок сервера: следы гусениц и медленное выцветание подпалин.
  onSnapshot(tick: number, tanks: readonly TankSnapshot[]): void {
    if (tick % 2 === 0) {
      this.treads(tanks);
    }
    if (tick % 45 === 0) {
      this.decalCtx.save();
      this.decalCtx.globalCompositeOperation = 'destination-out';
      this.decalCtx.fillStyle = 'rgba(0,0,0,0.05)';
      this.decalCtx.fillRect(0, 0, ARENA.width, ARENA.height);
      this.decalCtx.restore();
    }
  }

  onEvent(event: SnapshotEvent): void {
    switch (event.kind) {
      case 'shot': {
        if (event.side !== null) {
          this.tankFx[event.side].recoil = 1;
        }
        this.spawn(particle({ kind: 'flash', x: event.x, y: event.y, max: 0.09, size: 34, color: '255,220,150' }));
        this.sparks(event.x, event.y, 6, '255,210,120', 420, event.value, 0.5);
        this.smoke(event.x + event.dx * 6, event.y + event.dy * 6, 3, 10, 0.7);
        this.shake = Math.max(this.shake, 2.5);
        break;
      }
      case 'ricochet':
        this.sparks(event.x, event.y, 10, '255,240,200', 320, Math.atan2(event.dy, event.dx), 2.2);
        this.spawn(particle({ kind: 'flash', x: event.x, y: event.y, max: 0.08, size: 22, color: '255,255,230' }));
        break;
      case 'impact':
        this.sparks(event.x, event.y, 12, '255,190,110', 260);
        this.smoke(event.x, event.y, 4, 12, 0.9);
        this.scorch(event.x, event.y, 16, 0.35);
        break;
      case 'fizzle':
        this.smoke(event.x, event.y, 2, 8, 0.5);
        break;
      case 'bump':
        this.smoke(event.x, event.y, 2, 12, 0.6, '110,100,90');
        break;
      case 'kitSpawn':
        this.spawn(
          particle({ kind: 'ring', x: event.x, y: event.y, max: 0.6, size: 50, color: '93,255,160', width: 4 }),
        );
        break;
      case 'pickup':
        this.spawn(
          particle({ kind: 'ring', x: event.x, y: event.y, max: 0.7, size: 80, color: '93,255,160', width: 6 }),
        );
        this.sparks(event.x, event.y, 16, '140,255,190', 200);
        this.popup(`+${String(Math.round(event.value))}`, event.x, event.y - 30, '#5dffa0', 34);
        break;
      case 'clash':
        this.spawn(particle({ kind: 'flash', x: event.x, y: event.y, max: 0.18, size: 70, color: '220,240,255' }));
        this.spawn(
          particle({ kind: 'ring', x: event.x, y: event.y, max: 0.45, size: 90, color: '220,240,255', width: 5 }),
        );
        this.sparks(event.x, event.y, 24, '220,240,255', 420);
        this.popup('ПЕРЕХВАТ!', event.x, event.y - 34, '#dff2ff', 34, 1.4);
        this.shake = Math.max(this.shake, 6);
        break;
      case 'hit':
        this.onHit(event);
        break;
      case 'death':
        this.onDeath(event);
        break;
      case 'zoneStart':
        this.announce('ЗОНА СУЖАЕТСЯ', '#ff4d5e', 'вне круга — урон');
        break;
      case 'roundOver':
        break;
    }
  }

  private onHit(event: SnapshotEvent): void {
    if (event.side === null) {
      return;
    }
    const fx = this.tankFx[event.side];
    const isZone = (event.flags & EventFlag.Zone) !== 0;
    if (isZone) {
      fx.flash = Math.max(fx.flash, 0.25);
      if (Math.random() < 0.25) {
        this.sparks(event.x, event.y, 2, '255,70,90', 120);
      }
      return;
    }
    fx.flash = 1;
    const direction = Math.atan2(event.dy, event.dx);
    this.sparks(event.x, event.y, 22, '255,200,120', 480, direction, 1.4);
    this.smoke(event.x, event.y, 4, 14, 0.9, '90,90,95');
    this.popup(
      `-${String(Math.round(event.value))}`,
      event.x + (Math.random() - 0.5) * 20,
      event.y - 40,
      '#ffffff',
      36,
    );
    this.shake = Math.max(this.shake, 9);
    const isSelf = (event.flags & EventFlag.Self) !== 0;
    const isRicochet = (event.flags & EventFlag.Ricochet) !== 0;
    const shooter: Side = event.side === 0 ? 1 : 0;
    if (isSelf) {
      this.announce('САМ СЕБЯ!', SIDE_COLORS[event.side], 'рикошетом');
    } else if (isRicochet) {
      this.popup('РИКОШЕТ!', event.x, event.y - 76, SIDE_COLORS[shooter], 30, 1.3);
    }
    if (!this.hasFirstBlood && !isSelf) {
      this.hasFirstBlood = true;
      this.announce('ПЕРВАЯ КРОВЬ', SIDE_COLORS[shooter], this.names()[shooter]);
    }
  }

  private onDeath(event: SnapshotEvent): void {
    const { x, y } = event;
    this.spawn(particle({ kind: 'flash', x, y, max: 0.35, size: 260, color: '255,210,140' }));
    this.spawn(particle({ kind: 'ring', x, y, max: 0.7, size: 260, color: '255,230,190', width: 10 }));
    this.spawn(particle({ kind: 'ring', x, y, max: 1.1, size: 380, color: '255,140,60', width: 4 }));
    for (let i = 0; i < 70; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 360;
      this.spawn(
        particle({
          kind: 'fire',
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          max: 0.4 + Math.random() * 0.7,
          size: 10 + Math.random() * 22,
          drag: 3,
        }),
      );
    }
    const color = event.side === null ? '#ffffff' : SIDE_COLORS[event.side];
    for (let i = 0; i < 26; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 120 + Math.random() * 420;
      this.spawn(
        particle({
          kind: 'debris',
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          max: 0.8 + Math.random() * 0.9,
          size: 3 + Math.random() * 6,
          rot: Math.random() * 6,
          vr: (Math.random() - 0.5) * 20,
          drag: 2.5,
          color,
        }),
      );
    }
    this.sparks(x, y, 50, '255,220,150', 700);
    this.smoke(x, y, 24, 34, 2.4, '70,70,74');
    this.scorch(x, y, 90, 0.75);
    this.shake = 26;
    this.flashScreen = 0.55;
  }

  update(dt: number, tanks: readonly { x: number; y: number; hp: number; maxHp: number; isAlive: boolean }[]): void {
    this.time += dt;
    for (const p of this.particles) {
      p.life += dt;
      const damping = Math.exp(-p.drag * dt);
      p.vx *= damping;
      p.vy *= damping;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
    for (const popup of this.popups) {
      popup.life += dt;
    }
    this.popups = this.popups.filter((popup) => popup.life < popup.max);
    for (const announcement of this.announcements) {
      announcement.life += dt;
    }
    this.announcements = this.announcements.filter((announcement) => announcement.life < announcement.max);
    this.shake = Math.max(0, this.shake - dt * 60);
    this.flashScreen = Math.max(0, this.flashScreen - dt * 2);
    for (const [index, tank] of tanks.entries()) {
      const fx = this.tankFx[index === 0 ? 0 : 1];
      fx.flash = Math.max(0, fx.flash - dt * 7);
      fx.recoil = Math.max(0, fx.recoil - dt * 6);
      if (fx.ghostHp === null || fx.ghostHp < tank.hp) {
        fx.ghostHp = tank.hp;
      } else {
        fx.ghostHp = lerp(fx.ghostHp, tank.hp, Math.min(1, dt * 2.5));
      }
      const hurt = tank.hp / tank.maxHp;
      fx.smokeTimer -= dt;
      if ((!tank.isAlive || hurt < 0.35) && fx.smokeTimer <= 0) {
        fx.smokeTimer = tank.isAlive ? 0.12 : 0.07;
        this.smoke(
          tank.x,
          tank.y,
          1,
          tank.isAlive ? 12 : 20,
          tank.isAlive ? 1.2 : 2,
          tank.isAlive ? '80,80,85' : '50,50,54',
        );
        if (!tank.isAlive && Math.random() < 0.5) {
          this.spawn(
            particle({
              kind: 'fire',
              x: tank.x + (Math.random() - 0.5) * 20,
              y: tank.y + (Math.random() - 0.5) * 20,
              vy: -20,
              max: 0.5,
              size: 10,
              drag: 1,
            }),
          );
        }
      }
    }
  }

  private treads(tanks: readonly TankSnapshot[]): void {
    const g = this.decalCtx;
    for (const tank of tanks) {
      if (!tank.isAlive || Math.abs(tank.speed) < 8) {
        continue;
      }
      const px = -Math.sin(tank.heading);
      const py = Math.cos(tank.heading);
      g.fillStyle = 'rgba(0,0,0,0.2)';
      for (const offset of [-17, 17]) {
        g.save();
        g.translate(
          tank.x + px * offset - Math.cos(tank.heading) * 14,
          tank.y + py * offset - Math.sin(tank.heading) * 14,
        );
        g.rotate(tank.heading);
        g.fillRect(-4, -4.5, 8, 9);
        g.restore();
      }
    }
  }

  private scorch(x: number, y: number, radius: number, alpha: number): void {
    const g = this.decalCtx;
    const gradient = g.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(0,0,0,${String(alpha)})`);
    gradient.addColorStop(0.6, `rgba(10,8,6,${String(alpha * 0.5)})`);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gradient;
    g.beginPath();
    g.arc(x, y, radius, 0, Math.PI * 2);
    g.fill();
  }

  private spawn(p: Particle): void {
    if (this.particles.length < MAX_PARTICLES) {
      this.particles.push(p);
    }
  }

  private sparks(
    x: number,
    y: number,
    count: number,
    color: string,
    speed: number,
    direction?: number,
    spread = Math.PI,
  ): void {
    for (let i = 0; i < count; i++) {
      const angle = direction === undefined ? Math.random() * Math.PI * 2 : direction + (Math.random() - 0.5) * spread;
      const velocity = speed * (0.4 + Math.random() * 0.8);
      this.spawn(
        particle({
          kind: 'spark',
          x,
          y,
          vx: Math.cos(angle) * velocity,
          vy: Math.sin(angle) * velocity,
          max: 0.2 + Math.random() * 0.35,
          color,
          size: 2 + Math.random() * 1.5,
          drag: 4,
        }),
      );
    }
  }

  private smoke(x: number, y: number, count: number, size = 14, max = 1.2, color = '120,120,125'): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const velocity = 10 + Math.random() * 40;
      this.spawn(
        particle({
          kind: 'smoke',
          x,
          y,
          vx: Math.cos(angle) * velocity,
          vy: Math.sin(angle) * velocity - 10,
          max: max * (0.6 + Math.random() * 0.8),
          size: size * (0.6 + Math.random() * 0.8),
          color,
          drag: 1.5,
        }),
      );
    }
  }

  private popup(text: string, x: number, y: number, color: string, size = 30, max = 1.1): void {
    this.popups.push({ text, x, y, color, size, life: 0, max });
  }

  announce(text: string, color: string, sub = ''): void {
    this.announcements.push({ text, sub, color, life: 0, max: 1.8 });
  }

  drawDecals(ctx: CanvasRenderingContext2D): void {
    ctx.drawImage(this.decals, 0, 0);
  }

  drawBullets(
    ctx: CanvasRenderingContext2D,
    bullets: readonly { id: number; owner: Side; x: number; y: number }[],
  ): void {
    const live = new Set<number>();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const bullet of bullets) {
      live.add(bullet.id);
      let trail = this.trails.get(bullet.id);
      if (trail === undefined) {
        trail = [];
        this.trails.set(bullet.id, trail);
      }
      const last = trail[trail.length - 1];
      if (last === undefined || Math.hypot(last.x - bullet.x, last.y - bullet.y) > 3) {
        trail.push({ x: bullet.x, y: bullet.y });
      }
      let length = 0;
      for (let i = trail.length - 1; i > 0; i--) {
        const a = trail[i];
        const b = trail[i - 1];
        if (a === undefined || b === undefined) {
          break;
        }
        length += Math.hypot(a.x - b.x, a.y - b.y);
        if (length > TRAIL_LENGTH) {
          trail.splice(0, i - 1);
          break;
        }
      }
      const color = SIDE_COLORS[bullet.owner];
      for (let i = 1; i < trail.length; i++) {
        const from = trail[i - 1];
        const to = trail[i];
        if (from === undefined || to === undefined) {
          continue;
        }
        const k = i / trail.length;
        ctx.strokeStyle = rgba(color, k * 0.7);
        ctx.lineWidth = 1 + k * 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
      const glow = ctx.createRadialGradient(bullet.x, bullet.y, 0, bullet.x, bullet.y, 18);
      glow.addColorStop(0, rgba(color, 0.9));
      glow.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(bullet.x, bullet.y, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(bullet.x, bullet.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    for (const id of this.trails.keys()) {
      if (!live.has(id)) {
        this.trails.delete(id);
      }
    }
  }

  drawParticles(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    for (const p of this.particles) {
      const k = p.life / p.max;
      if (p.kind === 'smoke') {
        ctx.fillStyle = `rgba(${p.color},${String(0.35 * (1 - k))})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.6 + k * 1.6), 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'debris') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = k < 0.2 ? '#ffd9a0' : '#1d1d20';
        ctx.globalAlpha = 1 - k * 0.6;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const k = p.life / p.max;
      if (p.kind === 'spark') {
        ctx.strokeStyle = `rgba(${p.color},${String(1 - k)})`;
        ctx.lineWidth = p.size;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
        ctx.stroke();
      } else if (p.kind === 'fire') {
        const r = p.size * (1 - k * 0.5);
        const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        const green = Math.round(230 - k * 150);
        const blue = Math.round(150 - k * 150);
        gradient.addColorStop(0, `rgba(255,${String(green)},${String(blue)},${String(0.9 * (1 - k))})`);
        gradient.addColorStop(1, 'rgba(255,60,0,0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'flash') {
        const r = p.size * (0.6 + k * 0.6);
        const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        gradient.addColorStop(0, `rgba(${p.color},${String(1 - k)})`);
        gradient.addColorStop(1, `rgba(${p.color},0)`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'ring') {
        ctx.strokeStyle = `rgba(${p.color},${String(0.8 * (1 - k))})`;
        ctx.lineWidth = p.width * (1 - k) + 0.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * easeOut(k), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawPopups(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.textAlign = 'center';
    for (const popup of this.popups) {
      const k = popup.life / popup.max;
      const scale = k < 0.15 ? 0.6 + (k / 0.15) * 0.5 : 1.1 - Math.min(0.1, k - 0.15);
      ctx.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      ctx.font = `${String(Math.round(popup.size * scale))}px ${HEAD_FONT}`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      const y = popup.y - easeOut(k) * 34;
      ctx.strokeText(popup.text, popup.x, y);
      ctx.fillStyle = popup.color;
      ctx.fillText(popup.text, popup.x, y);
    }
    ctx.restore();
  }

  drawAnnouncements(ctx: CanvasRenderingContext2D, viewWidth: number, y: number): void {
    const announcement = this.announcements[this.announcements.length - 1];
    if (announcement === undefined) {
      return;
    }
    const k = announcement.life / announcement.max;
    const enter = easeOut(k / 0.12);
    const alpha = k > 0.75 ? 1 - (k - 0.75) / 0.25 : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, y - 62, viewWidth, announcement.sub !== '' ? 104 : 82);
    ctx.fillStyle = announcement.color;
    ctx.fillRect(0, y - 62, viewWidth * enter, 4);
    ctx.font = `${String(Math.round(56 * (0.8 + 0.2 * enter)))}px ${HEAD_FONT}`;
    ctx.shadowColor = announcement.color;
    ctx.shadowBlur = 20;
    ctx.fillText(announcement.text, viewWidth / 2, y);
    ctx.shadowBlur = 0;
    if (announcement.sub !== '') {
      ctx.font = `600 20px ${BODY_FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(announcement.sub, viewWidth / 2, y + 30);
    }
    ctx.restore();
  }
}
