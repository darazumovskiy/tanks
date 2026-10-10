import { expect, test, type Locator, type Page } from '@playwright/test';
import { Player, sleep, until } from './player.js';
import { GameServer } from './server.js';

// Звук на устройстве: одна настройка на все экраны, кнопка на каждом экране; касание кнопки в бою не трогает танк.

const NICKNAME_KEY = 'tanks.nickname';
const HOME_SOUND = '#home-sound';
const BATTLE_SOUND = '#sound-toggle';
const WATCH_SOUND = '#watch-sound';
const LAG_SOUND = '.lag-sound';
const AUTOFIRE_BUTTON = '#autofire';
const SETTINGS_BUTTON = '#settings-toggle';
const MENU_BUTTON = '#menu';
const BOT_ROOM = 'bot01sound';
const FFA_SIZE = 10;
const READY_TIMEOUT_MS = 15_000;
const BOT_LEVEL = 1;
// После касания танк и башня успели бы сдвинуться, если бы касание дошло до стика.
const SETTLE_MS = 600;
const POSITION_TOLERANCE = 1;
const TURRET_TOLERANCE = 0.01;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const server = new GameServer();

test.beforeAll(async () => {
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
});

async function expectMuted(button: Locator, isMuted: boolean): Promise<void> {
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('aria-pressed', String(isMuted));
  await expect(button).toHaveAttribute('aria-label', isMuted ? 'Включить звук' : 'Выключить звук');
}

// `isMuted` из отладочного состояния страницы: `tanksGame` у боёв, `tanksLab` у стенда; null — состояния ещё нет.
function pageIsMuted(page: Page, holder: 'tanksGame' | 'tanksLab'): Promise<boolean> {
  return until(
    () =>
      page.evaluate((key) => {
        const source = (
          window as unknown as Record<string, { debugState(): { isMuted?: boolean } | null } | undefined>
        )[key];
        return source?.debugState()?.isMuted ?? null;
      }, holder),
    READY_TIMEOUT_MS,
    `${holder}.debugState().isMuted`,
  );
}

function isOverlapping(first: Box, second: Box): boolean {
  const isApartX = first.x + first.width <= second.x || second.x + second.width <= first.x;
  const isApartY = first.y + first.height <= second.y || second.y + second.height <= first.y;
  return !isApartX && !isApartY;
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) {
    throw new Error(`${selector} не на экране`);
  }
  return box;
}

test('выключил на главной — выключено после перезагрузки, в дуэли, бою толпы, бою ботов и на стенде', async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addInitScript((key) => {
    localStorage.setItem(key, 'Звукач');
  }, NICKNAME_KEY);
  const page = await context.newPage();

  await page.goto(`${server.baseUrl}/`);
  const home = page.locator(HOME_SOUND);
  await expectMuted(home, false);
  await home.click();
  await expectMuted(home, true);
  await page.reload();
  await expectMuted(page.locator(HOME_SOUND), true);

  await page.goto(`${server.baseUrl}/d/${BOT_ROOM}`);
  const duel = page.locator(BATTLE_SOUND);
  await expectMuted(duel, true);
  expect(await pageIsMuted(page, 'tanksGame')).toBe(true);
  await page.keyboard.press('KeyM');
  await expectMuted(duel, false);
  expect(await pageIsMuted(page, 'tanksGame')).toBe(false);
  await page.keyboard.press('KeyM');
  await expectMuted(duel, true);
  expect(await pageIsMuted(page, 'tanksGame')).toBe(true);

  await page.goto(`${server.baseUrl}/ffa/${String(FFA_SIZE)}`);
  const ffa = page.locator(BATTLE_SOUND);
  await expectMuted(ffa, true);
  expect(await pageIsMuted(page, 'tanksGame')).toBe(true);
  await ffa.click();
  await expectMuted(ffa, false);
  expect(await pageIsMuted(page, 'tanksGame')).toBe(false);

  await page.goto(`${server.baseUrl}/watch`);
  const watch = page.locator(WATCH_SOUND);
  await expectMuted(watch, false);
  await watch.click();
  await expectMuted(watch, true);
  expect(await pageIsMuted(page, 'tanksGame')).toBe(true);

  await page.goto(`${server.baseUrl}/?lab=lag`);
  const lab = page.locator(LAG_SOUND);
  await expectMuted(lab, true);
  expect(await pageIsMuted(page, 'tanksLab')).toBe(true);
  await lab.click();
  await expectMuted(lab, false);
  expect(await pageIsMuted(page, 'tanksLab')).toBe(false);

  await page.goto(`${server.baseUrl}/`);
  await expectMuted(page.locator(HOME_SOUND), false);
  await context.close();
});

test('телефон 844 × 390: касание кнопки звука в бою не двигает танк и не стреляет; кнопка не на других', async ({
  browser,
}) => {
  const player = await Player.openAgainstBot(browser, server.baseUrl, 'Звукач', BOT_LEVEL, '', true);
  try {
    const { page } = player;
    await player.waitForFight();
    const before = await player.state();
    if (before === null) {
      throw new Error('нет состояния боя');
    }
    await page.tap(BATTLE_SOUND);
    await expectMuted(page.locator(BATTLE_SOUND), true);
    await sleep(SETTLE_MS);
    const after = await player.state();
    if (after === null) {
      throw new Error('нет состояния боя');
    }
    const reload = await page.evaluate(() => {
      const game = (window as unknown as { tanksGame: { debugState(): { me: { reloadLeft: number } } } }).tanksGame;
      return game.debugState().me.reloadLeft;
    });
    expect(after.isMuted).toBe(true);
    expect(Math.abs(after.me.x - before.me.x)).toBeLessThan(POSITION_TOLERANCE);
    expect(Math.abs(after.me.y - before.me.y)).toBeLessThan(POSITION_TOLERANCE);
    expect(Math.abs(after.me.turret - before.me.turret)).toBeLessThan(TURRET_TOLERANCE);
    expect(reload).toBe(0);
    expect(after.isAutoFiring).toBe(false);

    const viewport = page.viewportSize();
    if (viewport === null) {
      throw new Error('нет размера экрана');
    }
    const sound = await boxOf(page, BATTLE_SOUND);
    expect(sound.x).toBeGreaterThanOrEqual(0);
    expect(sound.y).toBeGreaterThanOrEqual(0);
    expect(sound.x + sound.width).toBeLessThanOrEqual(viewport.width);
    expect(sound.y + sound.height).toBeLessThanOrEqual(viewport.height);
    for (const other of [AUTOFIRE_BUTTON, SETTINGS_BUTTON, MENU_BUTTON]) {
      expect(isOverlapping(sound, await boxOf(page, other)), other).toBe(false);
    }
  } finally {
    await player.close();
  }
});
