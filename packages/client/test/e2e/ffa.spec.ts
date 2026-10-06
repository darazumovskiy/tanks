import { expect, test, type Browser } from '@playwright/test';
import { deriveStats, ffaMap, isTraceReturning, STAT_KEYS, traceShot, type Point } from '@tanks/shared/engine';
import { FfaPhase } from '@tanks/shared/protocol';
import { NetProxy } from './netProxy.js';
import { Player, sleep, type FfaDebugState, type PlayerOptions } from './player.js';
import { GameServer } from './server.js';
import { SwarmProcess } from './swarm.js';

const SIZE = 10;
const DEFAULT_STATS = '3322';
// Броня 0 и орудие 5: три своих рикошета по 43 снимают все 100 здоровья.
const GLASS_CANNON = { armor: 0, engine: 0, gun: 5, reload: 5 };
const GLASS_CANNON_STATS = STAT_KEYS.map((key) => String(GLASS_CANNON[key])).join('');
const TOUGH = { armor: 5, engine: 3, gun: 2, reload: 0 };
const TOUGH_STATS = STAT_KEYS.map((key) => String(TOUGH[key])).join('');
const TOKEN_KEY = `tanks.ffaToken.${String(SIZE)}`;
const KEY_FORWARD = 'KeyW';
const DRIVE_MS = 800;
const MIN_DRIVE_DISTANCE = 20;
// Лобби затихает за секунду, отсчёт — 3 с, плюс загрузка страницы и пола.
const FIGHT_TIMEOUT_MS = 20_000;
const SCREEN_TIMEOUT_MS = 10_000;
const BOT_COUNT = SIZE - 2;
// Разведчик, опоздавший и финалист входят в ту же игру — роевых ботов на три меньше мест.
const MATCH_BOT_COUNT = SIZE - 3;
// Снаряд от выстрела до отскока и обратно в танк — меньше секунды на короткой дистанции.
const SHOT_RETURN_TIMEOUT_MS = 3_000;
const MAX_SELF_SHOTS = 5;
const MIN_WALL_DISTANCE = 45;
// Возрождение через 4 с после гибели: обломки 2 с и ожидание 2 с.
const RESPAWN_MS = 4_000;
const RESPAWN_SLACK_MS = 1_500;
const REFUSE_MS = 1_500;
// Детектор молчания клиента срабатывает через 4 с без единого сообщения сервера.
const SILENCE_EARLY_MS = 3_500;
const SILENCE_LATE_MS = 7_000;
const IDLE_WARN_SECONDS = 2;
const IDLE_KICK_SECONDS = 4;
const SHORT_MATCH_SECONDS = 20;
const SHORT_RESULTS_SECONDS = 3;
const MATCH_END_TIMEOUT_MS = 30_000;
const FINAL_NOTICE_MS = 2_000;
const TARGET_CLICK_ATTEMPTS = 3;
const TARGET_SWITCH_TIMEOUT_MS = 2_000;
// Левый стик телефона 844 × 390: касание и точка на кольце радиуса 40 вправо; правая половина — башня вправо.
const PHONE_MOVE_TOUCH = { x: 200, y: 200 };
const PHONE_MOVE_RIGHT = { x: 240, y: 200 };
const PHONE_AIM_TOUCH = { x: 650, y: 200 };
const PHONE_AIM_RIGHT = { x: 690, y: 200 };
const TURRET_TOLERANCE = 0.05;
// Сдвиг камеры по башне вправо — 240 единиц поля; на половине пути он уже больше 150.
const CAMERA_SHIFT_MIN = 150;
const AXIS_ANGLES = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

const servers: GameServer[] = [];
const swarms: SwarmProcess[] = [];
const proxies: NetProxy[] = [];
const players: Player[] = [];

// Сбой закрытия страницы не должен оставить живыми рой и сервер следующему тесту.
test.afterEach(async () => {
  try {
    for (const player of players.splice(0)) {
      await player.close();
    }
  } finally {
    try {
      for (const swarm of swarms.splice(0)) {
        await swarm.stop();
      }
      for (const proxy of proxies.splice(0)) {
        await proxy.close();
      }
    } finally {
      for (const server of servers.splice(0)) {
        await server.stop();
      }
    }
  }
});

