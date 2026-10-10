import { expect, test, type Page } from '@playwright/test';
import { GameServer } from './server.js';

// Стенд задержки: холст и ручки на месте, судья шагает без ошибок; смена ручек даёт новые V и C и счётчики с нуля.

// Срез `window.tanksLab.debugState()` в той части, которой пользуется сценарий.
interface LagState {
  mode: string;
  rttMs: number;
  capMs: number;
  viewLagTicks: number;
  compensationTicks: number;
  judgeTick: number;
  counters: { hitsTaken: number; compensatedHits: number; shots: number; hits: number };
  shooterView: { x: number; y: number } | null;
  serverView: { x: number; y: number } | null;
  isShooterViewShown: boolean;
  isServerViewShown: boolean;
  isPaused: boolean;
}

const TICK_GROWTH_MS = 1_000;
const FIRE_HOLD_MS = 1_500;
const ZERO_COUNTERS = { hitsTaken: 0, compensatedHits: 0, shots: 0, hits: 0 };

const server = new GameServer();

test.beforeAll(async () => {
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
});

async function lagState(page: Page): Promise<LagState> {
  return page.evaluate(() => {
    const lab = (window as unknown as { tanksLab: { debugState(): LagState } }).tanksLab;
    return lab.debugState();
  });
}

async function choose(page: Page, title: string, value: string): Promise<void> {
  if (await page.locator('.lag-panel').isHidden()) {
    await page.locator('.lag-chip').click();
  }
  await page.locator('.lag-field', { hasText: title }).locator('select').selectOption(value);
}

test('стенд задержки: холст и ручки, тик судьи растёт, ошибок нет; смена ручек — новые V и C, счётчики с нуля', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  await page.goto(`${server.baseUrl}/?lab=lag`);
  await page.waitForFunction(() => 'tanksLab' in window);
  await expect(page.locator('.lag-canvas')).toBeVisible();
  await expect(page.locator('.lag-chip')).toBeVisible();
  await expect(page.locator('.lag-readout')).toBeVisible();

  const first = await lagState(page);
  expect(first).toMatchObject({ mode: 'victim', rttMs: 200, capMs: 120, viewLagTicks: 8, compensationTicks: 4 });
  await page.waitForTimeout(TICK_GROWTH_MS);
  expect((await lagState(page)).judgeTick).toBeGreaterThan(first.judgeTick);

  await choose(page, 'Режим', 'shooter');
  await page.locator('.lag-chip').click();
  await expect(page.locator('.lag-panel')).toBeHidden();
  await page.keyboard.down('Space');
  await page.waitForTimeout(FIRE_HOLD_MS);
  await page.keyboard.up('Space');
  const shooter = await lagState(page);
  expect(shooter.mode).toBe('shooter');
  expect(shooter.counters.shots).toBeGreaterThan(0);

  await choose(page, 'Задержка стрелка', '300');
  expect(await lagState(page)).toMatchObject({
    mode: 'shooter',
    rttMs: 300,
    viewLagTicks: 11,
    compensationTicks: 4,
    counters: ZERO_COUNTERS,
  });

  await choose(page, 'Предел компенсации', '200');
  expect(await lagState(page)).toMatchObject({ capMs: 200, viewLagTicks: 11, compensationTicks: 6 });

  await choose(page, 'Режим', 'victim');
  expect(await lagState(page)).toMatchObject({ mode: 'victim', rttMs: 300, capMs: 200, counters: ZERO_COUNTERS });
  await expect(page.locator('.lag-toggle')).toHaveCount(2);
  await expect(page.locator('.lag-chip-mode')).toHaveText('В тебя стреляет лагер');

  expect(errors).toEqual([]);
});

test('стенд задержки: кружки жертвы включаются по одному, пауза кнопкой и P держит тик судьи, смена ручки снимает паузу', async ({
  page,
}) => {
  await page.goto(`${server.baseUrl}/?lab=lag`);
  await page.waitForFunction(() => 'tanksLab' in window);

  await page.locator('.lag-chip').click();
  const shooterToggle = page.locator('.lag-toggle', { hasText: 'Где тебя видит стрелок' });
  const serverToggle = page.locator('.lag-toggle', { hasText: 'Где тебя проверяет сервер' });
  await expect(page.locator('.lag-hint')).toBeVisible();
  const initial = await lagState(page);
  expect(initial).toMatchObject({ isShooterViewShown: false, isServerViewShown: false, isPaused: false });
  expect(initial.shooterView).not.toBeNull();
  expect(initial.serverView).not.toBeNull();
  await shooterToggle.click();
  expect(await lagState(page)).toMatchObject({ isShooterViewShown: true, isServerViewShown: false });
  await serverToggle.click();
  expect(await lagState(page)).toMatchObject({ isShooterViewShown: true, isServerViewShown: true });
  await shooterToggle.click();
  expect(await lagState(page)).toMatchObject({ isShooterViewShown: false, isServerViewShown: true });

  await page.locator('.lag-pause').click();
  await expect(page.locator('.lag-paused')).toBeVisible();
  const paused = await lagState(page);
  expect(paused.isPaused).toBe(true);
  await page.waitForTimeout(TICK_GROWTH_MS);
  expect((await lagState(page)).judgeTick).toBe(paused.judgeTick);

  await page.keyboard.press('KeyP');
  await expect(page.locator('.lag-paused')).toBeHidden();
  await page.waitForTimeout(TICK_GROWTH_MS);
  const resumed = await lagState(page);
  expect(resumed.isPaused).toBe(false);
  expect(resumed.judgeTick).toBeGreaterThan(paused.judgeTick);

  await page.keyboard.press('KeyP');
  expect((await lagState(page)).isPaused).toBe(true);
  await choose(page, 'Режим', 'shooter');
  const shooter = await lagState(page);
  expect(shooter).toMatchObject({ mode: 'shooter', isPaused: false, shooterView: null, serverView: null });
  await expect(page.locator('.lag-paused')).toBeHidden();
  await expect(page.locator('.lag-circles')).toBeHidden();
});
