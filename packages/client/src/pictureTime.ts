import { BULLET_RADIUS, DT, TANK_RADIUS, type Point } from '@tanks/shared/engine';
import type { FfaEventKind, SnapshotEventKind } from '@tanks/shared/protocol';

// Зона «у танка»: ближе к своему танку снаряд рисуется в его времени, ближе к чужому — во времени чужого.
export const PICTURE_NEAR = TANK_RADIUS * 2.5;
// Тик картинки снаряда растёт не медленнее этой доли хода тика чужих: улетающий от своего танка снаряд замедляется,
// но назад не летит и не зависает.
export const PICTURE_MIN_TIME_RATE = 0.5;
// Свой танк вернулся на поле: тик своего танка на картинке догоняет тик предсказания, идя во столько раз быстрее
// тика чужих.
export const PICTURE_CATCH_UP_RATE = 2;
// Событие, до места которого картинка не дошла за это время, выбрасывается; свой снаряд у корпуса врага ждёт вспышку
// столько же хода тика чужих.
export const EVENT_MAX_WAIT_MS = 500;
const HOLD_MAX_TICKS = EVENT_MAX_WAIT_MS / (DT * 1000);
// Свой снаряд касается нарисованного танка на этом расстоянии от его центра.
const HOLD_CONTACT = TANK_RADIUS + BULLET_RADIUS;
// Свой снаряд на подлёте к нарисованному танку рисуется впереди своей дорожки на столько тиков: за последний тик
// перед попаданием он сближается с танком почти на свой корпус, и без запаса вспышка застала бы его в воздухе.
const LEAD_TICKS = 2;
// Запас набирается, когда до касания по дорожке осталось не больше стольких тиков; набирается во столько раз быстрее
// хода тика картинки снаряда — снаряд на подлёте ускоряется, — сходит вдвое медленнее.
const LEAD_LOOK_TICKS = LEAD_TICKS + 2;
const LEAD_RATE = 2;

// Два времени кадра: myTick — тик своего танка (предсказание), othersTick — дробный тик чужих танков
// (интерполяция снимков). me — свой танк в myTick, null — его нет на поле; others — живые чужие в othersTick.
export interface PictureClock {
  myTick: number;
  othersTick: number;
  me: Point | null;
  others: readonly Point[];
}

export interface TrackPoint {
  id: number;
  owner: number;
  x: number;
  y: number;
}

