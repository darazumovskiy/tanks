import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { GameServer } from './server.js';

const STATS_KEY = 'tanks.stats';
const FULL_STATS = '3322';
const EMPTY_STATS = '0000';
const HTTP_OK = 200;
const MAIN_SCRIPT = /\/assets\/index-[^"]+\.js/;
const NEXT_BUILD_SCRIPT = '/assets/index-nextbuild.js';
const LOCKED_TEXT = 'Раздай танку все очки — и в бой';
const PHONE = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SCREENS: readonly { id: string; options: BrowserContextOptions }[] = [
  { id: 'телефон 834 × 375', options: { ...PHONE, viewport: { width: 834, height: 375 } } },
  { id: 'телефон 844 × 390', options: { ...PHONE, viewport: { width: 844, height: 390 } } },
  { id: 'телефон 667 × 375 (одна колонка)', options: { ...PHONE, viewport: { width: 667, height: 375 } } },
  { id: 'телефон 640 × 360 (одна колонка)', options: { ...PHONE, viewport: { width: 640, height: 360 } } },
  { id: 'телефон 390 × 844', options: { ...PHONE, viewport: { width: 390, height: 844 } } },
  { id: 'компьютер 1280 × 720', options: { viewport: { width: 1280, height: 720 } } },
];
const ICONS: readonly { path: string; type: string }[] = [
  { path: '/favicon.ico', type: 'image/x-icon' },
  { path: '/favicon.svg', type: 'image/svg+xml' },
  { path: '/apple-touch-icon.png', type: 'image/png' },
];

declare global {
  interface Window {
    tanksBeforeReload?: true;
    tanksLeaving?: true;
  }
}

const server = new GameServer();

test.beforeAll(async () => {
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
});

async function openHome(browser: Browser, options: BrowserContextOptions, stats: string | null): Promise<Page> {
  const context = await browser.newContext(options);
  if (stats !== null) {
    await context.addInitScript(
      ([key, value]) => {
        localStorage.setItem(key, value);
      },
      [STATS_KEY, stats] as const,
    );
  }
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/`);
  await expect(page.locator('#home')).toBeVisible();
  return page;
}

async function bottomOf(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) {
    throw new Error(`${selector} не виден`);
  }
  return box.y + box.height;
}

// Страница дочитала свежий `/` и следующей задачей шлёт этот запрос: к нему сверка уже решила, перезагружаться ли.
// Метка идёт по сети, потому что пока переход в бой придержан, Playwright не выполняет код в уходящей странице.
const HOME_READ_SIGNAL = '/tanks-home-read';

async function returnToScreen(page: Page): Promise<void> {
  await page.evaluate((signal) => {
    window.tanksBeforeReload = true;
    addEventListener('beforeunload', () => {
      window.tanksLeaving = true;
    });
    const load = window.fetch.bind(window);
    window.fetch = async (...request) => {
      const response = await load(...request);
      const readText = response.text.bind(response);
      response.text = async () => {
        const text = await readText();
        setTimeout(() => void load(signal));
        return text;
      };
      return response;
    };
    document.dispatchEvent(new Event('visibilitychange'));
  }, HOME_READ_SIGNAL);
}

function homeCheckRead(page: Page): Promise<unknown> {
  return page.waitForRequest(`${server.baseUrl}${HOME_READ_SIGNAL}`);
}

function withNextBuild(html: string): string {
  return html.replace(MAIN_SCRIPT, NEXT_BUILD_SCRIPT);
}

test('иконка игры: сервер отдаёт её файлы, главная на них ссылается', async ({ browser, request }) => {
  for (const icon of ICONS) {
    const response = await request.get(`${server.baseUrl}${icon.path}`);
    expect(response.status(), icon.path).toBe(HTTP_OK);
    expect(response.headers()['content-type'], icon.path).toBe(icon.type);
  }
  const page = await openHome(browser, {}, null);
  await expect(page.locator('link[rel="icon"][href="/favicon.svg"]')).toHaveCount(1);
  await expect(page.locator('link[rel="icon"][href="/favicon.ico"]')).toHaveCount(1);
  await expect(page.locator('link[rel="apple-touch-icon"][href="/apple-touch-icon.png"]')).toHaveCount(1);
  await page.context().close();
});

for (const screen of SCREENS) {
  test(`«В общий бой» на первом экране без прокрутки: ${screen.id}`, async ({ browser }) => {
    const height = screen.options.viewport?.height ?? 0;
    const ready = await openHome(browser, screen.options, FULL_STATS);
    await expect(ready.locator('#ffa-start')).toBeEnabled();
    await expect(ready.locator('#ffa-locked')).toBeHidden();
    expect(await bottomOf(ready, '#ffa-start')).toBeLessThanOrEqual(height);
    expect(await ready.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await ready.context().close();

    const locked = await openHome(browser, screen.options, EMPTY_STATS);
    await expect(locked.locator('#ffa-start')).toBeDisabled();
    await expect(locked.locator('#ffa-locked')).toHaveText(LOCKED_TEXT);
    expect(await bottomOf(locked, '#ffa-locked')).toBeLessThanOrEqual(height);
    await locked.context().close();
  });
}

test('главная вернулась на экран после выкладки — перезагружается, ник на месте', async ({ browser }) => {
  const page = await openHome(browser, {}, FULL_STATS);
  await page.locator('#nickname').fill('Свёрнутый');
  await page.route(
    `${server.baseUrl}/`,
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: withNextBuild(await response.text()) });
    },
    { times: 1 },
  );
  const reloaded = page.waitForEvent('load');
  await returnToScreen(page);
  await reloaded;
  await expect(page.locator('#home')).toBeVisible();
  expect(await page.evaluate(() => window.tanksBeforeReload)).toBeUndefined();
  await expect(page.locator('#nickname')).toHaveValue('Свёрнутый');
  await page.context().close();
});

test('главная вернулась на экран, сборка та же — не перезагружается', async ({ browser }) => {
  const page = await openHome(browser, {}, FULL_STATS);
  const checkRead = homeCheckRead(page);
  await returnToScreen(page);
  await checkRead;
  expect(await page.evaluate(() => [window.tanksBeforeReload, window.tanksLeaving])).toEqual([true, undefined]);
  await page.context().close();
});

test('игрок нажал «В общий бой», пока главная сверялась с новой сборкой, — попадает в бой', async ({ browser }) => {
  const page = await openHome(browser, {}, FULL_STATS);
  let releaseHome = (): void => undefined;
  const homeHeld = new Promise<void>((resolve) => {
    releaseHome = resolve;
  });
  let releaseFight = (): void => undefined;
  const fightHeld = new Promise<void>((resolve) => {
    releaseFight = resolve;
  });
  await page.route(
    `${server.baseUrl}/`,
    async (route) => {
      const response = await route.fetch();
      const html = withNextBuild(await response.text());
      await homeHeld;
      await route.fulfill({ response, body: html });
    },
    { times: 1 },
  );
  // Переход в бой придерживается, пока главная не дочитает свежую сборку: иначе новая страница успела бы сменить
  // старую раньше, чем сверка решит перезагружаться.
  await page.route(`${server.baseUrl}/ffa`, async (route) => {
    await fightHeld;
    await route.continue().catch(() => undefined);
  });
  const homeAsked = page.waitForRequest(`${server.baseUrl}/`);
  await returnToScreen(page);
  await homeAsked;
  const button = await page.locator('#ffa-start').boundingBox();
  if (button === null) {
    throw new Error('#ffa-start не виден');
  }
  const fightAsked = page.waitForRequest(`${server.baseUrl}/ffa`);
  // Мышью, а не locator.click: тот ждёт конца начатого перехода, а переход здесь придержан.
  await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
  await fightAsked;
  const checkRead = homeCheckRead(page);
  releaseHome();
  await checkRead;
  releaseFight();
  await expect(page).toHaveURL(`${server.baseUrl}/ffa`);
  await expect(page.locator('#home')).toBeHidden();
  await page.context().close();
});
