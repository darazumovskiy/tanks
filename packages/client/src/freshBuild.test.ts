import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchHomeHtml, reloadOnNewBuild, type FreshBuildOptions } from './freshBuild.js';

const LOADED_HEAD = `
  <link rel="stylesheet" href="/fonts/fonts.css" />
  <script type="module" crossorigin src="/assets/index-aaa.js"></script>
  <link rel="stylesheet" crossorigin href="/assets/index-aaa.css" />`;
const SAME_BUILD = `<!doctype html><html><head>${LOADED_HEAD}</head><body></body></html>`;
const NEW_SCRIPT = SAME_BUILD.replace('index-aaa.js', 'index-bbb.js');
const NEW_STYLE = SAME_BUILD.replace('index-aaa.css', 'index-bbb.css');
const NOT_A_BUILD = '<!doctype html><html><head><title>Шлюз</title></head><body>Войдите в сеть</body></html>';
// Так дописывают свои файлы в живую страницу встроенный переводчик Chrome и расширения.
const FOREIGN_FILES = `
  <script src="https://translate.googleapis.com/_/translate_http/_/js/main.js"></script>
  <link rel="stylesheet" href="https://www.gstatic.com/_/translate_http/_/ss/translate.css" />
  <script src="chrome-extension://abcdefghijklmnop/content.js"></script>
  <link rel="stylesheet" href="chrome-extension://abcdefghijklmnop/content.css" />
  <script src="/injected.js"></script>`;
const CHECK_INTERVAL_MS = 30_000;

interface Harness {
  page: Document;
  requests: number;
  reloads: number;
  clock: number;
  setVisibility: (state: DocumentVisibilityState) => void;
  settle: () => Promise<void>;
  // Игрок нажал кнопку боя: переход начат.
  cancelCheck: () => void;
}

function createHarness(pathname: string, respond: () => Promise<string | null>, liveHead = LOADED_HEAD): Harness {
  const page = document.implementation.createHTMLDocument('Танки');
  page.head.innerHTML = liveHead;
  let visibility: DocumentVisibilityState = 'visible';
  Object.defineProperty(page, 'visibilityState', { configurable: true, get: () => visibility });
  const harness: Harness = {
    page,
    requests: 0,
    reloads: 0,
    clock: 0,
    setVisibility: (state) => {
      visibility = state;
      page.dispatchEvent(new Event('visibilitychange'));
    },
    settle: async () => {
      for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve();
      }
    },
    cancelCheck: () => undefined,
  };
  const options: FreshBuildOptions = {
    pathname,
    loadHome: () => {
      harness.requests++;
      return respond();
    },
    reload: () => {
      harness.reloads++;
    },
    now: () => harness.clock,
  };
  const freshBuild = reloadOnNewBuild(page, options);
  harness.cancelCheck = () => {
    freshBuild.cancelCheck();
  };
  return harness;
}

async function returnToScreen(harness: Harness): Promise<void> {
  harness.setVisibility('hidden');
  harness.setVisibility('visible');
  await harness.settle();
}

