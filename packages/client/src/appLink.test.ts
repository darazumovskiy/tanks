import { describe, expect, it } from 'vitest';
import { ANDROID_PACKAGE, androidIntentUrl, isAndroidBrowser, showOpenInApp } from './appLink.js';

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 15; 24129PN74G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('isAndroidBrowser', () => {
  it('браузер Android — да', () => {
    expect(isAndroidBrowser(ANDROID_CHROME, false)).toBe(true);
  });

  it('Android внутри приложения — нет', () => {
    expect(isAndroidBrowser(ANDROID_CHROME, true)).toBe(false);
  });

  it('iPhone и компьютер — нет', () => {
    expect(isAndroidBrowser(IPHONE_SAFARI, false)).toBe(false);
    expect(isAndroidBrowser(MAC_CHROME, false)).toBe(false);
  });
});

describe('androidIntentUrl', () => {
  it('собирает intent-ссылку на страницу дуэли с откатом на APK', () => {
    const url = androidIntentUrl('https://tanks.example/d/abc123?x=1', 'https://tanks.example/app/tanks.apk');
    expect(url).toBe(
      `intent://tanks.example/d/abc123#Intent;scheme=https;package=${ANDROID_PACKAGE};` +
        'S.browser_fallback_url=https%3A%2F%2Ftanks.example%2Fapp%2Ftanks.apk;end',
    );
  });
});

describe('showOpenInApp', () => {
  it('показывает плашку со ссылкой, крестик прячет', () => {
    const banner = document.createElement('div');
    banner.hidden = true;
    const link = document.createElement('a');
    const close = document.createElement('button');
    banner.append(link, close);
    document.body.append(banner);
    showOpenInApp(banner, link, close, 'intent://tanks.example/d/abc123#Intent;end');
    expect(banner.hidden).toBe(false);
    expect(link.getAttribute('href')).toBe('intent://tanks.example/d/abc123#Intent;end');
    close.click();
    expect(banner.hidden).toBe(true);
  });
});
