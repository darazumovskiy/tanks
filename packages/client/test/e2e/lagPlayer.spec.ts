import { expect, test } from '@playwright/test';
import { NetProxy, type NetProxyOptions } from './netProxy.js';
import { NETWORK_PROFILES, networkShape } from './networkProfile.js';
import { Player, type FfaDebugState } from './player.js';

import { GameServer } from './server.js';

const SIZE = 10;
const STATS = '2233';
const FIGHT_TIMEOUT_MS = 30_000;
const LAGGER_NAME = 'Лагер';
const EVEN_BURSTS: NetProxyOptions = { delayMs: 135, burstMs: 200 };
const NIGHT_NETWORK = networkShape(NETWORK_PROFILES.night);
const STEER_EVERY_MS = 700;
const DRIVE_MS = 6_000;
const DEMO_PORT = 8095;
const DEMO_MINUTES = 10;
const MS_PER_MINUTE = 60_000;

const servers: GameServer[] = [];
const proxies: NetProxy[] = [];
const players: Player[] = [];

test.afterEach(async () => {
  for (const player of players.splice(0)) {
    await player.close();
  }
  for (const proxy of proxies.splice(0)) {
    await proxy.close();
  }
  for (const server of servers.splice(0)) {
    await server.stop();
  }
});

function nearestAngle(state: FfaDebugState): number | null {
  const me = state.me;
  if (me === null) {
    return null;
  }
  let best: { angle: number; distance: number } | null = null;
  for (const other of state.others) {
    if (!other.isAlive) {
      continue;
    }
    const distance = Math.hypot(other.x - me.x, other.y - me.y);
    if (best === null || distance < best.distance) {
      best = { angle: Math.atan2(other.y - me.y, other.x - me.x), distance };
    }
  }
  return best?.angle ?? null;
}

// Как живой игрок: газ, змейка влево-вправо, башня на ближайший танк, огонь не отпускается.
async function zigzag(player: Player, durationMs: number): Promise<void> {
  const viewport = player.page.viewportSize() ?? { width: 0, height: 0 };
  const reach = Math.min(viewport.width, viewport.height) / 3;
  await player.page.keyboard.down('KeyW');
  await player.setFiring(true);
  const until = Date.now() + durationMs;
  let isLeft = true;
  while (Date.now() < until) {
    const state = await player.ffaState();
    const angle = state === null ? null : nearestAngle(state);
    if (angle !== null) {
      await player.page.mouse.move(
        viewport.width / 2 + reach * Math.cos(angle),
        viewport.height / 2 + reach * Math.sin(angle),
      );
    }
    await player.holdKey(isLeft ? 'KeyA' : 'KeyD', STEER_EVERY_MS);
    isLeft = !isLeft;
  }
  await player.setFiring(false);
  await player.page.keyboard.up('KeyW');
}

// Газ без руля: свой танк едет туда же, куда его везёт повтор прошлой команды на сервере.
async function driveStraight(player: Player, durationMs: number): Promise<void> {
  await player.holdKey('KeyW', durationMs);
}

async function joinLagger(
  browser: Parameters<typeof Player.openFfa>[0],
  server: GameServer,
  network: NetProxyOptions,
): Promise<{ player: Player; start: FfaDebugState }> {
  const proxy = await NetProxy.start(server.listenPort, network);
  proxies.push(proxy);
  const player = await Player.openFfa(browser, proxy.baseUrl, SIZE, LAGGER_NAME, STATS);
  players.push(player);
  const start = await player.waitForFfa(
    (state) => state.screen === 'fight' && state.me !== null,
    FIGHT_TIMEOUT_MS,
    'бой',
  );
  return { player, start };
}

// Выброшенные команды игрока: сверх очереди и засчитанные за повторы паузы.
function droppedInputs(
  server: GameServer,
  gameId: string,
  playerId: number | null,
): { overflow: number; owed: number } {
  const lines = server.gameLog(gameId).split('\n');
  const count = (reason: string): number =>
    lines.filter((line) => line.includes(`input ${reason} id=${String(playerId)} `)).length;
  return { overflow: count('overflow'), owed: count('owed') };
}

test.describe('игрок с пачками в сети', () => {
  for (const [title, network, isDropExpected] of [
    ['пачки 200 мс — сервер не применяет команд пачки сверх присланных', EVEN_BURSTS, true],
    ['неровные пачки ночной сети — сервер не применяет команд пачки сверх присланных', NIGHT_NETWORK, true],
    ['ровная задержка — команды не выбрасываются', { delayMs: 30 }, false],
  ] as const) {
    test(title, async ({ browser }) => {
      test.setTimeout(90_000);
      const server = new GameServer({ FFA_LOBBY_WAIT_SECONDS: '1', FFA_MINIMUM: '1' });
      servers.push(server);
      await server.start();
      const { player, start } = await joinLagger(browser, server, network);
      await zigzag(player, DRIVE_MS);
      const gameId = start.gameId ?? '';
      await server.stop();
      const drops = droppedInputs(server, gameId, start.playerId);
      if (isDropExpected) {
        expect(drops.overflow + drops.owed).toBeGreaterThan(0);
      } else {
        expect(drops).toEqual({ overflow: 0, owed: 0 });
      }
    });
  }
});

