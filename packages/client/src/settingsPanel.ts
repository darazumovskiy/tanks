import { AIM_LINE_STYLES, aimLineStyleById, drawAimLinePreview, type AimLineStyleId } from './render/aimLineStyles.js';
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
const STYLE_FLAG: BooleanSettingKey = 'hasAimLine';
const STYLE_LABEL = 'Вид прицела';
const STYLE_OPEN_CLASS = 'is-open';
const STYLE_SELECTED_CLASS = 'is-selected';
const PREVIEW_WIDTH = 160;
const PREVIEW_HEIGHT = 16;

// Полоска-превью стиля: нейтральный вид слева направо в CSS-пикселях, с плотностью экрана.
function stylePreview(id: AimLineStyleId): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'style-preview';
  const ratio = window.devicePixelRatio;
  canvas.width = Math.round(PREVIEW_WIDTH * ratio);
  canvas.height = Math.round(PREVIEW_HEIGHT * ratio);
  canvas.style.width = `${String(PREVIEW_WIDTH)}px`;
  canvas.style.height = `${String(PREVIEW_HEIGHT)}px`;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    ctx.scale(ratio, ratio);
    drawAimLinePreview(ctx, aimLineStyleById(id).style, PREVIEW_WIDTH, PREVIEW_HEIGHT);
  }
  return canvas;
}

interface StyleRow {
  row: HTMLElement;
  toggle: HTMLButtonElement;
  list: HTMLElement;
  options: Map<AimLineStyleId, HTMLButtonElement>;
}

// isTouchDevice — флажки `isTouchOnly` и группа камеры; hasCameraGroup — у режима есть стратегии камеры
// (в бою толпы камера одна).
export interface SettingsPanelOptions {
  isTouchDevice: boolean;
  hasCameraGroup: boolean;
}

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
  private styleRow: StyleRow | null = null;

  constructor(
    private readonly root: HTMLElement,
    toggle: HTMLElement,
    private readonly store: SettingsStore,
    { isTouchDevice, hasCameraGroup }: SettingsPanelOptions,
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
    if (isTouchDevice && hasCameraGroup) {
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
      if (field.key === STYLE_FLAG) {
        root.append(this.buildStyleRow());
      }
    }
    if (store.isAdmin) {
      this.appendAdminGroup(isTouchDevice);
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

  private appendAdminGroup(isTouchDevice: boolean): void {
    const title = document.createElement('div');
    title.className = 'settings-group-title';
    title.textContent = ADMIN_GROUP_TITLE;
    this.root.append(title);
    for (const field of BOOLEAN_FIELDS) {
      const isHidden = field.isTouchOnly === true && !isTouchDevice;
      if (field.isAdminOnly === true && !isHidden) {
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

  // Выпадающий список стилей линии: кнопка показывает выбранный с полоской-превью, список — все стили.
  private buildStyleRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'settings-row settings-style';
    const head = document.createElement('div');
    head.className = 'settings-head';
    head.textContent = STYLE_LABEL;
    const picker = document.createElement('div');
    picker.className = 'style-picker';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'style-toggle';
    toggle.setAttribute('aria-haspopup', 'listbox');
    toggle.setAttribute('aria-expanded', 'false');
    const list = document.createElement('div');
    list.className = 'style-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    const options = new Map<AimLineStyleId, HTMLButtonElement>();
    const setOpen = (isOpen: boolean): void => {
      list.hidden = !isOpen;
      toggle.classList.toggle(STYLE_OPEN_CLASS, isOpen);
      toggle.setAttribute('aria-expanded', String(isOpen));
    };
    for (const entry of AIM_LINE_STYLES) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'style-option';
      option.dataset.style = entry.id;
      option.setAttribute('role', 'option');
      const name = document.createElement('span');
      name.className = 'style-name';
      name.textContent = entry.title;
      const hint = document.createElement('span');
      hint.className = 'style-hint';
      hint.textContent = entry.hint;
      option.append(name, stylePreview(entry.id), hint);
      option.addEventListener('click', () => {
        this.store.setAimLineStyle(entry.id);
        setOpen(false);
        this.refresh();
      });
      options.set(entry.id, option);
      list.append(option);
    }
    toggle.addEventListener('click', () => {
      setOpen(list.hidden);
    });
    picker.append(toggle, list);
    row.append(head, picker);
    this.styleRow = { row, toggle, list, options };
    return row;
  }

  private refreshStyleRow(): void {
    const styleRow = this.styleRow;
    if (styleRow === null) {
      return;
    }
    const current = this.store.value.aimLineStyle;
    styleRow.row.hidden = !this.store.value[STYLE_FLAG];
    const name = document.createElement('span');
    name.className = 'style-name';
    name.textContent = aimLineStyleById(current).title;
    const chevron = document.createElement('span');
    chevron.className = 'dropdown-chevron';
    chevron.textContent = '▾';
    styleRow.toggle.replaceChildren(name, chevron, stylePreview(current));
    for (const [id, option] of styleRow.options) {
      const isSelected = id === current;
      option.classList.toggle(STYLE_SELECTED_CLASS, isSelected);
      option.setAttribute('aria-selected', String(isSelected));
    }
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
    this.refreshStyleRow();
  }
}

function formatValue(value: number, field: NumericSettingField): string {
  const decimals = field.step < 1 ? 2 : 0;
  return value.toFixed(decimals);
}