// Игру заполняют сами браузеры и рой; серверных ботов включают только их сценарии.
async function startServer(env: Record<string, string> = {}): Promise<GameServer> {
  const server = new GameServer({ FFA_LOBBY_QUIET_SECONDS: '1', FFA_SERVER_BOTS: '0', ...env });
  servers.push(server);
  await server.start();
  return server;
}

function startSwarm(server: GameServer, count: number): SwarmProcess {
  const swarm = SwarmProcess.start(server.wsUrl, SIZE, count);
  swarms.push(swarm);
  return swarm;
}

async function startProxy(server: GameServer): Promise<NetProxy> {
  const proxy = await NetProxy.start(server.listenPort);
  proxies.push(proxy);
  return proxy;
}

async function openFfa(
  browser: Browser,
  baseUrl: string,
  name: string,
  options: PlayerOptions & { stats?: string } = {},
): Promise<Player> {
  const player = await Player.openFfa(browser, baseUrl, SIZE, name, options.stats ?? DEFAULT_STATS, options);
  players.push(player);
  return player;
}

function ownTank(state: FfaDebugState): NonNullable<FfaDebugState['me']> {
  if (state.me === null) {
    throw new Error('своего танка нет на поле');
  }
  return state.me;
}

function isFighting(state: FfaDebugState): boolean {
  return state.screen === 'fight' && state.me !== null;
}

// Едет вперёд и возвращает, на сколько сдвинулся свой танк, когда сдвиг стал заметен.
async function driveForward(player: Player): Promise<number> {
  const before = ownTank(await player.waitForFfa(isFighting, FIGHT_TIMEOUT_MS, 'бой'));
  const distanceOf = (state: FfaDebugState): number => {
    const me = ownTank(state);
    return Math.hypot(me.x - before.x, me.y - before.y);
  };
  await player.holdKey(KEY_FORWARD, DRIVE_MS);
  const after = await player.waitForFfa(
    (state) => isFighting(state) && distanceOf(state) > MIN_DRIVE_DISTANCE,
    SCREEN_TIMEOUT_MS,
    'танк не сдвинулся после езды',
  );
  return distanceOf(after);
}

// Клик по полю у зрителя переводит камеру на другой живой танк. Цель в финале может и погибнуть — тогда зритель
// сменит её сам; такая смена не в счёт, клик повторяется.
async function switchesTargetByClick(watcher: Player): Promise<boolean> {
  const viewport = watcher.page.viewportSize() ?? { width: 0, height: 0 };
  for (let attempt = 0; attempt < TARGET_CLICK_ATTEMPTS; attempt++) {
    const before = await watcher.waitForFfa(
      (state) => state.spectating !== null && state.others.filter((tank) => tank.isAlive).length >= 2,
      SCREEN_TIMEOUT_MS,
      'зрителю не за кем следить',
    );
    await watcher.page.mouse.click(viewport.width / 2, viewport.height / 2);
    const after = await watcher
      .waitForFfa(
        (state) => state.spectating !== null && state.spectating !== before.spectating,
        TARGET_SWITCH_TIMEOUT_MS,
        'зритель не сменил цель',
      )
      .catch(() => null);
    const previous = after?.others.find((tank) => tank.id === before.spectating);
    if (previous?.isAlive === true) {
      return true;
    }
  }
  return false;
}

// Ось, выстрел по которой возвращается рикошетом в стоящий танк: ближняя стена или край поля, но не вплотную.
function ricochetAngle(me: Point): number {
  const map = ffaMap(SIZE);
  const { bulletSpeed } = deriveStats(GLASS_CANNON);
  const candidates = AXIS_ANGLES.map((angle) => ({ angle, segments: traceShot(map, me, angle, bulletSpeed).segments }))
    .filter(({ segments }) => isTraceReturning(segments, me, null))
    .map(({ angle, segments }) => {
      const bounce = segments[0];
      const distance = bounce === undefined ? 0 : Math.hypot(bounce.x2 - me.x, bounce.y2 - me.y);
      return { angle, distance };
    })
    .filter(({ distance }) => distance >= MIN_WALL_DISTANCE)
    .sort((a, b) => a.distance - b.distance);
  const best = candidates[0];
  if (best === undefined) {
    throw new Error(`с точки (${me.x.toFixed(0)}, ${me.y.toFixed(0)}) рикошет в себя по осям не выходит`);
  }
  return best.angle;
}

