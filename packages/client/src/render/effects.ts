import { EventFlag, type FfaEventKind, type SnapshotEventKind, type TankSnapshot } from '@tanks/shared/protocol';
import type { Camera } from './camera.js';
import type { DecalLayer } from './decals.js';
import { BODY_FONT, HEAD_FONT, easeOut, lerp, rgba } from './view.js';

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
  size: number;
  life: number;
  max: number;
}

export interface TankFx {
  flash: number;
  recoil: number;
  ghostHp: number | null;
  smokeTimer: number;
}

// Событие эффектов — форма события снимка толпы с видами дуэли и толпы: tank — о ком событие, by — стрелок.
export interface FxEvent {
  kind: SnapshotEventKind | FfaEventKind;
  tank: number | null;
  by: number | null;
  x: number;
  y: number;
  value: number;
  dx: number;
  dy: number;
  flags: number;
}

type FxAnnouncementKind = 'zoneStart' | 'selfHit' | 'firstBlood';

// size и duration — доли базового объявления: заголовок 56 точек, 1,8 с.
export interface FxAnnouncement {
  kind: FxAnnouncementKind;
  size: number;
  duration: number;
}

// Что событие делает с экраном целиком. Решает вызывающий: дуэль и толпа трясут и объявляют по своим правилам.
// hasParticles — частицы, следы, цифры и отдача на месте события; без них событие далеко за окном только объявляется.
export interface FxEventOptions {
  shake: number;
  flash: number;
  announcement: FxAnnouncement | null;
  hasParticles: boolean;
}

export interface FxTank {
  id: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  isAlive: boolean;
}

export interface FxBullet {
  id: number;
  x: number;
  y: number;
  color: string;
}

interface TrailPoint {
  x: number;
  y: number;
}

const MAX_PARTICLES = 1400;
const TRAIL_LENGTH = 80;
const TREAD_EVERY_TICKS = 2;
const TREAD_MIN_SPEED = 8;
const DECAL_FADE_EVERY_TICKS = 45;
const ZONE_ANNOUNCE_COLOR = '#ff4d5e';
const ANNOUNCE_SECONDS = 1.8;

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

function idleTankFx(): TankFx {
  return { flash: 0, recoil: 0, ghostHp: null, smokeTimer: 0 };
}

// Визуальный слой поверх симуляции: частицы, следы гусениц и подпалины, всплывающие цифры, объявления, тряска.
// Цвет и имя танка — по номеру: дуэль красит по стороне, толпа — своего и чужих.
export class Effects {
  private particles: Particle[] = [];
  private popups: Popup[] = [];
  private announcements: Announcement[] = [];
  private readonly trails = new Map<number, TrailPoint[]>();
  private readonly tankFxById = new Map<number, TankFx>();
  shake = 0;
  flashScreen = 0;
  time = 0;

  constructor(
    private readonly decals: DecalLayer,
    private readonly colorOf: (id: number) => string,
    private readonly nameOf: (id: number) => string,
  ) {}

  reset(): void {
    this.decals.clear();
    this.particles = [];
    this.popups = [];
    this.trails.clear();
    this.tankFxById.clear();
  }

  tankFx(id: number): Readonly<TankFx> {
    return this.fxOf(id);
  }

  private fxOf(id: number): TankFx {
    const known = this.tankFxById.get(id);
    if (known !== undefined) {
      return known;
    }
    const fx = idleTankFx();
    this.tankFxById.set(id, fx);
    return fx;
  }

  // Вызывается на каждый снимок сервера: следы гусениц и медленное выцветание подпалин.
  onSnapshot(tick: number, tanks: readonly TankSnapshot[]): void {
    if (tick % TREAD_EVERY_TICKS === 0) {
      for (const tank of tanks) {
        if (!tank.isAlive || Math.abs(tank.speed) < TREAD_MIN_SPEED) {
          continue;
        }
        this.decals.tread(tank.x, tank.y, tank.heading);
      }
    }
    if (tick % DECAL_FADE_EVERY_TICKS === 0) {
      this.decals.fade();
    }
  }

  onEvent(event: FxEvent, options: FxEventOptions): void {
    if (options.hasParticles) {
      this.spawnFor(event);
    }
    this.shake = Math.max(this.shake, options.shake);
    this.flashScreen = Math.max(this.flashScreen, options.flash);
    if (options.announcement !== null) {
      this.announceFor(options.announcement, event);
    }
  }

