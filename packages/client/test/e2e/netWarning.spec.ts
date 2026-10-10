import { expect, test } from '@playwright/test';
import { NetProxy } from './netProxy.js';
import { networkShape } from './networkProfile.js';
import { Player, sleep, type FfaDebugState } from './player.js';
import { GameServer } from './server.js';

const SIZE = 10;
const STATS = '2233';
const FIGHT_TIMEOUT_MS = 30_000;
const PING_MS = 50;
const EVEN_PLAY_MS = 10_000;
// Паузы раз в 2 с: вторая — через 2–4 с, плашка — через 3 с после неё.
const WARNING_TIMEOUT_MS = 20_000;
const POLL_MS = 250;

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

async function joinThrough(browser: Parameters<typeof Player.openFfa>[0], jitter: 'even' | 'stall'): Promise<Player> {
  const server = new GameServer({ FFA_LOBBY_WAIT_SECONDS: '1', FFA_MINIMUM: '1' });
  servers.push(server);
  await server.start();
  const proxy = await NetProxy.start(server.listenPort, networkShape({ pingMs: PING_MS, jitter }));
  proxies.push(proxy);
  const player = await Player.openFfa(browser, proxy.baseUrl, SIZE, 'Связной', STATS);
  players.push(player);
  await player.waitForFfa((state) => state.screen === 'fight' && state.me !== null, FIGHT_TIMEOUT_MS, 'бой');
  return player;
}

test.describe('предупреждение о плохой связи', () => {
  test('ровная сеть с пингом 50 — плашки нет весь бой', async ({ browser }) => {
    test.setTimeout(60_000);
    const player = await joinThrough(browser, 'even');
    const levels: number[] = [];
    const until = Date.now() + EVEN_PLAY_MS;
    while (Date.now() < until) {
      const state = await player.ffaState();
      levels.push(state?.netWarning.level ?? -1);
      await sleep(POLL_MS);
    }
    expect(levels.length).toBeGreaterThan(10);
    expect(levels.every((level) => level === 0)).toBe(true);
  });

  test('связь замирает раз в 2 с — оранжевая «Плохая сеть»', async ({ browser }) => {
    test.setTimeout(60_000);
    const player = await joinThrough(browser, 'stall');
    const warned: FfaDebugState = await player.waitForFfa(
      (state) => state.netWarning.level > 0,
      WARNING_TIMEOUT_MS,
      'предупреждение о связи',
    );
    expect(warned.netWarning).toMatchObject({ level: 2, pingDegree: 0, jitterDegree: 2, text: 'Плохая сеть' });
    expect(warned.netWarning.isShown).toBe(warned.screen === 'fight');
  });
});