test('главная → «В общий бой»: адрес /ffa, лобби «1 / 30»; «Выйти» — на главную', async ({ browser }) => {
  const server = await startServer();
  const player = await Player.openHome(browser, server.baseUrl, 'Новичок', DEFAULT_STATS);
  players.push(player);
  await player.page.locator('#ffa-start').click();
  await expect(player.page).toHaveURL(/\/ffa$/);
  const lobby = await player.waitForScreen('lobby', SCREEN_TIMEOUT_MS);
  expect(lobby).toMatchObject({ players: 1, capacity: 30 });
  await expect(player.ffaLayer('ffa-lobby').locator('.ffa-lobby-count')).toHaveText('1 / 30');
  await player.ffaButton('Выйти').click();
  await expect(player.page).toHaveURL(/\/$/);
  await expect(player.page.locator('#ffa-start')).toBeVisible();
});

test('компьютер и телефон в лобби, затем рой из 8 ботов: отсчёт, бой на 10 танков, движение видно второму', async ({
  browser,
}) => {
  const server = await startServer({ FFA_MINIMUM: String(SIZE) });
  const desktop = await openFfa(browser, server.baseUrl, 'Компьютер');
  const phone = await openFfa(browser, server.baseUrl, 'Телефон', { isTouch: true });
  await desktop.waitForFfa(
    (state) => state.screen === 'lobby' && state.players === 2,
    SCREEN_TIMEOUT_MS,
    'двое в лобби',
  );
  await phone.waitForFfa((state) => state.screen === 'lobby' && state.players === 2, SCREEN_TIMEOUT_MS, 'двое в лобби');
  for (const player of [desktop, phone]) {
    await expect(player.ffaLayer('ffa-lobby').locator('.ffa-lobby-count')).toHaveText(`2 / ${String(SIZE)}`);
  }
  const swarm = startSwarm(server, BOT_COUNT);

  await phone.waitForScreen('countdown', FIGHT_TIMEOUT_MS).catch((error: unknown) => {
    throw new Error(`${String(error)}\nрой:\n${swarm.output}`);
  });
  const fightA = await desktop.waitForFfa(
    (state) => isFighting(state) && state.tanks === SIZE,
    FIGHT_TIMEOUT_MS,
    'бой',
  );
  await phone.waitForFfa((state) => isFighting(state) && state.tanks === SIZE, FIGHT_TIMEOUT_MS, 'бой');
  const desktopId = fightA.playerId;
  const seenBefore = (await phone.ffaState())?.others.find((tank) => tank.id === desktopId);
  expect(seenBefore).toBeDefined();
  expect(await driveForward(desktop)).toBeGreaterThan(MIN_DRIVE_DISTANCE);
  await phone.waitForFfa(
    (state) => {
      const seen = state.others.find((tank) => tank.id === desktopId);
      return (
        seen !== undefined &&
        seenBefore !== undefined &&
        Math.hypot(seen.x - seenBefore.x, seen.y - seenBefore.y) > MIN_DRIVE_DISTANCE
      );
    },
    SCREEN_TIMEOUT_MS,
    'телефон не увидел, как сдвинулся танк компьютера',
  );
});

