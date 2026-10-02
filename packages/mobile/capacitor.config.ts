import type { CapacitorConfig } from '@capacitor/cli';

// Оболочка не хранит клиент внутри: открывает игровой сервер, и выкладка на сервер обновляет приложение.
// www/ — заглушка, Capacitor требует локальную папку даже при удалённом адресе.
const config: CapacitorConfig = {
  appId: 'io.github.darazumovskiy.tanks',
  appName: 'Танки',
  webDir: 'www',
  server: {
    url: process.env.TANKS_SERVER_URL ?? 'https://172-232-212-157.sslip.io',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0b0f0d',
  },
};

export default config;
