import { expect, test, type Browser } from '@playwright/test';
import { botRoomCode, type BotLevel } from '@tanks/shared/protocol';
import { Player, sleep, until, type DebugState } from './player.js';
import { GameServer } from './server.js';

const DEFAULT_STATS = '3322';
const SHOOTER_STATS = '0055';
const TARGET_STATS = '0500';
// Верхняя полоса карты «Полигон»: между краями поля на ней нет стен.
const LANE_Y = 100;
const SHOOTER_POST = { x: 140, y: LANE_Y };
const TARGET_POST = { x: 1460, y: LANE_Y };
const ARRIVE_DISTANCE = 30;
const DRIVE_MS = 800;
const MIN_DRIVE_DISTANCE = 20;
const KILL_TIMEOUT_MS = 60_000;
// Сервер держит итог раунда 90 тиков — три секунды.
const ROUND_PAUSE_MS = 3_000;
// Клиент шлёт строки раз в секунду, сервер пишет на диск раз в полсекунды.
const LOG_TIMEOUT_MS = 5_000;
const AUTOFIRE_START_TIMEOUT_MS = 5_000;
// Снаряд живёт до 4 с — столько выпущенные до выключения могут оставаться в полёте.
const AUTOFIRE_STOP_TIMEOUT_MS = 8_000;
// Дольше перезарядки: за это время выключенный авто-огонь выпустил бы новый снаряд.
const NO_FIRE_CHECK_MS = 2_000;
const ANDROID_PACKAGE = 'io.github.darazumovskiy.tanks';
const ANDROID_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15; 24129PN74G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

const server = new GameServer();

test.beforeAll(async () => {
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
});

function roomCode(prefix = 'e2e'): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Код комнаты не длиннее 16 знаков: после префикса с уровнем остаётся место на короткий случайный хвост.
function botCode(level: BotLevel): string {
  return botRoomCode(level, Math.random().toString(36).slice(2, 10));
}

async function openPair(
  browser: Browser,
  code: string,
  statsA = DEFAULT_STATS,
  statsB = DEFAULT_STATS,
): Promise<[Player, Player]> {
  const a = await Player.open(browser, server.baseUrl, code, 'Алиса', statsA);
  const b = await Player.open(browser, server.baseUrl, code, 'Боб', statsB);
  await a.waitForBattle();
  await b.waitForBattle();
  return [a, b];
}

test('два браузера входят по ссылке, движение одного видно другому, журнал игры собирает обе стороны', async ({
  browser,
}) => {
  const [a, b] = await openPair(browser, roomCode());
  const stateA = await a.waitForBattle();
  expect(stateA.side).toBe(0);
  expect((await b.waitForBattle()).side).toBe(1);
  expect(stateA.gameId).toMatch(/^[A-Z0-9]{4}$/);
  expect((await b.waitForBattle()).gameId).toBe(stateA.gameId);

  const seenBefore = (await b.waitForFight()).enemy;
  expect(await a.driveForward(DRIVE_MS)).toBeGreaterThan(MIN_DRIVE_DISTANCE);
  await until(
    async () => {
      const state = await b.state();
      return state !== null && Math.abs(state.enemy.x - seenBefore.x) > MIN_DRIVE_DISTANCE ? true : null;
    },
    5_000,
    'второй игрок не увидел движение первого',
  );

  await until(
    () => {
      const log = server.gameLog(stateA.gameId);
      const hasAll = [' S gt=', ' C0 gt=', ' C1 gt='].every((mark) => log.includes(mark));
      return Promise.resolve(hasAll && log.includes(' in seq=') && log.includes(' snap rt=') ? true : null);
    },
    LOG_TIMEOUT_MS,
    'в журнале игры нет строк сервера и обоих клиентов',
  );

  await a.close();
  await b.close();
});

