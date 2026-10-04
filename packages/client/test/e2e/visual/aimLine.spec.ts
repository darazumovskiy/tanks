import { expect, test } from '@playwright/test';
import { GameServer } from '../server.js';

// Эталонные снимки семи стилей линии выстрела: сцена «на противнике», телефон, t = 1 — через холст лаборатории.
// Разошёлся снимок — либо осознанная правка токена с обновлением эталона (`--update-snapshots`), либо регрессия.

const STYLE_IDS = ['soft-tracer', 'tracer', 'dots', 'hairline', 'tapered', 'grain', 'neon'];
const ROUND = '2';
const SCENE = 'on-target';
const SCREEN = 'phone';
const TIME_S = 1;
const SPRITE_SETTLE_MS = 700;
const MAX_DIFF_PIXEL_RATIO = 0.01;

const server = new GameServer();

test.beforeAll(async () => {
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
});

test('семь стилей линии совпадают с эталонами', async ({ page }) => {
  await page.goto(`${server.baseUrl}/?lab=fx&round=${ROUND}`);
  await page.waitForFunction(() => 'tanksFxLab' in window);
  await page.waitForTimeout(SPRITE_SETTLE_MS);
  for (const id of STYLE_IDS) {
    await page.evaluate(
      ([scene, variant, screen, timeS]) => {
        window.tanksFxLab.show(scene, variant, screen, Number(timeS));
      },
      [SCENE, id, SCREEN, String(TIME_S)] as const,
    );
    await expect(page.locator('.fx-stage-canvas:visible')).toHaveScreenshot(`aim-line-${id}.png`, {
      maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    });
  }
});
