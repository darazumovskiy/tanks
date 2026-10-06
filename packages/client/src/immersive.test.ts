import { describe, expect, it, vi } from 'vitest';
import { bindImmersive, type OrientationControl } from './immersive.js';

interface Setup {
  isFullscreen?: boolean;
  fullscreen?: () => Promise<void>;
  lock?: OrientationControl['lock'];
}

function setup(options: Setup = {}): {
  page: HTMLElement;
  banner: HTMLElement;
  requestFullscreen: ReturnType<typeof vi.fn>;
  lock: ReturnType<typeof vi.fn>;
} {
  const page = document.createElement('div');
  const banner = document.createElement('div');
  page.append(banner);
  const requestFullscreen = vi.fn(options.fullscreen ?? (() => Promise.resolve()));
  const lock = vi.fn(options.lock ?? (() => Promise.resolve()));
  bindImmersive({
    events: page,
    root: { requestFullscreen },
    orientation: { type: 'portrait-primary', lock },
    isFullscreen: () => options.isFullscreen ?? false,
    isOutside: (target) => !(target instanceof Node && banner.contains(target)),
  });
  return { page, banner, requestFullscreen, lock };
}

function tap(target: HTMLElement): void {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('bindImmersive', () => {
  it('касание поля — полный экран без панелей браузера, затем альбомная ориентация', async () => {
    const { page, requestFullscreen, lock } = setup();
    tap(page);
    await settle();
    expect(requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' });
    expect(lock).toHaveBeenCalledWith('landscape');
  });

  it('касание плашки «Открыть в приложении» страницу не разворачивает', async () => {
    const { banner, requestFullscreen } = setup();
    tap(banner);
    await settle();
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it('уже на весь экран — ничего не просит', async () => {
    const { page, requestFullscreen, lock } = setup({ isFullscreen: true });
    tap(page);
    await settle();
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });

  it('браузер отказал в полном экране — ошибка не всплывает, ориентацию не просит', async () => {
    const { page, lock } = setup({ fullscreen: () => Promise.reject(new Error('нет жеста')) });
    tap(page);
    await settle();
    expect(lock).not.toHaveBeenCalled();
  });

  it('браузер отказал в ориентации — ошибка не всплывает', async () => {
    const { page, requestFullscreen } = setup({ lock: () => Promise.reject(new Error('не поддерживается')) });
    tap(page);
    await settle();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('браузер без блокировки ориентации — только полный экран', async () => {
    const page = document.createElement('div');
    const requestFullscreen = vi.fn(() => Promise.resolve());
    bindImmersive({
      events: page,
      root: { requestFullscreen },
      orientation: { type: 'portrait-primary' },
      isFullscreen: () => false,
      isOutside: () => true,
    });
    tap(page);
    await settle();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });
});
