import { expect, test, type BrowserContextOptions, type Page } from '@playwright/test';
import { GameServer } from '../server.js';

// Эталоны кадра толпы: каждый кадр стенда `/?lab=frames&set=ffa` на каждом своём экране и главная с секцией
// общего боя совпадают с эталоном попиксельно. Кадры холста снимаются прямым и обратным порядком: кадр не зависит
// от предыдущего. Кадры интерфейса матча — страница целиком: поле на холсте боя и интерфейс поверх.

interface FfaFrameInfo {
  id: string;
  kind: 'canvas' | 'page';
  screens: string[];
}

interface FloorCheckReport {
  redrawDiff: number;
  junctionDiff: number;
  holes: number;
  borderCovered: number;
  screensChecked: number;
  shakenHoles: number;
}

interface FfaFramesApi {
  frames: FfaFrameInfo[];
  ready: () => Promise<void>;
  show: (frameId: string, screenId: string) => void;
  snapshot: () => string;
  floorChecks: () => FloorCheckReport;
}

declare global {
  interface Window {
    tanksFfaFrames: FfaFramesApi;
  }
}

const SEED = 20261005;
const EXACT = { maxDiffPixels: 0, threshold: 0 };
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const PHONE: BrowserContextOptions = {
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};
const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 };
const SCREENS: readonly { id: string; options: BrowserContextOptions }[] = [
  { id: 'phone', options: PHONE },
  { id: 'desktop', options: DESKTOP },
];
const BOTH = ['phone', 'desktop'];
const CANVAS_FRAMES: Omit<FfaFrameInfo, 'kind'>[] = [
  { id: 'floor-50', screens: BOTH },
  { id: 'floor-seam', screens: BOTH },
  { id: 'floor-pending', screens: ['phone'] },
  { id: 'crowd-50', screens: ['phone'] },
  { id: 'zone-50', screens: ['phone'] },
  { id: 'shield', screens: ['phone'] },
  { id: 'art-color', screens: ['phone'] },
  { id: 'arrows-one', screens: ['phone'] },
  { id: 'arrows-three', screens: ['phone'] },
  { id: 'arrows-edge', screens: ['phone'] },
  { id: 'aim-one', screens: ['phone'] },
  { id: 'aim-two', screens: ['phone'] },
];
const PAGE_FRAMES: Omit<FfaFrameInfo, 'kind'>[] = [
  { id: 'hud-connecting', screens: ['phone'] },
  { id: 'hud-lobby-few', screens: ['phone'] },
  { id: 'hud-lobby-invite', screens: ['phone'] },
  { id: 'hud-lobby-start', screens: BOTH },
  { id: 'hud-lobby-full', screens: ['phone'] },
  { id: 'hud-lobby-50', screens: ['phone'] },
  { id: 'hud-countdown', screens: ['phone'] },
  { id: 'hud-fight', screens: ['phone'] },
  { id: 'hud-death', screens: ['phone'] },
  { id: 'hud-out', screens: ['phone'] },
  { id: 'hud-final', screens: ['phone'] },
  { id: 'hud-final-start', screens: ['phone'] },
  { id: 'hud-idle', screens: ['phone'] },
  { id: 'hud-spectator', screens: ['phone'] },
  { id: 'hud-results', screens: BOTH },
  { id: 'hud-fatal-idle', screens: ['phone'] },
  { id: 'hud-fatal-replaced', screens: ['phone'] },
  { id: 'hud-fatal-update', screens: ['phone'] },
  { id: 'hud-fatal-error', screens: ['phone'] },
  { id: 'hud-connection', screens: ['phone'] },
];
const EXPECTED_FRAMES: FfaFrameInfo[] = [
  ...CANVAS_FRAMES.map((frame): FfaFrameInfo => ({ ...frame, kind: 'canvas' })),
  ...PAGE_FRAMES.map((frame): FfaFrameInfo => ({ ...frame, kind: 'page' })),
];

const server = new GameServer();

test.beforeAll(async () => {
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
});