// Снаряд кадра: где нарисован и в каком тике.
export interface PictureBullet extends TrackPoint {
  tick: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function nearestPoint(point: Point, others: readonly Point[]): Point | null {
  let best: Point | null = null;
  for (const other of others) {
    if (best === null || distance(point, other) < distance(point, best)) {
      best = other;
    }
  }
  return best;
}

function nearest(point: Point, others: readonly Point[]): number {
  const best = nearestPoint(point, others);
  return best === null ? Infinity : distance(point, best);
}

// Доля пути от времени чужих к своему: 1 — у своего танка, 0 — у чужого, между ними — по расстояниям за вычетом
// зоны «у танка». Оба рядом — время своего: попадание по себе важнее.
export function pictureWeight(toMe: number, toOther: number): number {
  const a = Math.max(0, toMe - PICTURE_NEAR);
  const b = Math.max(0, toOther - PICTURE_NEAR);
  if (a === 0 || b === Infinity) {
    return 1;
  }
  return b / (a + b);
}

function tickFromWeight(clock: PictureClock, weight: number): number {
  return clock.othersTick + weight * (clock.myTick - clock.othersTick);
}

// Тик картинки в точке поля: тем же весом, что у снаряда.
export function pictureTickAt(clock: PictureClock, point: Point): number {
  const toMe = clock.me === null ? Infinity : distance(point, clock.me);
  return tickFromWeight(clock, pictureWeight(toMe, nearest(point, clock.others)));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Тик своего танка на картинке. Танк ушёл с поля (tankTick — null) — тик не прыгает к тику чужих, а догоняет его,
// идя вдвое медленнее; танк вернулся — тик догоняет тик предсказания, идя вдвое быстрее тика чужих, и дальше равен ему.
export class OwnTime {
  private tick: number | null = null;
  private othersTick = 0;
  private isCatchingUp = false;

  next(tankTick: number | null, othersTick: number): number {
    const othersStep = Math.max(0, othersTick - this.othersTick);
    this.othersTick = othersTick;
    const previous = this.tick;
    let tick: number;
    if (previous === null) {
      this.isCatchingUp = tankTick === null;
      tick = tankTick ?? othersTick;
    } else if (tankTick === null) {
      this.isCatchingUp = true;
      tick = Math.max(othersTick, previous + PICTURE_MIN_TIME_RATE * othersStep);
    } else if (this.isCatchingUp && tankTick > previous) {
      tick = Math.max(othersTick, Math.min(tankTick, previous + PICTURE_CATCH_UP_RATE * othersStep));
      this.isCatchingUp = tick < tankTick;
    } else {
      this.isCatchingUp = false;
      tick = tankTick;
    }
    this.tick = tick;
    return tick;
  }
}

// Снаряды по тикам: до последнего снимка — истина сервера, после — досчёт предсказания. Тик, записанный заново,
// заменяет прежний целиком.
// velocity — скорость в секунду, если известна.
interface TrackRecord extends TrackPoint {
  velocity?: Point;
}

function pointOf(record: TrackRecord): TrackPoint {
  return { id: record.id, owner: record.owner, x: record.x, y: record.y };
}

export class BulletTracks {
  private readonly byTick = new Map<number, Map<number, TrackRecord>>();
  private ticks: number[] = [];
  private readonly bornDead = new Map<number, number>();

  record(tick: number, bullets: Iterable<TrackPoint & { vx?: number; vy?: number }>): void {
    const points = new Map<number, TrackRecord>();
    for (const bullet of bullets) {
      const point: TrackRecord = { id: bullet.id, owner: bullet.owner, x: bullet.x, y: bullet.y };
      if (bullet.vx !== undefined && bullet.vy !== undefined) {
        point.velocity = { x: bullet.vx, y: bullet.vy };
      }
      points.set(bullet.id, point);
    }
    if (!this.byTick.has(tick)) {
      this.ticks.push(tick);
      this.ticks.sort((a, b) => a - b);
    }
    this.byTick.set(tick, points);
  }

  // Снаряд родился и погиб в одном шаге: в дорожке его нет, но тик гибели известен.
  markBornDead(id: number, tick: number): void {
    this.bornDead.set(id, tick);
  }

  lastTick(): number {
    return this.ticks.at(-1) ?? -Infinity;
  }

  forgetFrom(tick: number): void {
    this.keep((candidate) => candidate < tick);
  }

  forgetBefore(tick: number): void {
    this.keep((candidate) => candidate >= tick);
  }

  // Номера снарядов, живых хоть в одном тике отрезка.
  idsBetween(from: number, to: number): Set<number> {
    const ids = new Set<number>();
    for (const tick of this.ticks) {
      if (tick < Math.floor(from) || tick > Math.ceil(to)) {
        continue;
      }
      for (const id of this.byTick.get(tick)?.keys() ?? []) {
        ids.add(id);
      }
    }
    return ids;
  }

  // Место в дробном тике: между записанными тиками — линейно; в следующем тике снаряда нет — погиб, не рисуется;
  // в предыдущем нет — рисуется с места рождения.
  at(id: number, tick: number): TrackPoint | null {
    const [lower, upper] = this.bracket(tick);
    const a = lower === null ? undefined : this.byTick.get(lower)?.get(id);
    const b = upper === null ? undefined : this.byTick.get(upper)?.get(id);
    if (a === undefined || lower === null) {
      return b === undefined ? null : pointOf(b);
    }
    if (upper === null || upper === lower) {
      return pointOf(a);
    }
    if (b === undefined) {
      return null;
    }
    const t = (tick - lower) / (upper - lower);
    return { ...pointOf(b), x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
  }

  // Последнее место не позже тика и первое не раньше: по ним снаряд меряет расстояние до танков, даже если в самом
  // тике его уже или ещё нет.
  lastAt(id: number, tick: number): TrackPoint | null {
    for (let index = this.ticks.length - 1; index >= 0; index--) {
      const candidate = this.ticks[index] ?? 0;
      const point = candidate <= tick ? this.byTick.get(candidate)?.get(id) : undefined;
      if (point !== undefined) {
        return pointOf(point);
      }
    }
    return null;
  }

  // Первый записанный тик, где снаряда уже нет после тиков, где он был; родился и погиб в одном шаге — тик этого
  // шага; жив в последнем тике — null.
  deathTick(id: number): number | null {
    let isSeen = false;
    for (const tick of this.ticks) {
      if (this.byTick.get(tick)?.has(id) === true) {
        isSeen = true;
      } else if (isSeen) {
        return tick;
      }
    }
    return this.bornDead.get(id) ?? null;
  }

  // Место за последним записанным: снаряд продолжает его скоростью (нет её — ходом между двумя последними местами),
  // но не дальше limit тиков; продолжить нечем — null.
  ahead(id: number, tick: number, limit: number): Point | null {
    let later: { tick: number; point: TrackRecord } | null = null;
    for (let index = this.ticks.length - 1; index >= 0; index--) {
      const candidate = this.ticks[index] ?? 0;
      const point = candidate <= tick ? this.byTick.get(candidate)?.get(id) : undefined;
      if (point === undefined) {
        continue;
      }
      if (later === null) {
        if (tick - candidate > limit) {
          return null;
        }
        later = { tick: candidate, point };
        if (point.velocity !== undefined) {
          const seconds = (tick - candidate) * DT;
          return { x: point.x + point.velocity.x * seconds, y: point.y + point.velocity.y * seconds };
        }
        continue;
      }
      const t = (tick - later.tick) / (later.tick - candidate);
      return { x: later.point.x + (later.point.x - point.x) * t, y: later.point.y + (later.point.y - point.y) * t };
    }
    return null;
  }

  firstAt(id: number, tick: number): TrackPoint | null {
    for (const candidate of this.ticks) {
      const point = candidate >= tick ? this.byTick.get(candidate)?.get(id) : undefined;
      if (point !== undefined) {
        return pointOf(point);
      }
    }
    return null;
  }

  private bracket(tick: number): [number | null, number | null] {
    let lower: number | null = null;
    let upper: number | null = null;
    for (const candidate of this.ticks) {
      if (candidate <= tick) {
        lower = candidate;
      }
      if (candidate >= tick) {
        upper = candidate;
        break;
      }
    }
    return [lower, upper];
  }

  private keep(isKept: (tick: number) => boolean): void {
    for (const tick of this.ticks) {
      if (!isKept(tick)) {
        this.byTick.delete(tick);
      }
    }
    this.ticks = this.ticks.filter(isKept);
    for (const [id, tick] of this.bornDead) {
      if (!isKept(tick)) {
        this.bornDead.delete(id);
      }
    }
  }
}

// Свой снаряд на броне: x, y — где нарисован; tank — где нарисован танк, на броне которого он стоит; offset — место
// на броне от центра танка; heading — направление полёта в миг касания; deathTick — тик гибели снаряда, пропавшего из дорожек целиком: погибший в шаге рождения или
// погашенный сервером до первого снимка с ним — тогда это тик последнего пришедшего снимка.
interface Hold extends Point {
  tank: Point;
  offset: Point;
  sinceOthersTick: number;
  heading: Point;
  deathTick?: number;
}

// drawn — где снаряд нарисован; hold — свой снаряд стоит на броне нарисованного танка; isHoldOver — стоял и больше
// не встанет; lead — на сколько тиков свой снаряд рисуется впереди своего тика картинки.
interface ShownTime {
  tick: number;
  othersTick: number;
  drawn: Point | null;
  hold: Hold | null;
  isHoldOver: boolean;
  lead?: number;
}

interface Contact extends Point {
  tank: Point;
  heading: Point;
}

// Первая точка отрезка from → to на окружности радиуса HOLD_CONTACT вокруг танка; from уже внутри — ближайшая к
// нему точка окружности.
function contactOf(from: Point, to: Point, tanks: readonly Point[]): Contact | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const heading = directionOf(from, to);
  let best: { t: number; point: Point; tank: Point } | null = null;
  for (const tank of tanks) {
    const fx = from.x - tank.x;
    const fy = from.y - tank.y;
    const inside = Math.hypot(fx, fy);
    if (inside < HOLD_CONTACT) {
      const point = inside === 0 ? from : surfaceOf(from, tank);
      if (best === null || best.t > 0) {
        best = { t: 0, point, tank };
      }
      continue;
    }
    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - HOLD_CONTACT * HOLD_CONTACT;
    const discriminant = b * b - 4 * a * c;
    if (a === 0 || discriminant < 0) {
      continue;
    }
    const t = (-b - Math.sqrt(discriminant)) / (2 * a);
    if (t >= 0 && t <= 1 && (best === null || t < best.t)) {
      best = { t, point: { x: from.x + dx * t, y: from.y + dy * t }, tank };
    }
  }
  return best === null ? null : { ...best.point, tank: best.tank, heading };
}

function directionOf(from: Point, to: Point): Point {
  const length = distance(from, to);
  return length === 0 ? { x: 0, y: 0 } : { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}

function surfaceOf(point: Point, tank: Point): Point {
  const away = distance(point, tank);
  return {
    x: tank.x + ((point.x - tank.x) / away) * HOLD_CONTACT,
    y: tank.y + ((point.y - tank.y) / away) * HOLD_CONTACT,
  };
}

// Луч из точки по направлению проходит через окружность касания какого-нибудь танка впереди.
function isAimedAtTank(from: Point, heading: Point, tanks: readonly Point[]): boolean {
  return tanks.some((tank) => {
    const along = (tank.x - from.x) * heading.x + (tank.y - from.y) * heading.y;
    const across = Math.abs((tank.y - from.y) * heading.x - (tank.x - from.x) * heading.y);
    return across < HOLD_CONTACT && (along > 0 || distance(from, tank) < HOLD_CONTACT);
  });
}

// Тик картинки каждого снаряда: у своего танка — его тик, у чужих — их, между — по весу; растёт не медленнее
// PICTURE_MIN_TIME_RATE хода тика чужих и без верхнего ограничения — подлетая к своему танку, снаряд догоняет его
// время. Тик чужих стоит (снимки задержались) — не растёт и тик картинки. myOwner — владелец своих снарядов.
export class BulletPicture {
  private readonly shown = new Map<number, ShownTime>();

  constructor(
    private readonly tracks: BulletTracks,
    private readonly myOwner: number,
  ) {}

  // confirmedTick — тик последнего снимка: дорожка до него включительно — решение сервера.
  frame(clock: PictureClock, confirmedTick = Infinity): PictureBullet[] {
    const ids = this.tracks.idsBetween(clock.othersTick, clock.myTick);
    const bullets: PictureBullet[] = [];
    for (const id of ids) {
      const tick = this.tickOf(id, clock);
      const previous = this.shown.get(id);
      const track = this.tracks.at(id, tick);
      const isOwn = (this.tracks.lastAt(id, tick) ?? this.tracks.firstAt(id, tick))?.owner === this.myOwner;
      const shown =
        isOwn && previous?.isHoldOver !== true
          ? this.ownShown(id, tick, clock, confirmedTick, previous)
          : { drawn: track, hold: null, isHoldOver: previous?.isHoldOver ?? false };
      this.shown.set(id, { tick, othersTick: clock.othersTick, ...shown });
      if (shown.drawn !== null) {
        bullets.push({ id, owner: track?.owner ?? this.myOwner, x: shown.drawn.x, y: shown.drawn.y, tick });
      }
    }
    for (const [id, time] of this.shown) {
      if (ids.has(id)) {
        continue;
      }
      const hold = time.hold;
      const held =
        hold === null
          ? null
          : this.heldShown(id, time.tick, clock, confirmedTick, {
              ...hold,
              deathTick: hold.deathTick ?? this.tracks.deathTick(id) ?? confirmedTick,
            });
      const drawn = held?.drawn ?? null;
      if (held === null || drawn === null) {
        this.shown.delete(id);
        continue;
      }
      this.shown.set(id, { ...time, othersTick: clock.othersTick, ...held });
      bullets.push({ id, owner: this.myOwner, x: drawn.x, y: drawn.y, tick: time.tick });
    }
    return bullets;
  }

  // Свой выстрел подтверждён: снаряд продолжает в том же тике картинки под номером сервера.
  rename(fromId: number, toId: number): void {
    const time = this.shown.get(fromId);
    if (time === undefined) {
      return;
    }
    this.shown.delete(fromId);
    this.shown.set(toId, time);
  }

  // Расстояния до танков — от места, где снаряд нарисован сейчас; впервые показанный — от места в тике своего танка
  // и в тике чужих. Снаряд, который в выбранном тике оказался бы в зоне своего танка, рисуется в тике своего танка:
  // у своего танка картинка и сервер совпадают в каждом кадре.
  private tickOf(id: number, clock: PictureClock): number {
    const previous = this.shown.get(id);
    const drawn = previous === undefined ? null : (previous.drawn ?? this.tracks.at(id, previous.tick));
    const atMine = drawn ?? this.tracks.at(id, clock.myTick) ?? this.tracks.lastAt(id, clock.myTick);
    const atOthers = drawn ?? this.tracks.at(id, clock.othersTick) ?? this.tracks.firstAt(id, clock.othersTick);
    const toMe = clock.me === null || atMine === null ? Infinity : distance(atMine, clock.me);
    const toOther = atOthers === null ? Infinity : nearest(atOthers, clock.others);
    const target = tickFromWeight(clock, pictureWeight(toMe, toOther));
    const floor =
      previous === undefined
        ? target
        : previous.tick + PICTURE_MIN_TIME_RATE * Math.max(0, clock.othersTick - previous.othersTick);
    const tick = Math.min(clock.myTick, Math.max(target, floor));
    const point = this.tracks.at(id, tick);
    const isAtMine = clock.me !== null && point !== null && distance(point, clock.me) <= PICTURE_NEAR;
    return isAtMine ? clock.myTick : tick;
  }

  // Свой снаряд не заходит в нарисованный чужой танк: путь от прошлого места до нового, задевший броню, обрывается
  // на ней, и снаряд стоит там до вспышки; на подлёте рисуется впереди своей дорожки на запас. Погибший в дорожке
  // раньше брони на картинке летит дальше прежним ходом, если впереди танк; погибший в своём тике — только если
  // в прошлом кадре был виден.
  private ownShown(
    id: number,
    tick: number,
    clock: PictureClock,
    confirmedTick: number,
    previous: ShownTime | undefined,
  ): Omit<ShownTime, 'tick' | 'othersTick'> {
    const held = previous?.hold ?? null;
    if (held !== null) {
      return this.heldShown(id, tick, clock, confirmedTick, held);
    }
    const from = previous?.drawn ?? null;
    const death = this.tracks.deathTick(id);
    const lead = this.leadOf(id, tick, clock, previous);
    const reach = tick + lead;
    const track = reach <= this.tracks.lastTick() ? this.tracks.at(id, reach) : null;
    const canExtrapolate = (from !== null && death !== null) || lead > 0;
    const to = track ?? (canExtrapolate ? this.tracks.ahead(id, reach, HOLD_MAX_TICKS) : null);
    if (to === null) {
      return { drawn: null, hold: null, isHoldOver: false, lead };
    }
    const contact = contactOf(from ?? this.tracks.lastAt(id, tick) ?? to, to, clock.others);
    if (contact !== null) {
      const heading = contact.heading.x === 0 && contact.heading.y === 0 ? this.headingOf(id, tick) : contact.heading;
      const offset = { x: contact.x - contact.tank.x, y: contact.y - contact.tank.y };
      const hold = {
        x: contact.x,
        y: contact.y,
        tank: contact.tank,
        offset,
        sinceOthersTick: clock.othersTick,
        heading,
      };
      return this.heldShown(id, tick, clock, confirmedTick, hold);
    }
    if (track !== null || death === null) {
      return { drawn: to, hold: null, isHoldOver: false, lead };
    }
    const target = nearestPoint(to, clock.others);
    const isFlying =
      from !== null &&
      target !== null &&
      pictureTickAt(clock, target) <= death - 1 &&
      isAimedAtTank(to, directionOf(from, to), clock.others);
    return { drawn: isFlying ? to : null, hold: null, isHoldOver: false, lead };
  }

  // Снаряд, который за LEAD_LOOK_TICKS тиков своей дорожки коснётся нарисованного танка, набирает запас; иначе запас
  // сходит, и снаряд не идёт назад.
  private leadOf(id: number, tick: number, clock: PictureClock, previous: ShownTime | undefined): number {
    const was = previous?.lead ?? 0;
    const step = previous === undefined ? 0 : Math.max(0, tick - previous.tick);
    const now = this.tracks.at(id, tick) ?? this.tracks.lastAt(id, tick);
    const soon = this.tracks.ahead(id, tick + LEAD_LOOK_TICKS, Infinity);
    const isNearTank = now !== null && soon !== null && contactOf(now, soon, clock.others) !== null;
    if (!isNearTank) {
      return Math.max(0, was - PICTURE_MIN_TIME_RATE * step);
    }
    return Math.min(LEAD_TICKS, was + LEAD_RATE * step);
  }

  // Стоит на броне, пока картинка у танка не дойдёт до тика гибели снаряда — в том же кадре вспышка попадания, — но
  // не дольше предела ожидания. Танк едет — снаряд едет на его броне. Сервер решил «мимо» — снаряд летит дальше по
  // дорожке, как только место в ней не позади брони, и больше не встаёт.
  private heldShown(
    id: number,
    tick: number,
    clock: PictureClock,
    confirmedTick: number,
    hold: Hold,
  ): Omit<ShownTime, 'tick' | 'othersTick'> {
    const target = nearestPoint(hold.tank, clock.others);
    const death = hold.deathTick ?? this.tracks.deathTick(id);
    const isOver =
      target === null ||
      clock.othersTick - hold.sinceOthersTick >= HOLD_MAX_TICKS ||
      (death !== null && pictureTickAt(clock, target) > death - 1);
    if (isOver) {
      return { drawn: null, hold: null, isHoldOver: true };
    }
    const track = this.tracks.at(id, tick);
    const isAhead = track !== null && (track.x - hold.x) * hold.heading.x + (track.y - hold.y) * hold.heading.y >= 0;
    if (death === null && isAhead && this.isPassed(id, clock, confirmedTick, hold, target)) {
      return { drawn: track, hold: null, isHoldOver: true };
    }
    const at = { x: target.x + hold.offset.x, y: target.y + hold.offset.y };
    return { drawn: at, hold: { ...hold, ...at, tank: target }, isHoldOver: false };
  }

  // В подтверждённом тике сразу за картинкой танка снаряд жив, вне брони и по ходу полёта уже за центром танка.
  private isPassed(id: number, clock: PictureClock, confirmedTick: number, hold: Hold, target: Point): boolean {
    const tick = Math.ceil(clock.othersTick) + 1;
    const point = tick <= confirmedTick ? this.tracks.at(id, tick) : null;
    return (
      point !== null &&
      distance(point, target) > HOLD_CONTACT &&
      (point.x - target.x) * hold.heading.x + (point.y - target.y) * hold.heading.y > 0
    );
  }

  private headingOf(id: number, tick: number): Point {
    const now = this.tracks.ahead(id, tick, Infinity);
    const next = this.tracks.ahead(id, tick + 1, Infinity);
    return now === null || next === null ? { x: 0, y: 0 } : directionOf(now, next);
  }
}

// Где играется событие: на нарисованном танке (место в снимке события — от него переносится точка; о своём танке —
// сразу), в своей точке поля или сразу, если места у события нет.
export type EventPlace =
  { kind: 'tank'; id: number; x: number; y: number; isOwn: boolean } | { kind: 'point' } | { kind: 'now' };

export type PictureEventKind = SnapshotEventKind | FfaEventKind;

export interface DueEvent<E> {
  event: E;
  tick: number;
}

interface WaitingEvent<E> extends DueEvent<E> {
  place: EventPlace;
  addedAt: number;
}

// События снимка ждут, пока картинка в их месте дойдёт до их тика: тик места больше «тик − 1» — то же мгновение,
// когда снаряд пропадает с картинки, а интерполированный танк становится подбитым. Не дождавшееся за
// EVENT_MAX_WAIT_MS выбрасывается молча.
export class EventSchedule<E extends Point> {
  private waiting: WaitingEvent<E>[] = [];

  add(event: E, tick: number, place: EventPlace, now: number): void {
    this.waiting = this.waiting.filter((item) => !isExpired(item, now));
    this.waiting.push({ event, tick, place, addedAt: now });
  }

  // Пришедшие события по порядку прихода; точка события о танке перенесена на нарисованный танк.
  release(clock: PictureClock, drawnTank: (id: number) => Point | null, now: number): DueEvent<E>[] {
    const due: DueEvent<E>[] = [];
    const rest: WaitingEvent<E>[] = [];
    for (const item of this.waiting) {
      if (isExpired(item, now)) {
        continue;
      }
      const drawn = item.place.kind === 'tank' ? drawnTank(item.place.id) : null;
      if (!this.isDue(item, clock, drawn)) {
        rest.push(item);
        continue;
      }
      due.push({ event: this.moved(item, drawn), tick: item.tick });
    }
    this.waiting = rest;
    return due;
  }

  clear(): void {
    this.waiting = [];
  }

  private isDue(item: WaitingEvent<E>, clock: PictureClock, drawn: Point | null): boolean {
    const { place } = item;
    if (place.kind === 'now' || (place.kind === 'tank' && place.isOwn)) {
      return true;
    }
    return pictureTickAt(clock, drawn ?? item.event) > item.tick - 1;
  }

  private moved(item: WaitingEvent<E>, drawn: Point | null): E {
    const { place, event } = item;
    if (place.kind !== 'tank' || drawn === null) {
      return event;
    }
    return { ...event, x: event.x + drawn.x - place.x, y: event.y + drawn.y - place.y };
  }
}

function isExpired(item: WaitingEvent<unknown>, now: number): boolean {
  return now - item.addedAt >= EVENT_MAX_WAIT_MS;
}

const TANK_EVENT_KINDS: ReadonlySet<PictureEventKind> = new Set(['shot', 'hit', 'shield', 'death']);
const PLACELESS_EVENT_KINDS: ReadonlySet<PictureEventKind> = new Set([
  'zoneStart',
  'suddenDeath',
  'matchOver',
  'roundOver',
]);

// Место события по виду: выстрел, попадание, щит и гибель — о танке (его место в снимке события), события без
// координат — сразу, остальные — в своей точке. ownId — номер своего танка, null — зритель.
export function eventPlace(
  kind: PictureEventKind,
  tank: (Point & { id: number }) | null,
  ownId: number | null,
): EventPlace {
  if (PLACELESS_EVENT_KINDS.has(kind)) {
    return { kind: 'now' };
  }
  if (TANK_EVENT_KINDS.has(kind) && tank !== null) {
    return { kind: 'tank', id: tank.id, x: tank.x, y: tank.y, isOwn: tank.id === ownId };
  }
  return { kind: 'point' };
}

// latestTick — тик последнего пришедшего снимка: досчитанное после него сервер ещё не подтвердил.
export interface PictureDebug {
  myTick: number;
  othersTick: number;
  latestTick: number;
  me: Point | null;
  others: Point[];
  bullets: PictureBullet[];
}

// Нарисованный кадр для сквозной сверки с сервером.
export function pictureDebug(clock: PictureClock, latestTick: number, bullets: readonly PictureBullet[]): PictureDebug {
  return {
    myTick: clock.myTick,
    othersTick: clock.othersTick,
    latestTick,
    me: clock.me === null ? null : { x: clock.me.x, y: clock.me.y },
    others: clock.others.map((other) => ({ x: other.x, y: other.y })),
    bullets: bullets.map((bullet) => ({ ...bullet })),
  };
}
