import {
  BULLET_RADIUS,
  DT,
  TANK_RADIUS,
  type Bullet,
  type DuelEvent,
  type Tank,
  type World,
  type WorldEvent,
} from '@tanks/shared/engine';
import { EventFlag } from '@tanks/shared/protocol';

export type HitEvent = Extract<WorldEvent, { type: 'hit' }>;

// Запас дальности сверх хода танков и снарядов за шаги досчёта: расталкивание танков при столкновениях и о стены.
export const PUSH_MARGIN = TANK_RADIUS;
// Снимок через столько тиков после касания, где снаряд жив, отменяет касание: сервер вправе засчитать попадание
// на тик позже досчёта — поправка своего танка сдвигает касание.
export const CONFIRM_SLACK_TICKS = 2;
// Столько тиков после касания попадание сервера тем же снарядом после отмены — то же попадание, а не новое.
const LATE_HIT_TICKS = 6;
const NOT_BULLET_HIT_FLAGS = EventFlag.Self | EventFlag.Zone;

// Флаги попадания снимка: снаряд противника, не свой рикошет и не зона.
export function isBulletHitFlags(flags: number): boolean {
  return (flags & NOT_BULLET_HIT_FLAGS) === 0;
}

// Касание своего танка в шаге досчёта: снаряд, его стрелок, урон орудия и попадание движка в точке касания.
export interface OwnTouch {
  id: number;
  owner: number;
  damage: number;
  hit: HitEvent;
}

// Сыгранное по касанию попадание снарядом id: урон в нём — урон на картинке; tick — тик шага касания.
export interface PlayedHit {
  id: number;
  hit: HitEvent;
  tick: number;
}

// served — попадания снарядом по своему танку в снимках; doubles — из них сыгранные снимком повторно: касание тем же
// снарядом уже было на картинке и отменено задолго до попадания.
export interface OwnHitCounts {
  played: number;
  confirmed: number;
  cancelled: number;
  served: number;
  doubles: number;
}

// tick — тик последнего касания снаряда в досчёте.
interface PendingHit {
  owner: number;
  damage: number;
  tick: number;
}

// isShown — касание было на картинке; забытые несыгранные касания не подтверждаются поздно и не возвращаются.
interface CancelledHit {
  owner: number;
  tick: number;
  isShown: boolean;
}

function copyOf<W extends World>(world: W, bullets: readonly Bullet[]): W {
  return {
    ...world,
    tanks: world.tanks.map((tank) => ({ ...tank, tally: { ...tank.tally } })),
    bullets: bullets.map((bullet) => ({ ...bullet })),
    kits: world.kits.map((kit) => ({ ...kit })),
    zone: { ...world.zone },
  };
}

// Чужие снаряды, которые за шаг могут долететь до своего танка.
function reachingBullets(world: World, me: Tank): Bullet[] {
  const tankReach = me.stats.maxSpeed * DT;
  return world.bullets.filter((bullet) => {
    const reach = Math.hypot(bullet.vx, bullet.vy) * DT + tankReach + TANK_RADIUS + BULLET_RADIUS + PUSH_MARGIN;
    return bullet.owner !== me.id && Math.hypot(bullet.x - me.x, bullet.y - me.y) <= reach;
  });
}

function isBulletHitOn(myId: number, event: WorldEvent | DuelEvent): event is HitEvent {
  return event.type === 'hit' && event.tank === myId && event.cause === 'bullet';
}

// Шаг досчёта: события шага поля и касания своего танка в нём.
export interface TouchStep<V> {
  events: readonly V[];
  touches: OwnTouch[];
}

// Шаг досчёта и касания своего танка в нём; step — шаг поля (stepWorld или stepRound с командами шага), он же
// шагает копию. Снаряды досчёта урона не несут, поэтому чужой снаряд, погибший в шаге, проверяется копией поля
// до шага, где из снарядов — только он и с уроном: попадание по своему танку в копии — касание. Другие снаряды
// на касание не влияют: попадание в танк движок считает раньше перехватов.
export function stepWithTouches<W extends World, V extends WorldEvent | DuelEvent>(
  world: W,
  myId: number,
  damageOf: (owner: number) => number,
  step: (world: W) => readonly V[],
): TouchStep<V> {
  const me = world.tanks.find((tank) => tank.id === myId);
  const candidates = me?.isAlive === true ? reachingBullets(world, me) : [];
  if (candidates.length === 0) {
    return { events: step(world), touches: [] };
  }
  const before = copyOf(world, candidates);
  const events = step(world);
  const alive = new Set(world.bullets.map((bullet) => bullet.id));
  const touches: OwnTouch[] = [];
  for (const candidate of before.bullets) {
    if (alive.has(candidate.id)) {
      continue;
    }
    const damage = damageOf(candidate.owner);
    const probe = copyOf(before, [{ ...candidate, damage }]);
    const probeEvents: readonly (WorldEvent | DuelEvent)[] = step(probe);
    const hit = probeEvents.find((event): event is HitEvent => isBulletHitOn(myId, event));
    if (hit !== undefined) {
      touches.push({ id: candidate.id, owner: candidate.owner, damage, hit });
    }
  }
  return { events, touches };
}

