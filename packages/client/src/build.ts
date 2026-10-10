// Метку `TanksApp/<versionName>` к User-Agent добавляет оболочка Android (packages/mobile/capacitor.config.ts).
const APP_SHELL_PATTERN = /(?:^| )TanksApp\/(\S+)/;
const WEB_SHELL = 'web';

// Поля строки журнала `device`: версия клиента и версия оболочки, в браузере — web.
export function formatBuildFields(userAgent: string): string {
  const shell = APP_SHELL_PATTERN.exec(userAgent)?.[1] ?? WEB_SHELL;
  return `build=${APP_VERSION} app=${shell}`;
}
