import { expect, test, type Page } from '@playwright/test';
import {
  BULLET_RADIUS,
  deriveStats,
  DT,
  STAT_MAX,
  TANK_RADIUS,
  type FfaEvent,
  type FfaMatch,
} from '@tanks/shared/engine';
import { MessageType, replayFfaJournal } from '@tanks/shared/protocol';
import { PICTURE_MIN_TIME_RATE, PICTURE_NEAR } from '../../src/pictureTime.js';
import { isPredictedBullet } from '../../src/predictedShots.js';
import { NetProxy } from './netProxy.js';
import { normalizeAngle, Player, sleep } from './player.js';
import { GameServer } from './server.js';
import { SwarmProcess } from './swarm.js';

const SIZE = 10;
const BOT_COUNT = SIZE - 1;
// Броня и двигатель: танк живёт дольше под огнём роя и ездит быстро — разрыв во времени заметнее.
const STURDY_STATS = '5500';
const FIGHT_TIMEOUT_MS = 30_000;
// Бой идёт, пока кадров со снарядом у своего танка не наберётся с запасом на кадры с поправкой предсказания,
// но не дольше предела.
const COLLECT_MAX_MS = 90_000;
const COLLECT_MIN_MS = 20_000;
const NEAR_FRAMES_WANTED = 45;
const TURN_EVERY_MS = 1_500;
// Погоня в общем бою: шаг управления, дистанция, на которой танк кружит вокруг цели, и допуск курса.
const CHASE_STEP_MS = 150;
const CIRCLE_DISTANCE = 260;
const HEADING_TOLERANCE = 0.25;
// Допуски сверки в единицах поля.
const POSITION_TOLERANCE = 2;
const PREDICTION_TOLERANCE = 1;
const MAX_MISPREDICTED_SHARE = 0.1;
const MIN_NEAR_FRAMES = 20;
const MIN_NEAR_BULLETS = 3;
// Снарядов у чужих танков вдали от своего: в общем бою их десятки, в дуэли — единицы за бой.
const MIN_FAR_BULLETS_FFA = 20;
const MIN_FAR_BULLETS_DUEL = 1;
const CONTACT = TANK_RADIUS + BULLET_RADIUS;
// Кадров, где свой снаряд касается чужого корпуса: общий бой стреляет по цели всю погоню и не кончается, пока их не
// наберётся с запасом.
const MIN_OWN_AT_HULL_FFA = 2;
const OWN_AT_HULL_FRAMES_WANTED = 15;
// Снаряд, пропавший на сервере у самого своего танка, — попадание: касание плюс шаг самого быстрого снаряда за тик.
const HIT_REACH = CONTACT + deriveStats({ armor: 0, engine: 0, gun: STAT_MAX, reload: 0 }).bulletSpeed * DT;
// Снаряд у чужого танка и не ближе этого к своему — во времени чужих: улетевший от своего танка снаряд успевает
// сойти к нему по правилу «не медленнее половины».
const FAR_FROM_ME = 400;
// Снаряд выше тика чужих, сходящий к нему по правилу «не медленнее половины»: за кадр его тик растёт не больше доли
// хода тика чужих.
const FAR_TICK_TOLERANCE = 1e-6;
const DUEL_BOT_ROOM = 'bot09picture';

interface Point {
  x: number;
  y: number;
}

interface PictureBullet extends Point {
  id: number;
  owner: number;
  tick: number;
}

interface Picture {
  myTick: number;
  othersTick: number;
  latestTick: number;
  me: Point | null;
  others: Point[];
  bullets: PictureBullet[];
}

interface CollectedFrame {
  round: number;
  pending: number;
  picture: Picture;
}

interface TruthTick {
  me: Point | null;
  bullets: Map<number, Point>;
}

type Truth = (round: number, tick: number) => TruthTick | undefined;

interface Verdict {
  frames: number;
  nearFrames: number;
  nearBullets: number;
  mispredicted: number;
  unconfirmedDeaths: number;
  hullDeaths: number;
  insideHull: number;
  ownAtHull: number;
  farBullets: number;
  hits: number;
  misses: number;
  violations: string[];
  meanGapTicks: number;
  meanPending: number;
}

