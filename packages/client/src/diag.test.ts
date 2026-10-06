import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIAG_BATCH_LINES, DIAG_FLUSH_INTERVAL_MS, DIAG_MAX_LINES, DiagLog } from './diag.js';

interface Sent {
  url: string;
  body: string;
}

describe('DiagLog', () => {
  const posted: Sent[] = [];
  const beaconed: Sent[] = [];
  let isPostOk = true;
  let isBeaconOk = true;
  let now = 1000;
  let diag: DiagLog;

  beforeEach(() => {
    vi.useFakeTimers();
    posted.length = 0;
    beaconed.length = 0;
    isPostOk = true;
    isBeaconOk = true;
    now = 1000;
    diag = new DiagLog('abc123', {
      post: (url, body) => {
        posted.push({ url, body });
        return Promise.resolve(isPostOk);
      },
      beacon: (url, body) => {
        beaconed.push({ url, body });
        return isBeaconOk;
      },
      now: () => now,
    });
  });

  afterEach(() => {
    diag.close();
    vi.useRealTimers();
  });

  it('до старта дуэли пишет под ключом комнаты, после — под идентификатором игры и со стороной', async () => {
    diag.write('device ua=test');
    await vi.advanceTimersByTimeAsync(DIAG_FLUSH_INTERVAL_MS);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe('/log?key=room-abc123&src=C');
    expect(posted[0]?.body).toBe('gt=0 tc=00:00 now=1000 device ua=test');

    diag.setSource(1);
    diag.write('net welcome');
    diag.setGame('K7MF');
    expect(beaconed).toHaveLength(1);
    expect(beaconed[0]?.url).toBe('/log?key=room-abc123&src=C1');
    diag.write('net roundstart');
    await vi.advanceTimersByTimeAsync(DIAG_FLUSH_INTERVAL_MS);
    expect(posted[1]?.url).toBe('/log?key=K7MF&src=C1');
    expect(posted[1]?.body).toContain('net roundstart');
  });

  it('оценивает таймкод по последнему снимку и местному времени', async () => {
    diag.markSnapshot(1800, 1000);
    now = 1000 + 100;
    diag.write('x');
    expect(diag.gameTick()).toBe(1803);
    now = 1000 + 1000;
    diag.write('y');
    await diag.flush();
    expect(posted[0]?.body.split('\n')).toEqual(['gt=1803 tc=01:00 now=1100 x', 'gt=1830 tc=01:01 now=2000 y']);
  });

  it('пустой буфер не отправляет; пачка уходит одной отправкой и очищается', async () => {
    await vi.advanceTimersByTimeAsync(DIAG_FLUSH_INTERVAL_MS * 3);
    expect(posted).toHaveLength(0);
    diag.write('a');
    diag.write('b');
    await vi.advanceTimersByTimeAsync(DIAG_FLUSH_INTERVAL_MS);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body.split('\n')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DIAG_FLUSH_INTERVAL_MS);
    expect(posted).toHaveLength(1);
  });

  it('при ошибке отправки строки не теряются и уходят со следующей пачкой', async () => {
    isPostOk = false;
    diag.write('a');
    await vi.advanceTimersByTimeAsync(DIAG_FLUSH_INTERVAL_MS);
    expect(posted).toHaveLength(1);
    isPostOk = true;
    diag.write('b');
    await vi.advanceTimersByTimeAsync(DIAG_FLUSH_INTERVAL_MS);
    expect(posted).toHaveLength(2);
    expect(posted[1]?.body.split('\n').map((line) => line.slice(-1))).toEqual(['a', 'b']);
  });

  it('буфер ограничен, пачка не больше лимита, старые строки вытесняются', async () => {
    for (let i = 0; i < DIAG_MAX_LINES + 10; i++) {
      diag.write(`l${String(i)}`);
    }
    await vi.advanceTimersByTimeAsync(DIAG_FLUSH_INTERVAL_MS);
    const lines = posted[0]?.body.split('\n') ?? [];
    expect(lines).toHaveLength(DIAG_BATCH_LINES);
    expect(lines[0]?.endsWith(' l10')).toBe(true);
  });

  it('скрытие страницы и закрытие шлют буфер маяком; при отказе маяка строки остаются', () => {
    diag.write('a');
    isBeaconOk = false;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(beaconed).toHaveLength(1);
    expect(beaconed[0]?.body).toContain('vis hidden');
    isBeaconOk = true;
    window.dispatchEvent(new Event('pagehide'));
    expect(beaconed).toHaveLength(2);
    expect(beaconed[1]?.body).toBe(beaconed[0]?.body);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    diag.close();
    expect(beaconed).toHaveLength(3);
    expect(beaconed[2]?.body).toContain('vis visible');
  });
});