test('два раунда подряд: стрелок убивает мишень, в новом раунде ввод работает', async ({ browser }) => {
  const [shooter, target] = await openPair(browser, roomCode(), SHOOTER_STATS, TARGET_STATS);
  await shooter.waitForFight();
  await target.waitForFight();
  await Promise.all([shooter.driveTo(SHOOTER_POST, ARRIVE_DISTANCE), target.driveTo(TARGET_POST, ARRIVE_DISTANCE)]);

  const deadline = Date.now() + KILL_TIMEOUT_MS;
  await shooter.setFiring(true);
  try {
    while (Date.now() < deadline) {
      const state = await shooter.waitForBattle();
      if (!state.enemy.isAlive || state.roundIndex === 1) {
        break;
      }
      await shooter.aimAt(state.enemy);
      await sleep(200);
    }
  } finally {
    await shooter.setFiring(false);
  }

  // Пауза между раундами короче отсчёта: попап надо поймать сразу после гибели мишени.
  await expect(shooter.roundEndTitle()).toHaveText('ПОБЕДА!', { timeout: ROUND_PAUSE_MS });
  await expect(target.roundEndTitle()).toHaveText('ПОРАЖЕНИЕ', { timeout: ROUND_PAUSE_MS });
  expect(await shooter.roundEndMenuHref()).toBe('/');

  const next = await shooter.waitForRound(1, 10_000);
  expect(next.score).toEqual([1, 0]);
  await target.waitForRound(1, 10_000);
  await expect(shooter.roundEndTitle()).toBeHidden();
  expect(await shooter.driveForward(DRIVE_MS)).toBeGreaterThan(MIN_DRIVE_DISTANCE);
  expect(await target.driveForward(DRIVE_MS)).toBeGreaterThan(MIN_DRIVE_DISTANCE);

  await shooter.close();
  await target.close();
});

test('соперник ушёл — ожидание; вернулся — новый раунд, оба едут', async ({ browser }) => {
  const code = roomCode();
  const [a, b] = await openPair(browser, code);
  await a.waitForFight();
  await b.close();
  await a.expectOverlay('Ждём соперника');
  await a.expectNoBattle();

  const returned = await Player.open(browser, server.baseUrl, code, 'Боб', DEFAULT_STATS);
  await returned.waitForBattle();
  expect(await a.driveForward(DRIVE_MS)).toBeGreaterThan(MIN_DRIVE_DISTANCE);
  expect(await returned.driveForward(DRIVE_MS)).toBeGreaterThan(MIN_DRIVE_DISTANCE);

  await a.close();
  await returned.close();
});

test('сервер перезапущен под открытыми страницами — клиенты возвращаются сами', async ({ browser }) => {
  const [a, b] = await openPair(browser, roomCode());
  await a.waitForFight();
  await server.restart();
  await a.expectOverlay('Связь потеряна');
  await a.waitForBattle(20_000);
  await b.waitForBattle(20_000);
  expect(await a.driveForward(DRIVE_MS)).toBeGreaterThan(MIN_DRIVE_DISTANCE);
  expect(await b.driveForward(DRIVE_MS)).toBeGreaterThan(MIN_DRIVE_DISTANCE);

  await a.close();
  await b.close();
});

test('телефон: кнопка авто-огня стреляет без касания стика, повторное касание выключает', async ({ browser }) => {
  const code = roomCode();
  const phone = await Player.open(browser, server.baseUrl, code, 'Телефон', DEFAULT_STATS, { isTouch: true });
  const desktop = await Player.open(browser, server.baseUrl, code, 'Компьютер', DEFAULT_STATS);
  await phone.waitForFight();
  await desktop.waitForFight();
  expect(await phone.isAutoFireButtonVisible()).toBe(true);
  expect(await desktop.isAutoFireButtonVisible()).toBe(false);
  expect((await phone.state())?.isAutoFiring).toBe(false);

  expect(await phone.tapAutoFire()).toBe(true);
  await until(
    async () => {
      const state = await desktop.state();
      return state !== null && state.bullets > 0 ? true : null;
    },
    AUTOFIRE_START_TIMEOUT_MS,
    'снаряды авто-огня не появились у второго игрока',
  );

  expect(await phone.tapAutoFire()).toBe(false);
  await until(
    async () => {
      const state = await desktop.state();
      return state !== null && state.bullets === 0 ? true : null;
    },
    AUTOFIRE_STOP_TIMEOUT_MS,
    'после выключения авто-огня снаряды не закончились',
  );
  await sleep(NO_FIRE_CHECK_MS);
  expect((await desktop.state())?.bullets).toBe(0);

  await phone.close();
  await desktop.close();
});

