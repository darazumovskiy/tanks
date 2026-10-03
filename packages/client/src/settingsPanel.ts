import { NUMERIC_FIELDS, type NumericSettingField, type SettingsStore } from './settings.js';

// Панель настроек в бою: ползунки меняют хранилище сразу, игра читает его каждый тик — результат виден не выходя из боя.
export class SettingsPanel {
  private readonly rows = new Map<NumericSettingField['key'], { input: HTMLInputElement; value: HTMLElement }>();
  private readonly frameGraph: HTMLInputElement;

  constructor(
    private readonly root: HTMLElement,
    toggle: HTMLElement,
    private readonly store: SettingsStore,
  ) {
    root.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'settings-title';
    title.textContent = 'Настройки';
    root.append(title);
    for (const field of NUMERIC_FIELDS) {
      root.append(this.buildRow(field));
    }
    const graphLabel = document.createElement('label');
    graphLabel.className = 'settings-check';
    this.frameGraph = document.createElement('input');
    this.frameGraph.type = 'checkbox';
    this.frameGraph.addEventListener('change', () => {
      this.store.setShowFrameGraph(this.frameGraph.checked);
    });
    graphLabel.append(this.frameGraph, document.createTextNode(' График кадров'));
    root.append(graphLabel);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'settings-reset';
    reset.textContent = 'Сбросить';
    reset.addEventListener('click', () => {
      this.store.reset();
      this.refresh();
    });
    root.append(reset);
    // Второй палец при зажатом стике не рождает click — слушаем само касание.
    toggle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.toggle();
    });
    toggle.addEventListener('keydown', (event) => {
      if (event.code === 'Enter' || event.code === 'Space') {
        event.preventDefault();
        this.toggle();
      }
    });
    this.refresh();
  }

  toggle(): void {
    this.root.hidden = !this.root.hidden;
    if (!this.root.hidden) {
      this.refresh();
    }
  }

  private buildRow(field: NumericSettingField): HTMLElement {
    const row = document.createElement('label');
    row.className = 'settings-row';
    const head = document.createElement('div');
    head.className = 'settings-head';
    const name = document.createElement('span');
    name.textContent = field.label;
    const value = document.createElement('span');
    value.className = 'settings-value';
    head.append(name, value);
    const hint = document.createElement('div');
    hint.className = 'settings-hint';
    hint.textContent = field.hint;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step);
    input.addEventListener('input', () => {
      this.store.setNumber(field.key, Number(input.value));
      value.textContent = formatValue(this.store.value[field.key], field);
    });
    row.append(head, hint, input);
    this.rows.set(field.key, { input, value });
    return row;
  }

  private refresh(): void {
    for (const field of NUMERIC_FIELDS) {
      const row = this.rows.get(field.key);
      if (row === undefined) {
        continue;
      }
      const current = this.store.value[field.key];
      row.input.value = String(current);
      row.value.textContent = formatValue(current, field);
    }
    this.frameGraph.checked = this.store.value.showFrameGraph;
  }
}

function formatValue(value: number, field: NumericSettingField): string {
  const decimals = field.step < 1 ? 2 : 0;
  return value.toFixed(decimals);
}
