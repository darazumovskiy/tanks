import { describe, expect, it } from 'vitest';
import { botView, createRound, type BotView } from '@tanks/shared/engine';
import { HunterBrain } from '../src/bots/hunter.js';

const POLYGON = 0;

// Мозг — функция от вида, как движок: редкие игровые ситуации задаются видом напрямую.
function viewOnPolygon(): BotView {
  const round = createRound(POLYGON, [
    { name: 'Охотник', stats: { armor: 3, engine: 3, gun: 2, reload: 2 } },
    { name: 'Цель', stats: { armor: 3, engine: 3, gun: 2, reload: 2 } },
  ]);
  return botView(round, 0);
}

describe('Охотник на крафтовых видах', () => {
  it('при здоровье ниже 60 % и активной аптечке сворачивает к аптечке, а не к противнику', () => {
    const healthy = viewOnPolygon();
    const wounded = viewOnPolygon();
    for (const kit of wounded.repairKits) {
      kit.isActive = true;
    }
    wounded.me.hp = wounded.me.maxHp * 0.3;

    // Обе аптечки равноудалены от точки появления, первой в карте идёт верхняя — поворот вверх (отрицательный).
    const toEnemy = new HunterBrain().tick(healthy);
    const toKit = new HunterBrain().tick(wounded);
    expect(toKit.turn).toBeLessThan(-0.1);
    expect(toKit.turn).not.toBe(toEnemy.turn);
  });

  it('за краем сжавшейся зоны бросает перестрелку и едет к центру', () => {
    const view = viewOnPolygon();
    view.arena.walls = [];
    view.enemy.x = view.me.x;
    view.enemy.y = view.me.y - 300;
    view.zone.radius = 200;

    const action = new HunterBrain().tick(view);
    expect(action.throttle).toBe(1);
    expect(Math.abs(action.turn)).toBeLessThan(0.1);
  });

  it('цель внутри сплошной стены недостижима: пути нет, едет прямо на цель', () => {
    const view = viewOnPolygon();
    view.arena.walls = [{ x: 1000, y: 0, w: 600, h: 900 }];
    view.enemy.x = 1300;
    view.enemy.y = 450;

    const action = new HunterBrain().tick(view);
    expect(action.throttle).toBe(1);
    expect(Math.abs(action.turn)).toBeLessThan(0.1);
    expect(action.isFiring).toBe(false);
  });
});
