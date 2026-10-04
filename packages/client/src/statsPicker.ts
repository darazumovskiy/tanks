import { STAT_KEYS, STAT_MAX, STAT_POINTS, type Stats } from '@tanks/shared/engine';

type StatKey = (typeof STAT_KEYS)[number];

interface StatLabel {
  name: string;
  effect: string;
}

export interface StatsPreset {
  name: string;
  stats: Stats;
}

// Что даёт каждая характеристика — словами игрока, без формул.
const LABELS: Readonly<Record<StatKey, StatLabel>> = {
  armor: { name: 'Броня', effect: 'больше здоровья' },
  engine: { name: 'Двигатель', effect: 'быстрее едет и поворачивает' },
  gun: { name: 'Пушка', effect: 'больнее бьёт, снаряд быстрее' },
  reload: { name: 'Перезарядка', effect: 'чаще стреляет' },
};

export const PRESETS: readonly StatsPreset[] = [
  { name: 'Универсал', stats: { armor: 3, engine: 3, gun: 2, reload: 2 } },
  { name: 'Броненосец', stats: { armor: 5, engine: 1, gun: 2, reload: 2 } },
  { name: 'Гонщик', stats: { armor: 1, engine: 5, gun: 2, reload: 2 } },
  { name: 'Снайпер', stats: { armor: 1, engine: 1, gun: 5, reload: 3 } },
  { name: 'Пулемёт', stats: { armor: 2, engine: 1, gun: 2, reload: 5 } },
];

const SELECTED_CLASS = 'is-selected';
const FILLED_CLASS = 'is-filled';
const DISABLED_CLASS = 'is-disabled';

export function statsTotal(stats: Stats): number {
  return STAT_KEYS.reduce((sum, key) => sum + stats[key], 0);
}

export function statsLeft(stats: Stats): number {
  return STAT_POINTS - statsTotal(stats);
}

function isSameStats(a: Stats, b: Stats): boolean {
  return STAT_KEYS.every((key) => a[key] === b[key]);
}

export interface StatsPicker {
  value: () => Stats;
}

// Четыре характеристики по пять делений; очков на всех ровно STAT_POINTS. Деление ставит значение: ткнул в
// третье — три очка, ткнул в текущее — на одно меньше. Деления, на которые очков уже нет, приглушены.
export function mountStatsPicker(
  container: HTMLElement,
  initial: Stats,
  onChange: (stats: Stats) => void,
): StatsPicker {
  let stats: Stats = { ...initial };
  const pips = new Map<StatKey, HTMLButtonElement[]>();
  const presetButtons: { preset: StatsPreset; button: HTMLButtonElement }[] = [];

  const presets = document.createElement('div');
  presets.className = 'stats-presets';
  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stats-preset';
    button.textContent = preset.name;
    button.addEventListener('click', () => {
      stats = { ...preset.stats };
      render();
    });
    presets.append(button);
    presetButtons.push({ preset, button });
  }

  const rows = document.createElement('div');
  rows.className = 'stats-rows';
  for (const key of STAT_KEYS) {
    const row = document.createElement('div');
    row.className = 'stat-row';
    const text = document.createElement('div');
    text.className = 'stat-text';
    const name = document.createElement('span');
    name.className = 'stat-name';
    name.textContent = LABELS[key].name;
    const effect = document.createElement('span');
    effect.className = 'stat-effect';
    effect.textContent = LABELS[key].effect;
    text.append(name, effect);
    const scale = document.createElement('div');
    scale.className = 'stat-pips';
    scale.setAttribute('role', 'group');
    scale.setAttribute('aria-label', LABELS[key].name);
    const buttons: HTMLButtonElement[] = [];
    for (let level = 1; level <= STAT_MAX; level++) {
      const pip = document.createElement('button');
      pip.type = 'button';
      pip.className = 'stat-pip';
      pip.dataset.stat = key;
      pip.dataset.level = String(level);
      pip.setAttribute('aria-label', `${LABELS[key].name}: ${String(level)}`);
      pip.addEventListener('click', () => {
        const wanted = level === stats[key] ? level - 1 : level;
        const affordable = Math.min(wanted, stats[key] + statsLeft(stats));
        stats = { ...stats, [key]: affordable };
        render();
      });
      buttons.push(pip);
      scale.append(pip);
    }
    pips.set(key, buttons);
    row.append(text, scale);
    rows.append(row);
  }

  const left = document.createElement('div');
  left.className = 'stats-left';

  const render = (): void => {
    const remaining = statsLeft(stats);
    for (const key of STAT_KEYS) {
      for (const pip of pips.get(key) ?? []) {
        const level = Number(pip.dataset.level);
        pip.classList.toggle(FILLED_CLASS, level <= stats[key]);
        pip.classList.toggle(DISABLED_CLASS, level > stats[key] + remaining);
      }
    }
    for (const { preset, button } of presetButtons) {
      button.classList.toggle(SELECTED_CLASS, isSameStats(preset.stats, stats));
    }
    left.textContent = remaining === 0 ? 'Все очки розданы' : `Осталось очков: ${String(remaining)}`;
    left.classList.toggle('is-complete', remaining === 0);
    onChange(stats);
  };

  container.replaceChildren(presets, rows, left);
  render();
  return { value: () => ({ ...stats }) };
}
