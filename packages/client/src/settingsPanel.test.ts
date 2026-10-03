import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, NUMERIC_FIELDS, SettingsStore } from './settings.js';
import { SettingsPanel } from './settingsPanel.js';

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
    store = new SettingsStore(localStorage);
    new SettingsPanel(root, toggle, store);
  });

  const rangeFor = (key: string): HTMLInputElement => {
    const index = NUMERIC_FIELDS.findIndex((field) => field.key === key);
    const input = root.querySelectorAll<HTMLInputElement>('input[type=range]')[index];
    if (input === undefined) {
      throw new Error(`нет ползунка ${key}`);
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
    expect(new SettingsStore(localStorage).value.stickRadiusPx).toBe(90);
  });

  it('флажок графика кадров', () => {
    const checkbox = root.querySelector<HTMLInputElement>('input[type=checkbox]');
    expect(checkbox).not.toBeNull();
    if (checkbox === null) {
      return;
    }
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(store.value.showFrameGraph).toBe(true);
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
});
