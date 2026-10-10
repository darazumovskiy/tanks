import {
  createRound,
  DT,
  IDLE_ACTION,
  normalizeAngle,
  stepRound,
  type Action,
  type Round,
  type RoundRules,
  type Side,
  type Stats,
} from '@tanks/shared/engine';
import {
  duelSide,
  toSnapshotEvent,
  type SnapshotEvent,
  type SnapshotMessage,
  type TankSnapshot,
} from '@tanks/shared/protocol';
import { isBulletHitFlags, OwnHits, stepWithTouches, type OwnHitCounts } from './ownHits.js';
import {
  bracketByTick,
  INTERPOLATION_MIN_TICKS,
  NO_SHIFT,
  OthersTiming,
  OwnSmoothing,
  shiftNearOwn,
  type Pose,
} from './netSmoothing.js';
import { OwnShots, type DueShot, type OwnShotCounts } from './ownShots.js';
import {
  BulletPicture,
  BulletTracks,
  flightEndTick,
  OwnTime,
  recordFlight,
  type HoldEnd,
  type PictureClock,
} from './pictureTime.js';
import { PredictedShots, predictedBulletId, type ConfirmedBullet } from './predictedShots.js';

export interface InterpolatedTank {
  x: number;
  y: number;
  heading: number;
  turret: number;
  speed: number;
  hp: number;
  maxHp: number;
  isAlive: boolean;
}

export interface InterpolatedBullet {
  id: number;
  owner: Side;
  x: number;
  y: number;
}

export interface WorldView {
  round: Round;
  tanks: [InterpolatedTank, InterpolatedTank];
  bullets: InterpolatedBullet[];
}

// Кадр боя: снаряд несёт свой тик картинки, clock — тики своего танка и противника.
export interface PictureView extends WorldView {
  bullets: (InterpolatedBullet & { tick: number })[];
  clock: PictureClock;
}

interface PendingInput {
  seq: number;
  action: Action;
}

interface TimedSnapshot {
  message: SnapshotMessage;
  receivedAt: number;
}

const SNAPSHOT_BUFFER_MS = 1000;
const SNAPSHOT_BUFFER_TICKS = Math.ceil(SNAPSHOT_BUFFER_MS / (DT * 1000));

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  return normalizeAngle(a + normalizeAngle(b - a) * t);
}

function applyTank(target: Round['tanks'][number], source: TankSnapshot): void {
  target.x = source.x;
  target.y = source.y;
  target.heading = source.heading;
  target.turret = source.turret;
  target.speed = source.speed;
  target.hp = source.hp;
  target.reloadLeft = source.reloadLeft;
  target.isAlive = source.isAlive;
}

// Свой танк — предсказание по собственному вводу с переигрыванием после снимка сервера; чужой танк — интерполяция
// между двумя снимками с отставанием на два тика; снаряды — во времени того, рядом с чем летят. Снаряд противника,
// погасший в досчёте о свой танк, — попадание сразу, снимок его подтверждает или отменяет. Со сглаживанием дёрганой
// сети противник рисуется по тику игры с отставанием под неровность снимков, а нарисованный свой танк догоняет
// поправку плавно — вместе со снарядами у него.
export class Prediction {
  private round: Round;
  private readonly pending: PendingInput[] = [];
  private readonly snapshots: TimedSnapshot[] = [];
  private readonly tracks = new BulletTracks();
  private readonly flight = new BulletTracks();
  private isFlightStale = true;
  private readonly picture: BulletPicture;
  private readonly ownTime = new OwnTime();
  private readonly shots = new PredictedShots();
  private readonly ownHits = new OwnHits();
  private playedOnTouch: ReadonlySet<SnapshotEvent> = new Set();
  private readonly ownShots = new OwnShots<SnapshotEvent>();
  private playedShots: ReadonlySet<SnapshotEvent> = new Set();
  private serverBulletIds = new Set<number>();
  private confirmed: ConfirmedBullet[] = [];
  private seq: number;
  private readonly othersTiming = new OthersTiming();
  private readonly ownSmoothing = new OwnSmoothing();
  private shift: Pose = { ...NO_SHIFT };
  lastCorrectionPx = 0;
  latestTick = 0;
  latestGameTick = 0;

