import { describe, expect, it } from 'vitest';
import { describeClient, group, readClientInfo, UNKNOWN, type ClientEnvironment } from './clientInfo.js';

const BASE: ClientEnvironment = {
  userAgent: '',
  isNativeApp: false,
  isStandalone: false,
  screenWidth: 1080,
  screenHeight: 2400,
  dpr: 2.75,
  touch: true,
  appVersion: 'abc1234',
};

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; 24129PN74G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Mobile Safari/537.36';
const IOS_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IOS_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_MODE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const WINDOWS_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';
const WINDOWS_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.56';
const ANDROID_SAMSUNG =
  'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36';
const LINUX_CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('describeClient', () => {
  it.each([
    [ANDROID_CHROME, true, 'android', 'Android', '14', 'Chrome', '130'],
    [IOS_SAFARI, true, 'ios', 'iOS', '17.5', 'Safari', '17'],
    [IOS_CHROME, true, 'ios', 'iOS', '17.5', 'Chrome', '130'],
    [IPAD_DESKTOP_MODE, true, 'ios', 'iPadOS', UNKNOWN, 'Safari', '17'],
    [
      'Mozilla/5.0 (iPad; CPU OS 16 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1',
      true,
      'ios',
      'iOS',
      '16',
      'Safari',
      '16',
    ],
    [MAC_CHROME, false, 'desktop', 'macOS', '10.15', 'Chrome', '130'],
    [WINDOWS_FIREFOX, false, 'desktop', 'Windows', '10', 'Firefox', '131'],
    [WINDOWS_EDGE, false, 'desktop', 'Windows', '10', 'Edge', '130'],
    [ANDROID_SAMSUNG, true, 'android', 'Android', '13', 'Samsung', '23'],
    [LINUX_CHROME, false, 'desktop', 'Linux', UNKNOWN, 'Chrome', '130'],
  ])('разбирает агент %s', (userAgent, touch, platform, os, osVersion, browser, browserVersion) => {
    const info = describeClient({ ...BASE, userAgent, touch });
    expect(info).toMatchObject({ platform, os, osVersion, browser, browserVersion, touch });
  });

  it('неизвестный агент — unknown без исключения, остальные поля заполнены', () => {
    const info = describeClient({ ...BASE, userAgent: 'curl/8.4.0', touch: false });
    expect(info).toEqual({
      platform: UNKNOWN,
      os: UNKNOWN,
      osVersion: UNKNOWN,
      browser: UNKNOWN,
      browserVersion: UNKNOWN,
      shell: 'browser',
      appVersion: 'abc1234',
      screen: '1080x2400',
      dpr: 2.75,
      touch: false,
    });
  });

  it('оболочка: приложение Capacitor важнее PWA, PWA важнее браузера', () => {
    expect(describeClient({ ...BASE, userAgent: ANDROID_CHROME, isNativeApp: true, isStandalone: true }).shell).toBe(
      'app',
    );
    expect(describeClient({ ...BASE, userAgent: ANDROID_CHROME, isStandalone: true }).shell).toBe('pwa');
    expect(describeClient({ ...BASE, userAgent: ANDROID_CHROME }).shell).toBe('browser');
  });

  it('старые Windows называются по имени, незнакомые — номером NT', () => {
    expect(
      describeClient({ ...BASE, userAgent: 'Mozilla/5.0 (Windows NT 6.1; rv:60.0) Firefox/60.0', touch: false })
        .osVersion,
    ).toBe('7');
    expect(
      describeClient({ ...BASE, userAgent: 'Mozilla/5.0 (Windows NT 5.1) Firefox/60.0', touch: false }).osVersion,
    ).toBe('5.1');
  });

  it('группа регулярного выражения без совпадения — пустая строка', () => {
    const match = /(a)(b)?/.exec('a');
    expect(match).not.toBeNull();
    if (match !== null) {
      expect(group(match, 1)).toBe('a');
      expect(group(match, 2)).toBe('');
    }
  });

  it('readClientInfo собирает описание из окружения страницы', () => {
    const info = readClientInfo();
    expect(info.appVersion).toBe(APP_VERSION);
    expect(info.screen).toMatch(/^\d+x\d+$/);
    expect(['app', 'pwa', 'browser']).toContain(info.shell);
  });
});
