import { clamp, MUZZLE_OFFSET, normalizeAngle, type Action, type BotView, type Stats } from '@tanks/shared/engine';
import type { BotBrain } from './arenaBot.js';
import { isClear } from './sight.js';

const THROTTLE = 0.7;
const SWAY_RATE = 0.8;
const TURN_RIGHT = 0.6;
const TURN_LEFT = -0.4;
const AIM_GAIN = 3;
const FIRE_WINDOW_RAD = 0.2;
const SHOT_PAD = 6;

// Уровень 2 — спарринг-бот «Манекен» из tank-arena: кружит по синусоиде, башня на текущее положение противника,
// стреляет каждую перезарядку при наведении. Стен при езде не знает; в стену не стреляет — иначе расстреливает
// себя рикошетами.
export class CarouselBrain implements BotBrain {
  readonly stats: Stats = { armor: 4, engine: 2, gun: 2, reload: 2 };

  tick(view: BotView): Action {
    const { me, enemy } = view;
    const wanted = Math.atan2(enemy.y - me.y, enemy.x - me.x);
    const error = normalizeAngle(wanted - me.turret);
    const muzzleX = me.x + Math.cos(me.turret) * MUZZLE_OFFSET;
    const muzzleY = me.y + Math.sin(me.turret) * MUZZLE_OFFSET;
    const isAimed = Math.abs(error) < FIRE_WINDOW_RAD;
    return {
      throttle: THROTTLE,
      turn: Math.sin(view.time * SWAY_RATE) > 0 ? TURN_RIGHT : TURN_LEFT,
      turretTurn: clamp(error * AIM_GAIN, -1, 1),
      isFiring: isAimed && isClear(view.arena.walls, muzzleX, muzzleY, enemy.x, enemy.y, SHOT_PAD),
    };
  }
}
