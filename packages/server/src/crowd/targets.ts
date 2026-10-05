import { TICK_RATE, type Point } from '@tanks/shared/engine';
import type { CrowdTank, CrowdView } from './view.js';

const MAX_HUNTERS = 2;
const RETARGET_TICKS = TICK_RATE;
// Текущая цель уступает новой, только если та ближе во столько раз: иначе бот дёргался бы между двумя.
const SWITCH_RATIO = 1.5;

interface Claim {
  gameId: string;
  targetId: number;
}

// Общий учёт роя: кто из ботов кого выбрал целью. Владелец — сам бот; номера игроков свои в каждой игре.
export class TargetBook {
  private readonly claims = new Map<object, Claim>();

  claim(owner: object, gameId: string, targetId: number | null): void {
    if (targetId === null) {
      this.claims.delete(owner);
      return;
    }
    this.claims.set(owner, { gameId, targetId });
  }

  hunters(gameId: string, targetId: number, except: object): number {
    let count = 0;
    for (const [owner, claim] of this.claims) {
      if (owner !== except && claim.gameId === gameId && claim.targetId === targetId) {
        count++;
      }
    }
    return count;
  }
}

function distance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function nearest(from: Point, tanks: readonly CrowdTank[]): CrowdTank | undefined {
  let best: CrowdTank | undefined;
  for (const tank of tanks) {
    if (best === undefined || distance(from, tank) < distance(from, best)) {
      best = tank;
    }
  }
  return best;
}

// Обидчик в окне — цель сразу; текущая держится до пересмотра; при пересмотре — ближайший свободный противник,
// неуязвимый — только если других свободных нет. Свободный — на нём меньше MAX_HUNTERS других ботов.
export function chooseTarget(
  view: CrowdView,
  currentId: number | null,
  isDue: boolean,
  isFull: (id: number) => boolean,
): number | null {
  const attacker = nearest(
    view.me,
    view.enemies.filter((tank) => view.attackers.includes(tank.id)),
  );
  if (attacker !== undefined) {
    return attacker.id;
  }
  const current = view.enemies.find((tank) => tank.id === currentId);
  if (current !== undefined && !isDue) {
    return current.id;
  }
  const free = view.enemies.filter((tank) => tank.id === currentId || !isFull(tank.id));
  const open = free.filter((tank) => tank.shieldLeft <= 0);
  const best = nearest(view.me, open.length > 0 ? open : free);
  if (best === undefined) {
    return null;
  }
  if (current !== undefined && distance(view.me, current) <= distance(view.me, best) * SWITCH_RATIO) {
    return current.id;
  }
  return best.id;
}

// Цель одного бота: пересмотр раз в секунду, запись в общий учёт роя.
export class Targeting {
  private targetId: number | null = null;
  private pickedTick = -Infinity;

  constructor(
    private readonly book: TargetBook,
    private readonly owner: object,
  ) {}

  release(): void {
    this.targetId = null;
    this.pickedTick = -Infinity;
    this.book.claim(this.owner, '', null);
  }

  pick(view: CrowdView, gameId: string): CrowdTank | null {
    const isDue = view.tick - this.pickedTick >= RETARGET_TICKS;
    const next = chooseTarget(
      view,
      this.targetId,
      isDue,
      (id) => this.book.hunters(gameId, id, this.owner) >= MAX_HUNTERS,
    );
    if (isDue || next !== this.targetId) {
      this.pickedTick = view.tick;
    }
    this.targetId = next;
    this.book.claim(this.owner, gameId, next);
    return view.enemies.find((tank) => tank.id === next) ?? null;
  }
}
