import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings, parseSettings, SETTINGS_STORAGE_KEY, SettingsStore } from './settings.js';

const PHONE_DEFAULTS = defaultSettings();
const DESKTOP_DEFAULTS = defaultSettings();
const PLAYER = { isAdmin: false };
const ADMIN = { isAdmin: true };

describe('defaultSettings', () => {
  it('умолчания одинаковы для телефона и компьютера: предохранитель включён, обзор 85 %', () => {
    expect(PHONE_DEFAULTS).toEqual(DESKTOP_DEFAULTS);
    expect(PHONE_DEFAULTS.hasRicochetGuard).toBe(true);
    expect(PHONE_DEFAULTS.minViewPercent).toBe(85);
  });

  it('порог газа на повороте — 0,6 на обоих устройствах, зажимается в 0–1', () => {
    expect(PHONE_DEFAULTS.pivotThrottle).toBe(0.6);
    expect(DESKTOP_DEFAULTS.pivotThrottle).toBe(0.6);
    expect(parseSettings(JSON.stringify({ pivotThrottle: 3 }), PHONE_DEFAULTS, PLAYER).pivotThrottle).toBe(1);
    expect(parseSettings(JSON.stringify({ pivotThrottle: 0.2 }), PHONE_DEFAULTS, PLAYER).pivotThrottle).toBe(0.2);
  });

  it('линия выстрела включена, подсказка упреждения и огонь по цели выключены на обоих устройствах', () => {
    for (const defaults of [PHONE_DEFAULTS, DESKTOP_DEFAULTS]) {
      expect(defaults.hasAimLine).toBe(true);
      expect(defaults.hasLeadHint).toBe(false);
      expect(defaults.hasZoneFire).toBe(false);
    }
  });
});

describe('parseSettings', () => {
  it('пусто — умолчания устройства', () => {
    expect(parseSettings(null, PHONE_DEFAULTS, PLAYER)).toEqual(PHONE_DEFAULTS);
    expect(parseSettings(null, DESKTOP_DEFAULTS, PLAYER)).toEqual(DESKTOP_DEFAULTS);
  });

  it('мусор и не-объект — умолчания', () => {
    expect(parseSettings('{oops', PHONE_DEFAULTS, PLAYER)).toEqual(PHONE_DEFAULTS);
    expect(parseSettings('42', PHONE_DEFAULTS, PLAYER)).toEqual(PHONE_DEFAULTS);
    expect(parseSettings('null', PHONE_DEFAULTS, PLAYER)).toEqual(PHONE_DEFAULTS);
  });

  it('значения вне диапазона зажимаются, неверные типы заменяются умолчанием', () => {
    const settings = parseSettings(
      JSON.stringify({ stickRadiusPx: 500, deadZone: -1, fireRing: 'x', minViewPercent: 55, showFrameGraph: 'yes' }),
      PHONE_DEFAULTS,
      PLAYER,
    );
    expect(settings.stickRadiusPx).toBe(110);
    expect(settings.deadZone).toBe(0);
    expect(settings.fireRing).toBe(PHONE_DEFAULTS.fireRing);
    expect(settings.minViewPercent).toBe(55);
    expect(settings.showFrameGraph).toBe(false);
  });

  it('булевы флаги читаются; запись без флага получает умолчание устройства', () => {
    const settings = parseSettings(JSON.stringify({ showFrameGraph: true, hasFireRing: true }), PHONE_DEFAULTS, PLAYER);
    expect(settings.showFrameGraph).toBe(true);
    expect(settings.hasFireRing).toBe(true);
    const legacy = JSON.stringify({ stickRadiusPx: 60 });
    expect(parseSettings(legacy, PHONE_DEFAULTS, PLAYER).hasFireRing).toBe(false);
  });

  it('флаг предохранителя: без записи — умолчание true, с записью — читается; старые ключи hasQuickReverse и hasAutoAim не ломают разбор и не попадают в настройки', () => {
    const legacy = parseSettings(JSON.stringify({ stickRadiusPx: 60 }), PHONE_DEFAULTS, PLAYER);
    expect(legacy.hasRicochetGuard).toBe(true);
    const disabled = parseSettings(
      JSON.stringify({ hasRicochetGuard: false, hasQuickReverse: true, hasAutoAim: true }),
      DESKTOP_DEFAULTS,
      PLAYER,
    );
    expect(disabled.hasRicochetGuard).toBe(false);
    expect('hasQuickReverse' in disabled).toBe(false);
    expect('hasAutoAim' in disabled).toBe(false);
  });

  it('линия выстрела читается всем; подсказка упреждения — только с правом админа', () => {
    const raw = JSON.stringify({ hasAimLine: true, hasLeadHint: true });
    const player = parseSettings(raw, DESKTOP_DEFAULTS, PLAYER);
    expect(player.hasAimLine).toBe(true);
    expect(player.hasLeadHint).toBe(false);
    const admin = parseSettings(raw, DESKTOP_DEFAULTS, ADMIN);
    expect(admin.hasAimLine).toBe(true);
    expect(admin.hasLeadHint).toBe(true);
    expect(parseSettings(JSON.stringify({ stickRadiusPx: 60 }), DESKTOP_DEFAULTS, ADMIN).hasLeadHint).toBe(false);
  });

  it('огонь по цели — только с правом админа', () => {
    const raw = JSON.stringify({ hasZoneFire: true });
    expect(parseSettings(raw, PHONE_DEFAULTS, PLAYER).hasZoneFire).toBe(false);
    expect(parseSettings(raw, PHONE_DEFAULTS, ADMIN).hasZoneFire).toBe(true);
  });

  it('вид прицела: умолчание «точки» на обоих устройствах, известный читается, неизвестный — умолчание', () => {
    expect(PHONE_DEFAULTS.aimLineStyle).toBe('dots');
    expect(DESKTOP_DEFAULTS.aimLineStyle).toBe('dots');
    expect(parseSettings(JSON.stringify({ aimLineStyle: 'neon' }), PHONE_DEFAULTS, PLAYER).aimLineStyle).toBe('neon');
    expect(parseSettings(JSON.stringify({ aimLineStyle: 'laser' }), PHONE_DEFAULTS, PLAYER).aimLineStyle).toBe('dots');
    expect(parseSettings(JSON.stringify({ aimLineStyle: 7 }), PHONE_DEFAULTS, PLAYER).aimLineStyle).toBe('dots');
  });
});

