import { expect, test, type Page } from '@playwright/test';
import { GameServer } from './server.js';

// Лаборатория эффектов: сцены и варианты перечислены, линия видна у каждого варианта, лист и параметры работают.

const SPRITE_SETTLE_MS = 700;
const EXPECTED_SCENES = ['wall-tail', 'on-target', 'lead', 'returning', 'with-bullet'];
const ROUND_1_VARIANTS = ['current', 'flat', 'tracer', 'neon'];
const ROUND_1_PICKS = ['tracer', 'neon'];
const EXPECTED_VARIANTS = ['tracer', 'neon', 'hairline', 'dots', 'tapered', 'grain', 'soft-tracer'];
const SHEET_ROWS = 3;
const LIGHTBOX_ZOOM = 4;
const REVIEW_BUILD_MS = 3_000;
const PHONE = { width: 844, height: 390, pixelRatio: 2 };
const SHEET_COLUMNS = 3;
const SHEET_LABEL_HEIGHT = 56;
const SHEET_CROP_FRACTION = 0.5;
// Середина первого отрезка сцены «на противнике»: я (260, 450) → край корпуса противника (700 − 29, 450).
const ON_TARGET_MID = { x: (260 + 34 + 671) / 2, y: 450 };
const OFF_LINE_WORLD = 40;
// Хвост сцены «в край почти в упор» идёт назад через танк со скосом 0,1 рад: точка на обратном пути перед дулом.
const RETURNING_TAIL = { x: 60, y: 469 };

interface FxLabApi {
  scenes: string[];
  variants: string[];
  screens: string[];
  show: (scene: string, variant?: string, screen?: string, timeS?: number) => void;
  state: () => {
    scene: string;
    variant: string;
    screen: string;
    timeS: number;
    aimLineState: string;
    isReturning: boolean;
  };
  probe: (x: number, y: number) => number[];
  sheet: (scene?: string, screen?: string, timeS?: number) => { width: number; height: number };
  setParam: (path: string, value: number | string) => void;
}

declare global {
  interface Window {
    tanksFxLab: FxLabApi;
  }
}

const server = new GameServer();

test.beforeAll(async () => {
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
});

async function openLab(page: Page, query = ''): Promise<void> {
  await page.goto(`${server.baseUrl}/?lab=fx${query}`);
  await page.waitForFunction(() => 'tanksFxLab' in window);
  await page.waitForTimeout(SPRITE_SETTLE_MS);
}

function brightness(pixel: number[]): number {
  return (pixel[0] ?? 0) + (pixel[1] ?? 0) + (pixel[2] ?? 0);
}

test('лаборатория: сцены, варианты и экраны перечислены; линия «на противнике» видна у каждого варианта', async ({
  page,
}) => {
  await openLab(page);
  const lists = await page.evaluate(() => ({
    scenes: window.tanksFxLab.scenes,
    variants: window.tanksFxLab.variants,
    screens: window.tanksFxLab.screens,
  }));
  expect(lists.scenes).toEqual(EXPECTED_SCENES);
  expect(lists.variants).toEqual(EXPECTED_VARIANTS);
  expect(lists.screens).toEqual(['phone', 'desktop']);
  for (const variant of EXPECTED_VARIANTS) {
    const probe = await page.evaluate(
      ([v, mid, off]) => {
        window.tanksFxLab.show('on-target', v, 'phone', 1);
        return {
          state: window.tanksFxLab.state(),
          onLine: window.tanksFxLab.probe(mid.x, mid.y),
          offLine: window.tanksFxLab.probe(mid.x, mid.y + off),
        };
      },
      [variant, ON_TARGET_MID, OFF_LINE_WORLD] as const,
    );
    expect(probe.state.aimLineState, variant).toBe('onTarget');
    expect(probe.state.variant).toBe(variant);
    expect(brightness(probe.onLine), `${variant}: линия ярче пола`).toBeGreaterThan(brightness(probe.offLine) + 60);
  }
});

