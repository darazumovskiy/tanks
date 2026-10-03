import { expect, test, type Browser } from '@playwright/test';
import { Player, sleep, until } from './player.js';
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
// Клиент шлёт строки раз в секунду, сервер пишет на диск раз в полсекунды.
const LOG_TIMEOUT_MS = 5_000;
const AUTOFIRE_START_TIMEOUT_MS = 5_000;
// Снаряд живёт до 4 с — столько выпущенные до выключения могут оставаться в полёте.
const AUTOFIRE_STOP_TIMEOUT_MS = 8_000;
// Дольше перезарядки: за это время выключенный авто-огонь выпустил бы новый снаряд.
const NO_FIRE_CHECK_MS = 2_000;

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
      if (state.roundIndex === 1) {
        break;
      }
      if (state.enemy.isAlive) {
        await shooter.aimAt(state.enemy);
      }
      await sleep(200);
    }
  } finally {
    await shooter.setFiring(false);
  }

  const next = await shooter.waitForRound(1, 10_000);
  expect(next.score).toEqual([1, 0]);
  await target.waitForRound(1, 10_000);
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
  const phone = await Player.open(browser, server.baseUrl, code, 'Телефон', DEFAULT_STATS, true);
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

test('комната с манекеном: раунд стартует сразу, манекен двигается', async ({ browser }) => {
  const human = await Player.open(browser, server.baseUrl, roomCode('bot'), 'Дима', DEFAULT_STATS);
  const start = await human.waitForFight();
  expect(start.side).toBe(1);
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
    'манекен не двигается',
  );
  await human.close();
});
