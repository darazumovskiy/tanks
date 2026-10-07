import { describe, expect, it } from 'vitest';
import { botView, createRound, type BotView } from '@tanks/shared/engine';
import { ReactionDelay } from './reaction.js';

const POLYGON = 0;
const STATS = { armor: 3, engine: 3, gun: 2, reload: 2 };

// Вид тика `tick`: противник, свой танк и снаряд сдвинуты на номер тика — по полю видно, из какого тика оно взято.
function viewAt(tick: number): BotView {
  const round = createRound(POLYGON, [
    { name: 'Бот', stats: STATS },
    { name: 'Цель', stats: STATS },
  ]);
  const view = botView(round, 0);
  view.tick = tick;
  view.me.x = tick;
  view.enemy.x = tick;
  view.zone.radius = tick;
  view.bullets = [
    { id: tick, x: tick, y: 0, vx: 0, vy: 0, isMine: false, bouncesLeft: 1, damage: 23, canHitOwner: false },
  ];
  return view;
}

function perceiveTicks(delay: ReactionDelay, count: number): BotView[] {
  return Array.from({ length: count }, (_, tick) => delay.perceive(viewAt(tick)));
}

describe('задержка реакции', () => {
  it('без задержки мозг видит свежий вид как есть', () => {
    const delay = new ReactionDelay(0);
    const fresh = viewAt(5);
    expect(delay.perceive(fresh)).toEqual(fresh);
  });

  it('пока истории меньше задержки — противник и снаряды из самого старого вида, остальное свежее', () => {
    const seen = perceiveTicks(new ReactionDelay(3), 3);
    for (const [tick, view] of seen.entries()) {
      expect(view.enemy.x).toBe(0);
      expect(view.bullets.map((bullet) => bullet.id)).toEqual([0]);
      expect(view.me.x).toBe(tick);
      expect(view.zone.radius).toBe(tick);
      expect(view.tick).toBe(tick);
    }
  });

  it('с полной историей противник и снаряды — ровно reactionTicks тиков назад', () => {
    const seen = perceiveTicks(new ReactionDelay(3), 10);
    for (const [tick, view] of seen.slice(3).entries()) {
      expect(view.enemy.x).toBe(tick);
      expect(view.bullets.map((bullet) => bullet.id)).toEqual([tick]);
      expect(view.me.x).toBe(tick + 3);
    }
  });
});
