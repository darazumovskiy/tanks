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
const SCREENS: readonly { id: string; options: BrowserContextOptions }[] = [
  { id: 'телефон 844 × 390', options: { ...PHONE, viewport: { width: 844, height: 390 } } },
  { id: 'компьютер 1280 × 720', options: { viewport: { width: 1280, height: 720 } } },
];
const LEFT_ID = 'bot1';
const RIGHT_ID = 'bot10';
const MAX_SPEED = 4;
// Параллакс разбирает Манекена за несколько секунд боя; на ×4 с отсчётом — заведомо быстрее.
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
