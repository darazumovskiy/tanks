import {
  BULLET_RADIUS,
  flyBullets,
  TANK_RADIUS,
  type Bullet,
  type Point,
  type Side,
  type World,
} from '@tanks/shared/engine';
import { duelSide } from '@tanks/shared/protocol';
import { pictureWeight } from '../pictureTime.js';
import type { InterpolatedBullet } from '../prediction.js';

// Снаряды на картинке стенда, как в бою: каждый — в своём времени между временем своего нарисованного танка и
// временем нарисованного бота, по весу расстояний до них. У танка снаряд в его времени, поэтому касание на картинке
// совпадает с попаданием судьи.

const ARMOR_DISTANCE = TANK_RADIUS + BULLET_RADIUS;
const SIDES: readonly Side[] = [0, 1];
// Время снаряда — корень уравнения «время = время по весу в месте снаряда в это время»: при близких танках корней
// бывает несколько, поэтому первый не раньше прошлой картинки ищется перебором с этим шагом в тиках, затем делением
// пополам.
const ROOT_SCAN_TICKS = 0.25;
const ROOT_BISECT_STEPS = 12;
// Корень ближе этого к целому тику — целый тик: снаряд, погибший в следующем тике, не пропадает на тик раньше.
const ROOT_SNAP_TICKS = 1e-3;

// Снаряды по тикам: frames[i] — снаряды тика first + i от тика судьи, ключ и id — номер снаряда на картинке. Кадры
// до тика судьи включительно — его решение, после — полёт вперёд без танков.
export interface BulletFrames {
  first: number;
  frames: readonly ReadonlyMap<number, Bullet>[];
}

// Нарисованный танк; offset — его время на картинке в тиках от тика судьи. isHitOnTouch — попадание по нему играется
// в миг касания на картинке: снаряд пропадает сразу, судья засчитает попадание позже.
export interface TimedTank extends Point {
  isAlive: boolean;
  offset: number;
  isHitOnTouch: boolean;
}

export interface LagBullet extends InterpolatedBullet {
  isOnArmor: boolean;
}

// Снаряд коснулся брони танка с попаданием по касанию; point — место касания на картинке.
export interface BulletTouch {
  id: number;
  side: Side;
  point: Point;
  bullet: Bullet;
}

export interface BulletPicture {
  bullets: LagBullet[];
  touches: BulletTouch[];
}

// tick — тик судьи на счётчике стенда: растёт и между раундами, время картинки снаряда меряется им.
// tanks — свой нарисованный танк и нарисованный бот; field — поле для полёта вперёд.
interface BulletScene {
  tick: number;
  frames: BulletFrames;
  tanks: readonly [TimedTank, TimedTank];
  field: World;
}

interface Sample extends Point {
  bullet: Bullet;
  isVirtual: boolean;
}

// Снаряд на броне: offset — место от центра танка; contactTick — время картинки в миг касания.
interface Hold {
  side: Side;
  offset: Point;
  contactTick: number;
}

// tick — время снаряда на картинке; isHoldOver — стоял на броне, судья решил «мимо», больше не встаёт; isSpent —
// коснулся танка с попаданием по касанию, больше не рисуется.
interface Shown {
  tick: number;
  owner: Side;
  drawn: Point;
  hold: Hold | null;
  isHoldOver: boolean;
  isSpent: boolean;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function pointOf(point: Point): Point {
  return { x: point.x, y: point.y };
}

function relative(point: Point, origin: Point): Point {
  return { x: point.x - origin.x, y: point.y - origin.y };
}

// Полёт копии снаряда без танков на дробное число тиков; погиб на стене или от старости — null.
function flown(field: World, from: Bullet, ticks: number): Point | null {
  const bullet: Bullet = { ...from };
  const world: World = { ...field, tanks: [], bullets: [bullet] };
  const steps = Math.ceil(ticks);
  let before: Point = pointOf(bullet);
  for (let step = 0; step < steps; step++) {
    before = pointOf(bullet);
    flyBullets(world);
    if (bullet.isDead) {
      return null;
    }
  }
  const rest = ticks - (steps - 1);
  return { x: lerp(before.x, bullet.x, rest), y: lerp(before.y, bullet.y, rest) };
}

// Дорожка одного снаряда по кадрам; снаряд есть в кадрах подряд — от рождения до гибели.
class Track {
  private readonly samples: (Bullet | undefined)[];
  private readonly firstSeen: number;
  private readonly lastSeen: number;