// Кадр глазами игрока: нарисованный свой танк, его скорость и тик картинки чужих — каждым кадром страницы.
interface FrameSample {
  at: number;
  me: { x: number; y: number } | null;
  speed: number;
  othersTick: number;
}

const SMOOTH_DRIVE_MS = 12_000;
// Первые секунды не считаются: замер неровности снимков набирается, время чужих подстраивается.
const SAMPLE_WARMUP_MS = 2_500;
const TICK_MS = 1000 / 30;
// Тик чужих за кадр вырос меньше этой доли хода времени — картинка чужих стоит.
const STALL_SHARE = 0.25;
// Сдвиг своего танка дальше — возрождение, а не поправка.
const RESPAWN_JUMP = 120;
// Чуть дольше OWN_SMOOTHING_MS — за это время нарисованный танк проходит всю поправку.
const SURGE_WINDOW_MS = 150;

async function startSampling(page: Player['page']): Promise<void> {
  await page.evaluate(() => {
    interface Debug {
      screen?: string;
      me?: { speed: number } | null;
      picture?: { me: { x: number; y: number } | null; othersTick: number };
    }
    const scope = window as unknown as {
      tanksGame: { debugState(): Debug };
      frameSamples: FrameSample[];
      isSampling: boolean;
    };
    scope.frameSamples = [];
    scope.isSampling = true;
    const sample = (at: number): void => {
      const state = scope.tanksGame.debugState();
      const picture = state.picture;
      if (state.screen === 'fight' && picture !== undefined) {
        scope.frameSamples.push({ at, me: picture.me, speed: state.me?.speed ?? 0, othersTick: picture.othersTick });
      }
      if (scope.isSampling) {
        requestAnimationFrame(sample);
      }
    };
    requestAnimationFrame(sample);
  });
}

function stopSampling(page: Player['page']): Promise<FrameSample[]> {
  return page.evaluate(() => {
    const scope = window as unknown as { frameSamples: FrameSample[]; isSampling: boolean };
    scope.isSampling = false;
    return scope.frameSamples;
  });
}

interface Smoothness {
  overflows: number;
  // Самый большой сдвиг нарисованного своего танка за кадр сверх его хода.
  worstOwnJump: number;
  // Самый большой сдвиг нарисованного своего танка за SURGE_WINDOW_MS сверх его хода: поправка, которую сглаживание
  // растянуло на несколько кадров, глаз всё равно видит рывком.
  worstOwnSurge: number;
  // Доля кадров, где картинка чужих стоит.
  othersStallShare: number;
  // Самый большой шаг тика чужих за кадр сверх хода времени, тиков.
  worstOthersLeap: number;
}

function smoothnessOf(samples: readonly FrameSample[], overflows: number): Smoothness {
  const start = (samples[0]?.at ?? 0) + SAMPLE_WARMUP_MS;
  let worstOwnJump = 0;
  let stalls = 0;
  let frames = 0;
  let worstOthersLeap = 0;
  for (let index = 1; index < samples.length; index++) {
    const [was, now] = [samples[index - 1], samples[index]];
    if (was === undefined || now === undefined || now.at < start) {
      continue;
    }
    const elapsed = now.at - was.at;
    frames++;
    const othersStep = now.othersTick - was.othersTick;
    stalls += othersStep < (STALL_SHARE * elapsed) / TICK_MS ? 1 : 0;
    worstOthersLeap = Math.max(worstOthersLeap, othersStep - elapsed / TICK_MS);
    if (was.me === null || now.me === null) {
      continue;
    }
    const moved = Math.hypot(now.me.x - was.me.x, now.me.y - was.me.y);
    if (moved < RESPAWN_JUMP) {
      worstOwnJump = Math.max(worstOwnJump, moved - frameTravel(was, now));
    }
  }
  return {
    overflows,
    worstOwnJump,
    worstOwnSurge: worstOwnSurge(samples, start),
    othersStallShare: stalls / Math.max(1, frames),
    worstOthersLeap,
  };
}

function frameTravel(was: FrameSample, now: FrameSample): number {
  return (Math.max(Math.abs(was.speed), Math.abs(now.speed)) * (now.at - was.at)) / 1000;
}

