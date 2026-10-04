import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings, parseSettings, SETTINGS_STORAGE_KEY, SettingsStore } from './settings.js';

const PHONE_DEFAULTS = defaultSettings(true);
const DESKTOP_DEFAULTS = defaultSettings(false);

describe('defaultSettings', () => {
  it('автоведение включено только на устройстве с касанием, остальное одинаково', () => {
    expect(PHONE_DEFAULTS.hasAutoAim).toBe(true);
    expect(DESKTOP_DEFAULTS.hasAutoAim).toBe(false);
    expect({ ...PHONE_DEFAULTS, hasAutoAim: false }).toEqual(DESKTOP_DEFAULTS);
  });

  it('предохранитель и быстрый задний ход выключены на обоих устройствах', () => {
    expect(PHONE_DEFAULTS.hasRicochetGuard).toBe(false);
    expect(PHONE_DEFAULTS.hasQuickReverse).toBe(false);
    expect(DESKTOP_DEFAULTS.hasRicochetGuard).toBe(false);
    expect(DESKTOP_DEFAULTS.hasQuickReverse).toBe(false);
  });
});

describe('parseSettings', () => {
  it('пусто — умолчания устройства', () => {
    expect(parseSettings(null, PHONE_DEFAULTS)).toEqual(PHONE_DEFAULTS);
    expect(parseSettings(null, DESKTOP_DEFAULTS)).toEqual(DESKTOP_DEFAULTS);
  });

  it('мусор и не-объект — умолчания', () => {
    expect(parseSettings('{oops', PHONE_DEFAULTS)).toEqual(PHONE_DEFAULTS);
    expect(parseSettings('42', PHONE_DEFAULTS)).toEqual(PHONE_DEFAULTS);
    expect(parseSettings('null', PHONE_DEFAULTS)).toEqual(PHONE_DEFAULTS);
  });

  it('значения вне диапазона зажимаются, неверные типы заменяются умолчанием', () => {
    const settings = parseSettings(
      JSON.stringify({ stickRadiusPx: 500, deadZone: -1, fireRing: 'x', minViewPercent: 55, showFrameGraph: 'yes' }),
      PHONE_DEFAULTS,
    );
    expect(settings.stickRadiusPx).toBe(110);
    expect(settings.deadZone).toBe(0);
    expect(settings.fireRing).toBe(PHONE_DEFAULTS.fireRing);
    expect(settings.minViewPercent).toBe(55);
    expect(settings.showFrameGraph).toBe(false);
  });

  it('булевы флаги читаются; запись без флага получает умолчание устройства', () => {
    const settings = parseSettings(JSON.stringify({ showFrameGraph: true, hasFireRing: true }), PHONE_DEFAULTS);
    expect(settings.showFrameGraph).toBe(true);
    expect(settings.hasFireRing).toBe(true);
    const legacy = JSON.stringify({ stickRadiusPx: 60 });
    expect(parseSettings(legacy, PHONE_DEFAULTS).hasFireRing).toBe(false);
    expect(parseSettings(legacy, PHONE_DEFAULTS).hasAutoAim).toBe(true);
    expect(parseSettings(legacy, DESKTOP_DEFAULTS).hasAutoAim).toBe(false);
    expect(parseSettings(JSON.stringify({ hasAutoAim: false }), PHONE_DEFAULTS).hasAutoAim).toBe(false);
  });

  it('флаги предохранителя и быстрого заднего хода: без записи — false, с записью — читаются', () => {
    const legacy = parseSettings(JSON.stringify({ stickRadiusPx: 60 }), PHONE_DEFAULTS);
    expect(legacy.hasRicochetGuard).toBe(false);
    expect(legacy.hasQuickReverse).toBe(false);
    const enabled = parseSettings(JSON.stringify({ hasRicochetGuard: true, hasQuickReverse: true }), DESKTOP_DEFAULTS);
    expect(enabled.hasRicochetGuard).toBe(true);
    expect(enabled.hasQuickReverse).toBe(true);
  });
});

describe('SettingsStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('сохраняет изменения и восстанавливает их при следующем запуске', () => {
    const store = new SettingsStore(localStorage, PHONE_DEFAULTS);
    store.setNumber('stickRadiusPx', 80);
    store.setFlag('showFrameGraph', true);
    store.setFlag('hasFireRing', true);
    store.setFlag('hasAutoAim', false);
    const again = new SettingsStore(localStorage, PHONE_DEFAULTS);
    expect(again.value.stickRadiusPx).toBe(80);
    expect(again.value.showFrameGraph).toBe(true);
    expect(again.value.hasFireRing).toBe(true);
    expect(again.value.hasAutoAim).toBe(false);
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).not.toBeNull();
  });

  it('зажимает значение при записи', () => {
    const store = new SettingsStore(localStorage, PHONE_DEFAULTS);
    store.setNumber('followLagMs', 9999);
    expect(store.value.followLagMs).toBe(500);
  });

  it('режим камеры сохраняется; неизвестный режим и прежний ключ догона — умолчания', () => {
    const store = new SettingsStore(localStorage, PHONE_DEFAULTS);
    store.setCameraMode('pair');
    expect(new SettingsStore(localStorage, PHONE_DEFAULTS).value.cameraMode).toBe('pair');
    const legacy = parseSettings(
      JSON.stringify({ cameraMode: 'orbit', cameraLagMs: 50, zoomLagMs: 10 }),
      PHONE_DEFAULTS,
    );
    expect(legacy.cameraMode).toBe(PHONE_DEFAULTS.cameraMode);
    expect(legacy.followLagMs).toBe(PHONE_DEFAULTS.followLagMs);
    expect(legacy.zoomLagMs).toBe(10);
  });

  it('сброс возвращает умолчания своего устройства и сохраняет их', () => {
    const store = new SettingsStore(localStorage, PHONE_DEFAULTS);
    store.setNumber('minViewPercent', 40);
    store.setFlag('hasAutoAim', false);
    store.reset();
    expect(store.value).toEqual(PHONE_DEFAULTS);
    expect(new SettingsStore(localStorage, PHONE_DEFAULTS).value.minViewPercent).toBe(PHONE_DEFAULTS.minViewPercent);
    const desktop = new SettingsStore(localStorage, DESKTOP_DEFAULTS);
    desktop.setFlag('hasAutoAim', true);
    desktop.reset();
    expect(desktop.value.hasAutoAim).toBe(false);
  });

  it('объект настроек один и тот же — потребители читают изменения без подписки', () => {
    const store = new SettingsStore(localStorage, PHONE_DEFAULTS);
    const view = store.value;
    store.setNumber('deadZone', 0.3);
    expect(view.deadZone).toBe(0.3);
  });
});
