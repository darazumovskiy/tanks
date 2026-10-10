import {
  BULLET_RADIUS,
  deriveStats,
  isSegmentClear,
  MUZZLE_OFFSET,
  shotCarry,
  STAT_MAX,
  TANK_RADIUS,
  type Field,
  type Point,
} from '@tanks/shared/engine';
import type { FxBullet, FxTank } from './effects.js';

// Снаряд на картинке выходит из дула нарисованного стрелка и за это время садится на своё место.
export const MUZZLE_EXIT_S = 0.1;
// Дальше от дула снаряд появился не из выстрела (вошёл в окно, вход посреди матча): шаг выстрела и догон
// до 6 тиков самым быстрым снарядом с запасом на отставание нарисованного танка.
export const MUZZLE_EXIT_MAX_GAP = 240;
const CONTACT = TANK_RADIUS + BULLET_RADIUS;
const FASTEST_TANK_SPEED = deriveStats({ armor: 0, engine: STAT_MAX, gun: 0, reload: 0 }).maxSpeed;
// Другой танк за время выхода может подъехать к пути снаряда.
const TANK_REACH = CONTACT + FASTEST_TANK_SPEED * MUZZLE_EXIT_S;

interface Exit {
  gapX: number;
  gapY: number;
  bornAtS: number;
}

export function muzzleOf(tank: Readonly<FxTank>): Point {
  return { x: tank.x + Math.cos(tank.turret) * MUZZLE_OFFSET, y: tank.y + Math.sin(tank.turret) * MUZZLE_OFFSET };
}

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  const along = lengthSquared === 0 ? 0 : ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared;
  const t = Math.min(1, Math.max(0, along));
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t));
}

function isInside(point: Point, field: Readonly<Field>): boolean {
  return (
    point.x >= BULLET_RADIUS &&
    point.y >= BULLET_RADIUS &&
    point.x <= field.width - BULLET_RADIUS &&
    point.y <= field.height - BULLET_RADIUS
  );
}

// 1 в начале выхода, 0 в конце; скорость разрыва в начале и в конце нулевая — без рывка на стыках.
function gapShare(ageS: number): number {
  const u = Math.min(1, Math.max(0, ageS / MUZZLE_EXIT_S));
  return 1 - u * u * (3 - 2 * u);
}

// Выход из дула — только рисование: место снаряда в картинке и все сверки остаются прежними.
export class MuzzleExit {
  // null — снаряд рисуется на своём месте с первого кадра.
  private readonly exits = new Map<number, Exit | null>();

  place(
    bullets: readonly FxBullet[],
    tanks: ReadonlyMap<number, Readonly<FxTank>>,
    field: Readonly<Field>,
    timeS: number,
  ): FxBullet[] {
    const live = new Set<number>();
    const placed = bullets.map((bullet) => {
      live.add(bullet.id);
      let exit = this.exits.get(bullet.id);
      if (exit === undefined) {
        exit = this.start(bullet, tanks, field, timeS);
        this.exits.set(bullet.id, exit);
      }
      if (exit === null) {
        return bullet;
      }
      const share = gapShare(timeS - exit.bornAtS);
      return { ...bullet, x: bullet.x + exit.gapX * share, y: bullet.y + exit.gapY * share };
    });
    for (const id of this.exits.keys()) {
      if (!live.has(id)) {
        this.exits.delete(id);
      }
    }
    return placed;
  }

  rename(fromId: number, toId: number): void {
    const exit = this.exits.get(fromId);
    if (exit === undefined) {
      return;
    }
    this.exits.delete(fromId);
    this.exits.set(toId, exit);
  }

  reset(): void {
    this.exits.clear();
  }

  private start(
    bullet: FxBullet,
    tanks: ReadonlyMap<number, Readonly<FxTank>>,
    field: Readonly<Field>,
    timeS: number,
  ): Exit | null {
    const shooter = tanks.get(bullet.owner);
    if (shooter?.isAlive !== true) {
      return null;
    }
    const muzzle = muzzleOf(shooter);
    const gapX = muzzle.x - bullet.x;
    const gapY = muzzle.y - bullet.y;
    if (Math.hypot(gapX, gapY) > MUZZLE_EXIT_MAX_GAP) {
      return null;
    }
    if (this.isPointBlank(bullet, shooter, muzzle, tanks, field)) {
      return null;
    }
    return { gapX, gapY, bornAtS: timeS };
  }

  // Касание корпуса или стены на участке выхода: снаряд рисуется на своём месте, касание на картинке — попадание.
  private isPointBlank(
    bullet: FxBullet,
    shooter: Readonly<FxTank>,
    muzzle: Point,
    tanks: ReadonlyMap<number, Readonly<FxTank>>,
    field: Readonly<Field>,
  ): boolean {
    const carry = shotCarry(shooter, shooter.shotInheritPercent);
    const end = {
      x: bullet.x + (Math.cos(shooter.turret) * shooter.bulletSpeed + carry.x) * MUZZLE_EXIT_S,
      y: bullet.y + (Math.sin(shooter.turret) * shooter.bulletSpeed + carry.y) * MUZZLE_EXIT_S,
    };
    const path: readonly [Point, Point][] = [
      [muzzle, bullet],
      [bullet, end],
    ];
    const isOffField = !isInside(muzzle, field) || !isInside(bullet, field) || !isInside(end, field);
    if (isOffField) {
      return true;
    }
    const isWallHit = path.some(
      ([from, to]) => !isSegmentClear(field.walls, from.x, from.y, to.x, to.y, BULLET_RADIUS),
    );
    if (isWallHit) {
      return true;
    }
    for (const tank of tanks.values()) {
      if (tank.id === shooter.id || !tank.isAlive) {
        continue;
      }
      if (path.some(([from, to]) => distanceToSegment(tank, from, to) < TANK_REACH)) {
        return true;
      }
    }
    return false;
  }
}