  private spawnFor(event: FxEvent): void {
    switch (event.kind) {
      case 'shot': {
        if (event.tank !== null) {
          this.fxOf(event.tank).recoil = 1;
        }
        this.spawn(particle({ kind: 'flash', x: event.x, y: event.y, max: 0.09, size: 34, color: '255,220,150' }));
        this.sparks(event.x, event.y, 6, '255,210,120', 420, event.value, 0.5);
        this.smoke(event.x + event.dx * 6, event.y + event.dy * 6, 3, 10, 0.7);
        break;
      }
      case 'ricochet':
        this.sparks(event.x, event.y, 10, '255,240,200', 320, Math.atan2(event.dy, event.dx), 2.2);
        this.spawn(particle({ kind: 'flash', x: event.x, y: event.y, max: 0.08, size: 22, color: '255,255,230' }));
        break;
      case 'impact':
        this.sparks(event.x, event.y, 12, '255,190,110', 260);
        this.smoke(event.x, event.y, 4, 12, 0.9);
        this.decals.scorch(event.x, event.y, 16, 0.35);
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
        break;
      case 'hit':
        this.onHit(event);
        break;
      case 'death':
        this.onDeath(event);
        break;
      default:
        break;
    }
  }

  private onHit(event: FxEvent): void {
    if (event.tank === null) {
      return;
    }
    const fx = this.fxOf(event.tank);
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
    const isSelf = (event.flags & EventFlag.Self) !== 0;
    const isRicochet = (event.flags & EventFlag.Ricochet) !== 0;
    const isForeignRicochet = isRicochet && !isSelf;
    if (!isForeignRicochet || event.by === null) {
      return;
    }
    this.popup('РИКОШЕТ!', event.x, event.y - 76, this.colorOf(event.by), 30, 1.3);
  }

  private onDeath(event: FxEvent): void {
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
        }),
      );
    }
    this.sparks(x, y, 50, '255,220,150', 700);
    this.smoke(x, y, 24, 34, 2.4, '70,70,74');
    this.decals.scorch(x, y, 90, 0.75);
  }

  // «САМ СЕБЯ!» — цветом того, кто попал в себя; «ПЕРВАЯ КРОВЬ» — цветом и именем стрелка.
  private announceFor(announcement: FxAnnouncement, event: FxEvent): void {
    switch (announcement.kind) {
      case 'zoneStart':
        this.announce(announcement, 'ЗОНА СУЖАЕТСЯ', ZONE_ANNOUNCE_COLOR, 'вне круга — урон');
        break;
      case 'selfHit':
        if (event.tank !== null) {
          this.announce(announcement, 'САМ СЕБЯ!', this.colorOf(event.tank), 'рикошетом');
        }
        break;
      case 'firstBlood':
        if (event.by !== null) {
          this.announce(announcement, 'ПЕРВАЯ КРОВЬ', this.colorOf(event.by), this.nameOf(event.by));
        }
        break;
    }
  }

  update(dt: number, tanks: readonly FxTank[]): void {
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
    for (const tank of tanks) {
      const fx = this.fxOf(tank.id);
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

  private announce(announcement: FxAnnouncement, text: string, color: string, sub: string): void {
    this.announcements.push({
      text,
      sub,
      color,
      size: announcement.size,
      life: 0,
      max: ANNOUNCE_SECONDS * announcement.duration,
    });
  }

  drawDecals(ctx: CanvasRenderingContext2D, camera: Camera): void {
    this.decals.draw(ctx, camera);
  }

  // Снаряд сменил номер (предсказанный выстрел подтвердил сервер) — хвост продолжается под новым номером.
  renameTrail(fromId: number, toId: number): void {
    const trail = this.trails.get(fromId);
    if (trail === undefined) {
      return;
    }
    this.trails.delete(fromId);
    this.trails.set(toId, trail);
  }

  drawBullets(ctx: CanvasRenderingContext2D, bullets: readonly FxBullet[]): void {
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
      const { color } = bullet;
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
    const s = announcement.size;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, y - 62 * s, viewWidth, (announcement.sub !== '' ? 104 : 82) * s);
    ctx.fillStyle = announcement.color;
    ctx.fillRect(0, y - 62 * s, viewWidth * enter, 4 * s);
    ctx.font = `${String(Math.round(56 * s * (0.8 + 0.2 * enter)))}px ${HEAD_FONT}`;
    ctx.shadowColor = announcement.color;
    ctx.shadowBlur = 20 * s;
    ctx.fillText(announcement.text, viewWidth / 2, y);
    ctx.shadowBlur = 0;
    if (announcement.sub !== '') {
      ctx.font = `600 ${String(Math.round(20 * s))}px ${BODY_FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(announcement.sub, viewWidth / 2, y + 30 * s);
    }
    ctx.restore();
  }
}