test('опасный хвост на компьютере красноватый; лист строится в размере кадрированных ячеек; параметр меняет кадр', async ({
  page,
}) => {
  await openLab(page);
  const returning = await page.evaluate((tail) => {
    window.tanksFxLab.show('returning', 'soft-tracer', 'desktop', 0.5);
    return { state: window.tanksFxLab.state(), pixel: window.tanksFxLab.probe(tail.x, tail.y) };
  }, RETURNING_TAIL);
  expect(returning.state.isReturning).toBe(true);
  expect(returning.pixel[0] ?? 0).toBeGreaterThan(returning.pixel[1] ?? 0);
  expect(returning.pixel[0] ?? 0).toBeGreaterThan(returning.pixel[2] ?? 0);

  const sheet = await page.evaluate(() => window.tanksFxLab.sheet('on-target', 'phone', 1));
  const cellWidth = Math.round(PHONE.width * PHONE.pixelRatio * SHEET_CROP_FRACTION);
  const cellHeight = Math.round(PHONE.height * PHONE.pixelRatio * SHEET_CROP_FRACTION);
  expect(sheet.width).toBe(SHEET_COLUMNS * cellWidth);
  expect(sheet.height).toBe(SHEET_ROWS * (cellHeight + SHEET_LABEL_HEIGHT));
  await expect(page.locator('.fx-sheet canvas')).toBeVisible();
  await expect(page.locator('.fx-download')).toHaveAttribute('href', /^blob:/);

  const widened = await page.evaluate((mid) => {
    window.tanksFxLab.show('on-target', 'current', 'desktop', 1);
    const before = window.tanksFxLab.probe(mid.x, mid.y + 3);
    window.tanksFxLab.setParam('core.widthPx', 12);
    const after = window.tanksFxLab.probe(mid.x, mid.y + 3);
    return { before, after };
  }, ON_TARGET_MID);
  expect(brightness(widened.after)).toBeGreaterThan(brightness(widened.before) + 60);
});

test('параметры запроса задают раунд, сцену, вариант, экран и время', async ({ page }) => {
  await openLab(page, '&round=1&scene=lead&variant=neon&screen=desktop&t=2');
  const state = await page.evaluate(() => window.tanksFxLab.state());
  expect(state).toMatchObject({
    round: '1',
    scene: 'lead',
    variant: 'neon',
    screen: 'desktop',
    timeS: 2,
    aimLineState: 'lead',
  });
  expect(await page.evaluate(() => window.tanksFxLab.variants)).toEqual(ROUND_1_VARIANTS);
});

test('страница просмотра: сетка сцены × варианты, пометки якорей и выбора, лайтбокс с увеличением', async ({
  page,
}) => {
  await page.goto(`${server.baseUrl}/?lab=fx&view=review&round=1`);
  await page.waitForTimeout(REVIEW_BUILD_MS);
  await expect(page.locator('.fx-cell')).toHaveCount(EXPECTED_SCENES.length * ROUND_1_VARIANTS.length);
  await expect(page.locator('.fx-cell.is-anchor')).toHaveCount(EXPECTED_SCENES.length * 2);
  await expect(page.locator('.fx-cell.is-pick')).toHaveCount(EXPECTED_SCENES.length * ROUND_1_PICKS.length);
  const cell = page.locator('.fx-cell[data-scene="on-target"][data-variant="neon"]');
  const baseWidth = await cell
    .locator('canvas')
    .evaluate((canvas) => parseFloat((canvas as HTMLCanvasElement).style.width));
  await cell.click();
  const lightbox = page.locator('.fx-lightbox');
  await expect(lightbox).toBeVisible();
  await expect(page.locator('.fx-lightbox-caption')).toContainText('Неон с кольцом');
  await page.locator(`.fx-lightbox-bar button[data-zoom="${String(LIGHTBOX_ZOOM)}"]`).click();
  const zoomedWidth = await page
    .locator('.fx-lightbox-canvas')
    .evaluate((canvas) => parseFloat((canvas as HTMLCanvasElement).style.width));
  expect(zoomedWidth).toBeCloseTo(baseWidth * LIGHTBOX_ZOOM, 0);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.fx-lightbox-caption')).toContainText('Трассер');
  await page.keyboard.press('Escape');
  await expect(lightbox).toBeHidden();
});

test('отметки «нравится»: одна на вариант во всех сценах, переживают перезагрузку, собираются в текст и буфер', async ({
  browser,
}) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/?lab=fx&view=review&round=2`);
  await page.waitForTimeout(REVIEW_BUILD_MS);
  await page.locator('.fx-cell[data-scene="on-target"][data-variant="dots"] .fx-like input').check();
  await expect(page.locator('.fx-cell.is-liked[data-variant="dots"]')).toHaveCount(EXPECTED_SCENES.length);
  await expect(page.locator('.fx-lightbox')).toBeHidden();
  await expect(page.locator('.fx-picks-count')).toHaveText('выбрано 1');
  await page.reload();
  await page.waitForTimeout(REVIEW_BUILD_MS);
  await expect(page.locator('.fx-picks-count')).toHaveText('выбрано 1');
  await expect(page.locator('.fx-cell.is-liked[data-variant="dots"]')).toHaveCount(EXPECTED_SCENES.length);
  await page.locator('.fx-collect').click();
  const text = page.locator('.fx-popup-text');
  await expect(text).toBeVisible();
  await expect(text).toHaveValue(/раунд 2 · dots · Точки/);
  await page.locator('.fx-popup-copy').click();
  await expect(page.locator('.fx-popup-copy')).toHaveText('Скопировано');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('- раунд 2 · dots · Точки');
  await context.close();
});