const servers: GameServer[] = [];
const swarms: SwarmProcess[] = [];
const proxies: NetProxy[] = [];
const players: Player[] = [];

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

// Каждым кадром — нарисованный кадр из `debugState().picture`; номер раунда или матча — чтобы не смешать тики.
// Кадры, где чужой снаряд у своего танка и где свой снаряд у чужого корпуса, считаются сразу: по ним тест решает,
// хватит ли боя.
async function startCollecting(page: Page, myOwner: number): Promise<void> {
  await page.evaluate(
    ({ owner, near, hull }) => {
      interface Debug {
        picture?: unknown;
        matchIndex?: number;
        roundIndex?: number;
        pending?: number;
      }
      const scope = window as unknown as {
        tanksGame: { debugState(): Debug | null };
        pictureFrames: unknown[];
        nearFrames: number;
        ownAtHullFrames: number;
        isCollecting: boolean;
      };
      scope.pictureFrames = [];
      scope.nearFrames = 0;
      scope.ownAtHullFrames = 0;
      scope.isCollecting = true;
      const collect = (): void => {
        const state = scope.tanksGame.debugState();
        const picture = state?.picture as Picture | null | undefined;
        if (picture !== undefined && picture !== null) {
          scope.pictureFrames.push({
            round: state?.matchIndex ?? state?.roundIndex ?? 0,
            pending: state?.pending ?? 0,
            picture,
          });
          const me = picture.me;
          const isNear =
            me !== null &&
            picture.bullets.some(
              (bullet) => bullet.owner !== owner && Math.hypot(bullet.x - me.x, bullet.y - me.y) <= near,
            );
          scope.nearFrames += isNear ? 1 : 0;
          const isOwnAtHull = picture.bullets.some(
            (bullet) =>
              bullet.owner === owner &&
              picture.others.some((other) => Math.hypot(bullet.x - other.x, bullet.y - other.y) <= hull),
          );
          scope.ownAtHullFrames += isOwnAtHull ? 1 : 0;
        }
        if (scope.isCollecting) {
          requestAnimationFrame(collect);
        }
      };
      requestAnimationFrame(collect);
    },
    { owner: myOwner, near: PICTURE_NEAR, hull: CONTACT + POSITION_TOLERANCE },
  );
}

function nearFramesSoFar(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { nearFrames: number }).nearFrames);
}

function ownAtHullFramesSoFar(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { ownAtHullFrames: number }).ownAtHullFrames);
}

function stopCollecting(page: Page): Promise<CollectedFrame[]> {
  return page.evaluate(() => {
    const scope = window as unknown as { pictureFrames: CollectedFrame[]; isCollecting: boolean };
    scope.isCollecting = false;
    return scope.pictureFrames;
  });
}

