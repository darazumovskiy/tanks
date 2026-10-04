import {
  clamp,
  DEFAULT_STATS,
  DT,
  normalizeAngle,
  TICK_RATE,
  TURRET_RATE,
  type Action,
  type BotView,
  type Stats,
  type TankView,
} from '@tanks/shared/engine';
import type { BotBrain } from './arenaBot.js';

const WANDER_MIN_TICKS = TICK_RATE;
const WANDER_MAX_TICKS = TICK_RATE * 2;
const WANDER_THROTTLE = 0.6;
const STUCK_SPEED = 5;
const STUCK_TICKS = TICK_RATE / 2;
const AIM_NOISE_RAD = 0.35;
const AIM_SLOWDOWN = 0.4;
const FIRE_WINDOW_RAD = 0.3;
const FIRE_CHANCE_PER_TICK = 0.3 / TICK_RATE;
const HULL_TURN_RATE = 2;

// Уровень 1. Блуждает случайными курсами, целится медленно и с шумом, стреляет редко.
export class DummyBrain implements BotBrain {
  readonly stats: Stats = { ...DEFAULT_STATS };
  private wanderHeading = 0;
  private wanderTicksLeft = 0;
  private stuckTicks = 0;
  private aimNoise = 0;

  constructor(private readonly random: () => number) {}

  init(): void {
    this.wanderTicksLeft = 0;
    this.stuckTicks = 0;
  }

  tick(view: BotView): Action {
    return { ...this.wander(view.me), ...this.aim(view.me, view.enemy) };
  }

  private wander(me: TankView): Pick<Action, 'throttle' | 'turn'> {
    const isStuck = Math.abs(me.speed) < STUCK_SPEED;
    this.stuckTicks = isStuck ? this.stuckTicks + 1 : 0;
    if (this.wanderTicksLeft <= 0 || this.stuckTicks > STUCK_TICKS) {
      this.wanderHeading = this.random() * Math.PI * 2 - Math.PI;
      this.wanderTicksLeft = Math.round(WANDER_MIN_TICKS + this.random() * (WANDER_MAX_TICKS - WANDER_MIN_TICKS));
      this.stuckTicks = 0;
    }
    this.wanderTicksLeft--;
    const error = normalizeAngle(this.wanderHeading - me.heading);
    return {
      throttle: WANDER_THROTTLE * Math.max(0, Math.cos(error)),
      turn: clamp(error / (HULL_TURN_RATE * DT), -1, 1),
    };
  }

  private aim(me: TankView, enemy: TankView): Pick<Action, 'turretTurn' | 'isFiring'> {
    if (this.random() < 1 / TICK_RATE) {
      this.aimNoise = (this.random() * 2 - 1) * AIM_NOISE_RAD;
    }
    const wanted = Math.atan2(enemy.y - me.y, enemy.x - me.x) + this.aimNoise;
    const error = normalizeAngle(wanted - me.turret);
    const turretTurn = clamp((error / (TURRET_RATE * DT)) * AIM_SLOWDOWN, -1, 1);
    const isOnTarget = Math.abs(error) < FIRE_WINDOW_RAD;
    return { turretTurn, isFiring: isOnTarget && this.random() < FIRE_CHANCE_PER_TICK };
  }
}
