import { describe, expect, it } from 'vitest';
import {
  BULLET_RADIUS,
  createWorld,
  DEFAULT_RULES,
  deriveStats,
  DEFAULT_STATS,
  DT,
  IDLE_ACTION,
  stepWorld,
  TANK_RADIUS,
  type Bullet,
  type Tank,
  type World,
} from '@tanks/shared/engine';
import { CONFIRM_SLACK_TICKS, OwnHits, stepWithTouches, type OwnTouch } from './ownHits.js';
import { OPEN_MAP, placedTank } from './testing/ffaServer.js';

const ME = 2;
const ENEMY = 5;
const OTHER = 6;
const STILL_ZONE = { startRadius: 9000, finalRadius: 9000, startShrink: 1000, endShrink: 1001 };
const DAMAGE = 30;
const CONTACT = TANK_RADIUS + BULLET_RADIUS;
const SPEED = deriveStats(DEFAULT_STATS).bulletSpeed;

function worldOf(tanks: Tank[], bullets: Bullet[]): World {
  const world = createWorld(OPEN_MAP, tanks, DEFAULT_RULES, STILL_ZONE);
  world.bullets = bullets;
  return world;
}

// Снаряд у точки (x, y), летящий влево; урона, как у снарядов досчёта, нет.
function bulletAt(id: number, owner: number, x: number, y: number, hasBounced = false): Bullet {
  return {
    id,
    owner,
    x,
    y,
    vx: -SPEED,
    vy: 0,
    damage: 0,
    bouncesLeft: 1,
    hasBounced,
    age: 0.5,
    isDead: false,
  };
}

function touchesOf(world: World): OwnTouch[] {
  const actions = world.tanks.map(() => IDLE_ACTION);
  return stepWithTouches(
    world,
    ME,
    () => DAMAGE,
    (stepped) => stepWorld(stepped, actions),
  ).touches;
}

// Снаряд, который за шаг войдёт в касание своего танка в (600, 600).
const ARRIVING_X = 600 + CONTACT + SPEED * DT * 0.5;

describe('касание своего танка в шаге досчёта', () => {
  it('чужой снаряд погас о свой танк — касание с уроном стрелка в точке касания; шаг поля сделан один раз', () => {
    const world = worldOf(
      [placedTank(ME, 600, 600), placedTank(ENEMY, 1500, 600)],
      [bulletAt(1, ENEMY, ARRIVING_X, 600)],
    );
    const touches = touchesOf(world);
    expect(world.tick).toBe(1);
    expect(world.bullets).toEqual([]);
    expect(world.tanks[0]?.hp).toBe(deriveStats(DEFAULT_STATS).maxHp);
    expect(touches).toHaveLength(1);
    const [touch] = touches;
    expect(touch).toMatchObject({ id: 1, owner: ENEMY, damage: DAMAGE, hit: { type: 'hit', tank: ME, by: ENEMY } });
    const hitX = touch?.hit.bulletX ?? NaN;
    expect(hitX - 600).toBeLessThan(CONTACT);
    expect(hitX - 600).toBeGreaterThan(CONTACT - SPEED * DT);
  });

  it('копию шагает та же функция шага, в копии из снарядов — только проверяемый', () => {
    const world = worldOf(
      [placedTank(ME, 600, 600), placedTank(ENEMY, 1500, 600)],
      [bulletAt(1, ENEMY, ARRIVING_X, 600), bulletAt(2, ENEMY, 1200, 900)],
    );
    const actions = world.tanks.map(() => IDLE_ACTION);
    const stepped: { field: World; bulletIds: number[]; events: unknown[] }[] = [];
    const { events, touches } = stepWithTouches(
      world,
      ME,
      () => DAMAGE,
      (field) => {
        const bulletIds = field.bullets.map((bullet) => bullet.id);
        const fieldEvents = stepWorld(field, actions);
        stepped.push({ field, bulletIds, events: fieldEvents });
        return fieldEvents;
      },
    );
    expect(touches).toHaveLength(1);
    expect(events).toBe(stepped[0]?.events);
    expect(stepped.map(({ bulletIds }) => bulletIds)).toEqual([[1, 2], [1]]);
    expect(stepped[0]?.field).toBe(world);
    expect(world.bullets.map((bullet) => bullet.id)).toEqual([2]);
  });

  it('щит, другой танк на пути, снаряд, не долетевший до касания, свой рикошет — касаний нет', () => {
    const shielded = placedTank(ME, 600, 600);
    shielded.shieldLeft = 1;
    expect(touchesOf(worldOf([shielded], [bulletAt(1, ENEMY, ARRIVING_X, 600)]))).toEqual([]);
    const blocked = worldOf(
      [placedTank(ME, 600, 600), placedTank(OTHER, 600 + 2 * TANK_RADIUS + 2, 600)],
      [bulletAt(1, ENEMY, 600 + 2 * TANK_RADIUS + 2 + CONTACT + SPEED * DT * 0.5, 600)],
    );
    expect(touchesOf(blocked)).toEqual([]);
    expect(blocked.bullets).toEqual([]);
    expect(touchesOf(worldOf([placedTank(ME, 600, 600)], [bulletAt(1, ENEMY, 700, 600)]))).toEqual([]);
    expect(touchesOf(worldOf([placedTank(ME, 600, 600)], [bulletAt(1, ME, ARRIVING_X, 600, true)]))).toEqual([]);
  });
});

