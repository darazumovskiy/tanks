import { Capacitor } from '@capacitor/core';

export type ClientPlatform = 'android' | 'ios' | 'desktop' | 'unknown';
export type ClientShell = 'app' | 'pwa' | 'browser';

// Описание клиента — измерения для фильтров в мониторинге; собирается один раз при старте.
export interface ClientInfo {
  platform: ClientPlatform;
  shell: ClientShell;
  os: string;
  osVersion: string;
  browser: string;
  browserVersion: string;
  appVersion: string;
  screen: string;
  dpr: number;
  touch: boolean;
}

export interface ClientEnvironment {
  userAgent: string;
  isNativeApp: boolean;
  isStandalone: boolean;
  screenWidth: number;
  screenHeight: number;
  dpr: number;
  touch: boolean;
  appVersion: string;
}

export const UNKNOWN = 'unknown';

const ANDROID = /Android (\d+(?:\.\d+)*)/;
const IOS = /(?:iPhone|iPad|iPod).*? OS (\d+)(?:_(\d+))?/;
const MAC = /Mac OS X (\d+)(?:[_.](\d+))?/;
const WINDOWS = /Windows NT (\d+\.\d+)/;
const LINUX = 'Linux';
// Порядок важен: Chrome упоминают почти все, а Safari — все браузеры на iOS.
const BROWSERS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'Edge', pattern: /Edg(?:e|A|iOS)?\/(\d+)/ },
  { name: 'Opera', pattern: /OPR\/(\d+)/ },
  { name: 'Samsung', pattern: /SamsungBrowser\/(\d+)/ },
  { name: 'Yandex', pattern: /YaBrowser\/(\d+)/ },
  { name: 'Firefox', pattern: /(?:Firefox|FxiOS)\/(\d+)/ },
  { name: 'Chrome', pattern: /(?:Chrome|CriOS)\/(\d+)/ },
  { name: 'Safari', pattern: /Version\/(\d+)[\d.]* .*Safari\// },
];
// Windows NT 10.0 — и Windows 10, и Windows 11: по строке агента они неразличимы.
const WINDOWS_NAMES: Readonly<Record<string, string>> = { '10.0': '10', '6.3': '8.1', '6.2': '8', '6.1': '7' };

interface OsInfo {
  platform: ClientPlatform;
  os: string;
  osVersion: string;
}

// Группа регулярного выражения: пустая строка, если группа не сработала.
export function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? '';
}

function version(major: string, minor: string): string {
  return minor === '' ? major : `${major}.${minor}`;
}

function describeOs(userAgent: string, touch: boolean): OsInfo {
  const android = ANDROID.exec(userAgent);
  if (android !== null) {
    return { platform: 'android', os: 'Android', osVersion: group(android, 1) };
  }
  const ios = IOS.exec(userAgent);
  if (ios !== null) {
    return { platform: 'ios', os: 'iOS', osVersion: version(group(ios, 1), group(ios, 2)) };
  }
  const mac = MAC.exec(userAgent);
  if (mac !== null) {
    // iPad в режиме «как компьютер» представляется Mac, но у Mac нет касания.
    if (touch) {
      return { platform: 'ios', os: 'iPadOS', osVersion: UNKNOWN };
    }
    return { platform: 'desktop', os: 'macOS', osVersion: version(group(mac, 1), group(mac, 2)) };
  }
  const windows = WINDOWS.exec(userAgent);
  if (windows !== null) {
    const nt = group(windows, 1);
    return { platform: 'desktop', os: 'Windows', osVersion: WINDOWS_NAMES[nt] ?? nt };
  }
  if (userAgent.includes(LINUX)) {
    return { platform: 'desktop', os: 'Linux', osVersion: UNKNOWN };
  }
  return { platform: 'unknown', os: UNKNOWN, osVersion: UNKNOWN };
}

function describeBrowser(userAgent: string): { browser: string; browserVersion: string } {
  for (const { name, pattern } of BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match !== null) {
      return { browser: name, browserVersion: group(match, 1) };
    }
  }
  return { browser: UNKNOWN, browserVersion: UNKNOWN };
}

function describeShell(environment: ClientEnvironment): ClientShell {
  if (environment.isNativeApp) {
    return 'app';
  }
  if (environment.isStandalone) {
    return 'pwa';
  }
  return 'browser';
}

export function describeClient(environment: ClientEnvironment): ClientInfo {
  return {
    ...describeOs(environment.userAgent, environment.touch),
    ...describeBrowser(environment.userAgent),
    shell: describeShell(environment),
    appVersion: environment.appVersion,
    screen: `${String(environment.screenWidth)}x${String(environment.screenHeight)}`,
    dpr: environment.dpr,
    touch: environment.touch,
  };
}

export function readClientInfo(): ClientInfo {
  return describeClient({
    userAgent: navigator.userAgent,
    isNativeApp: Capacitor.isNativePlatform(),
    isStandalone: matchMedia('(display-mode: standalone)').matches,
    screenWidth: screen.width,
    screenHeight: screen.height,
    dpr: devicePixelRatio,
    touch: matchMedia('(pointer: coarse)').matches,
    appVersion: APP_VERSION,
  });
}
