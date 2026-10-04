import { beforeEach, describe, expect, it } from 'vitest';
import { STAT_POINTS, type Stats } from '@tanks/shared/engine';
import { mountStatsPicker, PRESETS, statsLeft, statsTotal } from './statsPicker.js';

let container: HTMLElement;
let latest: Stats | null;

function pip(stat: string, level: number): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `.stat-pip[data-stat="${stat}"][data-level="${String(level)}"]`,
  );
  if (button === null) {
    throw new Error(`нет деления ${stat} ${String(level)}`);
  }
  return button;
}

function filledCount(stat: string): number {
  return container.querySelectorAll(`.stat-pip[data-stat="${stat}"].is-filled`).length;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="stats-picker"></div>';
  container = document.querySelector<HTMLElement>('#stats-picker') ?? document.body;
  latest = null;
});

describe('распределение характеристик', () => {
  it('каждый пресет раздаёт ровно все очки', () => {
    for (const preset of PRESETS) {
      expect(statsTotal(preset.stats)).toBe(STAT_POINTS);
    }
  });

  it('рисует четыре строки с подписями и показывает текущее распределение', () => {
    const picker = mountStatsPicker(container, { armor: 3, engine: 3, gun: 2, reload: 2 }, (stats) => (latest = stats));
    expect(container.querySelectorAll('.stat-row').length).toBe(4);
    expect(container.querySelector('.stat-name')?.textContent).toBe('Броня');
    expect(filledCount('armor')).toBe(3);
    expect(filledCount('gun')).toBe(2);
    expect(container.querySelector('.stats-left')?.textContent).toBe('Все очки розданы');
    expect(picker.value()).toEqual({ armor: 3, engine: 3, gun: 2, reload: 2 });
    expect(latest).toEqual({ armor: 3, engine: 3, gun: 2, reload: 2 });
  });

  it('деление ставит значение, повторный тап в текущее снимает очко, лишнего не даёт', () => {
    const picker = mountStatsPicker(container, { armor: 3, engine: 3, gun: 2, reload: 2 }, () => undefined);
    pip('armor', 3).click();
    expect(picker.value().armor).toBe(2);
    expect(container.querySelector('.stats-left')?.textContent).toBe('Осталось очков: 1');
    pip('gun', 5).click();
    expect(picker.value().gun).toBe(3);
    expect(statsLeft(picker.value())).toBe(0);
    expect(pip('reload', 5).classList.contains('is-disabled')).toBe(true);
    pip('armor', 1).click();
    expect(picker.value().armor).toBe(1);
    expect(statsLeft(picker.value())).toBe(1);
  });

  it('пресет ставит раскладку целиком и подсвечивается, пока раскладка совпадает', () => {
    const picker = mountStatsPicker(container, { armor: 3, engine: 3, gun: 2, reload: 2 }, () => undefined);
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.stats-preset'));
    expect(buttons[0]?.classList.contains('is-selected')).toBe(true);
    buttons[3]?.click();
    expect(picker.value()).toEqual({ armor: 1, engine: 1, gun: 5, reload: 3 });
    expect(buttons[3]?.classList.contains('is-selected')).toBe(true);
    expect(buttons[0]?.classList.contains('is-selected')).toBe(false);
    pip('armor', 1).click();
    expect(picker.value().armor).toBe(0);
    expect(buttons[3]?.classList.contains('is-selected')).toBe(false);
  });
});
