import {
  BULLET_RADIUS,
  deriveStats,
  DT,
  flyBullets,
  STAT_MAX,
  TANK_RADIUS,
  type Point,
  type World,
} from '@tanks/shared/engine';
import type { FfaEventKind, SnapshotEventKind } from '@tanks/shared/protocol';

// Зона «у танка»: ближе к своему танку снаряд рисуется в его времени, ближе к чужому — во времени чужого.
export const PICTURE_NEAR = TANK_RADIUS * 2.5;
// Свой снаряд сходит ко времени чужих, когда до зоны чужого танка самое быстрое сближение займёт меньше стольких
// разрывов между временами: снаряд теряет разрыв, замедляясь не больше чем на треть, и входит в зону в её времени.
export const PICTURE_APPROACH_SPAN = 3;
const TANK_SPEED_MAX = deriveStats({ armor: 0, engine: STAT_MAX, gun: 0, reload: 0 }).maxSpeed;
// Тик картинки снаряда растёт не медленнее этой доли хода тика чужих: улетающий от своего танка снаряд замедляется,
// но назад не летит и не зависает.
export const PICTURE_MIN_TIME_RATE = 0.5;
// Свой танк вернулся на поле: тик своего танка на картинке догоняет тик предсказания, идя во столько раз быстрее
// тика чужих.
export const PICTURE_CATCH_UP_RATE = 2;
// Свой снаряд, летящий к своему танку, догоняет его время на столько тиков пути раньше: догон идёт кадрами, и без
// запаса снаряд входит в зону своего танка с отставанием в шаг кадра.
const RETURN_MARGIN_TICKS = 1;
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
export const PICTURE_LEAD_RATE = 2;
// Танк, на броне которого стоит свой снаряд, — ближайший к его прошлому месту не дальше радиуса танка: дальше
// ближайшим может оказаться соседний — корпуса не перекрываются. Нет такого — танк пропал с картинки или прыгнул,
// снаряд пропадает.
const HOLD_TANK_REACH = TANK_RADIUS;
// Место ухода с брони ищется делением отрезка тиков пополам до этой точности в тиках и не раньше стольких тиков до
// тика снаряда в миг касания: касание находится и на пути с запасом подлёта впереди тика снаряда, а дальше назад
// дорожка до отскока бывает впереди брони.
const RELEASE_TICK_PRECISION = 1e-3;
// Шаг, которым дорожка за местом на броне проверяется на заход в окружность касания: задевший её короче шага
// снаряд — не дальше пары единиц от окружности.
const RELEASE_SCAN_TICKS = 0.05;
// Место ухода с брони дальше окружности касания хотя бы на столько: на самой окружности снаряд неотличим от стоящего
// на броне.
const RELEASE_CLEARANCE = 0.01;
const RELEASE_LOOK_BACK_TICKS = LEAD_TICKS + 1;

