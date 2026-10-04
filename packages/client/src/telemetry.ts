import type { Side } from '@tanks/shared/engine';
import type { ClientInfo } from './clientInfo.js';

export type TelemetryKind = 'error' | 'net' | 'sec' | 'vis';
export type TelemetryFields = Record<string, string | number | boolean>;

export interface TelemetryOptions {
  beacon?: (url: string, body: string) => boolean;
  now?: () => number;
  intervalMs?: number;
}

export const TELEMETRY_ROUTE = '/telemetry';
export const TELEMETRY_FLUSH_INTERVAL_MS = 5000;
// Очередь на случай, когда пачки не уходят: старое вытесняется, игра от этого не зависит.
export const TELEMETRY_MAX_EVENTS = 50;
const NO_GAME = '';
const NO_SIDE = -1;
const ERROR_TEXT_MAX = 500;

function sendWithBeacon(url: string, body: string): boolean {
  if (typeof navigator.sendBeacon !== 'function') {
    return false;
  }
  return navigator.sendBeacon(url, body);
}

function errorText(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`.slice(0, ERROR_TEXT_MAX);
  }
  return String(reason).slice(0, ERROR_TEXT_MAX);
}

// События клиента для мониторинга с измерениями: ошибки, сеть, секундная сводка. Каждое событие
// несёт описание клиента; уходят пачкой «выстрелил и забыл», ответ не читается, ошибка отправки глотается.
export class Telemetry {
  private readonly client: ClientInfo;
  private readonly beacon: (url: string, body: string) => boolean;
  private readonly now: () => number;
  private readonly timer: number;
  private events: string[] = [];
  private game = NO_GAME;
  private side: number = NO_SIDE;
  private hasErrorHandlers = false;

  constructor(client: ClientInfo, options: TelemetryOptions = {}) {
    this.client = client;
    this.beacon = options.beacon ?? sendWithBeacon;
    this.now = options.now ?? ((): number => Date.now());
    this.timer = window.setInterval(() => {
      this.flush();
    }, options.intervalMs ?? TELEMETRY_FLUSH_INTERVAL_MS);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private readonly onPageHide = (): void => {
    this.flush();
  };

  private readonly onVisibilityChange = (): void => {
    this.event('vis', document.visibilityState);
    if (document.visibilityState === 'hidden') {
      this.flush();
    }
  };

  private readonly onError = (event: ErrorEvent): void => {
    const where = event.filename === '' ? '' : ` @ ${event.filename}:${String(event.lineno)}`;
    this.event('error', `${event.message}${where}`);
  };

  private readonly onRejection = (event: PromiseRejectionEvent): void => {
    this.event('error', `unhandled rejection: ${errorText(event.reason)}`);
  };

  installErrorHandlers(): void {
    if (this.hasErrorHandlers) {
      return;
    }
    this.hasErrorHandlers = true;
    window.addEventListener('error', this.onError);
    window.addEventListener('unhandledrejection', this.onRejection);
  }

  setSide(side: Side): void {
    this.side = side;
  }

  setGame(gameId: string): void {
    this.game = gameId;
  }

  leaveGame(): void {
    this.game = NO_GAME;
    this.side = NO_SIDE;
  }

  event(kind: TelemetryKind, msg: string, fields: TelemetryFields = {}): void {
    const record = { t: this.now(), kind, msg, game: this.game, side: this.side, client: this.client, ...fields };
    this.events.push(JSON.stringify(record));
    if (this.events.length > TELEMETRY_MAX_EVENTS) {
      this.events.splice(0, this.events.length - TELEMETRY_MAX_EVENTS);
    }
  }

  flush(): void {
    if (this.events.length === 0) {
      return;
    }
    const body = this.events.join('\n');
    this.events = [];
    try {
      this.beacon(TELEMETRY_ROUTE, body);
    } catch {
      return;
    }
  }

  close(): void {
    window.clearInterval(this.timer);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.hasErrorHandlers) {
      window.removeEventListener('error', this.onError);
      window.removeEventListener('unhandledrejection', this.onRejection);
      this.hasErrorHandlers = false;
    }
    this.flush();
  }
}
