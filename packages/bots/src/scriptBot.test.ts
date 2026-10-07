import { describe, expect, it } from 'vitest';
import { botView, createRound, type BotView } from '@tanks/shared/engine';
import { compileArenaBotScript, ScriptBrain } from './scriptBot.js';

const STATS = { armor: 1, engine: 2, gun: 3, reload: 4 };

// Скрипт в формате арены: счётчик ходов и номер раунда живут в переменных модуля.
const COUNTER_SCRIPT = `
let ticks = 0;
let lastRound = -1;
export default {
  name: 'Счётчик',
  stats: { armor: 1, engine: 2, gun: 3, reload: 4 },
  init(info) {
    lastRound = info.round;
  },
  tick(view) {
    ticks++;
    return {
      throttle: ticks / 10,
      turn: view.enemy.alive ? 1 : -1,
      turretTurn: lastRound,
      fire: view.bullets.every((bullet) => !bullet.mine),
    };
  },
};
`;

function duelView(): BotView {
  const round = createRound(0, [
    { name: 'Бот', stats: STATS },
    { name: 'Цель', stats: STATS },
  ]);
  return botView(round, 0);
}

describe('скрипт бота арены из исходного текста', () => {
  it('каждый вызов фабрики — свой экземпляр со своими переменными модуля', () => {
    const createCounter = compileArenaBotScript(COUNTER_SCRIPT);
    const first = new ScriptBrain(createCounter());
    const second = new ScriptBrain(createCounter());
    const view = duelView();

    first.tick(view);
    first.tick(view);
    expect(first.tick(view).throttle).toBeCloseTo(0.3);
    expect(second.tick(view).throttle).toBeCloseTo(0.1);
  });

  it('характеристики берутся из скрипта; реакция мгновенная', () => {
    const brain = new ScriptBrain(compileArenaBotScript(COUNTER_SCRIPT)());
    expect(brain.stats).toEqual(STATS);
    expect(brain.reactionTicks).toBe(0);
  });

  it('вид переводится в формат арены, ответ — в команду движка; раунды считаются от нуля', () => {
    const brain = new ScriptBrain(compileArenaBotScript(COUNTER_SCRIPT)());
    const view = duelView();
    brain.init(view);
    brain.init(view);
    view.enemy.isAlive = false;
    view.bullets = [{ id: 1, x: 0, y: 0, vx: 0, vy: 0, isMine: true, bouncesLeft: 0, damage: 1, canHitOwner: true }];

    const action = brain.tick(view);
    expect(action.turn).toBe(-1);
    expect(action.turretTurn).toBe(1);
    expect(action.isFiring).toBe(false);
  });
});