test('свой рикошет: три выстрела в стену — «сам себя» в ленте, «САМ СЕБЯ!», через 4 с снова в бою с неуязвимостью', async ({
  browser,
}) => {
  const server = await startServer({ FFA_MINIMUM: '1' });
  const player = await openFfa(browser, server.baseUrl, 'Рикошет', {
    stats: GLASS_CANNON_STATS,
    settings: { hasRicochetGuard: false },
  });
  const me = ownTank(await player.waitForFfa(isFighting, FIGHT_TIMEOUT_MS, 'бой'));
  await player.aimFfaAngle(ricochetAngle(me));

  let shots = 0;
  for (; shots < MAX_SELF_SHOTS && (await player.ffaState())?.screen === 'fight'; shots++) {
    const hpBefore = ownTank(await player.waitForFfa(isFighting, SCREEN_TIMEOUT_MS, 'бой')).hp;
    await player.page.mouse.down();
    await player.waitForFfa((state) => state.bullets > 0, SCREEN_TIMEOUT_MS, 'выстрел');
    await player.page.mouse.up();
    await player.waitForFfa(
      (state) => state.me === null || state.me.hp < hpBefore || !state.me.isAlive,
      SHOT_RETURN_TIMEOUT_MS,
      'снаряд не вернулся в свой танк',
    );
    await player.waitForFfa((state) => state.bullets === 0, SHOT_RETURN_TIMEOUT_MS, 'снаряд не погас');
  }
  const diedAt = Date.now();
  expect(shots).toBe(3);
  const dead = await player.waitForScreen('dead', SCREEN_TIMEOUT_MS);
  expect(dead.feed.some((line) => line.includes('сам себя'))).toBe(true);
  await expect(player.ffaLayer('ffa-death')).toContainText('САМ СЕБЯ!');
  const back = await player.waitForFfa(
    (state) => isFighting(state) && (state.me?.shieldLeft ?? 0) > 0,
    RESPAWN_MS + RESPAWN_SLACK_MS * 2,
    'не вернулся в бой с неуязвимостью',
  );
  expect(back.me?.isAlive).toBe(true);
  expect(Date.now() - diedAt).toBeGreaterThan(RESPAWN_MS - RESPAWN_SLACK_MS);
});

test('обрыв через посредника: разрыв и молчание — баннер связи, возврат на то же место, танк едет', async ({
  browser,
}) => {
  const server = await startServer({ FFA_MINIMUM: '1' });
  const proxy = await startProxy(server);
  const player = await openFfa(browser, proxy.baseUrl, 'Связь');
  const { playerId } = await player.waitForFfa(isFighting, FIGHT_TIMEOUT_MS, 'бой');

  proxy.isRefusing = true;
  proxy.cut();
  await expect(player.ffaLayer('ffa-connection')).toContainText('СВЯЗЬ ПРОПАЛА', { timeout: SCREEN_TIMEOUT_MS });
  await sleep(REFUSE_MS);
  proxy.isRefusing = false;
  await expect(player.ffaLayer('ffa-connection')).toContainText('ВЕРНУЛИСЬ!', { timeout: SCREEN_TIMEOUT_MS });
  expect((await player.waitForFfa(isFighting, SCREEN_TIMEOUT_MS, 'бой после разрыва')).playerId).toBe(playerId);
  expect(await driveForward(player)).toBeGreaterThan(MIN_DRIVE_DISTANCE);

  await expect(player.ffaLayer('ffa-connection')).toHaveCount(0, { timeout: SCREEN_TIMEOUT_MS });
  const mutedAt = Date.now();
  proxy.mute();
  await expect(player.ffaLayer('ffa-connection')).toContainText('СВЯЗЬ ПРОПАЛА', { timeout: SILENCE_LATE_MS });
  expect(Date.now() - mutedAt).toBeGreaterThan(SILENCE_EARLY_MS);
  await expect(player.ffaLayer('ffa-connection')).toContainText('ВЕРНУЛИСЬ!', { timeout: SCREEN_TIMEOUT_MS });
  expect((await player.waitForFfa(isFighting, SCREEN_TIMEOUT_MS, 'бой после молчания')).playerId).toBe(playerId);
  expect(await driveForward(player)).toBeGreaterThan(MIN_DRIVE_DISTANCE);
});

test('вторая страница с пропуском первой: у первой «Занято», вторая на том же месте; «Играть здесь» возвращает место', async ({
  browser,
}) => {
  const server = await startServer({ FFA_MINIMUM: '1' });
  const first = await openFfa(browser, server.baseUrl, 'Первая');
  const { playerId } = await first.waitForFfa(isFighting, FIGHT_TIMEOUT_MS, 'бой');
  const token = await first.page.evaluate((key) => sessionStorage.getItem(key) ?? '', TOKEN_KEY);
  expect(token).not.toBe('');

  const second = await openFfa(browser, server.baseUrl, 'Вторая', { session: { [TOKEN_KEY]: token } });
  await first.waitForScreen('replaced', SCREEN_TIMEOUT_MS);
  await expect(first.ffaLayer('ffa-fatal')).toContainText('ТЫ ИГРАЕШЬ В ДРУГОМ МЕСТЕ');
  expect((await second.waitForFfa(isFighting, FIGHT_TIMEOUT_MS, 'бой на второй')).playerId).toBe(playerId);
  expect(await driveForward(second)).toBeGreaterThan(MIN_DRIVE_DISTANCE);
  await sleep(1_000);
  expect((await first.ffaState())?.screen).toBe('replaced');

  await first.ffaButton('Играть здесь').click();
  expect((await first.waitForFfa(isFighting, FIGHT_TIMEOUT_MS, 'бой на первой')).playerId).toBe(playerId);
  await second.waitForScreen('replaced', SCREEN_TIMEOUT_MS);
});

