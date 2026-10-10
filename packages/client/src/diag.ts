import { DT } from '@tanks/shared/engine';
import { gameTimecode } from '@tanks/shared/protocol';
import type { HoldEnd } from './pictureTime.js';

export interface DiagOptions {
  post?: (url: string, body: string) => Promise<boolean>;
  beacon?: (url: string, body: string) => boolean;
  now?: () => number;
  intervalMs?: number;
}

const DIAG_ROUTE = '/log';
export const DIAG_FLUSH_INTERVAL_MS = 1000;
// Буфер на минуту боя с запасом: при недоступном сервере старые строки вытесняются новыми.
export const DIAG_MAX_LINES = 4000;
// Пачка укладывается в лимит тела для keepalive-запроса и маяка (64 КБ).
export const DIAG_BATCH_LINES = 400;
const TICK_MS = DT * 1000;
const SOURCE_PREFIX = 'C';

async function postWithFetch(url: string, body: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'POST', body, keepalive: true });
    return response.ok;
  } catch {
    return false;
  }
}

function postWithBeacon(url: string, body: string): boolean {
  return navigator.sendBeacon(url, body);
}

// Журнал клиента: строки копятся и уходят на сервер пачкой раз в секунду, при уходе страницы — маяком.
// Каждая строка несёт оценку таймкода игры: последний снимок плюс местное время с его прихода.
export class DiagLog {
  private key: string;
  private source = SOURCE_PREFIX;
  private lines: string[] = [];
  private lastSnapshotGameTick = 0;
  private lastSnapshotAt: number | null = null;
  private isSending = false;
  private readonly post: (url: string, body: string) => Promise<boolean>;
  private readonly beacon: (url: string, body: string) => boolean;
  private readonly now: () => number;
  private readonly timer: number;

  constructor(roomCode: string, options: DiagOptions = {}) {
    this.key = `room-${roomCode}`;
    this.post = options.post ?? postWithFetch;
    this.beacon = options.beacon ?? postWithBeacon;
    this.now = options.now ?? ((): number => performance.now());
    this.timer = window.setInterval(() => {
      void this.flush();
    }, options.intervalMs ?? DIAG_FLUSH_INTERVAL_MS);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
  }

  private readonly onVisibilityChange = (): void => {
    this.write(`vis ${document.visibilityState}`);
    if (document.visibilityState === 'hidden') {
      this.flushWithBeacon();
    }
  };

  private readonly onPageHide = (): void => {
    this.flushWithBeacon();
  };

  // Новый номер достаётся и строкам, ещё не отправленным под прежним источником.
  setSource(id: number): void {
    this.source = `${SOURCE_PREFIX}${String(id)}`;
  }

  // Новая дуэль: накопленное до неё уходит под старым ключом, дальше строки идут в файл игры.
  setGame(gameId: string): void {
    this.flushWithBeacon();
    this.key = gameId;
  }

  markSnapshot(gameTick: number, receivedAt: number): void {
    this.lastSnapshotGameTick = gameTick;
    this.lastSnapshotAt = receivedAt;
  }

  gameTick(now = this.now()): number {
    if (this.lastSnapshotAt === null) {
      return 0;
    }
    return this.lastSnapshotGameTick + Math.max(0, Math.round((now - this.lastSnapshotAt) / TICK_MS));
  }

  write(text: string): void {
    const now = this.now();
    const gameTick = this.gameTick(now);
    this.lines.push(`gt=${String(gameTick)} tc=${gameTimecode(gameTick)} now=${now.toFixed(0)} ${text}`);
    if (this.lines.length > DIAG_MAX_LINES) {
      this.lines.splice(0, this.lines.length - DIAG_MAX_LINES);
    }
  }

  async flush(): Promise<void> {
    if (this.isSending || this.lines.length === 0) {
      return;
    }
    const batch = this.lines.slice(0, DIAG_BATCH_LINES);
    const url = this.url();
    this.lines = this.lines.slice(batch.length);
    this.isSending = true;
    const isSent = await this.post(url, batch.join('\n'));
    this.isSending = false;
    if (!isSent) {
      this.lines = [...batch, ...this.lines];
    }
  }

  close(): void {
    window.clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
    this.flushWithBeacon();
  }

  private flushWithBeacon(): void {
    if (this.lines.length === 0) {
      return;
    }
    const batch = this.lines.slice(0, DIAG_BATCH_LINES);
    const url = this.url();
    this.lines = this.lines.slice(batch.length);
    if (!this.beacon(url, batch.join('\n'))) {
      this.lines = [...batch, ...this.lines];
    }
  }

  private url(): string {
    return `${DIAG_ROUTE}?key=${encodeURIComponent(this.key)}&src=${this.source}`;
  }
}

// Стояние своего снаряда на броне: сколько ждал ответа сервера по ходу картинки чужих и чем кончилось.
export function writeHoldEnds(diag: DiagLog, ends: readonly HoldEnd[]): void {
  for (const end of ends) {
    diag.write(`hold id=${String(end.id)} ms=${(end.ticks * TICK_MS).toFixed(0)} end=${end.outcome}`);
  }
}
