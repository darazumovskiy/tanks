import { expect, test, type BrowserContextOptions, type Page } from '@playwright/test';
import { GameServer } from './server.js';

// Срез `window.tanksGame.debugState()` экрана боя ботов в той части, которой пользуется сценарий.
interface WatchState {
  fighterIds: [string, string];
  score: [number, number];
  totalTicks: number;
  speed: number;
  isPaused: boolean;
}

const PHONE = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHONE_WIDTH = 844;
const PHONE_HEIGHT = 390;
const TOUCH_TARGET_PX = 44;
const SCREENS: readonly { id: string; options: BrowserContextOptions }[] = [
  { id: 'телефон 844 × 390', options: { ...PHONE, viewport: { width: PHONE_WIDTH, height: PHONE_HEIGHT } } },
  { id: 'компьютер 1280 × 720', options: { viewport: { width: 1280, height: 720 } } },
];
const LEFT_ID = 'bot1';
const RIGHT_ID = 'bot10';
const TWIN_ID = 'twin';
const MAX_SPEED = 4;
// Раунд кончается не позже лимита времени раунда: на ×4 с отсчётом — заведомо быстрее минуты.
const ROUND_TIMEOUT_MS = 60_000;
const PAUSE_CHECK_MS = 1_000;

const server = new GameServer();

test.beforeAll(async () => {
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
});

async function watchState(page: Page): Promise<WatchState> {
  return page.evaluate(() => {
    const game = (window as unknown as { tanksGame: { debugState(): WatchState } }).tanksGame;
    return game.debugState();
  });
}

async function pick(page: Page, side: 'left' | 'right', id: string): Promise<void> {
  await page.locator(`#watch-${side}-toggle`).click();
  await page.locator(`#watch-${side}-list [data-fighter="${id}"]`).click();
}

test('панель на телефоне 844 × 390: цели касания не меньше 44 точек, всё в экране', async ({ browser }) => {
  const phone = SCREENS[0];
  if (phone === undefined) {
    throw new Error('нет экрана телефона');
  }
  const context = await browser.newContext(phone.options);
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/watch`);
  await expect(page.locator('.watch-bar')).toBeVisible();
  await page.locator('#watch-right-toggle').click();
  const boxes = await page
    .locator('.watch-bar a, .watch-bar button:not(.level), #watch-right-list')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
        const name = element.id === '' ? (element.getAttribute('class') ?? '') : element.id;
        return { name, left, right, top, bottom, width, height };
      }),
    );
  expect(boxes.length).toBeGreaterThan(0);
  const rowHeights = await page
    .locator('#watch-right-list .level')
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  expect(rowHeights.length).toBeGreaterThan(0);
  expect(Math.min(...rowHeights)).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
  for (const box of boxes) {
    expect(box.width, box.name).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
    expect(box.height, box.name).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
    expect(box.left, box.name).toBeGreaterThanOrEqual(0);
    expect(box.right, box.name).toBeLessThanOrEqual(PHONE_WIDTH);
    expect(box.top, box.name).toBeGreaterThanOrEqual(0);
    expect(box.bottom, box.name).toBeLessThanOrEqual(PHONE_HEIGHT);
  }
  await context.close();
});

for (const screen of SCREENS) {
  test(`бой ботов с главной: Манекен против Параллакса доигрывает раунд на ×4 — ${screen.id}`, async ({ browser }) => {
    const context = await browser.newContext(screen.options);
    const page = await context.newPage();
    await page.goto(`${server.baseUrl}/`);
    await page.locator('#watch-open').click();
    await page.waitForURL('**/watch');
    await expect(page.locator('.watch-bar')).toBeVisible();

    await pick(page, 'left', LEFT_ID);
    await pick(page, 'right', RIGHT_ID);
    await page.locator(`[data-speed="${String(MAX_SPEED)}"]`).click();
    const started = await watchState(page);
    expect(started.fighterIds).toEqual([LEFT_ID, RIGHT_ID]);
    expect(started.speed).toBe(MAX_SPEED);
    await expect.poll(async () => (await watchState(page)).totalTicks).toBeGreaterThan(started.totalTicks);
    await expect
      .poll(
        async () => {
          const { score } = await watchState(page);
          return score[0] + score[1];
        },
        { timeout: ROUND_TIMEOUT_MS },
      )
      .toBeGreaterThan(0);

    await page.locator('#watch-pause').click();
    const paused = await watchState(page);
    expect(paused.isPaused).toBe(true);
    await page.waitForTimeout(PAUSE_CHECK_MS);
    expect((await watchState(page)).totalTicks).toBe(paused.totalTicks);
    await context.close();
  });
}

for (const screen of SCREENS) {
  test(`бой ботов: двойник против Манекена доигрывает раунд на ×4 — ${screen.id}`, async ({ browser }) => {
    const context = await browser.newContext(screen.options);
    const page = await context.newPage();
    await page.goto(`${server.baseUrl}/watch`);
    await expect(page.locator('.watch-bar')).toBeVisible();

    await pick(page, 'left', TWIN_ID);
    await pick(page, 'right', LEFT_ID);
    await page.locator(`[data-speed="${String(MAX_SPEED)}"]`).click();
    await expect.poll(async () => (await watchState(page)).fighterIds).toEqual([TWIN_ID, LEFT_ID]);
    await expect
      .poll(
        async () => {
          const { score } = await watchState(page);
          return score[0] + score[1];
        },
        { timeout: ROUND_TIMEOUT_MS },
      )
      .toBeGreaterThan(0);
    await context.close();
  });
}