test('бездействие: стоит — «Ты тут?», клавиша снимает; стоит дальше — «Выкинуло», «Вернуться в бой» — новым игроком', async ({
  browser,
}) => {
  const server = await startServer({
    FFA_MINIMUM: '1',
    FFA_IDLE_WARN_SECONDS: String(IDLE_WARN_SECONDS),
    FFA_IDLE_KICK_SECONDS: String(IDLE_KICK_SECONDS),
  });
  const player = await openFfa(browser, server.baseUrl, 'Соня');
  await player.waitForFfa(isFighting, FIGHT_TIMEOUT_MS, 'бой');
  const token = await player.page.evaluate((key) => sessionStorage.getItem(key) ?? '', TOKEN_KEY);
  await player.waitForFfa((state) => state.self?.idleTicksLeft !== null, SCREEN_TIMEOUT_MS, '«Ты тут?»');
  await expect(player.ffaLayer('ffa-idle')).toContainText('ТЫ ТУТ?');
  await player.holdKey(KEY_FORWARD, 200);
  await player.waitForFfa((state) => state.self?.idleTicksLeft === null, SCREEN_TIMEOUT_MS, '«Ты тут?» не снят');
  await expect(player.ffaLayer('ffa-idle')).toHaveCount(0);

  await player.waitForScreen('idle', SCREEN_TIMEOUT_MS);
  await expect(player.ffaLayer('ffa-fatal')).toContainText('ВЫКИНУЛО ЗА БЕЗДЕЙСТВИЕ');
  expect(await player.page.evaluate((key) => sessionStorage.getItem(key), TOKEN_KEY)).toBeNull();
  await player.ffaButton('Вернуться в бой').click();
  const back = await player.waitForFfa(
    (state) => state.playerId !== null && state.screen !== 'idle' && state.screen !== 'connecting',
    FIGHT_TIMEOUT_MS,
    'не вошёл заново',
  );
  expect(['lobby', 'countdown', 'fight', 'dead']).toContain(back.screen);
  const freshToken = await player.page.evaluate((key) => sessionStorage.getItem(key) ?? '', TOKEN_KEY);
  expect(freshToken).not.toBe('');
  expect(freshToken).not.toBe(token);
});

