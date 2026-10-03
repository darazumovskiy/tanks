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

test('два браузера входят по ссылке, движение одного видно другому', async ({ browser }) => {
  const [a, b] = await openPair(browser, roomCode());
  expect((await a.waitForBattle()).side).toBe(0);
  expect((await b.waitForBattle()).side).toBe(1);

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
