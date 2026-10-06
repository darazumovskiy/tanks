import { exitPointOf, HIDDEN_AIM_TARGETS, ricochetAngleOf, type HiddenAimTarget } from '@tanks/analysis';
import { nextRandom, type MapDef, type Point, type Random, type TankView } from '@tanks/shared/engine';

// Точка выхода и рикошет пересчитываются раз в 10 тиков.
const REPLAN_TICKS = 10;

// hold — башню не ведут: она остаётся, куда смотрела.
export type HiddenAimChoice = HiddenAimTarget | 'hold';

interface Planned {
  point: Point | null;
  tick: number;
}

const UNPLANNED: Planned = { point: null, tick: -Infinity };

// Куда двойник ведёт башню, когда противника не видно: цель выбирается при потере видимости, на каждом решении
// манёвра и при выходе из позиции, у каждой цели своя доля решений, в остальных башню не ведут. Доли берутся по
// порядку целей: при сумме больше 1 последним достаётся меньше. Цели, которой сейчас нет (нет пути, рикошета,
// противник ещё не был виден), заменяет пеленг.
export class HiddenAim {
  private choice: HiddenAimChoice = 'bearing';
  private lastSeen: Point | null = null;
  private planned: Planned = UNPLANNED;

  constructor(
    private readonly shares: Readonly<Record<HiddenAimTarget, number>>,
    private readonly random: Random,
  ) {}

  get current(): HiddenAimChoice {
    return this.choice;
  }

  reset(): void {
    this.choice = 'bearing';
    this.lastSeen = null;
    this.planned = UNPLANNED;
  }

  see(enemy: Point): void {
    this.lastSeen = { x: enemy.x, y: enemy.y };
  }

  pick(): void {
    let roll = nextRandom(this.random);
    this.choice = 'hold';
    this.planned = UNPLANNED;
    for (const target of HIDDEN_AIM_TARGETS) {
      roll -= this.shares[target];
      if (roll < 0) {
        this.choice = target;
        return;
      }
    }
  }

  // Точка, на которую рука ведёт башню; null — пеленг на самого противника.
  point(map: MapDef, me: TankView, enemy: Point, tick: number): Point | null {
    if (this.choice === 'bearing' || this.choice === 'hold') {
      return null;
    }
    if (this.choice === 'lastSeen') {
      return this.lastSeen;
    }
    if (tick - this.planned.tick >= REPLAN_TICKS) {
      this.planned = { point: this.plan(map, me, enemy), tick };
    }
    return this.planned.point;
  }

  private plan(map: MapDef, me: TankView, enemy: Point): Point | null {
    if (this.choice === 'exit') {
      return exitPointOf(map, me, enemy);
    }
    const angle = ricochetAngleOf(map, me, enemy, me.stats.bulletSpeed, me.turret);
    if (angle === null) {
      return null;
    }
    const distance = Math.hypot(enemy.x - me.x, enemy.y - me.y);
    return { x: me.x + Math.cos(angle) * distance, y: me.y + Math.sin(angle) * distance };
  }
}