async function expectEnemyMoves(human: Player, start: DebugState, what: string): Promise<void> {
  await until(
    async () => {
      const state = await human.state();
      if (state === null) {
        return null;
      }
      const hasMoved = Math.hypot(state.enemy.x - start.enemy.x, state.enemy.y - start.enemy.y) > MIN_DRIVE_DISTANCE;
      return hasMoved || state.enemy.heading !== start.enemy.heading ? true : null;
    },
    10_000,
    what,
  );
}

test('комната с манекеном по ссылке: раунд стартует сразу, манекен двигается', async ({ browser }) => {
  const human = await Player.open(browser, server.baseUrl, botCode(1), 'Дима', DEFAULT_STATS);
  const start = await human.waitForFight();
  expect(start.side).toBe(1);
  expect(start.nicknames[0]).toBe('Манекен');
  await expectEnemyMoves(human, start, 'манекен не двигается');
  await human.close();
});

test('кнопка «⌂» в бою ведёт на главную', async ({ browser }) => {
  const human = await Player.open(browser, server.baseUrl, botCode(1), 'Дима', DEFAULT_STATS);
  await human.waitForBattle();
  await human.clickMenu();
  await expect(human.page).toHaveURL(/\/$/);
  await expect(human.page.locator('#home')).toBeVisible();
  await human.close();
});

test('с главной: выбран уровень 10, «Против бота» ведёт в бой с ПАРАЛЛАКС-ASTRA', async ({ browser }) => {
  const human = await Player.openAgainstBot(browser, server.baseUrl, 'Дима', 10);
  await expect(human.page).toHaveURL(/\/d\/bot10[a-z0-9]+$/);
  const start = await human.waitForFight();
  expect(start.side).toBe(1);
  expect(start.nicknames[0]).toBe('ПАРАЛЛАКС-ASTRA');
  await expectEnemyMoves(human, start, 'бот Астры не двигается');
  await human.close();
});

test('создатель ждёт соперника: «Копировать» кладёт ссылку на дуэль в буфер обмена', async ({ browser }) => {
  const code = roomCode();
  const creator = await Player.open(browser, server.baseUrl, code, 'Алиса', DEFAULT_STATS);
  await creator.expectOverlay('Ждём соперника');
  const copyButton = creator.copyButton();
  await expect(copyButton).toHaveText('Копировать');
  await copyButton.click();
  await expect(copyButton).toHaveText('Скопировано');
  expect(await creator.clipboardText()).toBe(`${server.baseUrl}/d/${code}`);
  await creator.close();
});

test('браузер Android видит плашку «Открыть в приложении», компьютер — нет', async ({ browser }) => {
  const code = roomCode();
  const android = await Player.open(browser, server.baseUrl, code, 'Телефон', DEFAULT_STATS, {
    userAgent: ANDROID_USER_AGENT,
  });
  await expect(android.openAppBanner()).toBeVisible();
  const href = await android.openAppHref();
  expect(href).toMatch(/^intent:\/\//);
  expect(href).toContain(`${new URL(server.baseUrl).host}/d/${code}`);
  expect(href).toContain(`package=${ANDROID_PACKAGE}`);
  expect(href).toContain(encodeURIComponent(`${server.baseUrl}/app/tanks.apk`));
  await android.closeOpenAppBanner();
  await expect(android.openAppBanner()).toBeHidden();

  const desktop = await Player.open(browser, server.baseUrl, code, 'Компьютер', DEFAULT_STATS);
  await desktop.waitForBattle();
  await expect(desktop.openAppBanner()).toBeHidden();
  await android.close();
  await desktop.close();
});

test('сервер отдаёт подтверждение домена для Android App Links', async ({ request }) => {
  const response = await request.get(`${server.baseUrl}/.well-known/assetlinks.json`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  const statements = (await response.json()) as { target: { package_name: string } }[];
  expect(statements[0]?.target.package_name).toBe(ANDROID_PACKAGE);
});
