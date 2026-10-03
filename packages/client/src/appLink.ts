export const ANDROID_PACKAGE = 'io.github.darazumovskiy.tanks';
const ANDROID_USER_AGENT = /Android/i;

// Плашка нужна только в браузере телефона: в приложении игра уже открыта как надо, на компьютере приложения нет.
export function isAndroidBrowser(userAgent: string, isNativeApp: boolean): boolean {
  return ANDROID_USER_AGENT.test(userAgent) && !isNativeApp;
}

// Chrome по такой ссылке открывает приложение по имени пакета, а без приложения уходит на запасной адрес.
export function androidIntentUrl(pageUrl: string, fallbackUrl: string): string {
  const page = new URL(pageUrl);
  const fallback = encodeURIComponent(fallbackUrl);
  return `intent://${page.host}${page.pathname}#Intent;scheme=https;package=${ANDROID_PACKAGE};S.browser_fallback_url=${fallback};end`;
}

export function showOpenInApp(
  banner: HTMLElement,
  link: HTMLAnchorElement,
  close: HTMLButtonElement,
  href: string,
): void {
  link.href = href;
  banner.hidden = false;
  close.addEventListener('click', () => {
    banner.hidden = true;
  });
}
