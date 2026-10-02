import {
  createRound,
  DT,
  IDLE_ACTION,
  normalizeAngle,
  stepRound,
  type Action,
  type Round,
  type Side,
  type Stats,
} from '@tanks/shared/engine';
import type { BulletSnapshot, SnapshotMessage, TankSnapshot } from '@tanks/shared/protocol';

export interface InterpolatedTank {
  x: number;
  y: number;
  heading: number;
  turret: number;
  hp: number;
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

interface PendingInput {
  seq: number;
  action: Action;
}

interface TimedSnapshot {
  message: SnapshotMessage;
  receivedAt: number;
}

const INTERPOLATION_DELAY_TICKS = 2;
const SNAPSHOT_BUFFER_MS = 1000;

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

// Свой танк — предсказание по собственному вводу с переигрыванием после снимка сервера;
// чужой танк и снаряды — интерполяция между двумя снимками с отставанием на два тика.
export class Prediction {
  private round: Round;
  private readonly pending: PendingInput[] = [];
  private readonly snapshots: TimedSnapshot[] = [];
  private seq = 0;
  lastCorrectionPx = 0;
  latestTick = 0;

  constructor(
    private readonly side: Side,
    mapIndex: number,
    tanks: [{ nickname: string; stats: Stats }, { nickname: string; stats: Stats }],
  ) {
    this.round = createRound(mapIndex, [
      { name: tanks[0].nickname, stats: tanks[0].stats },
      { name: tanks[1].nickname, stats: tanks[1].stats },
    ]);
  }

  get me(): Round['tanks'][number] {
    return this.round.tanks[this.side];
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get isFighting(): boolean {
    return this.latestTick > 0 && !this.round.isOver;
  }

  // Применяет свой ввод к локальной копии и запоминает его до подтверждения сервером.
  predict(action: Action): number {
    this.seq++;
    this.pending.push({ seq: this.seq, action });
    if (this.isFighting) {
      stepRound(this.round, this.actionsFor(action));
    }
    return this.seq;
  }

  applySnapshot(message: SnapshotMessage, receivedAt: number): void {
    this.latestTick = message.tick;
    this.snapshots.push({ message, receivedAt });
    while (this.snapshots.length > 0 && receivedAt - (this.snapshots[0]?.receivedAt ?? 0) > SNAPSHOT_BUFFER_MS) {
      this.snapshots.shift();
    }

    const before = { x: this.me.x, y: this.me.y };
    this.round.tick = message.tick;
    this.round.time = message.tick * DT;
    this.round.isOver = message.isOver;
    this.round.winner = message.winner;
    this.round.endReason = message.endReason;
    this.round.zone.radius = message.zoneRadius;
    applyTank(this.round.tanks[0], message.tanks[0]);
    applyTank(this.round.tanks[1], message.tanks[1]);
    this.round.bullets = message.bullets.map((bullet) => ({ ...bullet, damage: 0, isDead: false }));
    this.round.nextBulletId = Math.max(0, ...message.bullets.map((bullet) => bullet.id)) + 1000;
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
      for (const input of this.pending) {
        stepRound(this.round, this.actionsFor(input.action));
      }
    }
    this.lastCorrectionPx = Math.hypot(this.me.x - before.x, this.me.y - before.y);
  }

  view(now: number): WorldView {
    const enemySide: Side = this.side === 0 ? 1 : 0;
    const renderAt = now - INTERPOLATION_DELAY_TICKS * DT * 1000;
    const [older, newer] = this.bracket(renderAt);
    const t =
      newer === older || newer === null || older === null
        ? 1
        : (renderAt - older.receivedAt) / (newer.receivedAt - older.receivedAt);
    const clampedT = Math.max(0, Math.min(1, t));
    const mine: InterpolatedTank = {
      x: this.me.x,
      y: this.me.y,
      heading: this.me.heading,
      turret: this.me.turret,
      hp: this.me.hp,
      isAlive: this.me.isAlive,
    };
    const enemy = this.interpolateTank(older, newer, enemySide, clampedT);
    const tanks: [InterpolatedTank, InterpolatedTank] = this.side === 0 ? [mine, enemy] : [enemy, mine];
    return { round: this.round, tanks, bullets: this.interpolateBullets(older, newer, clampedT) };
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
        hp: fallback.hp,
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
      hp: b.hp,
      isAlive: b.isAlive,
    };
  }

  private interpolateBullets(
    older: TimedSnapshot | null,
    newer: TimedSnapshot | null,
    t: number,
  ): InterpolatedBullet[] {
    if (older === null || newer === null) {
      return this.round.bullets.map((bullet) => ({ id: bullet.id, owner: bullet.owner, x: bullet.x, y: bullet.y }));
    }
    const previous = new Map<number, BulletSnapshot>(older.message.bullets.map((bullet) => [bullet.id, bullet]));
    const result: InterpolatedBullet[] = newer.message.bullets.map((bullet) => {
      const was = previous.get(bullet.id);
      if (was === undefined) {
        return { id: bullet.id, owner: bullet.owner, x: bullet.x, y: bullet.y };
      }
      return { id: bullet.id, owner: bullet.owner, x: lerp(was.x, bullet.x, t), y: lerp(was.y, bullet.y, t) };
    });
    // Свои снаряды, которые сервер ещё не подтвердил, показываются из предсказания.
    const known = new Set(result.map((bullet) => bullet.id));
    for (const bullet of this.round.bullets) {
      if (bullet.owner === this.side && !known.has(bullet.id)) {
        result.push({ id: bullet.id, owner: bullet.owner, x: bullet.x, y: bullet.y });
      }
    }
    return result;
  }
}
