import {
  BULLET_RADIUS,
  createWorld,
  deriveStats,
  DT,
  flyBullets,
  IDLE_ACTION,
  makeTank,
  normalizeAngle,
  stepWorld,
  TANK_RADIUS,
  zoneRadiusAt,
  type Action,
  type Bullet,
  type FfaMap,
  type Kit,
  type RoundRules,
  type Stats,
  type Tank,
  type World,
  type ZonePlan,
} from '@tanks/shared/engine';
import {
  BulletMirror,
  type FfaBulletSnapshot,
  type FfaSnapshotMessage,
  type FfaTankSnapshot,
} from '@tanks/shared/protocol';
import { BulletPicture, BulletTracks, OwnTime, type PictureBullet, type PictureClock } from '../pictureTime.js';
import { PredictedShots, predictedBulletId, type ConfirmedBullet } from '../predictedShots.js';

// Отставание картинки чужих — два тика; буфер — секунда снимков, как у дуэли.
const INTERPOLATION_DELAY_MS = 2 * DT * 1000;
const SNAPSHOT_BUFFER_MS = 1000;
const SNAPSHOT_BUFFER_TICKS = Math.ceil(SNAPSHOT_BUFFER_MS / (DT * 1000));
const APPEAR_MS = 150;
const VANISH_MS = 200;
// Скачок дальше этого между соседними снимками — перестановка, а не езда: не растягивается.
const JUMP_LIMIT = 200;
// Запас радиуса переигрывания на расталкивание танков при столкновениях.
const REPLAY_MARGIN = TANK_RADIUS;

// presence — насколько танк проявился: 0 — не виден, 1 — виден целиком.
export interface FfaViewTank {
  id: number;
  x: number;
  y: number;
  heading: number;
  turret: number;
  speed: number;
  hp: number;
  maxHp: number;
  isAlive: boolean;
  shieldLeft: number;
  presence: number;
}

export type FfaViewBullet = PictureBullet;

// Снаряд кадра несёт свой тик картинки; clock — тики своего танка и чужих.
export interface FfaFrameView {
  tanks: FfaViewTank[];
  bullets: FfaViewBullet[];
  kits: readonly Kit[];
  zoneRadius: number;
  clock: PictureClock;
}

export interface FfaTankSetup {
  name: string;
  stats: Stats;
}

interface PendingInput {
  seq: number;
  action: Action;
}

interface BufferedSnapshot {
  receivedAt: number;
  tick: number;
  order: number[];
  tanks: Map<number, FfaTankSnapshot>;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  return normalizeAngle(a + normalizeAngle(b - a) * t);
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function applyTank(target: Tank, source: FfaTankSnapshot): void {
  target.x = source.x;
  target.y = source.y;
  target.heading = source.heading;
  target.turret = source.turret;
  target.speed = source.speed;
  target.hp = source.hp;
  target.reloadLeft = source.reloadLeft;
  target.isAlive = source.isAlive;
  target.shieldLeft = source.shieldLeft;
}

// Своё предсказание среди N танков и картинка чужих. Поле предсказания — копия серверного поля из последнего
// снимка: танки ровно снимка и в его порядке (столкновения и выстрелы движок обходит по порядку), снаряды — копии
// зеркала. Свой танк переигрывается неподтверждёнными командами, чужие без команды тормозят со скорости снимка.
// Переигрывается только то, что за окно переигрывания может дотянуться до своего танка, и свои снаряды; остальные
// снаряды летят без танков — все снаряды поля стоят в тике своего танка. Чужие танки — интерполяция по номерам между
// двумя снимками с отставанием на два тика; снаряды — во времени того, рядом с чем летят.
export class FfaPrediction {
  private readonly world: World;
  private readonly mirror: BulletMirror;
  private readonly tracks = new BulletTracks();
  private readonly picture: BulletPicture;
  private readonly ownTime = new OwnTime();
  private readonly shots = new PredictedShots();
  private pending: PendingInput[] = [];
  private confirmed: ConfirmedBullet[] = [];
  private buffer: BufferedSnapshot[] = [];
  private readonly appearedAt = new Map<number, number>();
  private readonly vanishedAt = new Map<number, number>();
  private readonly lastSeen = new Map<number, Omit<FfaViewTank, 'presence'>>();
  private isMatchOver = false;
  lastCorrectionPx = 0;
  latestTick = 0;