// Два времени кадра: myTick — тик своего танка (предсказание), othersTick — дробный тик чужих танков
// (интерполяция снимков). me — свой танк предсказания в myTick, null — его нет на поле; others — живые чужие
// в othersTick; ownShift — смещение нарисованного своего танка от предсказанного, нет — ноль.
export interface PictureClock {
  myTick: number;
  othersTick: number;
  me: Point | null;
  others: readonly Point[];
  ownShift?: Point;
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

// Через сколько тиков снаряд на пути path (path[k] — место через k тиков) может оказаться в зоне «у танка» tank,
// если тот поедет ему навстречу по tankStep за тик; между тиками пути — линейно. Путь кончился раньше —
// бесконечность.
function ticksToZone(path: readonly Point[], tank: Point, tankStep = TANK_SPEED_MAX * DT): number {
  let previous = Infinity;
  for (const [ticks, point] of path.entries()) {
    const slack = distance(point, tank) - PICTURE_NEAR - tankStep * ticks;
    if (slack <= 0) {
      return ticks === 0 ? 0 : ticks - 1 + previous / (previous - slack);
    }
    previous = slack;
  }
  return Infinity;
}

// Доля пути своего снаряда от времени чужих к своему: 1 — у своего танка и пока снаряд не подлетает к чужому, к зоне
// чужого убывает до 0. У своего танка отставание во времени не больше, чем снаряд пролетает от края его зоны, и не
// больше половины тиков, за которые летящий к своему танку снаряд долетит до его зоны, если танк поедет навстречу:
// догоняя, снаряд сокращает отставание на тик за тик хода чужих, а путь до зоны — на два. Иначе отставший снаряд
// оказывается в зоне своего танка и прыгает в его тик. Рядом и чужой, и свой — время своего. path — будущий путь
// снаряда по тикам от места в тике картинки, me — свой танк, gapTicks — разрыв между временами.
export function ownBulletWeight(
  path: readonly Point[],
  me: Point | null,
  others: readonly Point[],
  gapTicks: number,
): number {
  const [start, next] = path;
  const toMe = me === null || start === undefined ? Infinity : distance(start, me);
  if (start === undefined || gapTicks <= 0 || toMe <= PICTURE_NEAR) {
    return 1;
  }
  const span = PICTURE_APPROACH_SPAN * gapTicks;
  let weight = 1;
  for (const other of others) {
    weight = Math.min(weight, ticksToZone(path, other) / span);
  }
  if (me === null) {
    return weight;
  }
  const step = next === undefined ? 0 : distance(start, next);
  const behind = step === 0 ? 0 : 1 - (toMe - PICTURE_NEAR) / (step * gapTicks);
  const returning = 1 - (ticksToZone(path, me) - RETURN_MARGIN_TICKS) / (PICTURE_CATCH_UP_RATE * gapTicks);
  return Math.min(1, Math.max(weight, behind, returning));
}

// Подтверждённый тик сразу за картинкой чужих танков: по нему решается, что свой снаряд на броне прошёл мимо.
function passedTickOf(clock: PictureClock): number {
  return Math.ceil(clock.othersTick) + 1;
}

function tickFromWeight(clock: PictureClock, weight: number): number {
  return clock.othersTick + weight * (clock.myTick - clock.othersTick);
}

// Тик картинки в точке поля: тем же весом, что у снаряда.
export function pictureTickAt(clock: PictureClock, point: Point): number {
  const toMe = clock.me === null ? Infinity : distance(point, clock.me);
  return tickFromWeight(clock, pictureWeight(toMe, nearest(point, clock.others)));
}

// Точка поля на экране: у своего танка сдвинута вместе с нарисованным танком — на смещение, умноженное на вес
// «у своего танка»; у чужого не сдвигается.
export function drawnNearOwn<P extends Point>(clock: PictureClock, point: P): P {
  const { me, ownShift } = clock;
  const isShifted = ownShift !== undefined && (ownShift.x !== 0 || ownShift.y !== 0);
  if (me === null || !isShifted) {
    return point;
  }
  const weight = pictureWeight(distance(point, me), nearest(point, clock.others));
  return { ...point, x: point.x + ownShift.x * weight, y: point.y + ownShift.y * weight };
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

  clear(): void {
    this.keep(() => false);
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

  // Первый записанный тик со снарядом; нет такого — null.
  firstTick(id: number): number | null {
    return this.ticks.find((tick) => this.byTick.get(tick)?.has(id) === true) ?? null;
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

// Тик, до которого нужен будущий путь своих снарядов: окно подлёта от тика своего танка.
export function flightEndTick(clock: PictureClock): number {
  return Math.ceil(clock.myTick + PICTURE_APPROACH_SPAN * Math.max(0, clock.myTick - clock.othersTick)) + 1;
}

// Будущий путь своих снарядов: из тика поля они летят дальше по правилам движка без танков до тика endTick — с
// отскоками от стен и гибелью о стену, которых ещё нет в дорожке.
export function recordFlight(flight: BulletTracks, world: World, owner: number, endTick: number): void {
  flight.clear();
  const own = world.bullets.filter((bullet) => bullet.owner === owner).map((bullet) => ({ ...bullet }));
  const ahead: World = { ...world, tanks: [], bullets: own };
  flight.record(ahead.tick, ahead.bullets);
  while (ahead.tick < endTick && ahead.bullets.length > 0) {
    flyBullets(ahead);
    flight.record(ahead.tick, ahead.bullets);
  }
}

// Свой снаряд на броне: x, y — где нарисован; tank — где нарисован танк, на броне которого он стоит; offset — место
// на броне от центра танка; sinceTick — тик картинки снаряда в миг касания; heading — направление полёта в миг
// касания; deathTick — тик гибели снаряда, пропавшего из дорожек целиком: погибший в шаге рождения или
// погашенный сервером до первого снимка с ним — тогда это тик последнего пришедшего снимка.
interface Hold extends Point {
  tank: Point;
  offset: Point;
  sinceOthersTick: number;
  sinceTick: number;
  heading: Point;
  deathTick?: number;
}

// drawn — где снаряд нарисован; hold — свой снаряд стоит на броне нарисованного танка; isHoldOver — стоял, а танк
// пропал или снаряд дождался гибели, и больше не встанет; overDeath — тик гибели, которой снаряд дождался на броне:
// досчёт своего танка переиграл её, и снаряд снова жив или гибнет позже — он снова встаёт на броню; isReleased — свой
// снаряд уходил с брони «мимо»; lead — на сколько тиков свой снаряд рисуется впереди своего тика картинки.
interface ShownTime {
  tick: number;
  myTick: number;
  othersTick: number;
  drawn: Point | null;
  hold: Hold | null;
  isHoldOver: boolean;
  overDeath?: number | undefined;
  isReleased: boolean;
  lead?: number;
}

// Как снаряд показан в кадре; releaseTick — снаряд ушёл с брони, и его тик картинки переставлен сюда.
type Shown = Omit<ShownTime, 'tick' | 'myTick' | 'othersTick' | 'isReleased'> & { releaseTick?: number };

// Чем кончилось стояние своего снаряда на броне: boom — картинка дошла до его гибели, вспышка, или танк под ним
// пропал с картинки вместе с ним (подбит этим снарядом); miss — сервер решил «мимо», снаряд ушёл с брони; lost — танк
// под ним пропал с картинки, а снаряд жив; timeout — предел ожидания.
export type HoldOutcome = 'boom' | 'miss' | 'lost' | 'timeout';

// ticks — сколько тиков чужих снаряд простоял на броне.
export interface HoldEnd {
  id: number;
  ticks: number;
  outcome: HoldOutcome;
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

// Насколько точка впереди места на броне по направлению полёта в миг касания.
function alongHeading(point: Point, hold: Hold): number {
  return (point.x - hold.x) * hold.heading.x + (point.y - hold.y) * hold.heading.y;
}

// Луч из точки по направлению проходит через окружность касания какого-нибудь танка впереди.
function isAimedAtTank(from: Point, heading: Point, tanks: readonly Point[]): boolean {
  return tanks.some((tank) => {
    const along = (tank.x - from.x) * heading.x + (tank.y - from.y) * heading.y;
    const across = Math.abs((tank.y - from.y) * heading.x - (tank.x - from.x) * heading.y);
    return across < HOLD_CONTACT && (along > 0 || distance(from, tank) < HOLD_CONTACT);
  });
}

// Тик картинки каждого снаряда: у своего танка — его тик, у чужих — их, между — по весу; свой снаряд — во времени
// своего танка, пока не подлетает к чужому. Растёт не медленнее PICTURE_MIN_TIME_RATE хода тика чужих; чужой снаряд —
// без верхнего ограничения: подлетая к своему танку, он догоняет его время; свой вне зоны своего танка растёт не
// быстрее тика своего танка и сокращает отставание от него не быстрее хода тика чужих — пролетев мимо чужого или
// потеряв его из виду, догоняет своё время вдвое быстрее хода чужих, а не прыгает.
// Тик чужих стоит (снимки задержались) — не растёт и тик картинки. myOwner — владелец своих снарядов; flight —
// будущий путь своих снарядов за дорожкой (`recordFlight`), нет в нём снаряда — прямо прежним ходом.
export class BulletPicture {
  private readonly shown = new Map<number, ShownTime>();
  private holdEnds: HoldEnd[] = [];

  constructor(
    private readonly tracks: BulletTracks,
    private readonly myOwner: number,
    private readonly flight = new BulletTracks(),
  ) {}

  // confirmedTick — тик последнего снимка: дорожка до него включительно — решение сервера.
  frame(clock: PictureClock, confirmedTick = Infinity): PictureBullet[] {
    const ids = this.tracks.idsBetween(clock.othersTick, clock.myTick);
    const bullets: PictureBullet[] = [];
    for (const id of ids) {
      const owner = (this.tracks.lastAt(id, clock.myTick) ?? this.tracks.firstAt(id, clock.othersTick))?.owner;
      const isOwn = owner === this.myOwner;
      const tick = this.tickOf(id, clock, isOwn);
      const previous = this.revived(id, this.shown.get(id));
      const track = this.tracks.at(id, tick);
      const { releaseTick, ...shown }: Shown =
        isOwn && previous?.isHoldOver !== true
          ? this.ownShown(id, tick, clock, confirmedTick, previous)
          : {
              drawn: track,
              hold: null,
              isHoldOver: previous?.isHoldOver ?? false,
              overDeath: previous?.overDeath,
            };
      const shownTick = releaseTick ?? tick;
      this.shown.set(id, {
        tick: shownTick,
        myTick: clock.myTick,
        othersTick: clock.othersTick,
        ...shown,
        isReleased: releaseTick !== undefined || previous?.isReleased === true,
      });
      if (shown.drawn !== null) {
        const owner = track?.owner ?? this.myOwner;
        bullets.push({ id, owner, x: shown.drawn.x, y: shown.drawn.y, tick: shownTick });
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
      const isReleased = time.isReleased || held.releaseTick !== undefined;
      this.shown.set(id, { ...time, myTick: clock.myTick, othersTick: clock.othersTick, ...held, isReleased });
      bullets.push({ id, owner: this.myOwner, x: drawn.x, y: drawn.y, tick: time.tick });
    }
    return bullets;
  }

  // Гибель, которой снаряд дождался на броне, досчёт переиграл: снаряд снова сам по себе, как отпущенный «мимо».
  private revived(id: number, previous: ShownTime | undefined): ShownTime | undefined {
    if (previous?.overDeath === undefined) {
      return previous;
    }
    const death = this.tracks.deathTick(id);
    if (death !== null && death <= previous.overDeath) {
      return previous;
    }
    return { ...previous, isHoldOver: false, overDeath: undefined, isReleased: true };
  }

  // Стояния на броне, кончившиеся с прошлого вызова.
  takeHoldEnds(): HoldEnd[] {
    const ends = this.holdEnds;
    this.holdEnds = [];
    return ends;
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
  // и в тике чужих (свой — от места в тике своего танка). Снаряд, который в выбранном тике оказался бы в зоне своего
  // танка, рисуется в тике своего танка: у своего танка картинка и сервер совпадают в каждом кадре. Свой снаряд на
  // броне — во времени места, как чужой: его время не уходит от времени танка под ним, и, отпущенный «мимо», он
  // догоняет своё время, а не прыгает, — и в зоне своего танка, когда враг вплотную.
  private tickOf(id: number, clock: PictureClock, isOwn: boolean): number {
    const previous = this.shown.get(id);
    const drawn = previous === undefined ? null : (previous.drawn ?? this.tracks.at(id, previous.tick));
    const atMine = drawn ?? this.tracks.at(id, clock.myTick) ?? this.tracks.lastAt(id, clock.myTick);
    const atOthers = drawn ?? this.tracks.at(id, clock.othersTick) ?? this.tracks.firstAt(id, clock.othersTick);
    const toMe = clock.me === null || atMine === null ? Infinity : distance(atMine, clock.me);
    const toOther = atOthers === null ? Infinity : nearest(atOthers, clock.others);
    const gap = clock.myTick - clock.othersTick;
    const drawnTick = previous === undefined ? clock.myTick : previous.tick + (previous.lead ?? 0);
    const isFlyingOwn = isOwn && atMine !== null && (previous?.hold ?? null) === null;
    const weight = isFlyingOwn
      ? ownBulletWeight(this.pathOf(id, drawnTick, atMine, gap), clock.me, clock.others, gap)
      : pictureWeight(toMe, toOther);
    const target = tickFromWeight(clock, weight);
    if (previous === undefined) {
      return this.atMineOr(id, clock, Math.min(clock.myTick, target));
    }
    const othersStep = Math.max(0, clock.othersTick - previous.othersTick);
    const floor = previous.tick + PICTURE_MIN_TIME_RATE * othersStep;
    const ceiling = isOwn
      ? previous.tick + Math.max(0, clock.myTick - previous.myTick) + (PICTURE_CATCH_UP_RATE - 1) * othersStep
      : Infinity;
    const tick = Math.min(clock.myTick, ceiling, Math.max(target, floor));
    const isOffArmor = previous.isHoldOver || previous.isReleased;
    return isOwn && isOffArmor ? tick : this.atMineOr(id, clock, tick);
  }

  private atMineOr(id: number, clock: PictureClock, tick: number): number {
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
  ): Shown {
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
        sinceTick: tick,
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
    return Math.min(LEAD_TICKS, was + PICTURE_LEAD_RATE * step);
  }

  // Стоит на броне, пока картинка у танка не дойдёт до тика гибели снаряда — в том же кадре вспышка попадания, — но
  // не дольше предела ожидания. Танк едет — снаряд едет на его броне; танк пропал — пропадает и снаряд. Сервер решил
  // «мимо» — снаряд уходит с брони по дорожке, как только место в ней не позади брони; дорожка повернула назад, не
  // пройдя танк (отскок у самой брони), — как только снаряд в ней удаляется от танка.
  private heldShown(id: number, tick: number, clock: PictureClock, confirmedTick: number, hold: Hold): Shown {
    const end = (outcome: HoldOutcome, shown: Shown): Shown => {
      this.holdEnds.push({ id, ticks: clock.othersTick - hold.sinceOthersTick, outcome });
      return shown;
    };
    const target = nearestPoint(hold.tank, clock.others);
    const death = hold.deathTick ?? this.tracks.deathTick(id);
    if (target === null || distance(target, hold.tank) > HOLD_TANK_REACH) {
      return end(death === null ? 'lost' : 'boom', { drawn: null, hold: null, isHoldOver: true });
    }
    if (death !== null && pictureTickAt(clock, target) > death - 1) {
      return end('boom', { drawn: null, hold: null, isHoldOver: true, overDeath: death });
    }
    const track = this.tracks.at(id, tick);
    const isAhead = track !== null && alongHeading(track, hold) >= 0;
    const passedTick = Math.min(clock.myTick, passedTickOf(clock));
    if (death === null && isAhead && this.isPassed(id, clock, confirmedTick, hold, target)) {
      const releaseTick = this.releaseTick(id, hold, tick, target, passedTick);
      const drawn = this.tracks.at(id, releaseTick) ?? track;
      return end('miss', { drawn, hold: null, isHoldOver: false, releaseTick });
    }
    if (death === null && this.isLeaving(id, clock, confirmedTick, target)) {
      const leaveTick = this.leaveTick(id, target, Math.max(tick, passedTick));
      if (tick >= leaveTick) {
        const drawn = this.tracks.at(id, leaveTick);
        return end('miss', { drawn, hold: null, isHoldOver: false, releaseTick: leaveTick });
      }
    }
    if (clock.othersTick - hold.sinceOthersTick >= HOLD_MAX_TICKS) {
      return end('timeout', { drawn: null, hold: null, isHoldOver: true });
    }
    const at = { x: target.x + hold.offset.x, y: target.y + hold.offset.y };
    return { drawn: at, hold: { ...hold, ...at, tank: target }, isHoldOver: false };
  }

  // Тик, откуда снаряд уходит с брони: где дорожка, пройдя место на броне, в последний раз выходит из окружности
  // касания танка target, — снаряд не проходит сквозь нарисованный танк: на картинке это попадание без урона.
  // Танк, увёзший снаряд вбок, дорожка задевает и после места на броне. passedTick — тик, где дорожка уже за танком:
  // поиск идёт от него, если в тике снаряда дорожка внутри окружности касания.
  private releaseTick(id: number, hold: Hold, tick: number, target: Point, passedTick: number): number {
    const isOutsideAt = (at: number): boolean => {
      const point = this.tracks.at(id, at);
      return point !== null && distance(point, target) > HOLD_CONTACT + RELEASE_CLEARANCE;
    };
    const crossing = this.crossingTick(id, hold, tick);
    const latest = Math.max(tick, passedTick);
    let outside = isOutsideAt(latest) ? latest : passedTick;
    if (!isOutsideAt(outside)) {
      return outside;
    }
    let inside = outside - RELEASE_SCAN_TICKS;
    while (inside > crossing && isOutsideAt(inside)) {
      outside = inside;
      inside -= RELEASE_SCAN_TICKS;
    }
    if (inside <= crossing && isOutsideAt(crossing)) {
      return crossing;
    }
    inside = Math.max(inside, crossing);
    while (outside - inside > RELEASE_TICK_PRECISION) {
      const middle = (inside + outside) / 2;
      if (isOutsideAt(middle)) {
        outside = middle;
      } else {
        inside = middle;
      }
    }
    return outside;
  }

  // Последний тик не позже tick, где дорожка доходит до места на броне по ходу полёта, а не место дорожки в своём
  // тике, которое за время на броне ушло вперёд. Поиск идёт назад от tick не дальше тиков, на которые танк отвёз место
  // на броне назад от касания: до отскока дорожка тоже бывает впереди брони.
  private crossingTick(id: number, hold: Hold, tick: number): number {
    const isAheadAt = (at: number): boolean => {
      const point = this.tracks.at(id, at);
      return point !== null && alongHeading(point, hold) >= 0;
    };
    const touch = this.tracks.at(id, hold.sinceTick);
    const next = this.tracks.at(id, hold.sinceTick + 1);
    const step = touch === null || next === null ? 0 : distance(touch, next);
    const dragged = touch === null || step === 0 ? 0 : Math.max(0, alongHeading(touch, hold)) / step;
    const lookBack = RELEASE_LOOK_BACK_TICKS + Math.ceil(dragged);
    const earliest = Math.max(hold.sinceTick - lookBack, this.tracks.firstTick(id) ?? tick);
    let ahead = tick;
    let behind = Math.max(earliest, tick - 1);
    while (behind > earliest && isAheadAt(behind)) {
      ahead = behind;
      behind = Math.max(earliest, behind - 1);
    }
    if (isAheadAt(behind)) {
      return behind;
    }
    while (ahead - behind > RELEASE_TICK_PRECISION) {
      const middle = (behind + ahead) / 2;
      if (isAheadAt(middle)) {
        ahead = middle;
      } else {
        behind = middle;
      }
    }
    return ahead;
  }

  // Самый ранний тик не позже latest, с которого дорожка вне окружности касания танка target и только удаляется от
  // него: там снаряд, повернувший у брони назад, с неё уходит.
  private leaveTick(id: number, target: Point, latest: number): number {
    const distanceAt = (at: number): number => {
      const point = this.tracks.at(id, at);
      return point === null ? -Infinity : distance(point, target);
    };
    let leave = latest;
    let earlier = leave - RELEASE_SCAN_TICKS;
    while (distanceAt(earlier) > HOLD_CONTACT + RELEASE_CLEARANCE && distanceAt(earlier) < distanceAt(leave)) {
      leave = earlier;
      earlier -= RELEASE_SCAN_TICKS;
    }
    return leave;
  }

  // В подтверждённом тике сразу за картинкой танка снаряд жив, вне брони и удаляется от танка.
  private isLeaving(id: number, clock: PictureClock, confirmedTick: number, target: Point): boolean {
    const tick = passedTickOf(clock);
    const point = tick <= confirmedTick ? this.tracks.at(id, tick) : null;
    const before = this.tracks.at(id, tick - RELEASE_SCAN_TICKS);
    return (
      point !== null &&
      before !== null &&
      distance(point, target) > HOLD_CONTACT + RELEASE_CLEARANCE &&
      distance(point, target) > distance(before, target)
    );
  }

  // В подтверждённом тике сразу за картинкой танка снаряд жив, вне брони и по ходу полёта уже за центром танка.
  private isPassed(id: number, clock: PictureClock, confirmedTick: number, hold: Hold, target: Point): boolean {
    const tick = passedTickOf(clock);
    const point = tick <= confirmedTick ? this.tracks.at(id, tick) : null;
    return (
      point !== null &&
      distance(point, target) > HOLD_CONTACT &&
      (point.x - target.x) * hold.heading.x + (point.y - target.y) * hold.heading.y > 0
    );
  }

  private headingOf(id: number, tick: number): Point {
    const now = this.tracks.at(id, tick) ?? this.tracks.ahead(id, tick, Infinity);
    const next = this.tracks.at(id, tick + 1) ?? this.tracks.ahead(id, tick + 1, Infinity);
    return now === null || next === null ? { x: 0, y: 0 } : directionOf(now, next);
  }

  // Путь снаряда по тикам на окно подлёта вперёд от места start в тике картинки: дорожка, за ней — будущий путь;
  // снаряд погиб — путь кончается. Снаряд родился позже тика картинки — путь от рождения: свой танк, вернувшись на
  // поле, догоняет время предсказания, и свой выстрел рождается впереди его тика на картинке.
  private pathOf(id: number, tick: number, start: Point, gapTicks: number): Point[] {
    const from = Math.max(tick, this.tracks.firstTick(id) ?? tick);
    const path = [start];
    for (let ticks = 1; ticks <= PICTURE_APPROACH_SPAN * gapTicks; ticks++) {
      const at = from + ticks;
      const point = at <= this.tracks.lastTick() ? this.tracks.at(id, at) : this.beyondTrack(id, at);
      if (point === null) {
        break;
      }
      path.push(point);
    }
    return path;
  }

  private beyondTrack(id: number, tick: number): Point | null {
    if (this.flight.firstTick(id) === null) {
      return this.tracks.ahead(id, tick, Infinity);
    }
    const last = this.flight.lastTick();
    if (tick <= last) {
      return this.flight.at(id, tick);
    }
    return this.flight.at(id, last) === null ? null : this.flight.ahead(id, tick, Infinity);
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

  // Пришедшие события по порядку прихода; точка события о танке перенесена на нарисованный танк, точка события
  // в поле сдвинута у своего танка, как снаряд.
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
      due.push({ event: this.moved(item, clock, drawn), tick: item.tick });
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

  private moved(item: WaitingEvent<E>, clock: PictureClock, drawn: Point | null): E {
    const { place, event } = item;
    if (place.kind === 'point') {
      return drawnNearOwn(clock, event);
    }
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

// latestTick — тик последнего пришедшего снимка: досчитанное после него сервер ещё не подтвердил. me — нарисованный
// свой танк, ownShift — его смещение от предсказанного.
export interface PictureDebug {
  myTick: number;
  othersTick: number;
  latestTick: number;
  me: Point | null;
  ownShift: Point;
  others: Point[];
  bullets: PictureBullet[];
}

// Нарисованный кадр для сквозной сверки с сервером.
export function pictureDebug(clock: PictureClock, latestTick: number, bullets: readonly PictureBullet[]): PictureDebug {
  const shift = clock.ownShift ?? { x: 0, y: 0 };
  return {
    myTick: clock.myTick,
    othersTick: clock.othersTick,
    latestTick,
    me: clock.me === null ? null : { x: clock.me.x + shift.x, y: clock.me.y + shift.y },
    ownShift: { x: shift.x, y: shift.y },
    others: clock.others.map((other) => ({ x: other.x, y: other.y })),
    bullets: bullets.map((bullet) => ({ ...bullet })),
  };
}
