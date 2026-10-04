import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const SERVER_ENTRY = `${ROOT}/packages/server/dist/main.js`;
const STATIC_ROOT = `${ROOT}/packages/client/dist`;
const START_TIMEOUT_MS = 10_000;
const PORT_LINE = /tanks server on \S*:(\d+)/;

// Собранный игровой сервер как отдельный процесс — тот же бинарник, что едет на боевую машину.
// extraEnv — переменные окружения поверх обязательных (например, серверный тумблер `WALL_SLIDE`).
export class GameServer {
  private child: ChildProcess | null = null;
  private port = 0;
  readonly logDir = mkdtempSync(join(tmpdir(), 'tanks-e2e-log-'));

  constructor(private readonly extraEnv: Record<string, string> = {}) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  // Файл появляется с первым сбросом буфера; до того — пустая строка.
  gameLog(gameId: string): string {
    const file = join(this.logDir, `${gameId}.log`);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }

  async start(port = 0): Promise<void> {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, ...this.extraEnv, PORT: String(port), STATIC_ROOT, LOG_DIR: this.logDir },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    this.child = child;
    this.port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('сервер не сообщил порт вовремя'));
      }, START_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        const match = PORT_LINE.exec(chunk.toString());
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`сервер завершился с кодом ${String(code)}`));
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === null) {
      return;
    }
    this.child = null;
    child.kill('SIGTERM');
    await once(child, 'exit');
  }

  // Выкладка: процесс останавливается и поднимается на том же порту, клиенты должны вернуться сами.
  async restart(): Promise<void> {
    const port = this.port;
    await this.stop();
    await this.start(port);
  }
}