// Свой танк ездит кругами — газ держится, поворот меняется, — пока снарядов у своего танка не наберётся достаточно.
async function driveCircles(page: Page): Promise<void> {
  await page.keyboard.down('KeyW');
  const keys = ['KeyA', 'KeyD'];
  const startedAt = Date.now();
  for (let index = 0; Date.now() - startedAt < COLLECT_MAX_MS; index++) {
    const key = keys[index % keys.length] ?? 'KeyA';
    await page.keyboard.down(key);
    await sleep(TURN_EVERY_MS);
    await page.keyboard.up(key);
    const isEnough = (await nearFramesSoFar(page)) >= NEAR_FRAMES_WANTED;
    if (isEnough && Date.now() - startedAt >= COLLECT_MIN_MS) {
      break;
    }
  }
  await page.keyboard.up('KeyW');
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Клавиши, которые держит игрок: нажимаются и отпускаются только при смене.
class HeldKeys {
  private readonly held = new Set<string>();

  constructor(private readonly page: Page) {}

  async set(keys: readonly string[]): Promise<void> {
    for (const key of [...this.held]) {
      if (!keys.includes(key)) {
        await this.page.keyboard.up(key);
        this.held.delete(key);
      }
    }
    for (const key of keys) {
      if (!this.held.has(key)) {
        await this.page.keyboard.down(key);
        this.held.add(key);
      }
    }
  }
}

// Общий бой: свой танк едет к ближайшему живому врагу, кружит вокруг него и стреляет по нему — рой стреляет по тому,
// кто рядом.
async function chaseNearest(player: Player): Promise<void> {
  const keys = new HeldKeys(player.page);
  const viewport = player.page.viewportSize() ?? { width: 0, height: 0 };
  const aimReach = Math.min(viewport.width, viewport.height) / 3;
  await player.page.mouse.move(viewport.width / 2 + aimReach, viewport.height / 2);
  await player.setFiring(true);
  const startedAt = Date.now();
  while (Date.now() - startedAt < COLLECT_MAX_MS) {
    const state = await player.ffaState();
    const me = state?.me ?? null;
    const targets = (state?.others ?? []).filter((other) => other.isAlive);
    const target = me === null ? undefined : targets.sort((a, b) => distance(a, me) - distance(b, me))[0];
    if (me === null || target === undefined) {
      await keys.set([]);
    } else {
      const toTarget = Math.atan2(target.y - me.y, target.x - me.x);
      const wanted = distance(target, me) > CIRCLE_DISTANCE ? toTarget : toTarget + Math.PI / 2;
      const diff = normalizeAngle(wanted - me.heading);
      const turn = Math.abs(diff) < HEADING_TOLERANCE ? [] : [diff > 0 ? 'KeyD' : 'KeyA'];
      await keys.set(['KeyW', ...turn]);
      await player.page.mouse.move(
        viewport.width / 2 + aimReach * Math.cos(toTarget),
        viewport.height / 2 + aimReach * Math.sin(toTarget),
      );
    }
    await sleep(CHASE_STEP_MS);
    const isEnough =
      (await nearFramesSoFar(player.page)) >= NEAR_FRAMES_WANTED &&
      (await ownAtHullFramesSoFar(player.page)) >= OWN_AT_HULL_FRAMES_WANTED;
    if (isEnough && Date.now() - startedAt >= COLLECT_MIN_MS) {
      break;
    }
  }
  await player.setFiring(false);
  await keys.set([]);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Снаряд у своего танка — попадание, если на сервере он пропал рядом с ним; иначе пролетел мимо.
function hitsAndMisses(
  frames: readonly CollectedFrame[],
  truth: Truth,
  nearBullets: ReadonlyMap<number, number>,
): { hits: number; misses: number } {
  const lastTick = Math.max(...frames.map(({ picture }) => picture.latestTick));
  let hits = 0;
  for (const [id, round] of nearBullets) {
    for (let tick = 0; tick <= lastTick; tick++) {
      const now = truth(round, tick);
      const next = truth(round, tick + 1);
      const at = now?.bullets.get(id);
      const me = now?.me ?? null;
      if (at === undefined || me === null || next === undefined || next.bullets.has(id)) {
        continue;
      }
      if (distance(at, me) <= HIT_REACH) {
        hits++;
        break;
      }
    }
  }
  return { hits, misses: nearBullets.size - hits };
}

// Тик, с которого снаряд мёртв на сервере, если он погиб к тику tick; null — жив.
function deathTickOf(truth: Truth, round: number, id: number, tick: number): number | null {
  let death: number | null = null;
  for (let candidate = tick; truth(round, candidate)?.bullets.has(id) === false; candidate--) {
    death = candidate;
  }
  return death;
}

// Место снаряда на сервере в дробном тике: между соседними тиками по прямой; снаряд, которого нет в одном из них, —
// null.
function serverAt(truth: Truth, round: number, id: number, tick: number): Point | null {
  const before = truth(round, Math.floor(tick))?.bullets.get(id);
  const after = truth(round, Math.ceil(tick))?.bullets.get(id);
  if (before === undefined || after === undefined) {
    return null;
  }
  const t = tick - Math.floor(tick);
  return { x: before.x + (after.x - before.x) * t, y: before.y + (after.y - before.y) * t };
}

// Снаряд у чужого танка и далеко от своего — и в этом кадре, и на месте прошлого кадра (от него клиент меряет
// расстояния) — в тике чужих либо выше него, но сходит к нему с наибольшей допустимой скоростью: от прошлого кадра
// его тик вырос не больше чем на PICTURE_MIN_TIME_RATE хода тика чужих (снаряд подлетел быстрее, чем успел сойти,
// или рядом появился танк). Чужой — на месте сервера в своём тике; свой сверяется только по тику: на подлёте он
// уходит вперёд своей дорожки и стоит на броне до вспышки.
function judgeFar(
  frame: CollectedFrame,
  previous: CollectedFrame | null,
  truth: Truth,
  violations: string[],
  checked: Set<number>,
  myOwner: number,
): void {
  const { round, picture } = frame;
  const me = picture.me;
  if (me === null) {
    return;
  }
  const before = previous?.round === round ? previous.picture : null;
  if (before === null) {
    return;
  }
  const toOthers = (point: Point): number => Math.min(...picture.others.map((other) => distance(point, other)));
  for (const bullet of picture.bullets) {
    const was = before.bullets.find((candidate) => candidate.id === bullet.id);
    const toOther = toOthers(bullet);
    const isNearOther = toOther <= PICTURE_NEAR && was !== undefined && toOthers(was) <= PICTURE_NEAR;
    if (!isNearOther || distance(bullet, me) < FAR_FROM_ME) {
      continue;
    }
    checked.add(bullet.id);
    const isConverging =
      bullet.tick - was.tick <= PICTURE_MIN_TIME_RATE * (picture.othersTick - before.othersTick) + FAR_TICK_TOLERANCE;
    if (bullet.tick - picture.othersTick > FAR_TICK_TOLERANCE && !isConverging) {
      violations.push(
        `снаряд ${String(bullet.id)} у чужого танка в тике ${bullet.tick.toFixed(2)}, а не ${picture.othersTick.toFixed(2)}`,
      );
      continue;
    }
    const server = serverAt(truth, round, bullet.id, bullet.tick);
    if (bullet.owner !== myOwner && toOther > CONTACT + POSITION_TOLERANCE && server !== null) {
      if (distance(bullet, server) > POSITION_TOLERANCE) {
        violations.push(
          `снаряд ${String(bullet.id)} у чужого танка в ${distance(bullet, server).toFixed(1)} от места сервера`,
        );
      }
    }
  }
}

function nearestOf(point: Point, others: readonly Point[]): Point | null {
  let best: Point | null = null;
  for (const other of others) {
    if (best === null || distance(point, other) < distance(point, best)) {
      best = other;
    }
  }
  return best;
}

// Свой снаряд у нарисованного чужого танка: не внутри корпуса и не назад против своего прошлого хода — разве что его
// везёт на броне надвигающийся танк. Возвращает число кадров, где свой снаряд касается чужого корпуса.
function judgeOwnAtHull(frames: readonly CollectedFrame[], myOwner: number, violations: string[]): number {
  let atHull = 0;
  for (let index = 2; index < frames.length; index++) {
    const [first, second, third] = [frames[index - 2], frames[index - 1], frames[index]];
    if (first === undefined || second === undefined || third === undefined) {
      continue;
    }
    const now = third.picture;
    for (const bullet of now.bullets.filter((candidate) => candidate.owner === myOwner)) {
      const tank = nearestOf(bullet, now.others);
      if (tank === null || distance(bullet, tank) > CONTACT + POSITION_TOLERANCE) {
        continue;
      }
      atHull++;
      if (distance(bullet, tank) < CONTACT - POSITION_TOLERANCE) {
        violations.push(`свой снаряд ${String(bullet.id)} внутри чужого корпуса: ${distance(bullet, tank).toFixed(1)}`);
      }
      const isSameRound = first.round === third.round && second.round === third.round;
      const was = second.picture.bullets.find((candidate) => candidate.id === bullet.id);
      const before = first.picture.bullets.find((candidate) => candidate.id === bullet.id);
      const wasTank = was === undefined ? null : nearestOf(was, second.picture.others);
      if (
        !isSameRound ||
        was === undefined ||
        before === undefined ||
        wasTank === null ||
        distance(was, before) === 0
      ) {
        continue;
      }
      const along =
        ((bullet.x - was.x) * (was.x - before.x) + (bullet.y - was.y) * (was.y - before.y)) / distance(was, before);
      if (along < -distance(tank, wasTank) - POSITION_TOLERANCE) {
        violations.push(`свой снаряд ${String(bullet.id)} у чужого корпуса шагнул назад на ${(-along).toFixed(1)}`);
      }
    }
  }
  return atHull;
}

// Сверка кадров с правдой сервера в тике своего танка: чужой снаряд у своего танка — в этом тике и на месте сервера;
// внутри своего корпуса не рисуется, если и на сервере он не там (танк, въехавший в снаряд, накрывает его до
// проверки попаданий следующего тика); снаряд в тике, который уже пришёл снимком, — живой на сервере. Снаряд у своего
// танка, погибший на сервере после последнего пришедшего снимка о другой танк или стену, — гибель, о которой клиент
// ещё не знает: не ошибка, считается отдельно; погибший так о свой корпус — ошибка: клиент досчитывает попадание
// по себе сам. Вторая половина договора — снаряды у чужих танков в тике чужих.
function judge(frames: readonly CollectedFrame[], truth: Truth, myOwner: number): Verdict {
  const violations: string[] = [];
  let nearFrames = 0;
  let mispredicted = 0;
  let unconfirmedDeaths = 0;
  let hullDeaths = 0;
  let insideHull = 0;
  const nearBullets = new Map<number, number>();
  const farBullets = new Set<number>();
  let previous: CollectedFrame | null = null;
  for (const frame of frames) {
    const { round, picture } = frame;
    for (const bullet of picture.bullets) {
      const isConfirmedTick = bullet.tick <= Math.ceil(picture.othersTick);
      if (isPredictedBullet(bullet.id) || !isConfirmedTick) {
        continue;
      }
      if (truth(round, Math.ceil(bullet.tick))?.bullets.has(bullet.id) !== true) {
        violations.push(`призрак: снаряд ${String(bullet.id)} в тике ${bullet.tick.toFixed(2)}`);
      }
    }
    judgeFar(frame, previous, truth, violations, farBullets, myOwner);
    previous = frame;
    const me = picture.me;
    const atMine = truth(round, picture.myTick);
    if (me === null || atMine?.me === null || atMine?.me === undefined) {
      continue;
    }
    if (distance(me, atMine.me) > PREDICTION_TOLERANCE) {
      mispredicted++;
      continue;
    }
    let hasNear = false;
    for (const bullet of picture.bullets) {
      if (bullet.owner === myOwner || distance(bullet, me) > PICTURE_NEAR) {
        continue;
      }
      hasNear = true;
      nearBullets.set(bullet.id, round);
      const server = atMine.bullets.get(bullet.id);
      const isServerInside = server !== undefined && distance(server, atMine.me) < CONTACT;
      if (distance(bullet, me) < CONTACT - POSITION_TOLERANCE && !isServerInside) {
        insideHull++;
      }
      if (Math.abs(bullet.tick - picture.myTick) > 1e-9) {
        violations.push(
          `снаряд ${String(bullet.id)} у своего танка в тике ${bullet.tick.toFixed(2)}, а не ${String(picture.myTick)}`,
        );
        continue;
      }
      if (server === undefined) {
        const death = deathTickOf(truth, round, bullet.id, picture.myTick);
        if (death !== null && death > picture.latestTick) {
          const before = truth(round, death - 1);
          const last = before?.bullets.get(bullet.id);
          const meBefore = before?.me ?? null;
          const isAtMe = last !== undefined && meBefore !== null && distance(last, meBefore) <= HIT_REACH;
          if (isAtMe) {
            hullDeaths++;
          } else {
            unconfirmedDeaths++;
          }
          continue;
        }
        violations.push(
          `призрак у своего танка: снаряд ${String(bullet.id)} погиб на тике ${String(death)}, снимок ${String(picture.latestTick)}`,
        );
        continue;
      }
      const screenGap = distance(bullet, me);
      const serverGap = distance(server, atMine.me);
      if (Math.abs(screenGap - serverGap) > POSITION_TOLERANCE || distance(bullet, server) > POSITION_TOLERANCE) {
        violations.push(
          `снаряд ${String(bullet.id)}: до танка на экране ${screenGap.toFixed(1)}, на сервере ${serverGap.toFixed(1)}`,
        );
      }
    }
    nearFrames += hasNear ? 1 : 0;
  }
  return {
    frames: frames.length,
    nearFrames,
    nearBullets: nearBullets.size,
    mispredicted,
    unconfirmedDeaths,
    hullDeaths,
    insideHull,
    ownAtHull: judgeOwnAtHull(frames, myOwner, violations),
    farBullets: farBullets.size,
    ...hitsAndMisses(frames, truth, nearBullets),
    violations,
    meanGapTicks: mean(frames.map(({ picture }) => picture.myTick - picture.othersTick)),
    meanPending: mean(frames.map(({ pending }) => pending)),
  };
}

function expectAgreement(verdict: Verdict, what: string, minFarBullets: number, minOwnAtHull: number): void {
  const summary = `${what}: кадров ${String(verdict.frames)}, со снарядом у своего танка ${String(verdict.nearFrames)}, снарядов ${String(verdict.nearBullets)}, у чужих танков ${String(verdict.farBullets)}, расхождений предсказания ${String(verdict.mispredicted)}, попаданий ${String(verdict.hits)}, промахов ${String(verdict.misses)}, гибелей до снимка о свой корпус ${String(verdict.hullDeaths)}, о другое ${String(verdict.unconfirmedDeaths)}, внутри корпуса ${String(verdict.insideHull)}, своих у чужого корпуса ${String(verdict.ownAtHull)}, разрыв ${verdict.meanGapTicks.toFixed(2)} тика, неподтверждённых ${verdict.meanPending.toFixed(2)}`;
  console.log(summary);
  test.info().annotations.push({ type: 'картинка', description: summary });
  expect(verdict.violations.slice(0, 10), summary).toEqual([]);
  expect(verdict.hullDeaths, summary).toBe(0);
  expect(verdict.insideHull, summary).toBe(0);
  expect(verdict.nearFrames, summary).toBeGreaterThanOrEqual(MIN_NEAR_FRAMES);
  expect(verdict.nearBullets, summary).toBeGreaterThanOrEqual(MIN_NEAR_BULLETS);
  expect(verdict.farBullets, summary).toBeGreaterThanOrEqual(minFarBullets);
  expect(verdict.ownAtHull, summary).toBeGreaterThanOrEqual(minOwnAtHull);
  expect(verdict.hits, summary).toBeGreaterThanOrEqual(1);
  expect(verdict.mispredicted / Math.max(1, verdict.frames), summary).toBeLessThanOrEqual(MAX_MISPREDICTED_SHARE);
}

// Правда общего боя — прогон журнала сервера движком: положения своего танка и всех снарядов на каждом тике матча.
function ffaTruth(log: string, playerId: number): Truth {
  const byMatch = new Map<FfaMatch, Map<number, TruthTick>>();
  const replay = replayFfaJournal(log.split('\n'), {
    onTick: (match: FfaMatch, _gameTick: number, _events: readonly FfaEvent[]) => {
      const ticks = byMatch.get(match) ?? new Map<number, TruthTick>();
      byMatch.set(match, ticks);
      const me = match.world.tanks.find((tank) => tank.id === playerId && tank.isAlive);
      ticks.set(match.world.tick, {
        me: me === undefined ? null : { x: me.x, y: me.y },
        bullets: new Map(match.world.bullets.map((bullet) => [bullet.id, { x: bullet.x, y: bullet.y }])),
      });
    },
  });
  return (round, tick) => {
    const match = replay.matches.find((candidate) => candidate.index === round)?.match;
    return match === undefined ? undefined : byMatch.get(match)?.get(tick);
  };
}

// Правда дуэли — снимки сервера из соединения игры: свой танк и все снаряды на каждом тике раунда.
function duelTruth(proxy: NetProxy, side: number): Truth {
  const byRound = new Map<number, Map<number, TruthTick>>();
  let round = 0;
  for (const { message } of proxy.serverMessages) {
    if (message.type === MessageType.RoundStart) {
      round = message.roundIndex;
      continue;
    }
    if (message.type !== MessageType.Snapshot) {
      continue;
    }
    const ticks = byRound.get(round) ?? new Map<number, TruthTick>();
    byRound.set(round, ticks);
    const me = message.tanks[side === 0 ? 0 : 1];
    ticks.set(message.tick, {
      me: me.isAlive ? { x: me.x, y: me.y } : null,
      bullets: new Map(message.bullets.map((bullet) => [bullet.id, { x: bullet.x, y: bullet.y }])),
    });
  }
  return (index, tick) => byRound.get(index)?.get(tick);
}

test.describe('картинка совпадает с сервером', () => {
  for (const delayMs of [30, 75]) {
    test(`общий бой через посредника ${String(delayMs)} мс в каждую сторону`, async ({ browser }) => {
      test.setTimeout(180_000);
      const server = new GameServer({ FFA_LOBBY_QUIET_SECONDS: '1', FFA_MINIMUM: '2' });
      servers.push(server);
      await server.start();
      const proxy = await NetProxy.start(server.listenPort, { delayMs });
      proxies.push(proxy);
      const player = await Player.openFfa(browser, proxy.baseUrl, SIZE, 'Дима', STURDY_STATS);
      players.push(player);
      swarms.push(SwarmProcess.start(server.wsUrl, SIZE, BOT_COUNT));
      const start = await player.waitForFfa(
        (state) => state.screen === 'fight' && state.me !== null,
        FIGHT_TIMEOUT_MS,
        'бой',
      );
      await startCollecting(player.page, start.playerId ?? -1);
      await chaseNearest(player);
      const frames = (await stopCollecting(player.page)).filter((frame) => frame.round === start.matchIndex);
      const gameId = await player.page.evaluate(() => {
        const scope = window as unknown as { tanksGame: { debugState(): { gameId?: string } } };
        return scope.tanksGame.debugState().gameId ?? '';
      });
      for (const swarm of swarms.splice(0)) {
        await swarm.stop();
      }
      await server.stop();
      const truth = ffaTruth(server.gameLog(gameId), start.playerId ?? -1);
      expectAgreement(
        judge(frames, truth, start.playerId ?? -1),
        `общий бой, ${String(delayMs)} мс`,
        MIN_FAR_BULLETS_FFA,
        MIN_OWN_AT_HULL_FFA,
      );
    });
  }

  for (const delayMs of [30, 75]) {
    test(`дуэль с ботом через посредника ${String(delayMs)} мс в каждую сторону`, async ({ browser }) => {
      test.setTimeout(180_000);
      const server = new GameServer();
      servers.push(server);
      await server.start();
      const proxy = await NetProxy.start(server.listenPort, { delayMs });
      proxies.push(proxy);
      const player = await Player.open(browser, proxy.baseUrl, DUEL_BOT_ROOM, 'Дима', STURDY_STATS);
      players.push(player);
      const start = await player.waitForFight(FIGHT_TIMEOUT_MS);
      await startCollecting(player.page, start.side);
      await driveCircles(player.page);
      const frames = await stopCollecting(player.page);
      const side = start.side;
      expectAgreement(
        judge(frames, duelTruth(proxy, side), side),
        `дуэль, ${String(delayMs)} мс`,
        MIN_FAR_BULLETS_DUEL,
        0,
      );
    });
  }
});
