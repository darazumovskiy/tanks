import { readFileSync } from 'node:fs';
import type { CapacitorConfig } from '@capacitor/cli';

// Метка версии оболочки в User-Agent попадает в журнал боя (строка device, поле app); versionName — из build.gradle.
// Путь — от packages/mobile: Capacitor CLI читает конфиг из папки пакета.
function shellVersion(): string {
  const gradle = readFileSync('android/app/build.gradle', 'utf8');
  const version = /versionName "([^"]+)"/.exec(gradle)?.[1];
  if (version === undefined) {
    throw new Error('versionName не найден в android/app/build.gradle');
  }
  return version;
}

// Оболочка не хранит клиент внутри: открывает игровой сервер, и выкладка на сервер обновляет приложение.
// www/ — заглушка, Capacitor требует локальную папку даже при удалённом адресе.
const config: CapacitorConfig = {
  appId: 'io.github.darazumovskiy.tanks',
  appName: 'Танки',
  webDir: 'www',
  server: {
    url: process.env.TANKS_SERVER_URL ?? 'https://tankbattle.io',
    cleartext: false,
  },
  appendUserAgent: `TanksApp/${shellVersion()}`,
  android: {
    allowMixedContent: false,
    backgroundColor: '#0b0f0d',
    // Проба: к игре внутри приложения подключается отладчик Chrome по кабелю (adb) — для замеров и проверок агентом.
    webContentsDebuggingEnabled: true,
  },
};

export default config;
