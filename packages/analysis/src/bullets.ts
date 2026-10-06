import { BULLET_LIFETIME, DT, ZONE, type Side, type Wall } from '@tanks/shared/engine';
import { wallNormalAt } from './geometry.js';
import type { GameEvent, ParsedRound } from './logParser.js';
import { roundTo } from './numbers.js';

// Снаряд без исхода дольше времени жизни с запасом — потерян разбором, а не движком.
const LIFETIME_GRACE_SEC = 0.5;
// Событие сопоставляется снаряду, если он в двух тиках пути плюс запас на округление координат.
const MATCH_WINDOW_TICKS = 2;
const MATCH_PAD = 15;
// Урон зоны за тик пишется в журнал с одним знаком после запятой.
const ZONE_TICK_DAMAGE = roundTo(ZONE.damagePerSecond * DT, 1);
const DAMAGE_EPSILON = 1e-6;
const CLASH_BULLETS = 2;

export const EVENT_KIND = {
  shot: 'shot',
  impact: 'impact',
  fizzle: 'fizzle',
  ricochet: 'ricochet',
  clash: 'clash',
  zoneStart: 'zoneStart',
  hit: 'hit',
  death: 'death',
  pickup: 'pickup',
  kitSpawn: 'kitSpawn',
  bump: 'bump',
  roundOver: 'roundOver',
} as const;

export type BulletOutcome = 'wall' | 'fizzle' | 'clash' | 'self' | 'bullet' | 'lost' | 'in_flight';
export type HitCause = 'bullet' | 'self' | 'zone' | 'unknown';

export interface TrackedBullet {
  owner: Side;
  shot: GameEvent;
  refGt: number;
  refX: number;
  refY: number;
  dx: number;
  dy: number;
  speed: number;
  hasBounced: boolean;
  isAlive: boolean;
  outcome: BulletOutcome | null;
}

export interface Hit {
  gt: number;
  victim: Side;
  damage: number;
  cause: HitCause;
  by: Side | null;
  isRicochet: boolean;
}

export interface TrackedRound {
  bullets: TrackedBullet[];
  hits: Hit[];
}

function positionAt(bullet: TrackedBullet, gt: number): { x: number; y: number } {
  const distance = bullet.speed * DT * (gt - bullet.refGt);
  return { x: bullet.refX + bullet.dx * distance, y: bullet.refY + bullet.dy * distance };
}

function tolerance(bullet: TrackedBullet): number {
  return bullet.speed * DT * MATCH_WINDOW_TICKS + MATCH_PAD;
}

function nearestBullet(
  bullets: readonly TrackedBullet[],
  gt: number,
  x: number,
  y: number,
  owner: Side | null,
): TrackedBullet | null {
  let best: TrackedBullet | null = null;
  let bestDistance = Infinity;
  for (const bullet of bullets) {
    if (!bullet.isAlive) {
      continue;
    }
    if (owner !== null && bullet.owner !== owner) {
      continue;
    }
    const position = positionAt(bullet, gt);
    const distance = Math.hypot(position.x - x, position.y - y);
    if (distance < bestDistance && distance < tolerance(bullet)) {
      best = bullet;
      bestDistance = distance;
    }
  }
  return best;
}

function finish(bullet: TrackedBullet, outcome: BulletOutcome): void {
  bullet.isAlive = false;
  bullet.outcome = outcome;
}

function finishNearest(
  bullets: readonly TrackedBullet[],
  event: GameEvent,
  owner: Side | null,
  outcome: BulletOutcome,
): void {
  const bullet = nearestBullet(bullets, event.gt, event.x, event.y, owner);
  if (bullet !== null) {
    finish(bullet, outcome);
  }
}

function reflect(bullet: TrackedBullet, event: GameEvent, walls: readonly Wall[]): void {
  const { nx, ny } = wallNormalAt(walls, event.x, event.y);
  const dot = bullet.dx * nx + bullet.dy * ny;
  bullet.dx -= 2 * dot * nx;
  bullet.dy -= 2 * dot * ny;
  bullet.refX = event.x;
  bullet.refY = event.y;
  bullet.refGt = event.gt;
  bullet.hasBounced = true;
}

function expireOld(bullets: readonly TrackedBullet[], gt: number): void {
  for (const bullet of bullets) {
    if (bullet.isAlive && (gt - bullet.shot.gt) * DT > BULLET_LIFETIME + LIFETIME_GRACE_SEC) {
      finish(bullet, 'lost');
    }
  }
}

function hitOf(event: GameEvent, bullet: TrackedBullet | null, isZoneActive: boolean): Hit {
  const victim = event.side ?? 0;
  if (bullet !== null) {
    const cause: HitCause = bullet.owner === victim ? 'self' : 'bullet';
    finish(bullet, cause);
    return { gt: event.gt, victim, damage: event.v, cause, by: bullet.owner, isRicochet: bullet.hasBounced };
  }
  const isZoneTick = isZoneActive && event.v <= ZONE_TICK_DAMAGE + DAMAGE_EPSILON;
  return { gt: event.gt, victim, damage: event.v, cause: isZoneTick ? 'zone' : 'unknown', by: null, isRicochet: false };
}

export function trackRound(round: ParsedRound, bulletSpeeds: [number, number], walls: readonly Wall[]): TrackedRound {
  const bullets: TrackedBullet[] = [];
  const hits: Hit[] = [];
  let isZoneActive = false;
  // Угол в событии выстрела округлён до 0,1 рад; угол башни в строке тика точнее на порядок.
  const turretByGt = new Map<number, [number, number]>();
  for (const tick of round.ticks) {
    turretByGt.set(tick.gt, [tick.poses[0].turret, tick.poses[1].turret]);
  }
  for (const event of round.events) {
    expireOld(bullets, event.gt);
    switch (event.kind) {
      case EVENT_KIND.shot: {
        const owner = event.side ?? 0;
        const angle = turretByGt.get(event.gt)?.[owner] ?? event.v;
        bullets.push({
          owner,
          shot: event,
          refGt: event.gt - 1,
          refX: event.x,
          refY: event.y,
          dx: Math.cos(angle),
          dy: Math.sin(angle),
          speed: bulletSpeeds[owner],
          hasBounced: false,
          isAlive: true,
          outcome: null,
        });
        break;
      }
      case EVENT_KIND.impact:
        finishNearest(bullets, event, event.side, 'wall');
        break;
      case EVENT_KIND.fizzle:
        finishNearest(bullets, event, event.side, 'fizzle');
        break;
      case EVENT_KIND.ricochet: {
        const bullet = nearestBullet(bullets, event.gt, event.x, event.y, event.side);
        if (bullet !== null) {
          reflect(bullet, event, walls);
        }
        break;
      }
      case EVENT_KIND.clash:
        for (let i = 0; i < CLASH_BULLETS; i++) {
          finishNearest(bullets, event, null, 'clash');
        }
        break;
      case EVENT_KIND.zoneStart:
        isZoneActive = true;
        break;
      case EVENT_KIND.hit:
        hits.push(hitOf(event, nearestBullet(bullets, event.gt, event.x, event.y, null), isZoneActive));
        break;
      default:
        break;
    }
  }
  for (const bullet of bullets) {
    if (bullet.isAlive) {
      finish(bullet, 'in_flight');
    }
  }
  return { bullets, hits };
}
