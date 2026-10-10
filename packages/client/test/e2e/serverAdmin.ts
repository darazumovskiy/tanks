// Админка машины игры: пульт стенда без посредника сети. Настройки сервера лежат в файле окружения службы tanks;
// смена — новый файл, перезапуск службы и ожидание /healthz. Запуск — служба tanks-admin от root (deploy/tanks-admin.service).
// SERVER_NAME — где работает сервер, подпись страницы; без неё — имя машины.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { envFileText, serverSettingsFromEnvFile, startPanel, type RestartableServer } from './badNetPanel.js';

const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? '8090');
const ADMIN_HOST = '127.0.0.1';
const SETTINGS_FILE = process.env.SETTINGS_FILE ?? '/etc/tanks/settings.env';
const LOG_DIR = process.env.LOG_DIR ?? '/opt/tanks-logs';
const SERVER_NAME = process.env.SERVER_NAME ?? hostname();
const SERVICE = 'tanks';
const HEALTH_URL = 'http://127.0.0.1:8080/healthz';
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 250;

const run = promisify(execFile);

async function isHealthy(): Promise<boolean> {
  try {
    return (await fetch(HEALTH_URL)).ok;
  } catch {
    return false;
  }
}

async function waitHealthy(): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isHealthy()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error(`служба ${SERVICE} не ответила за ${String(HEALTH_TIMEOUT_MS / 1000)} с`);
}

const server: RestartableServer = {
  logDir: LOG_DIR,
  restart: async (env) => {
    writeFileSync(SETTINGS_FILE, envFileText(env));
    await run('systemctl', ['restart', SERVICE]);
    await waitHealthy();
  },
};

const settings = serverSettingsFromEnvFile(existsSync(SETTINGS_FILE) ? readFileSync(SETTINGS_FILE, 'utf8') : '');
const panel = await startPanel({
  port: ADMIN_PORT,
  host: ADMIN_HOST,
  server,
  bench: null,
  serverName: SERVER_NAME,
  ...settings,
});
console.log(`админка на ${ADMIN_HOST}:${String(panel.port)}, настройки — ${SETTINGS_FILE}`);
