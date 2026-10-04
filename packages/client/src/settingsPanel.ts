import { PHONE_CAMERA_MODES, type PhoneCameraMode } from './render/cameraStrategy.js';
import {
  BOOLEAN_FIELDS,
  NUMERIC_FIELDS,
  type BooleanSettingField,
  type BooleanSettingKey,
  type NumericSettingField,
  type SettingsStore,
} from './settings.js';

const MODE_ACTIVE_CLASS = 'is-active';
const ADMIN_GROUP_TITLE = 'Для настройки';

// Панель настроек в бою: ползунки меняют хранилище сразу, игра читает его каждый тик — результат виден не выходя
// из боя. Поля камеры и флажки `isTouchOnly` показываются только на устройстве с касанием, поля камеры — только
// для выбранной стратегии. Флажок, от которого зависит ползунок, стоит прямо перед ним; остальные флажки — после
// всех ползунков. Админские флажки — отдельной группой внизу, только когда у хранилища есть право.
export class SettingsPanel {
  private readonly rows = new Map<
    NumericSettingField['key'],
    { row: HTMLElement; input: HTMLInputElement; value: HTMLElement }
  >();
  private readonly checks = new Map<BooleanSettingKey, HTMLInputElement>();
  private readonly modeButtons = new Map<PhoneCameraMode, HTMLButtonElement>();

  constructor(
    private readonly root: HTMLElement,
    toggle: HTMLElement,
    private readonly store: SettingsStore,
    isTouchDevice: boolean,
  ) {
    root.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'settings-title';
    title.textContent = 'Настройки';
    root.append(title);
    const cameraFields = NUMERIC_FIELDS.filter((field) => field.modes !== undefined);
    for (const field of NUMERIC_FIELDS) {
      if (cameraFields.includes(field)) {
        continue;
      }
      this.appendFlagBefore(field);
      root.append(this.buildRow(field));
    }
    if (isTouchDevice) {
      root.append(this.buildModeRow());
      for (const field of cameraFields) {
        root.append(this.buildRow(field));
      }
    }
    for (const field of BOOLEAN_FIELDS) {
      const isHidden = field.isTouchOnly === true && !isTouchDevice;
      const isAdminField = field.isAdminOnly === true;
      if (!isHidden && !isAdminField && !this.checks.has(field.key)) {
        root.append(this.buildCheck(field));
      }
    }
    if (store.isAdmin) {
      this.appendAdminGroup();
    }
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

  private appendAdminGroup(): void {
    const title = document.createElement('div');
    title.className = 'settings-group-title';
    title.textContent = ADMIN_GROUP_TITLE;
    this.root.append(title);
    for (const field of BOOLEAN_FIELDS) {
      if (field.isAdminOnly === true) {
        this.root.append(this.buildCheck(field));
      }
    }
  }

  private appendFlagBefore(field: NumericSettingField): void {
    const flag = BOOLEAN_FIELDS.find((candidate) => candidate.key === field.requiresFlag);
    if (flag === undefined || this.checks.has(flag.key)) {
      return;
    }
    this.root.append(this.buildCheck(flag));
  }

  private buildCheck(field: BooleanSettingField): HTMLElement {
    const row = document.createElement('label');
    row.className = 'settings-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => {
      this.store.setFlag(field.key, input.checked);
      this.refresh();
    });
    const name = document.createElement('span');
    name.textContent = field.label;
    const head = document.createElement('div');
    head.className = 'settings-head';
    head.append(input, name);
    const hint = document.createElement('div');
    hint.className = 'settings-hint';
    hint.textContent = field.hint;
    row.append(head, hint);
    this.checks.set(field.key, input);
    return row;
  }

  private buildModeRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const head = document.createElement('div');
    head.className = 'settings-head';
    head.textContent = 'Камера';
    const group = document.createElement('div');
    group.className = 'settings-modes';
    for (const { mode, label } of PHONE_CAMERA_MODES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-mode';
      button.textContent = label;
      button.addEventListener('click', () => {
        this.store.setCameraMode(mode);
        this.refresh();
      });
      this.modeButtons.set(mode, button);
      group.append(button);
    }
    row.append(head, group);
    return row;
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
    this.rows.set(field.key, { row, input, value });
    return row;
  }

  private refresh(): void {
    const mode = this.store.value.cameraMode;
    for (const field of NUMERIC_FIELDS) {
      const row = this.rows.get(field.key);
      if (row === undefined) {
        continue;
      }
      const current = this.store.value[field.key];
      row.input.value = String(current);
      row.value.textContent = formatValue(current, field);
      const isHiddenByMode = field.modes !== undefined && !field.modes.includes(mode);
      const isHiddenByFlag = field.requiresFlag !== undefined && !this.store.value[field.requiresFlag];
      row.row.hidden = isHiddenByMode || isHiddenByFlag;
    }
    for (const [buttonMode, button] of this.modeButtons) {
      button.classList.toggle(MODE_ACTIVE_CLASS, buttonMode === mode);
    }
    for (const [key, input] of this.checks) {
      input.checked = this.store.value[key];
    }
  }
}

function formatValue(value: number, field: NumericSettingField): string {
  const decimals = field.step < 1 ? 2 : 0;
  return value.toFixed(decimals);
}
