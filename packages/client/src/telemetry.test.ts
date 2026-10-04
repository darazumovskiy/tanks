import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientInfo } from './clientInfo.js';
import { Telemetry, TELEMETRY_FLUSH_INTERVAL_MS, TELEMETRY_MAX_EVENTS, TELEMETRY_ROUTE } from './telemetry.js';

const CLIENT: ClientInfo = {
  platform: 'android',
  shell: 'app',
  os: 'Android',
  osVersion: '14',
  browser: 'Chrome',
  browserVersion: '130',
  appVersion: 'abc1234',
  screen: '1080x2400',
  dpr: 2.75,
  touch: true,
};

interface Sent {
  url: string;
  body: string;
}

function parse(sent: Sent): Record<string, unknown>[] {
  return sent.body.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('Telemetry', () => {
  const beaconed: Sent[] = [];
  let isBeaconOk = true;
  let telemetry: Telemetry;

  beforeEach(() => {
    vi.useFakeTimers();
    beaconed.length = 0;
    isBeaconOk = true;
    telemetry = new Telemetry(CLIENT, {
      beacon: (url, body) => {
        beaconed.push({ url, body });
        return isBeaconOk;
      },
      now: () => 1700000000000,
    });
  });

  afterEach(() => {
    telemetry.close();
    vi.useRealTimers();
  });

  it('событие несёт вид, текст, игру, сторону, описание клиента и поля; уходит пачкой по таймеру', () => {
    telemetry.event('net', 'disconnect', { retry: 1500 });
    telemetry.setSide(1);
    telemetry.setGame('K7MF');
    telemetry.event('sec', 'sec', { fps: 58, worst: 24, rtt: 51, pend: 2, snaps: 30, ins: 30 });
    expect(beaconed).toHaveLength(0);

    vi.advanceTimersByTime(TELEMETRY_FLUSH_INTERVAL_MS);
    expect(beaconed).toHaveLength(1);
    expect(beaconed[0]?.url).toBe(TELEMETRY_ROUTE);
    const [first, second] = parse(beaconed[0] ?? { url: '', body: '' });
    expect(first).toEqual({
      t: 1700000000000,
      kind: 'net',
      msg: 'disconnect',
      game: '',
      side: -1,
      client: CLIENT,
      retry: 1500,
    });
    expect(second).toMatchObject({ kind: 'sec', game: 'K7MF', side: 1, fps: 58, rtt: 51 });

    vi.advanceTimersByTime(TELEMETRY_FLUSH_INTERVAL_MS);
    expect(beaconed).toHaveLength(1);

    telemetry.leaveGame();
    telemetry.event('net', 'menu');
    telemetry.flush();
    expect(parse(beaconed[1] ?? { url: '', body: '' })[0]).toMatchObject({ game: '', side: -1 });
  });

  it('ошибка окна и отклонённый промис становятся событиями error; после close обработчики сняты', () => {
    telemetry.installErrorHandlers();
    telemetry.installErrorHandlers();
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'app.js', lineno: 42 }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'inline' }));
    // В happy-dom нет PromiseRejectionEvent: обработчику достаточно поля reason.
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new TypeError('bad') }));
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'text' }));
    telemetry.flush();
    const events = parse(beaconed[0] ?? { url: '', body: '' });
    expect(events.map((event) => event.msg)).toEqual([
      'boom @ app.js:42',
      'inline',
      'unhandled rejection: TypeError: bad',
      'unhandled rejection: text',
    ]);
    expect(events.every((event) => event.kind === 'error')).toBe(true);

    telemetry.close();
    window.dispatchEvent(new ErrorEvent('error', { message: 'after close' }));
    telemetry.flush();
    expect(beaconed).toHaveLength(1);
  });

  it('очередь ограничена: остаются последние события', () => {
    for (let i = 0; i < TELEMETRY_MAX_EVENTS + 10; i++) {
      telemetry.event('net', `e${String(i)}`);
    }
    telemetry.flush();
    const events = parse(beaconed[0] ?? { url: '', body: '' });
    expect(events).toHaveLength(TELEMETRY_MAX_EVENTS);
    expect(events[0]?.msg).toBe('e10');
    expect(events[TELEMETRY_MAX_EVENTS - 1]?.msg).toBe(`e${String(TELEMETRY_MAX_EVENTS + 9)}`);
  });

  it('пустая очередь не отправляется; отказ или исключение маяка глотаются, очередь очищена', () => {
    telemetry.flush();
    expect(beaconed).toHaveLength(0);

    isBeaconOk = false;
    telemetry.event('net', 'a');
    telemetry.flush();
    expect(beaconed).toHaveLength(1);
    telemetry.flush();
    expect(beaconed).toHaveLength(1);

    const throwing = new Telemetry(CLIENT, {
      beacon: () => {
        throw new Error('нет сети');
      },
    });
    throwing.event('net', 'b');
    expect(() => {
      throwing.flush();
    }).not.toThrow();
    throwing.close();
  });

  it('уход со страницы отправляет накопленное маяком', () => {
    telemetry.event('net', 'bye');
    window.dispatchEvent(new Event('pagehide'));
    expect(beaconed).toHaveLength(1);
  });

  it('без параметров использует navigator.sendBeacon, а при его отсутствии не падает', () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
    const plain = new Telemetry(CLIENT);
    plain.event('net', 'x');
    plain.flush();
    expect(sendBeacon).toHaveBeenCalledWith(TELEMETRY_ROUTE, expect.stringContaining('"msg":"x"'));

    Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true });
    plain.event('net', 'y');
    expect(() => {
      plain.flush();
    }).not.toThrow();
    plain.close();
  });
});