  constructor(
    map: FfaMap,
    rules: Readonly<RoundRules>,
    private readonly zonePlan: Readonly<ZonePlan>,
    private readonly myId: number,
    private readonly setupOf: (id: number) => FfaTankSetup,
  ) {
    this.world = createWorld(map, [], rules, zonePlan);
    this.mirror = new BulletMirror(map);
    this.picture = new BulletPicture(this.tracks, myId);
  }

  get me(): Tank | null {
    return this.world.tanks.find((tank) => tank.id === this.myId) ?? null;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  // Шагает только в бою (не на отсчёте с тиком 0), пока свой танк жив на поле и матч не кончился.
  get isStepping(): boolean {
    return this.latestTick > 0 && this.me?.isAlive === true && !this.isMatchOver;
  }

  get tanksOnField(): readonly Tank[] {
    return this.world.tanks;
  }

  resetBullets(bullets: readonly FfaBulletSnapshot[]): void {
    this.mirror.reset(bullets);
  }

  // Новое соединение: неподтверждённые команды и снимки старого больше ничего не значат.
  resetConnection(): void {
    this.pending = [];
    this.buffer = [];
    this.shots.clear();
  }

  predict(seq: number, action: Action): void {
    this.pending.push({ seq, action });
    if (this.isStepping) {
      this.world.nextBulletId = predictedBulletId(seq);
      stepWorld(this.world, this.actionsFor(this.world.tanks, action));
      this.tracks.record(this.world.tick, this.world.bullets);
      this.shots.note(this.world.bullets);
    }
  }

  // Свои снаряды, которые сервер подтвердил с прошлого вызова: номер предсказания → номер сервера.
  takeConfirmedBullets(): ConfirmedBullet[] {
    const confirmed = this.confirmed;
    this.confirmed = [];
    return confirmed;
  }

  applySnapshot(message: FfaSnapshotMessage, receivedAt: number): void {
    this.latestTick = message.tick;
    if (message.events.some((event) => event.kind === 'matchOver')) {
      this.isMatchOver = true;
    }
    this.mirror.apply(message.tick, message);
    this.tracks.forgetFrom(message.tick);
    this.tracks.record(message.tick, this.mirror.bullets);
    this.tracks.forgetBefore(message.tick - SNAPSHOT_BUFFER_TICKS);
    this.remember(message, receivedAt);
    const before = this.me;
    const beforeX = before?.x ?? 0;
    const beforeY = before?.y ?? 0;
    const world = this.world;
    world.tick = message.tick;
    world.time = message.tick * DT;
    world.zone.radius = zoneRadiusAt(this.zonePlan, world.time);
    const known = new Map(world.tanks.map((tank) => [tank.id, tank]));
    world.tanks = message.tanks.map((source) => {
      const tank = known.get(source.id) ?? makeTank(this.setupOf(source.id), source.id, source);
      applyTank(tank, source);
      return tank;
    });
    for (const [index, kit] of message.kits.entries()) {
      const target = world.kits[index];
      if (target !== undefined) {
        target.isActive = kit.isActive;
        target.respawnIn = kit.respawnIn;
      }
    }
    world.bullets = this.mirror.bullets.map((bullet) => ({ ...bullet }));
    this.pending = this.pending.filter((input) => input.seq > message.ackSeq);
    if (this.isStepping) {
      this.replay();
    } else {
      this.flyAhead();
    }
    this.noteConfirmed(message);
    const me = this.me;
    this.lastCorrectionPx = before === null || me === null ? 0 : Math.hypot(me.x - beforeX, me.y - beforeY);
  }

  // Переигрывание за n неподтверждённых команд длится T = n·DT. Танк за это время сдвигается не дальше v·T, где
  // v — наибольшая из своей предельной скорости и скоростей снимка (чужие без команды только тормозят, толчок
  // соседа не дальше сдвига толкающего). Танки переигрываются замыканием от своего: входит каждый, кто ближе
  // 2·v·T + 2·радиус танка + запас к уже вошедшему, — так цепочка расталкивания до своего танка не рвётся.
  // Снаряд входит, если за T долетит до своего танка, свои снаряды — всегда. Не вошедшие стоят, где их оставил снимок.
  private replay(): void {
    const world = this.world;
    const me = this.me;
    if (me === null) {
      return;
    }
    const span = this.pending.length * DT;
    const tankReach = Math.max(me.stats.maxSpeed, ...world.tanks.map((tank) => Math.abs(tank.speed))) * span;
    const contact = 2 * tankReach + 2 * TANK_RADIUS + REPLAY_MARGIN;
    const near = new Set<Tank>([me]);
    const queue: Tank[] = [me];
    for (let from = queue.pop(); from !== undefined; from = queue.pop()) {
      for (const tank of world.tanks) {
        if (!near.has(tank) && Math.hypot(tank.x - from.x, tank.y - from.y) <= contact) {
          near.add(tank);
          queue.push(tank);
        }
      }
    }
    const tanks = world.tanks.filter((tank) => near.has(tank));
    const isReplayed = (bullet: Bullet): boolean =>
      bullet.owner === this.myId ||
      Math.hypot(bullet.x - me.x, bullet.y - me.y) <=
        tankReach + Math.hypot(bullet.vx, bullet.vy) * span + TANK_RADIUS + BULLET_RADIUS + REPLAY_MARGIN;
    const far: World = { ...world, tanks: [], bullets: world.bullets.filter((bullet) => !isReplayed(bullet)) };
    const field: World = { ...world, tanks, bullets: world.bullets.filter(isReplayed) };
    for (const input of this.pending) {
      const bornId = predictedBulletId(input.seq);
      field.nextBulletId = bornId;
      stepWorld(field, this.actionsFor(tanks, input.action));
      if (field.nextBulletId !== bornId && !field.bullets.some((bullet) => bullet.id === bornId)) {
        this.tracks.markBornDead(bornId, field.tick);
      }
      flyBullets(far);
      this.tracks.record(field.tick, [...field.bullets, ...far.bullets]);
      this.shots.note(field.bullets);
    }
    world.tick = field.tick;
    world.time = field.time;
    world.nextBulletId = field.nextBulletId;
    world.bullets = [...field.bullets, ...far.bullets];
  }

  // Своего танка на поле нет: тик своего танка на картинке догоняет тик чужих не сразу, и снаряды зеркала до него
  // досчитываются без танков на число неподтверждённых команд.
  private flyAhead(): void {
    const ahead: World = { ...this.world, tanks: [], bullets: this.world.bullets.map((bullet) => ({ ...bullet })) };
    for (let left = this.pending.length; left > 0; left--) {
      flyBullets(ahead);
      this.tracks.record(ahead.tick, ahead.bullets);
    }
  }

  private noteConfirmed(message: FfaSnapshotMessage): void {
    const predictedNow = new Set(this.world.bullets.map((bullet) => bullet.id));
    const born = message.births.filter((bullet) => bullet.owner === this.myId).map((bullet) => bullet.id);
    for (const pair of this.shots.confirm(predictedNow, message.ackSeq, born)) {
      this.picture.rename(pair.predictedId, pair.serverId);
      this.confirmed.push(pair);
    }
  }

  view(now: number): FfaFrameView {
    const renderAt = now - INTERPOLATION_DELAY_MS;
    const [older, newer] = this.bracket(renderAt);
    const t = this.blend(older, newer, renderAt);
    const othersTick = older === null || newer === null ? this.latestTick : lerp(older.tick, newer.tick, t);
    const tanks: FfaViewTank[] = [];
    for (const id of newer?.order ?? []) {
      const b = newer?.tanks.get(id);
      if (b !== undefined) {
        tanks.push(this.shown(id, this.poseBetween(older?.tanks.get(id), b, t), now));
      }
    }
    const me = this.me;
    if (me !== null && !tanks.some((tank) => tank.id === this.myId)) {
      tanks.push(this.shown(this.myId, this.poseOf(me), now));
    }
    const onField = tanks.filter((tank) => tank.id !== this.myId && tank.isAlive);
    const shownIds = new Set(tanks.map((tank) => tank.id));
    for (const [id, pose] of this.lastSeen) {
      if (shownIds.has(id)) {
        continue;
      }
      this.appearedAt.delete(id);
      const vanishedAt = this.vanishedAt.get(id) ?? now;
      this.vanishedAt.set(id, vanishedAt);
      const presence = 1 - (now - vanishedAt) / VANISH_MS;
      if (presence > 0) {
        tanks.push({ ...pose, presence });
      } else {
        this.lastSeen.delete(id);
        this.vanishedAt.delete(id);
      }
    }
    const shown = tanks.map((tank) => this.withPrediction(tank));
    const clock = this.clock(onField, othersTick);
    return {
      tanks: shown,
      bullets: this.picture.frame(clock, this.latestTick),
      kits: this.world.kits,
      zoneRadius: this.world.zone.radius,
      clock,
    };
  }

  // Тик своего танка — тик поля предсказания, пока свой танк на нём шагает; ушёл с поля — плавно догоняет тик
  // чужих (OwnTime). others — живые чужие из снимка, без гаснущих.
  private clock(others: readonly FfaViewTank[], othersTick: number): PictureClock {
    const me = this.isStepping ? this.me : null;
    const myTick = this.ownTime.next(me === null ? null : this.world.tick, othersTick);
    return { myTick, othersTick, me: me === null ? null : { x: me.x, y: me.y }, others };
  }

  // Танк виден: место запоминается — пропав из снимков, он гаснет там, где его видели в последний раз.
  private shown(id: number, pose: Omit<FfaViewTank, 'presence'>, now: number): FfaViewTank {
    this.lastSeen.set(id, pose);
    this.vanishedAt.delete(id);
    const appearedAt = this.appearedAt.get(id) ?? now;
    this.appearedAt.set(id, appearedAt);
    return { ...pose, presence: clampUnit((now - appearedAt) / APPEAR_MS) };
  }

  private actionsFor(tanks: readonly Tank[], mine: Action): Action[] {
    return tanks.map((tank) => (tank.id === this.myId ? mine : IDLE_ACTION));
  }

  private remember(message: FfaSnapshotMessage, receivedAt: number): void {
    this.buffer.push({
      receivedAt,
      tick: message.tick,
      order: message.tanks.map((tank) => tank.id),
      tanks: new Map(message.tanks.map((tank) => [tank.id, tank])),
    });
    while (this.buffer.length > 2 && receivedAt - (this.buffer[0]?.receivedAt ?? receivedAt) > SNAPSHOT_BUFFER_MS) {
      this.buffer.shift();
    }
  }

  private bracket(renderAt: number): [BufferedSnapshot | null, BufferedSnapshot | null] {
    let older: BufferedSnapshot | null = null;
    let newer: BufferedSnapshot | null = null;
    for (const snapshot of this.buffer) {
      if (snapshot.receivedAt <= renderAt) {
        older = snapshot;
      } else {
        newer = snapshot;
        break;
      }
    }
    older ??= newer;
    newer ??= older;
    return [older, newer];
  }

  private blend(older: BufferedSnapshot | null, newer: BufferedSnapshot | null, renderAt: number): number {
    if (older === null || newer === null || older === newer) {
      return 1;
    }
    return clampUnit((renderAt - older.receivedAt) / (newer.receivedAt - older.receivedAt));
  }

  private maxHpOf(id: number): number {
    const tank = this.world.tanks.find((candidate) => candidate.id === id);
    return tank?.stats.maxHp ?? deriveStats(this.setupOf(id).stats).maxHp;
  }

  private poseBetween(a: FfaTankSnapshot | undefined, b: FfaTankSnapshot, t: number): Omit<FfaViewTank, 'presence'> {
    const isJump = a === undefined || Math.hypot(b.x - a.x, b.y - a.y) > JUMP_LIMIT;
    const from = isJump ? b : a;
    return {
      id: b.id,
      x: lerp(from.x, b.x, t),
      y: lerp(from.y, b.y, t),
      heading: lerpAngle(from.heading, b.heading, t),
      turret: lerpAngle(from.turret, b.turret, t),
      speed: lerp(from.speed, b.speed, t),
      hp: b.hp,
      maxHp: this.maxHpOf(b.id),
      isAlive: b.isAlive,
      shieldLeft: b.shieldLeft,
    };
  }

  private poseOf(tank: Tank): Omit<FfaViewTank, 'presence'> {
    return {
      id: tank.id,
      x: tank.x,
      y: tank.y,
      heading: tank.heading,
      turret: tank.turret,
      speed: tank.speed,
      hp: tank.hp,
      maxHp: tank.stats.maxHp,
      isAlive: tank.isAlive,
      shieldLeft: tank.shieldLeft,
    };
  }

  // Свой танк — из предсказания, пока он на поле предсказания: оно идёт впереди снимков, и картинка
  // своего танка не отстаёт; ушёл с поля — гаснет по снимкам, как чужой.
  private withPrediction(tank: FfaViewTank): FfaViewTank {
    const me = this.me;
    if (tank.id !== this.myId || me === null) {
      return tank;
    }
    return { ...this.poseOf(me), presence: tank.presence };
  }
}