describe('SettingsStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('сохраняет изменения и восстанавливает их при следующем запуске', () => {
    const store = new SettingsStore(localStorage, PHONE_DEFAULTS, PLAYER);
    store.setNumber('stickRadiusPx', 80);
    store.setFlag('showFrameGraph', true);
    store.setFlag('hasFireRing', true);
    store.setFlag('hasRicochetGuard', false);
    const again = new SettingsStore(localStorage, PHONE_DEFAULTS, PLAYER);
    expect(again.value.stickRadiusPx).toBe(80);
    expect(again.value.showFrameGraph).toBe(true);
    expect(again.value.hasFireRing).toBe(true);
    expect(again.value.hasRicochetGuard).toBe(false);
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).not.toBeNull();
  });

  it('зажимает значение при записи', () => {
    const store = new SettingsStore(localStorage, PHONE_DEFAULTS, PLAYER);
    store.setNumber('followLagMs', 9999);
    expect(store.value.followLagMs).toBe(500);
  });

  it('вид прицела сохраняется и читается обратно', () => {
    const store = new SettingsStore(localStorage, PHONE_DEFAULTS, PLAYER);
    store.setAimLineStyle('neon');
    expect(new SettingsStore(localStorage, PHONE_DEFAULTS, PLAYER).value.aimLineStyle).toBe('neon');
  });

  it('режим камеры сохраняется; неизвестный режим и прежний ключ догона — умолчания', () => {
    const store = new SettingsStore(localStorage, PHONE_DEFAULTS, PLAYER);
    store.setCameraMode('pair');
    expect(new SettingsStore(localStorage, PHONE_DEFAULTS, PLAYER).value.cameraMode).toBe('pair');
    const legacy = parseSettings(
      JSON.stringify({ cameraMode: 'orbit', cameraLagMs: 50, zoomLagMs: 10 }),
      PHONE_DEFAULTS,
      PLAYER,
    );
    expect(legacy.cameraMode).toBe(PHONE_DEFAULTS.cameraMode);
    expect(legacy.followLagMs).toBe(PHONE_DEFAULTS.followLagMs);
    expect(legacy.zoomLagMs).toBe(10);
  });

  it('сброс возвращает умолчания своего устройства и сохраняет их', () => {
    const store = new SettingsStore(localStorage, PHONE_DEFAULTS, PLAYER);
    store.setNumber('minViewPercent', 40);
    store.setFlag('hasRicochetGuard', false);
    store.reset();
    expect(store.value).toEqual(PHONE_DEFAULTS);
    expect(new SettingsStore(localStorage, PHONE_DEFAULTS, PLAYER).value.minViewPercent).toBe(
      PHONE_DEFAULTS.minViewPercent,
    );
    const desktop = new SettingsStore(localStorage, DESKTOP_DEFAULTS, PLAYER);
    desktop.setFlag('hasAimLine', false);
    desktop.reset();
    expect(desktop.value.hasAimLine).toBe(true);
  });

  it('админский флаг в хранилище без права читается выключенным, с правом — как записан', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ hasLeadHint: true, hasAimLine: true }));
    const player = new SettingsStore(localStorage, DESKTOP_DEFAULTS, PLAYER);
    expect(player.isAdmin).toBe(false);
    expect(player.value.hasLeadHint).toBe(false);
    expect(player.value.hasAimLine).toBe(true);
    const admin = new SettingsStore(localStorage, DESKTOP_DEFAULTS, ADMIN);
    expect(admin.isAdmin).toBe(true);
    expect(admin.value.hasLeadHint).toBe(true);
  });

  it('объект настроек один и тот же — потребители читают изменения без подписки', () => {
    const store = new SettingsStore(localStorage, PHONE_DEFAULTS, PLAYER);
    const view = store.value;
    store.setNumber('deadZone', 0.3);
    expect(view.deadZone).toBe(0.3);
  });
});