test('короткий матч с роем: вход посреди боя, вход в финал при ботах — в бой, за него выбыл бот, итоги со своей строкой, следующий матч', async ({
  browser,
}) => {
  const server = await startServer({
    FFA_MINIMUM: '2',
    FFA_MATCH_SECONDS: String(SHORT_MATCH_SECONDS),
    FFA_RESULTS_SECONDS: String(SHORT_RESULTS_SECONDS),
  });
  const swarm = startSwarm(server, MATCH_BOT_COUNT);
  const scout = await openFfa(browser, server.baseUrl, 'Разведчик');
  await scout
    .waitForFfa((state) => state.phase === FfaPhase.Fight, FIGHT_TIMEOUT_MS, 'бой роя')
    .catch((error: unknown) => {
      throw new Error(`${String(error)}\nрой:\n${swarm.output}`);
    });

  const fighter = await openFfa(browser, server.baseUrl, 'Опоздавший');
  const joined = await fighter.waitForFfa(isFighting, FIGHT_TIMEOUT_MS, 'свой танк посреди боя');
  expect(joined.isFinal).toBe(false);
  expect(joined.score).not.toBeNull();
  await expect(fighter.ffaLayer('ffa-scoreboard')).toContainText(/\d:\d\d/);
  const feedSeen = new Set<string>();
  const noteFeed = (state: FfaDebugState): void => {
    for (const line of state.feed) {
      feedSeen.add(line);
    }
  };

  await fighter.waitForFfa(
    (state) => {
      noteFeed(state);
      return state.isFinal;
    },
    MATCH_END_TIMEOUT_MS,
    'финал',
  );
  const finalist = await openFfa(browser, server.baseUrl, 'Финалист');
  const landed = await finalist.waitForFfa(isFighting, SCREEN_TIMEOUT_MS, 'вошедший в финал при ботах — в бою');
  expect(landed.isFinal).toBe(true);
  await fighter.waitForFfa(
    (state) => {
      noteFeed(state);
      return state.feed.some((line) => line.endsWith('⊘ выбыл'));
    },
    SCREEN_TIMEOUT_MS,
    'за вошедшего в финал выбыл бот',
  );

  await fighter.waitForFfa(
    (state) => {
      noteFeed(state);
      return state.screen === 'results';
    },
    MATCH_END_TIMEOUT_MS,
    'итоги',
  );
  expect(feedSeen.size).toBeGreaterThan(0);
  await expect(fighter.ffaLayer('ffa-results').locator('.ffa-results-row.is-me')).toHaveCount(1);
  await finalist.waitForScreen('results', SCREEN_TIMEOUT_MS);
  await expect(finalist.ffaLayer('ffa-results').locator('.ffa-results-row.is-me')).toHaveCount(1);
  await fighter.waitForFfa(
    (state) => state.screen === 'countdown' && state.matchIndex === 2,
    SCREEN_TIMEOUT_MS,
    'отсчёт второго матча',
  );
  expect(await driveForward(fighter)).toBeGreaterThan(MIN_DRIVE_DISTANCE);
});

test('вход в финал без ботов в матче — зритель: клик меняет цель, на итогах «СЛЕДУЮЩИЙ МАТЧ — ТВОЙ»', async ({
  browser,
}) => {
  const server = await startServer({
    FFA_MINIMUM: '2',
    FFA_MATCH_SECONDS: String(SHORT_MATCH_SECONDS),
    FFA_RESULTS_SECONDS: String(SHORT_RESULTS_SECONDS),
  });
  // Обоим стоять в зоне до конца финала: броня 5 и по умолчанию держат урон зоны дольше, чем идёт сценарий.
  const tough = await openFfa(browser, server.baseUrl, 'Броня', { stats: TOUGH_STATS });
  await openFfa(browser, server.baseUrl, 'Второй');
  await tough.waitForFfa((state) => state.isFinal, MATCH_END_TIMEOUT_MS, 'финал');
  const watcher = await openFfa(browser, server.baseUrl, 'Зритель');
  const spectating = await watcher.waitForFfa(
    (state) =>
      state.screen === 'spectator' &&
      state.spectating !== null &&
      state.others.filter((tank) => tank.isAlive).length >= 2,
    SCREEN_TIMEOUT_MS,
    'зритель в финале',
  );
  expect(spectating.score).toBeNull();
  expect(await switchesTargetByClick(watcher)).toBe(true);
  await watcher.waitForScreen('results', MATCH_END_TIMEOUT_MS);
  await expect(watcher.ffaLayer('ffa-results')).toContainText('СЛЕДУЮЩИЙ МАТЧ — ТВОЙ');
});