async function snapshotFrames(page: Page, frames: readonly FfaFrameInfo[]): Promise<void> {
  for (const frame of frames) {
    for (const screenId of frame.screens) {
      const dataUrl = await page.evaluate(
        ([frameId, screen]) => {
          window.tanksFfaFrames.show(frameId, screen);
          return window.tanksFfaFrames.snapshot();
        },
        [frame.id, screenId] as const,
      );
      const png = Buffer.from(dataUrl.slice(PNG_DATA_URL_PREFIX.length), 'base64');
      expect.soft(png).toMatchSnapshot(`${frame.id}-${screenId}.png`, EXACT);
    }
  }
}

test('кадры толпы совпадают с эталонами в любом порядке', async ({ browser }) => {
  const context = await browser.newContext(DESKTOP);
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/?lab=frames&set=ffa&seed=${String(SEED)}`);
  await page.waitForFunction(() => 'tanksFfaFrames' in window);
  await page.evaluate(() => window.tanksFfaFrames.ready());
  const frames = await page.evaluate(() => window.tanksFfaFrames.frames);
  expect(frames).toEqual(EXPECTED_FRAMES);
  const canvasFrames = frames.filter((frame) => frame.kind === 'canvas');
  await snapshotFrames(page, canvasFrames);
  await snapshotFrames(page, [...canvasFrames].reverse());
  await context.close();
});

for (const screen of SCREENS) {
  test(`интерфейс матча совпадает с эталонами: ${screen.id}`, async ({ browser }) => {
    const context = await browser.newContext(screen.options);
    const page = await context.newPage();
    await page.goto(`${server.baseUrl}/?lab=frames&set=ffa&seed=${String(SEED)}`);
    await page.waitForFunction(() => 'tanksFfaFrames' in window);
    await page.evaluate(() => window.tanksFfaFrames.ready());
    for (const frame of PAGE_FRAMES.filter((candidate) => candidate.screens.includes(screen.id))) {
      await page.evaluate(
        ([frameId, screenId]) => {
          window.tanksFfaFrames.show(frameId, screenId);
        },
        [frame.id, screen.id] as const,
      );
      await expect.soft(page).toHaveScreenshot(`${frame.id}-${screen.id}.png`, EXACT);
    }
    await context.close();
  });
}

// Четыре разрешения; на экране — четыре масштаба, стык кусков и оба угла поля, по шесть дробных сдвигов камеры;
// полная отрисовка с дробной тряской, пока куски не готовы. Стык — до 1/255: Chromium тестов без видеокарты.
test('пол кусками: кусок дважды одинаков, стык равен цельной отрисовке, нет щелей и дыр под тряской, кромка открыта', async ({
  browser,
}) => {
  const context = await browser.newContext(DESKTOP);
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/?lab=frames&set=ffa&seed=${String(SEED)}`);
  await page.waitForFunction(() => 'tanksFfaFrames' in window);
  await page.evaluate(() => window.tanksFfaFrames.ready());
  const report = await page.evaluate(() => window.tanksFfaFrames.floorChecks());
  expect(report).toMatchObject({ redrawDiff: 0, holes: 0, borderCovered: 0, screensChecked: 72, shakenHoles: 0 });
  expect(report.junctionDiff).toBeLessThanOrEqual(1);
  await context.close();
});

for (const { id: screenId, options } of SCREENS) {
  test(`главная с секцией общего боя совпадает с эталоном: ${screenId}`, async ({ browser }) => {
    const context = await browser.newContext(options);
    // Плашку о сборе данных проверяет home.spec.ts; эталон главной — без неё.
    await context.addInitScript(() => {
      localStorage.setItem('tanks.privacyNoteClosed', '1');
    });
    const page = await context.newPage();
    await page.goto(`${server.baseUrl}/`);
    await page.evaluate(async () => {
      const faces: FontFace[] = [];
      document.fonts.forEach((face) => {
        faces.push(face);
      });
      await Promise.all(faces.map((face) => face.load()));
      await document.fonts.ready;
    });
    await expect(page.locator('#ffa-start')).toHaveText('В общий бой');
    await expect(page).toHaveScreenshot(`home-ffa-${screenId}.png`, { ...EXACT, fullPage: true });
    await context.close();
  });
}
