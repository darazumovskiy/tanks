import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings, SETTINGS_STORAGE_KEY, SettingsStore } from './settings.js';

describe('parseSettings', () => {
  it('пусто — умолчания', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('мусор и не-объект — умолчания', () => {
    expect(parseSettings('{oops')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('42')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('null')).toEqual(DEFAULT_SETTINGS);
  });

  it('значения вне диапазона зажимаются, неверные типы заменяются умолчанием', () => {
    const settings = parseSettings(
      JSON.stringify({ stickRadiusPx: 500, deadZone: -1, fireRing: 'x', minViewPercent: 55, showFrameGraph: 'yes' }),
    );
    expect(settings.stickRadiusPx).toBe(110);
    expect(settings.deadZone).toBe(0);
    expect(settings.fireRing).toBe(DEFAULT_SETTINGS.fireRing);
    expect(settings.minViewPercent).toBe(55);
    expect(settings.showFrameGraph).toBe(false);
  });

  it('булев флаг читается', () => {
    expect(parseSettings(JSON.stringify({ showFrameGraph: true })).showFrameGraph).toBe(true);
  });
});

describe('SettingsStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('сохраняет изменения и восстанавливает их при следующем запуске', () => {
    const store = new SettingsStore(localStorage);
    store.setNumber('stickRadiusPx', 80);
    store.setShowFrameGraph(true);
    const again = new SettingsStore(localStorage);
    expect(again.value.stickRadiusPx).toBe(80);
    expect(again.value.showFrameGraph).toBe(true);
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).not.toBeNull();
  });

  it('зажимает значение при записи', () => {
    const store = new SettingsStore(localStorage);
    store.setNumber('cameraLagMs', 9999);
    expect(store.value.cameraLagMs).toBe(500);
  });

  it('сброс возвращает умолчания и сохраняет их', () => {
    const store = new SettingsStore(localStorage);
    store.setNumber('minViewPercent', 40);
    store.reset();
    expect(store.value).toEqual(DEFAULT_SETTINGS);
    expect(new SettingsStore(localStorage).value.minViewPercent).toBe(DEFAULT_SETTINGS.minViewPercent);
  });

  it('объект настроек один и тот же — потребители читают изменения без подписки', () => {
    const store = new SettingsStore(localStorage);
    const view = store.value;
    store.setNumber('deadZone', 0.3);
    expect(view.deadZone).toBe(0.3);
  });
});