test('телефон: левый стик ведёт танк, башня вправо — центр камеры правее танка, «АВТО» стреляет', async ({
  browser,
}) => {
  const server = await startServer({ FFA_MINIMUM: '1' });
  // Башня вправо с точки появления может смотреть в стену, откуда снаряд вернётся, — предохранитель держал бы огонь.
  const phone = await openFfa(browser, server.baseUrl, 'Телефон', {
    isTouch: true,
    settings: { hasRicochetGuard: false },
  });
  const before = ownTank(await phone.waitForFfa(isFighting, FIGHT_TIMEOUT_MS, 'бой'));
  const drive = await phone.touchDrag(PHONE_MOVE_TOUCH, PHONE_MOVE_RIGHT);
  await sleep(DRIVE_MS);
  await drive.release();
  const after = ownTank(await phone.waitForFfa(isFighting, SCREEN_TIMEOUT_MS, 'бой'));
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(MIN_DRIVE_DISTANCE);

  const aim = await phone.touchDrag(PHONE_AIM_TOUCH, PHONE_AIM_RIGHT);
  const framed = await phone.waitForFfa(
    (state) => {
      const me = state.me;
      const camera = state.camera;
      if (me === null || camera === null || state.viewCenter === null) {
        return false;
      }
      const isTurretRight = Math.abs(me.turret) < TURRET_TOLERANCE;
      return isTurretRight && camera.x + camera.width / 2 - me.x > CAMERA_SHIFT_MIN;
    },
    SCREEN_TIMEOUT_MS,
    'камера не ушла вправо за башней',
  );
  await aim.release();
  expect((framed.viewCenter?.x ?? 0) - ownTank(framed).x).toBeGreaterThan(CAMERA_SHIFT_MIN);

  await phone.waitForFfa((state) => state.bullets === 0, SCREEN_TIMEOUT_MS, 'снаряды касания погасли');
  expect(await phone.isAutoFireButtonVisible()).toBe(true);
  await phone.page.tap('#autofire');
  await phone.waitForFfa((state) => state.isAutoFiring && state.bullets > 0, SCREEN_TIMEOUT_MS, '«АВТО» не стреляет');
  await phone.page.tap('#autofire');
  expect(
    (await phone.waitForFfa((state) => !state.isAutoFiring, SCREEN_TIMEOUT_MS, '«АВТО» не выключилась')).isAutoFiring,
  ).toBe(false);
});

// Сколько людей и серверных ботов в играх на 10 — по /metrics сервера.
async function ffa10Players(server: GameServer): Promise<{ humans: number; bots: number }> {
  const text = await (await fetch(`${server.baseUrl}/metrics`)).text();
  const valueOf = (kind: string): number =>
    Number(new RegExp(`^tanks_players\\{mode="ffa10",kind="${kind}"\\} (\\d+)$`, 'm').exec(text)?.[1] ?? NaN);
  return { humans: valueOf('human'), bots: valueOf('bot') };
}

test('серверные боты: человек в лобби — боты с никами «Сержант [4]», «7 / 10», бой без роя, рядом танки ботов', async ({
  browser,
}) => {
  const server = await startServer({ FFA_SERVER_BOTS: '1', FFA_LOBBY_QUIET_SECONDS: '5' });
  const player = await openFfa(browser, server.baseUrl, 'Одиночка');
  await player.waitForScreen('lobby', SCREEN_TIMEOUT_MS);
  const lobby = player.ffaLayer('ffa-lobby');
  await expect(lobby.locator('.ffa-lobby-count')).toHaveText(`7 / ${String(SIZE)}`);
  await expect(lobby.locator('.ffa-nick', { hasText: 'Сержант [4]' })).toHaveCount(1);
  await expect(lobby.locator('.ffa-nick', { hasText: 'Призрак [7]' })).toHaveCount(1);
  expect(await ffa10Players(server)).toEqual({ humans: 1, bots: 6 });
  const fight = await player.waitForFfa(
    (state) => isFighting(state) && state.others.filter((tank) => tank.isAlive).length >= 5,
    FIGHT_TIMEOUT_MS,
    'бой с ботами',
  );
  expect(fight.players).toBe(7);
  expect(await driveForward(player)).toBeGreaterThan(MIN_DRIVE_DISTANCE);
});

test('серверные боты: второй браузер входит в полную игру с ботами — та же игра, бот ушёл, оба в бою', async ({
  browser,
}) => {
  const server = await startServer({ FFA_SERVER_BOTS: '1', FFA_MINIMUM: String(SIZE) });
  const first = await openFfa(browser, server.baseUrl, 'Первый');
  const firstFight = await first.waitForFfa(isFighting, FIGHT_TIMEOUT_MS, 'бой первого');
  expect(firstFight.players).toBe(SIZE);
  expect(await ffa10Players(server)).toEqual({ humans: 1, bots: SIZE - 1 });

  const second = await openFfa(browser, server.baseUrl, 'Второй', { isTouch: true });
  const secondFight = await second.waitForFfa(isFighting, FIGHT_TIMEOUT_MS, 'бой второго');
  expect(secondFight.gameId).toBe(firstFight.gameId);
  await second.waitForFfa(
    (state) => state.others.some((tank) => tank.id === firstFight.playerId),
    SCREEN_TIMEOUT_MS,
    'второй не видит первого',
  );
  expect(await ffa10Players(server)).toEqual({ humans: 2, bots: SIZE - 2 });
  expect((await first.ffaState())?.players).toBe(SIZE);
});

