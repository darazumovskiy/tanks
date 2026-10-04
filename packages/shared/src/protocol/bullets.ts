import {
  createWorld,
  DEFAULT_RULES,
  flyBullets,
  type BattleMap,
  type Bullet,
  type World,
  type ZonePlan,
} from '../engine/index.js';
import type { FfaBounce, FfaBulletSnapshot } from './messages.js';

export function bulletSnapshot(bullet: Bullet): FfaBulletSnapshot {
  return {
    id: bullet.id,
    owner: bullet.owner,
    x: bullet.x,
    y: bullet.y,
    vx: bullet.vx,
    vy: bullet.vy,
    bouncesLeft: bullet.bouncesLeft,
    hasBounced: bullet.hasBounced,
    age: bullet.age,
  };
}

export interface BulletChanges {
  births: FfaBulletSnapshot[];
  bounces: FfaBounce[];
  deaths: number[];
}

// Сервер: помнит снаряды поля после прошлого тика (номер → рикошетов осталось); разница — то, что клиенту
// нужно, чтобы считать полёт самому.
export class BulletTracker {
  private known = new Map<number, number>();

  reset(): void {
    this.known = new Map();
  }

  diff(bullets: readonly Bullet[]): BulletChanges {
    const changes: BulletChanges = { births: [], bounces: [], deaths: [] };
    const next = new Map<number, number>();
    for (const bullet of bullets) {
      next.set(bullet.id, bullet.bouncesLeft);
      const bouncesBefore = this.known.get(bullet.id);
      if (bouncesBefore === undefined) {
        changes.births.push(bulletSnapshot(bullet));
      } else if (bullet.bouncesLeft < bouncesBefore) {
        changes.bounces.push({ id: bullet.id, x: bullet.x, y: bullet.y, vx: bullet.vx, vy: bullet.vy });
      }
    }
    for (const id of this.known.keys()) {
      if (!next.has(id)) {
        changes.deaths.push(id);
      }
    }
    this.known = next;
    return changes;
  }
}

// Полёт снарядов от зоны не зависит.
const STILL_ZONE: ZonePlan = { startRadius: 0, finalRadius: 0, startShrink: 0, endShrink: 0 };

function fromSnapshot(snapshot: FfaBulletSnapshot): Bullet {
  return { ...snapshot, damage: 0, isDead: false };
}

// Клиент: полёт снарядов между событиями сервера считается тем же движком; рождения, отскоки и гибели
// от сервера кладутся поверх.
export class BulletMirror {
  private readonly world: World;
  private isAligned = false;

  constructor(map: BattleMap) {
    this.world = createWorld({ ...map, kits: [] }, [], DEFAULT_RULES, STILL_ZONE);
  }

  get bullets(): readonly Bullet[] {
    return this.world.bullets;
  }

  // Все живые снаряды целиком — при входе в идущий матч и на старте матча; следующий снимок задаст тик.
  reset(bullets: readonly FfaBulletSnapshot[]): void {
    this.world.bullets = bullets.map(fromSnapshot);
    this.isAligned = false;
  }

  // Снимок тика T несёт состояние после T: свои снаряды доводятся до T, затем поверх — изменения сервера.
  apply(tick: number, changes: BulletChanges): void {
    if (!this.isAligned || tick < this.world.tick) {
      this.world.tick = Math.max(0, tick - 1);
      this.isAligned = true;
    }
    const bouncesBefore = new Map(this.world.bullets.map((bullet) => [bullet.id, bullet.bouncesLeft]));
    while (this.world.tick < tick) {
      flyBullets(this.world);
    }
    for (const bounce of changes.bounces) {
      const bullet = this.world.bullets.find((candidate) => candidate.id === bounce.id);
      if (bullet === undefined) {
        continue;
      }
      Object.assign(bullet, bounce);
      bullet.hasBounced = true;
      bullet.bouncesLeft = Math.max(0, (bouncesBefore.get(bounce.id) ?? 1) - 1);
    }
    const dead = new Set(changes.deaths);
    this.world.bullets = this.world.bullets.filter((bullet) => !dead.has(bullet.id));
    this.world.bullets.push(...changes.births.map(fromSnapshot));
  }
}
