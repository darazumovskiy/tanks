import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';
import { GameServer } from '../server.js';

// Эталоны кадра дуэли: каждый кадр стенда `/?lab=frames` на каждом своём экране, итоги раунда поверх боя, главная
// и ожидание соперника совпадают с эталоном попиксельно. Разошёлся кадр — либо осознанная правка вида с пересъёмкой
// только его эталона, либо регрессия. Кадры холста снимаются дважды — прямым и обратным порядком: кадр не зависит
// от предыдущего. Шрифты страница берёт только с игрового сервера.

interface FrameInfo {
  id: string;
  kind: 'canvas' | 'page';
  screens: string[];
}

interface FramesApi {
  frames: FrameInfo[];
  ready: () => Promise<void>;
  show: (frameId: string, screenId: string) => void;
  snapshot: () => string;
}

declare global {
  interface Window {
    tanksFrames: FramesApi;
  }
}

const SEED = 20261005;
const EXTERNAL_FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const FONT_PATH = /^\/fonts\/.+\.woff2$/;
const HTTP_OK = 200;
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
const WAITING_ROOMS: Readonly<Record<string, string>> = { phone: 'framewaitphone', desktop: 'framewaitdesk' };

const DESKTOP_FRAMES = ['map-0', 'map-1', 'map-2', 'map-3'];
const PHONE_FRAMES = [
  'side-0',
  'side-1',
  'tanks',
  'wreck-under',
  'tanks-overlap',
  'bullets',
  'kits',
  'zone-start',
  'zone-shrink',
  'fx-shot',
  'fx-shot-shake',
  'fx-shot-enemy',
  'fx-impact',
  'fx-ricochet',
  'fx-fizzle',
  'fx-clash',
  'fx-clash-shake',
  'fx-hit',
  'fx-hit-side-1',
  'fx-death',
  'fx-bump',
  'fx-pickup',
  'announce-first-blood',
  'announce-self',
  'announce-first-blood-enemy',
  'announce-self-enemy',
  'countdown-3',
  'countdown-2',
  'countdown-1',
  'countdown-go',
  'aim-on-target',
  'aim-none',
  'guard',
  'guard-side-1',
  'sticks-ring-reverse',
  'sticks-edge-fire',
  'debug-graph',
  'camera-follow-zoom',
  'camera-pair',
];
const ROUND_END_FRAMES = ['round-win', 'round-loss', 'round-draw'];
const EXPECTED_FRAMES: FrameInfo[] = [
  ...DESKTOP_FRAMES.map((id): FrameInfo => ({ id, kind: 'canvas', screens: ['desktop'] })),
  ...PHONE_FRAMES.map((id): FrameInfo => ({ id, kind: 'canvas', screens: ['phone'] })),
  ...ROUND_END_FRAMES.map((id): FrameInfo => ({ id, kind: 'page', screens: ['phone'] })),
];

const server = new GameServer();

test.beforeAll(async () => {
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
});

const requestLogs = new Map<BrowserContext, { urls: string[]; fontStatuses: number[] }>();

async function openContext(browser: Browser, options: BrowserContextOptions): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  const log = { urls: [] as string[], fontStatuses: [] as number[] };
  context.on('request', (request) => {
    log.urls.push(request.url());
  });
  context.on('response', (response) => {
    if (FONT_PATH.test(new URL(response.url()).pathname)) {
      log.fontStatuses.push(response.status());
    }
  });
  requestLogs.set(context, log);
  return context;
}

async function closeContext(context: BrowserContext): Promise<void> {
  const log = requestLogs.get(context);
  requestLogs.delete(context);
  await context.close();
  const external = log?.urls.filter((url) => EXTERNAL_FONT_HOSTS.includes(new URL(url).hostname)) ?? [];
  expect(external).toEqual([]);
  expect(log?.fontStatuses.length ?? 0).toBeGreaterThan(0);
  expect(log?.fontStatuses.every((status) => status === HTTP_OK)).toBe(true);
}

async function snapshotCanvasFrames(page: Page, frames: readonly FrameInfo[]): Promise<void> {
  for (const frame of frames) {
    for (const screenId of frame.screens) {
      const dataUrl = await page.evaluate(
        ([frameId, screen]) => {
          window.tanksFrames.show(frameId, screen);
          return window.tanksFrames.snapshot();
        },
        [frame.id, screenId] as const,
      );
      const png = Buffer.from(dataUrl.slice(PNG_DATA_URL_PREFIX.length), 'base64');
      expect.soft(png).toMatchSnapshot(`${frame.id}-${screenId}.png`, EXACT);
    }
  }
}

async function loadFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const faces: FontFace[] = [];
    document.fonts.forEach((face) => {
      faces.push(face);
    });
    await Promise.all(faces.map((face) => face.load()));
    await document.fonts.ready;
  });
}

async function openStand(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/?lab=frames&seed=${String(SEED)}`);
  await page.evaluate(() => window.tanksFrames.ready());
  return page;
}

test('кадры холста совпадают с эталонами в любом порядке', async ({ browser }) => {
  const context = await openContext(browser, DESKTOP);
  const page = await openStand(context);
  const frames = await page.evaluate(() => window.tanksFrames.frames);
  expect(frames).toEqual(EXPECTED_FRAMES);
  const canvasFrames = frames.filter((candidate) => candidate.kind === 'canvas');
  await snapshotCanvasFrames(page, canvasFrames);
  await snapshotCanvasFrames(page, [...canvasFrames].reverse());
  await closeContext(context);
});

test('итоги раунда поверх боя совпадают с эталонами', async ({ browser }) => {
  const context = await openContext(browser, PHONE);
  const page = await openStand(context);
  for (const frameId of ROUND_END_FRAMES) {
    await page.evaluate((id) => {
      window.tanksFrames.show(id, 'phone');
    }, frameId);
    await expect.soft(page).toHaveScreenshot(`${frameId}-phone.png`, { ...EXACT, animations: 'allow' });
  }
  await closeContext(context);
});

for (const screen of SCREENS) {
  test(`главная совпадает с эталоном: ${screen.id}`, async ({ browser }) => {
    const context = await openContext(browser, screen.options);
    const page = await context.newPage();
    await page.goto(`${server.baseUrl}/`);
    await loadFonts(page);
    await expect(page).toHaveScreenshot(`home-${screen.id}.png`, { ...EXACT, fullPage: true });
    await closeContext(context);
  });

  // В ссылке-приглашении — порт сервера, он свой в каждом прогоне.
  test(`ожидание соперника совпадает с эталоном: ${screen.id}`, async ({ browser }) => {
    const context = await openContext(browser, screen.options);
    const page = await context.newPage();
    await page.goto(`${server.baseUrl}/d/${WAITING_ROOMS[screen.id] ?? screen.id}`);
    await expect(page.locator('#overlay')).toContainText('Ждём соперника');
    await loadFonts(page);
    await expect(page).toHaveScreenshot(`waiting-${screen.id}.png`, {
      ...EXACT,
      mask: [page.locator('.overlay-link')],
    });
    await closeContext(context);
  });
}