  constructor(
    private readonly frames: BulletFrames,
    readonly id: number,
  ) {
    this.samples = frames.frames.map((frame) => frame.get(id));
    this.firstSeen = this.samples.findIndex((bullet) => bullet !== undefined);
    let last = -1;
    for (const [index, bullet] of this.samples.entries()) {
      if (bullet !== undefined) {
        last = index;
      }
    }
    this.lastSeen = last;
  }

  get owner(): Side | null {
    const bullet = this.samples[this.firstSeen];
    return bullet === undefined ? null : duelSide(bullet.owner);
  }

  // Место для веса: до рождения — место рождения, после гибели — последнее место.
  pointForWeight(offset: number): Point {
    const index = Math.min(this.lastSeen, Math.max(this.firstSeen, offset - this.frames.first));
    const lower = this.samples[Math.floor(index)];
    const upper = this.samples[Math.ceil(index)];
    if (lower === undefined || upper === undefined) {
      return pointOf(lower ?? upper ?? { x: 0, y: 0 });
    }
    const t = index - Math.floor(index);
    return { x: lerp(lower.x, upper.x, t), y: lerp(lower.y, upper.y, t) };
  }

  // Место во времени offset: между кадрами — линейно; родился внутри шага — с места рождения; ещё не родился — null.
  // Погиб у судьи — место полёта без танков от последнего кадра (isVirtual): по нему снаряд касается брони, сам не
  // рисуется. Погиб в полёте вперёд — на стене, от старости или от встречного снаряда — его больше нет.
  at(offset: number, field: World): Sample | null {
    const index = offset - this.frames.first;
    const lower = this.samples[Math.floor(index)];
    const upper = this.samples[Math.ceil(index)];
    if (upper !== undefined) {
      if (lower === undefined) {
        return { ...pointOf(upper), bullet: upper, isVirtual: false };
      }
      const t = index - Math.floor(index);
      return { x: lerp(lower.x, upper.x, t), y: lerp(lower.y, upper.y, t), bullet: upper, isVirtual: false };
    }
    const last = this.samples[this.lastSeen];
    const isDeadInFlight = this.lastSeen >= -this.frames.first;
    if (last === undefined || this.lastSeen > index || isDeadInFlight) {
      return null;
    }
    const point = flown(field, last, index - this.lastSeen);
    return point === null ? null : { ...point, bullet: last, isVirtual: true };
  }

  // Тик гибели по решению судьи; судья его ещё не видел или снаряд жив — null.
  deathTick(sceneTick: number): number | null {
    const judged = this.lastJudged();
    if (judged === null || judged === -this.frames.first) {
      return null;
    }
    return sceneTick + this.frames.first + judged + 1;
  }

  // Последний тик, где снаряд жив по решению судьи.
  lastJudgedTick(sceneTick: number): number | null {
    const judged = this.lastJudged();
    return judged === null ? null : sceneTick + this.frames.first + judged;
  }