  // Номер команды сквозной на всё соединение: сервер отбрасывает номера не больше уже принятого,
  // поэтому новый раунд продолжает счёт, а не начинает с единицы.
  // rules — правила раунда от сервера: с другими правилами предсказание расходилось бы с ним у стен.
  // hasNetSmoothing — сглаживание дёрганой сети из Welcome.
  constructor(
    private readonly side: Side,
    mapIndex: number,
    tanks: [{ nickname: string; stats: Stats }, { nickname: string; stats: Stats }],
    lastSeq: number,
    rules: Readonly<RoundRules>,
    private readonly hasNetSmoothing = false,
  ) {
    this.seq = lastSeq;
    this.picture = new BulletPicture(this.tracks, side, this.flight);
    this.round = createRound(
      mapIndex,
      [
        { name: tanks[0].nickname, stats: tanks[0].stats },
        { name: tanks[1].nickname, stats: tanks[1].stats },
      ],
      rules,
    );
  }

  get me(): Round['tanks'][number] {
    return this.round.tanks[this.side];
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get myBulletCount(): number {
    return this.round.bullets.filter((bullet) => bullet.owner === this.side).length;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get isFighting(): boolean {
    return this.latestTick > 0 && !this.round.isOver;
  }

  get ownHitCounts(): OwnHitCounts {
    return this.ownHits.counts;
  }

  get ownShotCounts(): OwnShotCounts {
    return this.ownShots.counts;
  }

  // Отставание картинки противника в тиках, которого требует неровность снимков.
  get interpolationTicks(): number {
    return this.hasNetSmoothing ? this.othersTiming.delayTicks : INTERPOLATION_MIN_TICKS;
  }

  // Попадания по своему танку, сыгранные по касанию в досчёте с прошлого вызова: играются сразу, в точке касания
  // на нарисованном танке.
  takeOwnHits(): SnapshotEvent[] {
    return this.ownHits.takePlayed().map(({ hit }) => {
      const event = toSnapshotEvent(hit);
      return { ...event, x: event.x + this.shift.x, y: event.y + this.shift.y };
    });
  }

  // Кадры стояли (вкладка скрыта): накопленные касания не играются, их попадания сыграют снимки.
  discardOwnHits(): void {
    this.ownHits.discardUnplayed();
  }

  // Событие последнего снимка — попадание, уже сыгранное касанием.
  wasPlayedOnTouch(event: SnapshotEvent): boolean {
    return this.playedOnTouch.has(event);
  }

  takeHoldEnds(): HoldEnd[] {
    return this.picture.takeHoldEnds();
  }

  // Свои выстрелы, рождённые досчётом с прошлого вызова: играются сразу, у дула нарисованного танка.
  takeOwnShots(): SnapshotEvent[] {
    return this.ownShots
      .takeDue()
      .map(({ event }) => ({ ...event, x: event.x + this.shift.x, y: event.y + this.shift.y }));
  }

  // Кадры стояли (вкладка скрыта): накопленные выстрелы не играются.
  discardOwnShots(): void {
    this.ownShots.discardDue();
  }

  // Событие последнего снимка — свой выстрел, уже сыгранный по досчёту.
  wasShotPlayed(event: SnapshotEvent): boolean {
    return this.playedShots.has(event);
  }

  // Применяет свой ввод к локальной копии и запоминает его до подтверждения сервером.
  predict(action: Action): number {
    this.seq++;
    this.pending.push({ seq: this.seq, action });
    if (this.isFighting) {
      this.ownShots.fired(this.seq, this.step(this.seq, action));
    }
    return this.seq;
  }

  // Свои снаряды, которые сервер подтвердил с прошлого вызова: номер предсказания → номер сервера.
  takeConfirmedBullets(): ConfirmedBullet[] {
    const confirmed = this.confirmed;
    this.confirmed = [];
    return confirmed;
  }

  applySnapshot(message: SnapshotMessage, receivedAt: number): void {
    this.latestTick = message.tick;
    this.latestGameTick = message.gameTick;
    this.snapshots.push({ message, receivedAt });
    while (this.snapshots.length > 0 && receivedAt - (this.snapshots[0]?.receivedAt ?? 0) > SNAPSHOT_BUFFER_MS) {
      this.snapshots.shift();
    }
    if (this.hasNetSmoothing) {
      this.othersTiming.note(message.gameTick, receivedAt);
    }

    const before = { x: this.me.x, y: this.me.y };
    const beforePose = this.ownPose();
    this.round.tick = message.tick;
    this.round.time = message.tick * DT;
    this.round.isOver = message.isOver;
    this.round.winner = message.winner;
    this.round.endReason = message.endReason;
    this.round.zone.radius = message.zoneRadius;
    applyTank(this.round.tanks[0], message.tanks[0]);
    applyTank(this.round.tanks[1], message.tanks[1]);
    this.round.bullets = message.bullets.map((bullet) => ({ ...bullet, damage: 0, isDead: false }));
    this.settleOwnHits(message);
    const ownServerShots = message.events.filter((event) => event.kind === 'shot' && event.side === this.side);
    this.playedShots = this.ownShots.settle(
      message.ackSeq,
      message.tick,
      ownServerShots,
      message.tanks[this.side].isAlive,
    );
    this.tracks.forgetFrom(message.tick);
    this.tracks.record(message.tick, message.bullets);
    this.tracks.forgetBefore(message.tick - SNAPSHOT_BUFFER_TICKS);
    this.isFlightStale = true;
    for (const [index, kit] of message.kits.entries()) {
      const target = this.round.kits[index];
      if (target !== undefined) {
        target.isActive = kit.isActive;
        target.respawnIn = kit.respawnIn;
      }
    }

    while (this.pending.length > 0 && (this.pending[0]?.seq ?? 0) <= message.ackSeq) {
      this.pending.shift();
    }
    if (this.isFighting) {
      const shots = new Map<number, DueShot<SnapshotEvent>>();
      for (const input of this.pending) {
        const shot = this.step(input.seq, input.action);
        if (shot !== null) {
          shots.set(input.seq, shot);
        }
      }
      this.ownShots.replayed(shots);
    }
    this.noteConfirmed(message);
    this.lastCorrectionPx = Math.hypot(this.me.x - before.x, this.me.y - before.y);
    if (this.hasNetSmoothing) {
      this.ownSmoothing.correct(beforePose, this.ownPose(), receivedAt);
    }
  }

  // Свой танк в бою на поле; null — раунд не идёт или танк подбит.
  private ownPose(): Pose | null {
    const me = this.me;
    const isOnField = this.isFighting && me.isAlive;
    return isOnField ? { x: me.x, y: me.y, heading: me.heading, turret: me.turret } : null;
  }

  // Шаг досчёта; результат — выстрел своего танка в этом шаге.
  private step(seq: number, action: Action): DueShot<SnapshotEvent> | null {
    const bornId = predictedBulletId(seq);
    this.round.nextBulletId = bornId;
    const actions = this.actionsFor(action);
    const { events, touches } = stepWithTouches(
      this.round,
      this.side,
      (owner) => this.round.tanks[duelSide(owner)].stats.damage,
      (round) => stepRound(round, actions),
    );
    for (const touch of touches) {
      this.ownHits.touch(touch, this.round.tick, this.me.hp);
    }
    if (this.round.nextBulletId !== bornId && !this.round.bullets.some((bullet) => bullet.id === bornId)) {
      this.tracks.markBornDead(bornId, this.round.tick);
    }
    this.tracks.record(this.round.tick, this.round.bullets);
    this.shots.note(this.round.bullets);
    this.isFlightStale = true;
    const shot = events.find((event) => event.type === 'shot' && event.tank === this.side);
    return shot === undefined ? null : { event: toSnapshotEvent(shot), tick: this.round.tick };
  }

  // Снимок подтверждает или отменяет сыгранные касания; конец раунда отменяет несыгранные. Погибшие — снаряды
  // прошлого снимка, которых нет в этом.
  private settleOwnHits(message: SnapshotMessage): void {
    const alive = new Set(message.bullets.map((bullet) => bullet.id));
    const died = new Set([...this.serverBulletIds].filter((id) => !alive.has(id)));
    this.playedOnTouch = this.ownHits.settle(message.tick, died, alive, message.events, (event) =>
      this.bulletHitOwner(event),
    );
    if (message.isOver) {
      this.ownHits.cancelAll();
    }
  }

  private bulletHitOwner(event: SnapshotEvent): number | null {
    const isBulletHit = event.kind === 'hit' && event.side === this.side && isBulletHitFlags(event.flags);
    return isBulletHit ? this.enemySide : null;
  }

  private get enemySide(): Side {
    return this.side === 0 ? 1 : 0;
  }

  private noteConfirmed(message: SnapshotMessage): void {
    const predictedNow = new Set(this.round.bullets.map((bullet) => bullet.id));
    const born = message.bullets
      .filter((bullet) => bullet.owner === this.side && !this.serverBulletIds.has(bullet.id))
      .map((bullet) => bullet.id);
    this.serverBulletIds = new Set(message.bullets.map((bullet) => bullet.id));
    for (const pair of this.shots.confirm(predictedNow, message.ackSeq, born)) {
      this.picture.rename(pair.predictedId, pair.serverId);
      this.confirmed.push(pair);
    }
  }

  view(now: number): PictureView {
    const enemySide = this.enemySide;
    this.shift = this.hasNetSmoothing ? this.ownSmoothing.at(now) : { ...NO_SHIFT };
    const [older, newer, clampedT] = this.othersFrame(now);
    const othersTick =
      older === null || newer === null ? this.latestTick : lerp(older.message.tick, newer.message.tick, clampedT);
    const predicted: InterpolatedTank = {
      x: this.me.x,
      y: this.me.y,
      heading: this.me.heading,
      turret: this.me.turret,
      speed: this.me.speed,
      hp: this.ownHits.shownHp(this.me.hp),
      maxHp: this.me.stats.maxHp,
      isAlive: this.me.isAlive,
    };
    const mine: InterpolatedTank = {
      ...predicted,
      x: predicted.x + this.shift.x,
      y: predicted.y + this.shift.y,
      heading: predicted.heading + this.shift.heading,
      turret: predicted.turret + this.shift.turret,
    };
    const enemy = this.interpolateTank(older, newer, enemySide, clampedT);
    const tanks: [InterpolatedTank, InterpolatedTank] = this.side === 0 ? [mine, enemy] : [enemy, mine];
    const clock = { ...this.clock(predicted, enemy, othersTick), ownShift: { x: this.shift.x, y: this.shift.y } };
    this.refreshFlight(clock);
    return {
      round: this.round,
      tanks,
      bullets: shiftNearOwn(this.picture.frame(clock, this.latestTick), clock).map((bullet) => ({
        ...bullet,
        owner: bullet.owner === 0 ? 0 : 1,
      })),
      clock,
    };
  }

  // Будущий путь своих снарядов пересчитывается, когда поле сдвинулось или окно подлёта ушло дальше пути.
  private refreshFlight(clock: PictureClock): void {
    const endTick = flightEndTick(clock);
    if (!this.isFlightStale && endTick <= this.flight.lastTick()) {
      return;
    }
    recordFlight(this.flight, this.round, this.side, endTick);
    this.isFlightStale = false;
  }

  // Снимки вокруг картинки противника и доля между ними: без сглаживания — по времени прихода с отставанием в два
  // тика, со сглаживанием — по тику игры с отставанием под неровность снимков.
  private othersFrame(now: number): [TimedSnapshot | null, TimedSnapshot | null, number] {
    if (!this.hasNetSmoothing) {
      const renderAt = now - INTERPOLATION_MIN_TICKS * DT * 1000;
      const [older, newer] = this.bracket(renderAt);
      const t =
        newer === older || newer === null || older === null
          ? 1
          : (renderAt - older.receivedAt) / (newer.receivedAt - older.receivedAt);
      return [older, newer, Math.max(0, Math.min(1, t))];
    }
    const gameTick = this.othersTiming.gameTickAt(now, this.latestGameTick);
    const bracket = bracketByTick(this.snapshots, (snapshot) => snapshot.message.gameTick, gameTick);
    return bracket === null ? [null, null, 1] : [bracket.older, bracket.newer, bracket.t];
  }

  // Тик своего танка — тик раунда предсказания, пока свой танк жив в бою; иначе плавно догоняет тик противника
  // (OwnTime). Снаряды после конца раунда не досчитываются: сервер останавливает раунд, снаряды в снимках стоят.
  private clock(mine: InterpolatedTank, enemy: InterpolatedTank, othersTick: number): PictureClock {
    const others = enemy.isAlive ? [enemy] : [];
    const isOnField = this.isFighting && mine.isAlive;
    const myTick = this.ownTime.next(isOnField ? this.round.tick : null, othersTick);
    return { myTick, othersTick, me: isOnField ? mine : null, others };
  }

  private actionsFor(mine: Action): [Action, Action] {
    return this.side === 0 ? [mine, IDLE_ACTION] : [IDLE_ACTION, mine];
  }

  private bracket(renderAt: number): [TimedSnapshot | null, TimedSnapshot | null] {
    let older: TimedSnapshot | null = null;
    let newer: TimedSnapshot | null = null;
    for (const snapshot of this.snapshots) {
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

  private interpolateTank(
    older: TimedSnapshot | null,
    newer: TimedSnapshot | null,
    side: Side,
    t: number,
  ): InterpolatedTank {
    const fallback = this.round.tanks[side];
    if (older === null || newer === null) {
      return {
        x: fallback.x,
        y: fallback.y,
        heading: fallback.heading,
        turret: fallback.turret,
        speed: fallback.speed,
        hp: fallback.hp,
        maxHp: fallback.stats.maxHp,
        isAlive: fallback.isAlive,
      };
    }
    const a = older.message.tanks[side];
    const b = newer.message.tanks[side];
    return {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      heading: lerpAngle(a.heading, b.heading, t),
      turret: lerpAngle(a.turret, b.turret, t),
      speed: lerp(a.speed, b.speed, t),
      hp: b.hp,
      maxHp: fallback.stats.maxHp,
      isAlive: b.isAlive,
    };
  }
}
