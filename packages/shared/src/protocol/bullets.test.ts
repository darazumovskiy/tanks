import { describe, expect, it } from 'vitest';
import {
  createFfaMatch,
  createRandom,
  DEFAULT_RULES,
  DEFAULT_STATS,
  ffaMap,
  nextRandom,
  stepFfaMatch,
  type Action,
  type Bullet,
  type FfaMatch,
} from '../engine/index.js';
import { BulletMirror, bulletSnapshot, BulletTracker } from './bullets.js';

const PLAYERS = 10;
const TICKS = 1500;
const LATE_JOIN_TICK = 700;

function playersOf(count: number): { id: number; name: string; stats: typeof DEFAULT_STATS }[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: `П${String(index)}`,
    stats: DEFAULT_STATS,
  }));
}

function state(bullets: readonly Bullet[]): [number, number, number, number, number, number, boolean][] {
  return [...bullets]
    .sort((a, b) => a.id - b.id)
    .map((bullet) => [bullet.id, bullet.x, bullet.y, bullet.vx, bullet.vy, bullet.bouncesLeft, bullet.hasBounced]);
}

// Все стреляют почти всегда: снаряды отскакивают, попадают в танки, сбивают друг друга.
function stepWithRandomActions(match: FfaMatch, random: ReturnType<typeof createRandom>, tick: number): void {
  const actions = new Map<number, Action>();
  if (tick % 10 === 0) {
    for (const player of match.players) {
      actions.set(player.id, {
        throttle: nextRandom(random) * 2 - 1,
        turn: nextRandom(random) * 2 - 1,
        turretTurn: nextRandom(random) * 2 - 1,
        isFiring: nextRandom(random) < 0.9,
      });
    }
  }
  stepFfaMatch(match, actions);
}

describe('снаряды у клиента по событиям сервера', () => {
  it('совпадают с сервером побитово на каждом тике; вошедший посреди матча догоняет по полному списку', () => {
    const map = ffaMap(10);
    const match = createFfaMatch(map, playersOf(PLAYERS), 3, DEFAULT_RULES);
    const random = createRandom(17);
    const tracker = new BulletTracker();
    const mirror = new BulletMirror(map);
    const late = new BulletMirror(map);
    let isLateJoined = false;
    let bounces = 0;
    let deaths = 0;
    for (let tick = 0; tick < TICKS && !match.isOver; tick++) {
      stepWithRandomActions(match, random, tick);
      const changes = tracker.diff(match.world.bullets);
      bounces += changes.bounces.length;
      deaths += changes.deaths.length;
      mirror.apply(match.world.tick, changes);
      expect(state(mirror.bullets), `тик ${String(match.world.tick)}`).toEqual(state(match.world.bullets));
      if (isLateJoined) {
        late.apply(match.world.tick, changes);
        expect(state(late.bullets), `вошедший, тик ${String(match.world.tick)}`).toEqual(state(match.world.bullets));
      }
      if (tick === LATE_JOIN_TICK) {
        late.reset(match.world.bullets.map(bulletSnapshot));
        isLateJoined = true;
      }
    }
    expect(bounces).toBeGreaterThan(50);
    expect(deaths).toBeGreaterThan(100);
  });

  it('снимки отсчёта с одним тиком не двигают снаряды; новый матч начинается заново по полному списку', () => {
    const map = ffaMap(10);
    const mirror = new BulletMirror(map);
    const born = { id: 5, owner: 1, x: 500, y: 500, vx: 300, vy: 0, bouncesLeft: 1, hasBounced: false, age: 0.1 };
    mirror.reset([born]);
    mirror.apply(0, { births: [], bounces: [], deaths: [] });
    mirror.apply(0, { births: [], bounces: [], deaths: [] });
    expect(mirror.bullets[0]?.x).toBe(500);
    mirror.apply(1, { births: [], bounces: [], deaths: [] });
    expect(mirror.bullets[0]?.x).toBe(510);
    mirror.reset([]);
    mirror.apply(0, { births: [], bounces: [], deaths: [] });
    expect(mirror.bullets).toHaveLength(0);
  });

  it('сброс отслеживания: после него все живые снаряды — снова рождения', () => {
    const tracker = new BulletTracker();
    const bullet: Bullet = {
      id: 1,
      owner: 1,
      x: 1,
      y: 2,
      vx: 3,
      vy: 4,
      damage: 0,
      bouncesLeft: 1,
      hasBounced: false,
      age: 0,
      isDead: false,
    };
    expect(tracker.diff([bullet]).births).toHaveLength(1);
    expect(tracker.diff([bullet]).births).toHaveLength(0);
    tracker.reset();
    expect(tracker.diff([bullet]).births).toHaveLength(1);
  });

  it('отскок от сервера для неизвестного снаряда пропускается', () => {
    const mirror = new BulletMirror(ffaMap(10));
    mirror.apply(3, { births: [], bounces: [{ id: 99, x: 1, y: 2, vx: 3, vy: 4 }], deaths: [] });
    expect(mirror.bullets).toHaveLength(0);
  });
});