  private lastJudged(): number | null {
    const judgeIndex = -this.frames.first;
    if (this.firstSeen < 0 || this.firstSeen > judgeIndex) {
      return null;
    }
    return Math.min(this.lastSeen, judgeIndex);
  }
}

function weightedOffset(point: Point, tanks: readonly [TimedTank, TimedTank]): number {
  const [me, bot] = tanks;
  const toMe = me.isAlive ? distance(point, me) : Infinity;
  const toBot = bot.isAlive ? distance(point, bot) : Infinity;
  return bot.offset + pictureWeight(toMe, toBot) * (me.offset - bot.offset);
}

function bisect(low: number, high: number, excess: (offset: number) => number): number {
  let below = low;
  let above = high;
  for (let step = 0; step < ROOT_BISECT_STEPS; step++) {
    const middle = (below + above) / 2;
    if (excess(middle) >= 0) {
      above = middle;
    } else {
      below = middle;
    }
  }
  return above;
}

// Время снаряда в тиках от тика судьи: первый корень не раньше floor. Снаряд нарисован там, где он во времени,
// которое даёт это место, и не летит назад.
function pictureOffset(track: Track, tanks: readonly [TimedTank, TimedTank], floor: number): number {
  const low = Math.min(tanks[0].offset, tanks[1].offset);
  const high = Math.max(tanks[0].offset, tanks[1].offset);
  const excess = (offset: number): number => offset - weightedOffset(track.pointForWeight(offset), tanks);
  let below = Math.min(high, Math.max(low, floor));
  if (excess(below) >= 0) {
    return below;
  }
  let above = Math.min(high, below + ROOT_SCAN_TICKS);
  while (above < high && excess(above) < 0) {
    below = above;
    above = Math.min(high, above + ROOT_SCAN_TICKS);
  }
  const root = bisect(below, above, excess);
  const whole = Math.round(root);
  return Math.abs(root - whole) < ROOT_SNAP_TICKS ? whole : root;
}

function onArmor(point: Point): Point {
  const away = Math.hypot(point.x, point.y);
  if (away === 0) {
    return { x: ARMOR_DISTANCE, y: 0 };
  }
  return { x: (point.x / away) * ARMOR_DISTANCE, y: (point.y / away) * ARMOR_DISTANCE };
}

// Первая точка пути from → to на броне танка в начале координат, t — доля пути; путь начат внутри — ближайшая точка
// брони. Пути нет (снаряд только появился) — проверяется одна точка to.
function armorContact(from: Point | null, to: Point): { point: Point; t: number } | null {
  const start = from ?? to;
  if (Math.hypot(start.x, start.y) < ARMOR_DISTANCE) {
    return { point: onArmor(start), t: 0 };
  }
  if (from === null) {
    return null;
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (from.x * dx + from.y * dy);
  const c = from.x * from.x + from.y * from.y - ARMOR_DISTANCE * ARMOR_DISTANCE;
  const discriminant = b * b - 4 * a * c;
  if (a === 0 || discriminant < 0) {
    return null;
  }
  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  if (t < 0 || t > 1) {
    return null;
  }
  return { point: { x: from.x + dx * t, y: from.y + dy * t }, t };
}

// Снаряды картинки по тикам судьи. Касание брони ищется в координатах танка: кадры между тиками двигают снаряд и
// танк линейно, поэтому путь, не задевший брони между картинками, не задевает её и между кадрами.
export class DrawnBullets {
  private shown = new Map<number, Shown>();
  private tanksBefore: readonly [Point, Point] | null = null;

  clear(): void {
    this.shown = new Map();
    this.tanksBefore = null;
  }

  frame(scene: BulletScene): BulletPicture {
    const ids = new Set(this.shown.keys());
    for (const frame of scene.frames.frames) {
      for (const id of frame.keys()) {
        ids.add(id);
      }
    }
    const shown = new Map<number, Shown>();
    const touches: BulletTouch[] = [];
    for (const id of ids) {
      const placed = this.place(new Track(scene.frames, id), scene, this.shown.get(id), touches);
      if (placed !== null) {
        shown.set(id, placed);
      }
    }
    this.shown = shown;
    this.tanksBefore = [pointOf(scene.tanks[0]), pointOf(scene.tanks[1])];
    const bullets = [...shown]
      .filter(([, placed]) => !placed.isSpent)
      .map(([id, placed]) => ({ id, owner: placed.owner, ...pointOf(placed.drawn), isOnArmor: placed.hold !== null }));
    return { bullets, touches };
  }

  // Потраченный касанием снаряд помнится, пока он есть в кадрах: судья может держать его живым ещё C тиков.
  private place(track: Track, scene: BulletScene, previous: Shown | undefined, touches: BulletTouch[]): Shown | null {
    const owner = track.owner;
    if (owner === null) {
      return null;
    }
    if (previous?.isSpent === true) {
      return previous;
    }
    const floor = previous === undefined ? -Infinity : previous.tick - scene.tick;
    const offset = pictureOffset(track, scene.tanks, floor);
    const tick = scene.tick + offset;
    const target = track.at(offset, scene.field);
    const hold = previous?.hold ?? null;
    if (hold !== null) {
      return this.held(track, scene, { tick, owner }, hold, target);
    }
    if (target === null) {
      return null;
    }
    const isHoldOver = previous?.isHoldOver === true;
    const contact = isHoldOver ? null : this.contactOf(scene, previous, target, owner, tick);
    if (contact === null) {
      if (target.isVirtual) {
        return null;
      }
      return { tick, owner, drawn: pointOf(target), hold: null, isHoldOver, isSpent: false };
    }
    const tank = scene.tanks[contact.side];
    if (!tank.isHitOnTouch) {
      return this.held(track, scene, { tick, owner }, contact, target);
    }
    // Судья уже убрал снаряд — в танк, встречным или о стену: попадание, если было, играет его вердикт.
    if (target.isVirtual) {
      return null;
    }
    const point = { x: tank.x + contact.offset.x, y: tank.y + contact.offset.y };
    touches.push({ id: track.id, side: contact.side, point, bullet: target.bullet });
    return { tick, owner, drawn: point, hold: null, isHoldOver: false, isSpent: true };
  }

  // Броня живого танка, кроме своего владельца до рикошета, — как в движке.
  private contactOf(
    scene: BulletScene,
    previous: Shown | undefined,
    target: Sample,
    owner: Side,
    tick: number,
  ): Hold | null {
    let best: { hold: Hold; t: number } | null = null;
    for (const side of SIDES) {
      const tank = scene.tanks[side];
      const canHit = tank.isAlive && (side !== owner || target.bullet.hasBounced);
      if (!canHit) {
        continue;
      }
      const before = this.tanksBefore?.[side];
      const from = previous === undefined || before === undefined ? null : relative(previous.drawn, before);
      const contact = armorContact(from, relative(target, tank));
      if (contact === null || (best !== null && best.t <= contact.t)) {
        continue;
      }
      best = { hold: { side, offset: contact.point, contactTick: tick }, t: contact.t };
    }
    return best?.hold ?? null;
  }

  // Стоит на броне и едет с танком, пока судья не решит. Погиб раньше времени танка на картинке — пропадает, в том же
  // шаге играется попадание. Жив после касания — «мимо»: летит дальше, как только место на дорожке вне брони.
  private held(
    track: Track,
    scene: BulletScene,
    base: { tick: number; owner: Side },
    hold: Hold,
    target: Sample | null,
  ): Shown | null {
    const tank = scene.tanks[hold.side];
    const death = track.deathTick(scene.tick);
    if (death !== null && death < scene.tick + tank.offset) {
      return null;
    }
    const lastAlive = track.lastJudgedTick(scene.tick);
    const isMissed = lastAlive !== null && lastAlive > Math.ceil(hold.contactTick);
    const isClear = target !== null && !target.isVirtual && distance(target, tank) >= ARMOR_DISTANCE;
    if (isMissed && isClear) {
      return { ...base, drawn: pointOf(target), hold: null, isHoldOver: true, isSpent: false };
    }
    const drawn = { x: tank.x + hold.offset.x, y: tank.y + hold.offset.y };
    return { ...base, drawn, hold, isHoldOver: false, isSpent: false };
  }
}
