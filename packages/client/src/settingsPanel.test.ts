import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings, NUMERIC_FIELDS, SettingsStore } from './settings.js';
import { SettingsPanel } from './settingsPanel.js';

const DEFAULT_SETTINGS = defaultSettings(true);
const PLAYER = { isAdmin: false };
const ADMIN = { isAdmin: true };
const AUTO_AIM_LABEL = 'Башня сама держит противника';
const GUARD_LABEL = 'Предохранитель';
const AIM_LINE_LABEL = 'Линия выстрела';
const LEAD_HINT_LABEL = 'Подсказка упреждения';
const ZONE_FIRE_LABEL = 'Огонь по цели';
const ADMIN_GROUP_TITLE = 'Для настройки';

describe('SettingsPanel', () => {
  let root: HTMLElement;
  let toggle: HTMLButtonElement;
  let store: SettingsStore;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    root = document.createElement('aside');
    root.hidden = true;
    toggle = document.createElement('button');
    document.body.append(root, toggle);
    store = new SettingsStore(localStorage, DEFAULT_SETTINGS, PLAYER);
    new SettingsPanel(root, toggle, store, true);
  });

  const rangeFor = (key: string): HTMLInputElement => {
    const field = NUMERIC_FIELDS.find((candidate) => candidate.key === key);
    const input = Array.from(root.querySelectorAll<HTMLLabelElement>('label.settings-row'))
      .find(
        (row) =>
          row.querySelector('.settings-head span')?.textContent === field?.label &&
          row.querySelector('.settings-hint')?.textContent === field?.hint,
      )
      ?.querySelector<HTMLInputElement>('input[type=range]');
    if (input === undefined || input === null) {
      throw new Error(`нет ползунка ${key}`);
    }
    return input;
  };

  const rowOf = (key: string): HTMLElement => {
    const row = rangeFor(key).closest<HTMLElement>('.settings-row');
    if (row === null) {
      throw new Error(`нет строки ${key}`);
    }
    return row;
  };

  const checkFor = (label: string): HTMLInputElement => {
    const input = Array.from(root.querySelectorAll<HTMLLabelElement>('label.settings-check'))
      .find((row) => row.querySelector('.settings-head span')?.textContent === label)
      ?.querySelector<HTMLInputElement>('input[type=checkbox]');
    if (input === undefined || input === null) {
      throw new Error(`нет флажка ${label}`);
    }
    return input;
  };

  const press = (): void => {
    toggle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, pointerType: 'touch', isPrimary: false }));
  };

  it('касание кнопки открывает и закрывает панель, даже если палец не главный', () => {
    press();
    expect(root.hidden).toBe(false);
    press();
    expect(root.hidden).toBe(true);
  });

  it('клавиша Enter на кнопке тоже переключает', () => {
    toggle.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    expect(root.hidden).toBe(false);
  });

  it('ползунки показывают текущие значения и меняют хранилище сразу', () => {
    expect(rangeFor('stickRadiusPx').value).toBe(String(DEFAULT_SETTINGS.stickRadiusPx));
    const radius = rangeFor('stickRadiusPx');
    radius.value = '90';
    radius.dispatchEvent(new Event('input'));
    expect(store.value.stickRadiusPx).toBe(90);
    expect(new SettingsStore(localStorage, DEFAULT_SETTINGS, PLAYER).value.stickRadiusPx).toBe(90);
  });

  it('ползунок «Разворот» стоит на 0,5 и пишет порог газа в хранилище', () => {
    const pivot = rangeFor('pivotThrottle');
    expect(pivot.value).toBe('0.5');
    pivot.value = '0.8';
    pivot.dispatchEvent(new Event('input'));
    expect(store.value.pivotThrottle).toBe(0.8);
    expect(localStorage.getItem('tanks.settings')).toContain('"pivotThrottle":0.8');
  });

  it('флажок графика кадров', () => {
    const checkbox = checkFor('График кадров');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(store.value.showFrameGraph).toBe(true);
  });

  it('флажок автоведения на телефоне отмечен по умолчанию, снятие уходит в хранилище', () => {
    const checkbox = checkFor(AUTO_AIM_LABEL);
    expect(checkbox.checked).toBe(true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    expect(store.value.hasAutoAim).toBe(false);
    expect(localStorage.getItem('tanks.settings')).toContain('"hasAutoAim":false');
    root.querySelector<HTMLButtonElement>('button.settings-reset')?.click();
    expect(checkFor(AUTO_AIM_LABEL).checked).toBe(true);
  });

  const desktopCheckLabels = (): (string | null)[] => {
    const desktopRoot = document.createElement('aside');
    document.body.append(desktopRoot);
    const desktopStore = new SettingsStore(localStorage, defaultSettings(false), PLAYER);
    new SettingsPanel(desktopRoot, document.createElement('button'), desktopStore, false);
    return Array.from(desktopRoot.querySelectorAll<HTMLLabelElement>('label.settings-check')).map(
      (row) => row.querySelector('.settings-head span')?.textContent ?? null,
    );
  };

  it('на компьютере флажок автоведения есть и снят по умолчанию', () => {
    const desktopRoot = document.createElement('aside');
    document.body.append(desktopRoot);
    const desktopStore = new SettingsStore(localStorage, defaultSettings(false), PLAYER);
    new SettingsPanel(desktopRoot, document.createElement('button'), desktopStore, false);
    const checkbox = Array.from(desktopRoot.querySelectorAll<HTMLLabelElement>('label.settings-check'))
      .find((row) => row.querySelector('.settings-head span')?.textContent === AUTO_AIM_LABEL)
      ?.querySelector<HTMLInputElement>('input[type=checkbox]');
    expect(checkbox?.checked).toBe(false);
  });

  it('флажок предохранителя снят по умолчанию, отметка уходит в хранилище', () => {
    const checkbox = checkFor(GUARD_LABEL);
    expect(checkbox.checked).toBe(false);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(store.value.hasRicochetGuard).toBe(true);
    expect(localStorage.getItem('tanks.settings')).toContain('"hasRicochetGuard":true');
  });

  it('на компьютере есть предохранитель и линия выстрела', () => {
    const labels = desktopCheckLabels();
    expect(labels).toContain(GUARD_LABEL);
    expect(labels).toContain(AIM_LINE_LABEL);
  });

  const checkLabels = (panelRoot: HTMLElement): (string | null)[] =>
    Array.from(panelRoot.querySelectorAll<HTMLLabelElement>('label.settings-check')).map(
      (row) => row.querySelector('.settings-head span')?.textContent ?? null,
    );

  it('без админ-режима: линия выстрела есть, подсказки упреждения и группы «Для настройки» нет', () => {
    const labels = checkLabels(root);
    expect(labels).toContain(AIM_LINE_LABEL);
    expect(labels).not.toContain(LEAD_HINT_LABEL);
    expect(labels).not.toContain(ZONE_FIRE_LABEL);
    expect(root.querySelector('.settings-group-title')).toBeNull();
    const aimLine = checkFor(AIM_LINE_LABEL);
    expect(aimLine.checked).toBe(true);
    aimLine.checked = false;
    aimLine.dispatchEvent(new Event('change'));
    expect(store.value.hasAimLine).toBe(false);
  });

  it('в админ-режиме: группа «Для настройки» внизу с флажком упреждения, отметка уходит в хранилище', () => {
    const adminRoot = document.createElement('aside');
    document.body.append(adminRoot);
    const adminStore = new SettingsStore(localStorage, DEFAULT_SETTINGS, ADMIN);
    new SettingsPanel(adminRoot, document.createElement('button'), adminStore, true);
    const title = adminRoot.querySelector('.settings-group-title');
    expect(title?.textContent).toBe(ADMIN_GROUP_TITLE);
    const labels = checkLabels(adminRoot);
    expect(labels.slice(-2)).toEqual([LEAD_HINT_LABEL, ZONE_FIRE_LABEL]);
    const order = Array.from(adminRoot.querySelectorAll('.settings-check, .settings-group-title'));
    const leadRow = Array.from(adminRoot.querySelectorAll<HTMLLabelElement>('label.settings-check')).find(
      (row) => row.querySelector('.settings-head span')?.textContent === LEAD_HINT_LABEL,
    );
    expect(title).not.toBeNull();
    expect(leadRow).toBeDefined();
    if (title !== null && leadRow !== undefined) {
      expect(order.indexOf(title)).toBe(order.indexOf(leadRow) - 1);
      const checkbox = leadRow.querySelector<HTMLInputElement>('input[type=checkbox]');
      expect(checkbox?.checked).toBe(false);
      if (checkbox !== null) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));
      }
      expect(adminStore.value.hasLeadHint).toBe(true);
      expect(localStorage.getItem('tanks.settings')).toContain('"hasLeadHint":true');
    }
  });

  it('огонь по цели: в админ-режиме на телефоне флажок есть и пишет флаг, на компьютере его нет', () => {
    const phoneRoot = document.createElement('aside');
    document.body.append(phoneRoot);
    const phoneStore = new SettingsStore(localStorage, DEFAULT_SETTINGS, ADMIN);
    new SettingsPanel(phoneRoot, document.createElement('button'), phoneStore, true);
    const checkbox = Array.from(phoneRoot.querySelectorAll<HTMLLabelElement>('label.settings-check'))
      .find((row) => row.querySelector('.settings-head span')?.textContent === ZONE_FIRE_LABEL)
      ?.querySelector<HTMLInputElement>('input[type=checkbox]');
    expect(checkbox?.checked).toBe(false);
    if (checkbox !== null && checkbox !== undefined) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change'));
    }
    expect(phoneStore.value.hasZoneFire).toBe(true);
    expect(localStorage.getItem('tanks.settings')).toContain('"hasZoneFire":true');

    const desktopRoot = document.createElement('aside');
    document.body.append(desktopRoot);
    const desktopStore = new SettingsStore(localStorage, defaultSettings(false), ADMIN);
    new SettingsPanel(desktopRoot, document.createElement('button'), desktopStore, false);
    const desktopLabels = checkLabels(desktopRoot);
    expect(desktopLabels).toContain(LEAD_HINT_LABEL);
    expect(desktopLabels).not.toContain(ZONE_FIRE_LABEL);
  });

  it('флажок кольца огня стоит перед ползунком радиуса и показывает его только включённым', () => {
    expect(store.value.hasFireRing).toBe(false);
    expect(rowOf('fireRing').hidden).toBe(true);
    const checkbox = checkFor('Кольцо огня');
    expect(checkbox.checked).toBe(false);
    const order = Array.from(root.querySelectorAll('.settings-check, .settings-row'));
    const checkRow = checkbox.closest('.settings-check');
    expect(checkRow).not.toBeNull();
    if (checkRow !== null) {
      expect(order.indexOf(checkRow)).toBe(order.indexOf(rowOf('fireRing')) - 1);
    }
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(store.value.hasFireRing).toBe(true);
    expect(rowOf('fireRing').hidden).toBe(false);
    root.querySelector<HTMLButtonElement>('button.settings-reset')?.click();
    expect(checkFor('Кольцо огня').checked).toBe(false);
    expect(rowOf('fireRing').hidden).toBe(true);
  });

  it('сброс возвращает умолчания и обновляет ползунки', () => {
    const deadZone = rangeFor('deadZone');
    deadZone.value = '0.4';
    deadZone.dispatchEvent(new Event('input'));
    root.querySelector<HTMLButtonElement>('button.settings-reset')?.click();
    expect(store.value.deadZone).toBe(DEFAULT_SETTINGS.deadZone);
    expect(rangeFor('deadZone').value).toBe(String(DEFAULT_SETTINGS.deadZone));
  });

  it('открытие панели подтягивает значения, изменённые вне её', () => {
    store.setNumber('minViewPercent', 50);
    press();
    expect(rangeFor('minViewPercent').value).toBe('50');
  });

  it('кнопки режима камеры меняют хранилище и показывают только поля выбранного режима', () => {
    expect(rowOf('followLagMs').hidden).toBe(false);
    expect(rowOf('zoomLagMs').hidden).toBe(true);
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button.settings-mode'));
    expect(buttons.map((button) => button.textContent)).toEqual(['За своим', 'За своим + отдаление', 'Оба в кадре']);
    buttons[2]?.click();
    expect(store.value.cameraMode).toBe('pair');
    expect(buttons[2]?.classList.contains('is-active')).toBe(true);
    expect(rowOf('followLagMs').hidden).toBe(true);
    expect(rowOf('zoomLagMs').hidden).toBe(false);
    expect(rowOf('pairVoidPercent').hidden).toBe(false);
    expect(rowOf('minViewPercent').hidden).toBe(false);
    buttons[1]?.click();
    expect(rowOf('followLagMs').hidden).toBe(false);
    expect(rowOf('zoomLagMs').hidden).toBe(false);
    expect(rowOf('pairVoidPercent').hidden).toBe(true);
  });

  it('на компьютере полей камеры нет', () => {
    const desktopRoot = document.createElement('aside');
    document.body.append(desktopRoot);
    new SettingsPanel(desktopRoot, document.createElement('button'), store, false);
    expect(desktopRoot.querySelector('button.settings-mode')).toBeNull();
    const labels = Array.from(desktopRoot.querySelectorAll('.settings-head span:first-child')).map(
      (span) => span.textContent,
    );
    expect(labels).toEqual(['Размер стика', 'Мёртвая зона', 'Разворот', 'Радиус кольца огня']);
  });
});