describe('открытая главная после выкладки', () => {
  let freshHtml: string | null;

  beforeEach(() => {
    freshHtml = NEW_SCRIPT;
  });

  it('вернулась на экран, на сервере другой скрипт — перезагружается', async () => {
    const harness = createHarness('/', () => Promise.resolve(freshHtml));
    await returnToScreen(harness);
    expect(harness.requests).toBe(1);
    expect(harness.reloads).toBe(1);
  });

  it('другой только стиль — тоже новая сборка', async () => {
    freshHtml = NEW_STYLE;
    const harness = createHarness('/', () => Promise.resolve(freshHtml));
    await returnToScreen(harness);
    expect(harness.reloads).toBe(1);
  });

  it('та же сборка — не перезагружается', async () => {
    freshHtml = SAME_BUILD;
    const harness = createHarness('/', () => Promise.resolve(freshHtml));
    await returnToScreen(harness);
    expect(harness.requests).toBe(1);
    expect(harness.reloads).toBe(0);
  });

  it.each(['/d/abc123', '/ffa', '/ffa/10'])('страница боя %s — ни запроса, ни перезагрузки', async (pathname) => {
    const harness = createHarness(pathname, () => Promise.resolve(freshHtml));
    await returnToScreen(harness);
    expect(harness.requests).toBe(0);
    expect(harness.reloads).toBe(0);
  });

  it('вкладка скрылась — сверки нет', async () => {
    const harness = createHarness('/', () => Promise.resolve(freshHtml));
    harness.setVisibility('hidden');
    await harness.settle();
    expect(harness.requests).toBe(0);
  });

  it('второй возврат раньше 30 с — без запроса; после 30 с — новый запрос', async () => {
    freshHtml = SAME_BUILD;
    const harness = createHarness('/', () => Promise.resolve(freshHtml));
    await returnToScreen(harness);
    harness.clock += CHECK_INTERVAL_MS - 1;
    await returnToScreen(harness);
    expect(harness.requests).toBe(1);
    harness.clock += 1;
    freshHtml = NEW_SCRIPT;
    await returnToScreen(harness);
    expect(harness.requests).toBe(2);
    expect(harness.reloads).toBe(1);
  });

  it('возврат во время запроса — второго запроса нет', async () => {
    let answer: (html: string | null) => void = () => undefined;
    const harness = createHarness(
      '/',
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await returnToScreen(harness);
    harness.clock += CHECK_INTERVAL_MS;
    await returnToScreen(harness);
    expect(harness.requests).toBe(1);
    answer(NEW_SCRIPT);
    await harness.settle();
    expect(harness.reloads).toBe(1);
  });

  it('нет связи или ответ не 200 — не перезагружается', async () => {
    freshHtml = null;
    const harness = createHarness('/', () => Promise.resolve(freshHtml));
    await returnToScreen(harness);
    expect(harness.requests).toBe(1);
    expect(harness.reloads).toBe(0);
  });

  it('в ответе ни скриптов, ни стилей (страница входа в сеть) — не перезагружается', async () => {
    freshHtml = NOT_A_BUILD;
    const harness = createHarness('/', () => Promise.resolve(freshHtml));
    await returnToScreen(harness);
    expect(harness.reloads).toBe(0);
  });

  it('переводчик и расширения дописали в страницу свои скрипты и стили — сборка та же, не перезагружается', async () => {
    freshHtml = SAME_BUILD;
    const harness = createHarness('/', () => Promise.resolve(freshHtml), LOADED_HEAD + FOREIGN_FILES);
    await returnToScreen(harness);
    expect(harness.requests).toBe(1);
    expect(harness.reloads).toBe(0);
  });

  it('чужие файлы на странице не прячут новую сборку', async () => {
    const harness = createHarness('/', () => Promise.resolve(freshHtml), LOADED_HEAD + FOREIGN_FILES);
    await returnToScreen(harness);
    expect(harness.reloads).toBe(1);
  });

  it('игрок пошёл в бой, пока шла сверка, — переход не отменяется; следующая сверка работает', async () => {
    let answer: (html: string | null) => void = () => undefined;
    const harness = createHarness(
      '/',
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await returnToScreen(harness);
    harness.cancelCheck();
    answer(NEW_SCRIPT);
    await harness.settle();
    expect(harness.reloads).toBe(0);

    harness.clock += CHECK_INTERVAL_MS;
    await returnToScreen(harness);
    answer(NEW_SCRIPT);
    await harness.settle();
    expect(harness.requests).toBe(2);
    expect(harness.reloads).toBe(1);
  });
});

describe('свежая главная с сервера', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('берёт `/` мимо кэша браузера и отдаёт текст', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(SAME_BUILD, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchHomeHtml()).toBe(SAME_BUILD);
    expect(fetchMock).toHaveBeenCalledWith('/', { cache: 'no-store' });
  });

  it('ответ не 200, нет связи или связь оборвалась посреди ответа — null', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('нет', { status: 502 })));
    expect(await fetchHomeHtml()).toBeNull();
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await fetchHomeHtml()).toBeNull();
    const broken = new ReadableStream({
      start: (controller) => {
        controller.error(new TypeError('network error'));
      },
    });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(broken, { status: 200 })));
    expect(await fetchHomeHtml()).toBeNull();
  });
});
