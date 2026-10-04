import { expect, test } from '@playwright/test';
import { Player, sleep, until, type DebugState } from './player.js';
import { GameServer } from './server.js';

const DEFAULT_STATS = '3322';
const TANK_RADIUS = 24;
// Верхняя полоса «Полигона» без стен; оттуда танк идёт в верхний край под острым углом.
const LANE_POST = { x: 140, y: 100 };
const ARRIVE_DISTANCE = 30;
// Около 26° к краю.
const SLIDE_HEADING = -Math.PI / 7;
const TOUCH_TIMEOUT_MS = 10_000;
const SAMPLES = 5;
const SAMPLE_GAP_MS = 200;
// Равновесие при 50 % под ≈ 26° к краю — около 115; без скольжения — около 21.
const SLIDE_PERCENT = 50;
const MIN_SLIDE_SPEED = 100;
const MAX_CORRECTION_PX = 2;
const MIN_WITNESSED_DISTANCE = 50;

const server = new GameServer({ WALL_SLIDE: String(SLIDE_PERCENT) });

test.beforeAll(async () => {
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
});

// Код комнаты не длиннее 16 знаков.
function roomCode(): string {
  return `sl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function isTouchingTopEdge(state: DebugState): boolean {
  return Math.abs(state.me.y - TANK_RADIUS) < 1;
}

test('сервер с WALL_SLIDE=50: танк под углом к краю скользит без залипания, предсказание согласно с сервером', async ({
  browser,
}) => {
  const code = roomCode();
  const driver = await Player.open(browser, server.baseUrl, code, 'Алиса', DEFAULT_STATS);
  const witness = await Player.open(browser, server.baseUrl, code, 'Боб', DEFAULT_STATS);
  const start = await driver.waitForFight();
  await witness.waitForFight();
  expect(start.rules.wallSlidePercent).toBe(SLIDE_PERCENT);
  expect((await witness.waitForBattle()).rules.wallSlidePercent).toBe(SLIDE_PERCENT);

  await driver.driveTo(LANE_POST, ARRIVE_DISTANCE);
  await driver.driveOnHeading(SLIDE_HEADING);
  await until(
    async () => {
      const state = await driver.state();
      return state !== null && isTouchingTopEdge(state) ? state : null;
    },
    TOUCH_TIMEOUT_MS,
    'танк не доехал до верхнего края',
  );

  const witnessedBefore = (await witness.waitForBattle()).enemy;
  const samples: DebugState[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    await sleep(SAMPLE_GAP_MS);
    samples.push(await driver.waitForBattle());
  }
  const witnessedAfter = (await witness.waitForBattle()).enemy;
  await driver.releaseAll();

  for (const sample of samples) {
    expect(isTouchingTopEdge(sample)).toBe(true);
    expect(sample.me.speed).toBeGreaterThanOrEqual(MIN_SLIDE_SPEED);
    expect(sample.correctionPx).toBeLessThanOrEqual(MAX_CORRECTION_PX);
  }
  expect(witnessedAfter.x - witnessedBefore.x).toBeGreaterThan(MIN_WITNESSED_DISTANCE);

  await driver.close();
  await witness.close();
});