function worstOwnSurge(samples: readonly FrameSample[], start: number): number {
  let worst = 0;
  for (let last = 1; last < samples.length; last++) {
    const end = samples[last];
    const endMe = end?.me ?? null;
    if (end === undefined || endMe === null || end.at < start) {
      continue;
    }
    let travel = 0;
    for (let first = last - 1; first >= 0; first--) {
      const [from, next] = [samples[first], samples[first + 1]];
      const fromMe = from?.me ?? null;
      if (from === undefined || next === undefined || fromMe === null || end.at - from.at > SURGE_WINDOW_MS) {
        break;
      }
      travel += frameTravel(from, next);
      const moved = Math.hypot(endMe.x - fromMe.x, endMe.y - fromMe.y);
      if (moved >= RESPAWN_JUMP) {
        break;
      }
      worst = Math.max(worst, moved - travel);
    }
  }
  return worst;
}

async function playLagger(
  browser: Parameters<typeof Player.openFfa>[0],
  network: NetProxyOptions,
  hasNetSmoothing: boolean,
  drive: (player: Player, durationMs: number) => Promise<void> = zigzag,
): Promise<Smoothness> {
  const server = new GameServer({
    FFA_LOBBY_WAIT_SECONDS: '1',
    FFA_MINIMUM: '1',
    NET_SMOOTHING: hasNetSmoothing ? '1' : '0',
  });
  servers.push(server);
  await server.start();
  const { player, start } = await joinLagger(browser, server, network);
  await startSampling(player.page);
  await drive(player, SMOOTH_DRIVE_MS);
  const samples = await stopSampling(player.page);
  await server.stop();
  return smoothnessOf(samples, droppedInputs(server, start.gameId ?? '', start.playerId).overflow);
}

test('ночная сеть со сглаживанием: команд сверх очереди не больше, свой танк не прыгает, чужие не стоят', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const plain = await playLagger(browser, NIGHT_NETWORK, false);
  const smooth = await playLagger(browser, NIGHT_NETWORK, true);
  const summary = `без сглаживания ${JSON.stringify(plain)}; со сглаживанием ${JSON.stringify(smooth)}`;
  console.log(summary);
  test.info().annotations.push({ type: 'сглаживание', description: summary });
  expect(smooth.overflows, summary).toBeLessThanOrEqual(plain.overflows);
  expect(smooth.worstOwnJump * 2, summary).toBeLessThanOrEqual(plain.worstOwnJump);
  expect(smooth.othersStallShare * 2, summary).toBeLessThanOrEqual(plain.othersStallShare);
  expect(smooth.worstOthersLeap, summary).toBeLessThan(plain.worstOthersLeap);
});

// Связь телефона, которая засыпает: каждые 2,07 с обе стороны замирают на 225 мс, остальное время пинг 50 мс.
const STALLING_NETWORK: NetProxyOptions = { delayMs: 25, stallEveryMs: 2_070, stallMs: 225 };
// Сдвиг своего танка сверх хода, который глаз не видит как рывок; сервер, шагнувший лишние тики паузы, давал десятки.
const STALL_OWN_SURGE_LIMIT = 10;

// Без сглаживания свой танк показывает поправку целиком: руль, переложенный посреди паузы, сервер угадать не может,
// поэтому там — газ без руля; повтор прошлой команды тогда совпадает с присланными.
for (const [title, hasNetSmoothing, drive] of [
  ['со сглаживанием, змейка с огнём', true, zigzag],
  ['со сглаживанием, газ без руля', true, driveStraight],
  ['без сглаживания, газ без руля', false, driveStraight],
] as const) {
  test(`связь замирает раз в 2 с (${title}): свой танк не рвёт вперёд`, async ({ browser }) => {
    test.setTimeout(90_000);
    const result = await playLagger(browser, STALLING_NETWORK, hasNetSmoothing, drive);
    const summary = JSON.stringify(result);
    console.log(summary);
    test.info().annotations.push({ type: 'паузы связи', description: summary });
    expect(result.worstOwnSurge, summary).toBeLessThan(STALL_OWN_SURGE_LIMIT);
  });
}

// Живой лагер для оператора: `LAG_DEMO=1 npx playwright test lagPlayer -g "живой лагер"`, затем открыть
// `http://localhost:8095/ffa/10` в своём браузере. LAG_DEMO_MINUTES — сколько минут Лагер играет.
test('живой лагер', async ({ browser }) => {
  test.skip(process.env.LAG_DEMO === undefined, 'запускается вручную: LAG_DEMO=1');
  const minutes = Number(process.env.LAG_DEMO_MINUTES ?? DEMO_MINUTES);
  test.setTimeout((minutes + 1) * MS_PER_MINUTE);
  const server = new GameServer({ FFA_LOBBY_WAIT_SECONDS: '1', FFA_MINIMUM: '1' });
  servers.push(server);
  await server.start(DEMO_PORT);
  const { player, start } = await joinLagger(browser, server, NIGHT_NETWORK);
  console.log(
    `Лагер в бою ${start.gameId ?? ''}: ${server.baseUrl.replace('127.0.0.1', 'localhost')}/ffa/${String(SIZE)}; журналы — ${server.logDir}`,
  );
  await zigzag(player, minutes * MS_PER_MINUTE);
});
