import {
  BULLET_RADIUS,
  createWorld,
  deriveStats,
  DT,
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

// Отставание картинки чужих — два тика; буфер — секунда снимков, как у дуэли.
const INTERPOLATION_DELAY_MS = 2 * DT * 1000;
const SNAPSHOT_BUFFER_MS = 1000;
const APPEAR_MS = 150;
const VANISH_MS = 200;
// Скачок дальше этого между соседними снимками — перестановка, а не езда: не растягивается.
const JUMP_LIMIT = 200;
// Свой снаряд, рождённый предсказанием, получает номер от команды выстрела в диапазоне, куда номера сервера
// не доходят: номер не меняется от снимка к снимку до подтверждения.
export const PREDICTED_BULLET_ID_BASE = 2 ** 30;
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

export interface FfaViewBullet {
  id: number;
  owner: number;
  x: number;
  y: number;
}

export interface FfaFrameView {
  tanks: FfaViewTank[];
  bullets: FfaViewBullet[];
  kits: readonly Kit[];
  zoneRadius: number;
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
  order: number[];
  tanks: Map<number, FfaTankSnapshot>;
  bullets: Map<number, FfaViewBullet>;
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

export interface ConfirmedBullet {
  predictedId: number;
  serverId: number;
}

// Своё предсказание среди N танков и картинка чужих. Поле предсказания — копия серверного поля из последнего
// снимка: танки ровно снимка и в его порядке (столкновения и выстрелы движок обходит по порядку), снаряды — копии
// зеркала. Свой танк переигрывается неподтверждёнными командами, чужие без команды тормозят со скорости снимка.
// Переигрывается только то, что за окно переигрывания может дотянуться до своего танка, и свои снаряды.
// Чужие танки и снаряды — интерполяция по номерам между двумя снимками с отставанием на два тика.
export class FfaPrediction {
  private readonly world: World;
  private readonly mirror: BulletMirror;
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
  }

  predict(seq: number, action: Action): void {
    this.pending.push({ seq, action });
    if (this.isStepping) {
      this.world.nextBulletId = PREDICTED_BULLET_ID_BASE + seq;
      stepWorld(this.world, this.actionsFor(this.world.tanks, action));
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
    const predictedBefore = world.bullets
      .filter((bullet) => bullet.id >= PREDICTED_BULLET_ID_BASE)
      .map((bullet) => bullet.id);
    world.bullets = this.mirror.bullets.map((bullet) => ({ ...bullet }));
    this.pending = this.pending.filter((input) => input.seq > message.ackSeq);
    if (this.isStepping) {
      this.replay();
    }
    this.noteConfirmed(predictedBefore, message);
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
    const farBullets = world.bullets.filter((bullet) => !isReplayed(bullet));
    const field: World = { ...world, tanks, bullets: world.bullets.filter(isReplayed) };
    for (const input of this.pending) {
      field.nextBulletId = PREDICTED_BULLET_ID_BASE + input.seq;
      stepWorld(field, this.actionsFor(tanks, input.action));
    }
    world.tick = field.tick;
    world.time = field.time;
    world.nextBulletId = field.nextBulletId;
    world.bullets = [...field.bullets, ...farBullets];
  }

  // Подтверждённый выстрел: снаряд предсказания с командой не новее подтверждённой пропал, а у сервера в этом
  // снимке родился свой снаряд — пары по порядку.
  private noteConfirmed(predictedBefore: readonly number[], message: FfaSnapshotMessage): void {
    const predictedNow = new Set(this.world.bullets.map((bullet) => bullet.id));
    const gone = predictedBefore
      .filter((id) => !predictedNow.has(id) && id - PREDICTED_BULLET_ID_BASE <= message.ackSeq)
      .sort((a, b) => a - b);
    const born = message.births
      .filter((bullet) => bullet.owner === this.myId)
      .map((bullet) => bullet.id)
      .sort((a, b) => a - b);
    for (let index = 0; index < Math.min(gone.length, born.length); index++) {
      this.confirmed.push({ predictedId: gone[index] ?? 0, serverId: born[index] ?? 0 });
    }
  }

  view(now: number): FfaFrameView {
    const renderAt = now - INTERPOLATION_DELAY_MS;
    const [older, newer] = this.bracket(renderAt);
    const t = this.blend(older, newer, renderAt);
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
    return {
      tanks: tanks.map((tank) => this.withPrediction(tank)),
      bullets: [...this.ownBullets(), ...this.otherBullets(older, newer, t)],
      kits: this.world.kits,
      zoneRadius: this.world.zone.radius,
    };
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
    const bullets = new Map<number, FfaViewBullet>();
    for (const bullet of this.mirror.bullets) {
      bullets.set(bullet.id, { id: bullet.id, owner: bullet.owner, x: bullet.x, y: bullet.y });
    }
    this.buffer.push({
      receivedAt,
      order: message.tanks.map((tank) => tank.id),
      tanks: new Map(message.tanks.map((tank) => [tank.id, tank])),
      bullets,
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

  // Свои снаряды — только из поля предсказания: выстрел виден сразу, а смена источника дала бы прыжок назад.
  private ownBullets(): FfaViewBullet[] {
    return this.world.bullets
      .filter((bullet) => bullet.owner === this.myId)
      .map((bullet) => ({ id: bullet.id, owner: bullet.owner, x: bullet.x, y: bullet.y }));
  }

  private otherBullets(older: BufferedSnapshot | null, newer: BufferedSnapshot | null, t: number): FfaViewBullet[] {
    const bullets: FfaViewBullet[] = [];
    for (const bullet of newer?.bullets.values() ?? []) {
      if (bullet.owner === this.myId) {
        continue;
      }
      const was = older?.bullets.get(bullet.id);
      if (was === undefined) {
        bullets.push(bullet);
        continue;
      }
      bullets.push({ ...bullet, x: lerp(was.x, bullet.x, t), y: lerp(was.y, bullet.y, t) });
    }
    return bullets;
  }
}