test('приглашение: первый в лобби жмёт «Позвать друга», второй по ссылке из буфера — в той же игре, без плашки', async ({
  browser,
}) => {
  const server = await startServer();
  const host = await openFfa(browser, server.baseUrl, 'Хозяин');
  const hostLobby = await host.waitForScreen('lobby', SCREEN_TIMEOUT_MS);
  await host.ffaButton('Позвать друга').click();
  await expect(host.ffaLayer('ffa-lobby').locator('.ffa-lobby-copied')).toBeVisible();
  const link = await host.clipboardText();
  expect(link).toBe(`${server.baseUrl}/ffa/${String(SIZE)}/${String(hostLobby.gameId)}`);

  const friend = await Player.openLink(browser, link, 'Друг', DEFAULT_STATS);
  players.push(friend);
  const friendLobby = await friend.waitForScreen('lobby', SCREEN_TIMEOUT_MS);
  expect(friendLobby.gameId).toBe(hostLobby.gameId);
  await host.waitForFfa((state) => state.players === 2, SCREEN_TIMEOUT_MS, 'друг в лобби хозяина');
  await expect(friend.ffaLayer('ffa-invite')).toHaveCount(0);
});

test('приглашение в игру, которой нет: лобби новой игры и плашка «ТОЙ ИГРЫ УЖЕ НЕТ»', async ({ browser }) => {
  const server = await startServer();
  const friend = await Player.openLink(browser, `${server.baseUrl}/ffa/${String(SIZE)}/ZZZZ`, 'Друг', DEFAULT_STATS);
  players.push(friend);
  const lobby = await friend.waitForScreen('lobby', SCREEN_TIMEOUT_MS);
  expect(lobby.gameId).not.toBe('ZZZZ');
  await expect(friend.ffaLayer('ffa-invite')).toHaveText('ТОЙ ИГРЫ УЖЕ НЕТВсе разошлись — вот новая');
});

test('серверные боты, короткий матч: второй входит в финал — сразу в бою, у обоих «выбыл» с ником бота, «ФИНАЛ!» про ботов, справка главной про финал', async ({
  browser,
}) => {
  const server = await startServer({
    FFA_SERVER_BOTS: '1',
    FFA_MATCH_SECONDS: String(SHORT_MATCH_SECONDS),
    FFA_RESULTS_SECONDS: String(SHORT_RESULTS_SECONDS),
  });
  const first = await openFfa(browser, server.baseUrl, 'Первый', { stats: TOUGH_STATS });
  await first.waitForFfa(isFighting, FIGHT_TIMEOUT_MS, 'бой первого');
  await expect(first.ffaLayer('ffa-final')).toContainText('Потом первыми выбывают боты', {
    timeout: MATCH_END_TIMEOUT_MS,
  });
  const atFinal = await first.waitForFfa((state) => state.isFinal, MATCH_END_TIMEOUT_MS, 'финал');
  // «ФИНАЛ!» видит только тот, чей танк на поле.
  if (isFighting(atFinal)) {
    await expect(first.ffaLayer('ffa-final')).toContainText(/ФИНАЛ!.*Подбили — вернёшься, пока живы боты/, {
      timeout: FINAL_NOTICE_MS,
    });
  }

  const second = await openFfa(browser, server.baseUrl, 'Второй');
  const landed = await second.waitForFfa(isFighting, SCREEN_TIMEOUT_MS, 'вошедший в финал при ботах — в бою');
  expect(landed.isFinal).toBe(true);
  const isBotOut = (line: string): boolean => /\[\d\] ⊘ выбыл$/.test(line);
  for (const player of [first, second]) {
    await player.waitForFfa((state) => state.feed.some(isBotOut), SCREEN_TIMEOUT_MS, 'строка «выбыл» с ником бота');
  }

  const home = await browser.newPage();
  try {
    await home.goto(`${server.baseUrl}/`);
    await expect(home.locator('#ffa-help')).toContainText('подбитые вылетают насовсем, но первыми — боты');
  } finally {
    await home.close();
  }
});