// Попадания по своему танку, сыгранные по касанию в досчёте: каждое — один раз, снимок подтверждает или тихо
// отменяет. Здоровье на картинке — из снимка за вычетом сыгранных и не подтверждённых.
export class OwnHits {
  private readonly pending = new Map<number, PendingHit>();
  // Снаряды отменённых и забытых касаний, пока живы: снова погаснув о свой танк в досчёте, не играются.
  private readonly cancelled = new Map<number, CancelledHit>();
  private played: PlayedHit[] = [];
  private readonly tally: OwnHitCounts = { played: 0, confirmed: 0, cancelled: 0, served: 0, doubles: 0 };

  get counts(): OwnHitCounts {
    return { ...this.tally };
  }

  // hp — здоровье своего танка в досчёте: из снимка, без сыгранных попаданий.
  shownHp(hp: number): number {
    let pending = 0;
    for (const hit of this.pending.values()) {
      pending += hit.damage;
    }
    return Math.max(0, hp - pending);
  }

  // Касание в шаге досчёта, после которого тик стал tick. Касание снаряда в ожидании переносит ожидание на свой тик:
  // поправка своего танка сдвигает касание. Сыгранное и вскоре отменённое касание снова ждёт подтверждения, не
  // играясь. Забытое касание и касание при нуле здоровья на картинке не играются.
  touch(touch: OwnTouch, tick: number, hp: number): void {
    const pending = this.pending.get(touch.id);
    if (pending !== undefined) {
      pending.tick = tick;
      return;
    }
    const shown = this.shownHp(hp);
    const cancelled = this.cancelled.get(touch.id);
    if (cancelled !== undefined) {
      if (shown > 0 && this.isSameHit(cancelled, tick)) {
        this.cancelled.delete(touch.id);
        this.pending.set(touch.id, { owner: touch.owner, damage: Math.min(shown, touch.damage), tick });
        this.tally.cancelled--;
      }
      return;
    }
    if (shown <= 0) {
      return;
    }
    const damage = Math.min(shown, touch.damage);
    this.pending.set(touch.id, { owner: touch.owner, damage, tick });
    this.played.push({ id: touch.id, hit: { ...touch.hit, damage }, tick });
    this.tally.played++;
  }

  takePlayed(): PlayedHit[] {
    const played = this.played;
    this.played = [];
    return played;
  }

  // Кадры стояли (вкладка скрыта): касания, не дошедшие до кадра, забываются — их попадания, если снимок ещё не
  // пришёл, сыграет снимок.
  discardUnplayed(): void {
    for (const { id, tick } of this.played) {
      const pending = this.pending.get(id);
      if (pending === undefined) {
        continue;
      }
      this.pending.delete(id);
      this.cancelled.set(id, { owner: pending.owner, tick, isShown: false });
      this.tally.played--;
    }
    this.played = [];
  }

  // Снимок тика tick: died — снаряды, погибшие в нём, alive — живые после него; ownerOf — стрелок попадания по своему
  // танку снарядом (не зоной и не своим рикошетом), для остальных событий — null. Снаряд пропал без гибели в снимке
  // (переподключение) — касание отменяется сразу: попадание, если было, уже в здоровье снимка.
  // Возвращает попадания снимка, уже сыгранные касанием, в том числе отменённым незадолго до попадания сервера.
  settle<E>(
    tick: number,
    died: ReadonlySet<number>,
    alive: ReadonlySet<number>,
    events: readonly E[],
    ownerOf: (event: E) => number | null,
  ): Set<E> {
    this.tally.served += events.filter((event) => ownerOf(event) !== null).length;
    const confirmed = new Set<E>();
    const matchOf = (owner: number): E | undefined =>
      events.find((event) => !confirmed.has(event) && ownerOf(event) === owner);
    for (const [id, hit] of this.pending) {
      if (died.has(id)) {
        this.pending.delete(id);
        const match = matchOf(hit.owner);
        if (match === undefined) {
          this.tally.cancelled++;
          continue;
        }
        confirmed.add(match);
        this.tally.confirmed++;
        continue;
      }
      const isAlive = alive.has(id);
      if (isAlive && tick < hit.tick + CONFIRM_SLACK_TICKS) {
        continue;
      }
      this.pending.delete(id);
      this.tally.cancelled++;
      if (isAlive) {
        this.cancelled.set(id, { owner: hit.owner, tick: hit.tick, isShown: true });
      }
    }
    for (const [id, hit] of this.cancelled) {
      if (alive.has(id)) {
        continue;
      }
      this.cancelled.delete(id);
      if (!died.has(id) || !hit.isShown) {
        continue;
      }
      const match = matchOf(hit.owner);
      if (match === undefined) {
        continue;
      }
      if (!this.isSameHit(hit, tick)) {
        this.tally.doubles++;
        continue;
      }
      confirmed.add(match);
      this.tally.cancelled--;
      this.tally.confirmed++;
    }
    return confirmed;
  }

  // Раунд или матч кончился: подтверждения несыгранным касаниям уже не придут, а не дошедшие до кадра не играются.
  cancelAll(): void {
    for (const { id } of this.played) {
      if (this.pending.delete(id)) {
        this.tally.played--;
      }
    }
    this.played = [];
    this.tally.cancelled += this.pending.size;
    this.pending.clear();
  }

  private isSameHit(cancelled: CancelledHit, tick: number): boolean {
    return cancelled.isShown && tick <= cancelled.tick + LATE_HIT_TICKS;
  }
}
