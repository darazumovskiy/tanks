import { appendFile, appendFileSync, mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { readBody } from './httpBody.js';

// Строки журнала попадают в файл `<dir>/<key>.log`; key — идентификатор дуэли или `room-<код>` до её начала.
export interface GameLog {
  write(key: string, source: string, text: string): void;
}

export const LOG_ROUTE = '/log';
export const LOG_SOURCE_SERVER = 'S';
// Версия сервера без коммита сборки — локальный запуск и тесты.
export const DEV_BUILD = 'dev';
const LOG_KEY_PATTERN = /^[A-Za-z0-9-]{1,40}$/;
const LOG_SOURCE_PATTERN = /^[A-Za-z0-9]{1,6}$/;
const LOG_BODY_LIMIT_BYTES = 256 * 1024;
const FLUSH_INTERVAL_MS = 500;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;

export const NO_LOG: GameLog = {
  write(): void {
    return;
  },
};

// Отдельная строка сразу после `game start`: разбор журналов читает `game start` до конца строки.
export function formatBuildLine(build: string): string {
  return `build server=${build}`;
}

function timeOfDay(now: Date): string {
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  const ms = String(now.getUTCMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

// Диск не трогается в момент записи: строки копятся в памяти и уходят в файл таймером, вне тика.
export class FileGameLog implements GameLog {
  private readonly pending = new Map<string, string[]>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.timer = setInterval(() => {
      this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  write(key: string, source: string, text: string): void {
    const line = `${timeOfDay(new Date())} ${source} ${text}\n`;
    const lines = this.pending.get(key);
    if (lines === undefined) {
      this.pending.set(key, [line]);
      return;
    }
    lines.push(line);
  }

  flush(): void {
    for (const [key, lines] of this.pending) {
      appendFile(this.fileOf(key), lines.join(''), () => undefined);
    }
    this.pending.clear();
  }

  close(): void {
    clearInterval(this.timer);
    for (const [key, lines] of this.pending) {
      appendFileSync(this.fileOf(key), lines.join(''));
    }
    this.pending.clear();
  }

  private fileOf(key: string): string {
    return join(this.dir, `${key}.log`);
  }
}

// Приёмщик строк клиента: `POST /log?key=<ключ>&src=<источник>`, тело — строки через перевод строки.
export function receiveClientLog(log: GameLog, request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(String(request.url), 'http://localhost');
  const key = url.searchParams.get('key') ?? '';
  const source = url.searchParams.get('src') ?? '';
  if (!LOG_KEY_PATTERN.test(key) || !LOG_SOURCE_PATTERN.test(source)) {
    response.writeHead(HTTP_BAD_REQUEST);
    response.end();
    return;
  }
  readBody(request, response, LOG_BODY_LIMIT_BYTES, (body) => {
    for (const text of body.split('\n')) {
      if (text !== '') {
        log.write(key, source, text);
      }
    }
    response.writeHead(HTTP_NO_CONTENT);
    response.end();
  });
}