function touchOf(id: number, damage = DAMAGE, owner = ENEMY): OwnTouch {
  return {
    id,
    owner,
    damage,
    hit: { type: 'hit', tank: ME, x: 600, y: 600, damage: 0, cause: 'bullet', by: owner, bulletX: 628, bulletY: 600 },
  };
}

interface ServerHit {
  owner: number | null;
}

const ownerOf = (event: ServerHit): number | null => event.owner;

describe('сыгранные касания', () => {
  it('касание играется один раз; здоровье на картинке — без него; снимок с гибелью снаряда и попаданием подтверждает', () => {
    const hits = new OwnHits();
    hits.touch(touchOf(1), 40, 100);
    hits.touch(touchOf(1), 41, 100);
    const played = hits.takePlayed();
    expect(played.map(({ id, tick, hit }) => [id, tick, hit.damage])).toEqual([[1, 40, DAMAGE]]);
    expect(hits.takePlayed()).toEqual([]);
    expect(hits.shownHp(100)).toBe(100 - DAMAGE);
    const zone: ServerHit = { owner: null };
    const served: ServerHit = { owner: ENEMY };
    const confirmed = hits.settle(40, new Set([1]), new Set(), [zone, served], ownerOf);
    expect([...confirmed]).toEqual([served]);
    expect(hits.shownHp(100 - DAMAGE)).toBe(100 - DAMAGE);
    expect(hits.counts).toEqual({ played: 1, confirmed: 1, cancelled: 0, served: 1, doubles: 0 });
  });

  it('снаряд погиб без попадания по своему танку от того же стрелка — отмена, здоровье из снимка', () => {
    const hits = new OwnHits();
    hits.touch(touchOf(1), 40, 100);
    const confirmed = hits.settle(39, new Set([1]), new Set(), [{ owner: OTHER }], ownerOf);
    expect(confirmed.size).toBe(0);
    expect(hits.shownHp(100)).toBe(100);
    expect(hits.counts).toEqual({ played: 1, confirmed: 0, cancelled: 1, served: 1, doubles: 0 });
  });

  it('снаряд жив: до 2 тиков после касания ждёт, на 2-м — отмена; снова погас в досчёте — ждёт, не играясь', () => {
    const hits = new OwnHits();
    hits.touch(touchOf(1), 40, 100);
    hits.takePlayed();
    for (let tick = 40; tick < 40 + CONFIRM_SLACK_TICKS; tick++) {
      hits.settle(tick, new Set(), new Set([1]), [], ownerOf);
      expect(hits.shownHp(100)).toBe(100 - DAMAGE);
    }
    hits.settle(40 + CONFIRM_SLACK_TICKS, new Set(), new Set([1]), [], ownerOf);
    expect(hits.shownHp(100)).toBe(100);
    expect(hits.counts).toEqual({ played: 1, confirmed: 0, cancelled: 1, served: 0, doubles: 0 });
    hits.touch(touchOf(1), 43, 100);
    expect(hits.takePlayed()).toEqual([]);
    expect(hits.shownHp(100)).toBe(100 - DAMAGE);
    const served: ServerHit = { owner: ENEMY };
    expect([...hits.settle(43, new Set([1]), new Set(), [served], ownerOf)]).toEqual([served]);
    expect(hits.counts).toEqual({ played: 1, confirmed: 1, cancelled: 0, served: 1, doubles: 0 });
  });

  it('повторное касание снаряда в ожидании переносит ожидание на свой тик: снимок по старому тику не отменяет', () => {
    const hits = new OwnHits();
    hits.touch(touchOf(1), 40, 100);
    hits.touch(touchOf(1), 43, 100);
    hits.settle(40 + CONFIRM_SLACK_TICKS, new Set(), new Set([1]), [], ownerOf);
    expect(hits.shownHp(100)).toBe(100 - DAMAGE);
    const served: ServerHit = { owner: ENEMY };
    expect([...hits.settle(43, new Set([1]), new Set(), [served], ownerOf)]).toEqual([served]);
    expect(hits.takePlayed()).toHaveLength(1);
    expect(hits.counts).toEqual({ played: 1, confirmed: 1, cancelled: 0, served: 1, doubles: 0 });
  });

  it('сервер попал вскоре после отмены — попадание уже сыграно; много позже — играется снова и считается повтором', () => {
    const late = new OwnHits();
    late.touch(touchOf(1), 40, 100);
    late.settle(42, new Set(), new Set([1]), [], ownerOf);
    const served: ServerHit = { owner: ENEMY };
    expect([...late.settle(45, new Set([1]), new Set(), [served], ownerOf)]).toEqual([served]);
    expect(late.counts).toEqual({ played: 1, confirmed: 1, cancelled: 0, served: 1, doubles: 0 });

    const later = new OwnHits();
    later.touch(touchOf(1), 40, 100);
    later.settle(42, new Set(), new Set([1]), [], ownerOf);
    expect(later.settle(60, new Set([1]), new Set(), [served], ownerOf).size).toBe(0);
    expect(later.counts).toEqual({ played: 1, confirmed: 0, cancelled: 1, served: 1, doubles: 1 });
  });

  it('попадание снимка тиком позже касания подтверждает без отмены', () => {
    const hits = new OwnHits();
    hits.touch(touchOf(1), 40, 100);
    hits.settle(40, new Set(), new Set([1]), [], ownerOf);
    const served: ServerHit = { owner: ENEMY };
    expect([...hits.settle(41, new Set([1]), new Set(), [served], ownerOf)]).toEqual([served]);
    expect(hits.counts).toEqual({ played: 1, confirmed: 1, cancelled: 0, served: 1, doubles: 0 });
  });

  it('снаряд пропал из снимка без гибели (переподключение) — касание отменено сразу, здоровье из снимка', () => {
    const hits = new OwnHits();
    hits.touch(touchOf(1), 40, 100);
    expect(hits.settle(38, new Set(), new Set(), [], ownerOf).size).toBe(0);
    expect(hits.shownHp(100 - DAMAGE)).toBe(100 - DAMAGE);
    expect(hits.counts).toEqual({ played: 1, confirmed: 0, cancelled: 1, served: 0, doubles: 0 });
  });

  it('смертельное касание — урон до нуля; при нуле на картинке следующее касание не играется', () => {
    const hits = new OwnHits();
    hits.touch(touchOf(1, 50), 40, 20);
    hits.touch(touchOf(2, 50), 41, 20);
    expect(hits.takePlayed().map(({ hit }) => hit.damage)).toEqual([20]);
    expect(hits.shownHp(20)).toBe(0);
    expect(hits.counts.played).toBe(1);
  });

  it('два касания одного стрелка в одном снимке — два подтверждения на два попадания', () => {
    const hits = new OwnHits();
    hits.touch(touchOf(1), 40, 100);
    hits.touch(touchOf(2), 40, 100);
    const served: ServerHit[] = [{ owner: ENEMY }, { owner: ENEMY }];
    expect(hits.settle(40, new Set([1, 2]), new Set(), served, ownerOf).size).toBe(2);
    expect(hits.counts).toEqual({ played: 2, confirmed: 2, cancelled: 0, served: 2, doubles: 0 });
  });

  it('конец раунда отменяет неподтверждённые касания, а не дошедшие до кадра не играются', () => {
    const hits = new OwnHits();
    hits.touch(touchOf(1), 40, 100);
    hits.takePlayed();
    hits.touch(touchOf(2), 41, 100);
    hits.cancelAll();
    expect(hits.takePlayed()).toEqual([]);
    expect(hits.shownHp(100)).toBe(100);
    expect(hits.counts).toEqual({ played: 1, confirmed: 0, cancelled: 1, served: 0, doubles: 0 });
  });

  it('кадры стояли: несыгранное касание забыто — здоровье из снимка, попадание снимка не помечено сыгранным', () => {
    const hits = new OwnHits();
    hits.touch(touchOf(1), 40, 100);
    hits.discardUnplayed();
    expect(hits.takePlayed()).toEqual([]);
    expect(hits.shownHp(100)).toBe(100);
    expect(hits.settle(40, new Set([1]), new Set(), [{ owner: ENEMY }], ownerOf).size).toBe(0);
    expect(hits.counts).toEqual({ played: 0, confirmed: 0, cancelled: 0, served: 1, doubles: 0 });
  });
});
