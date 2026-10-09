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
import {
  PICTURE_APPROACH_SPAN,
  PICTURE_CATCH_UP_RATE,
  PICTURE_LEAD_RATE,
  PICTURE_MIN_TIME_RATE,
  PICTURE_NEAR,
} from '../../src/pictureTime.js';
import { isBulletHitFlags, type OwnHitCounts } from '../../src/ownHits.js';
import type { OwnShotCounts } from '../../src/ownShots.js';
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
// Кадров касания без сыгранного попадания (попадание, которого досчёт не предсказал, играет снимок) — не больше одного
// или этой доли; отменённых касаний — не больше этой доли сыгранных.
const MAX_TOUCH_UNPLAYED_SHARE = 0.1;
const MAX_CANCELLED_SHARE = 0.1;
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
// Кадров со своим снарядом вдали от чужих: в тесном общем бою их бывает мало, бой не кончается, пока их нет.
const OWN_FAR_FRAMES_WANTED = 10;
// Снаряд, пропавший на сервере у самого своего танка, — попадание: касание плюс шаг самого быстрого снаряда за тик.
const HIT_REACH = CONTACT + deriveStats({ armor: 0, engine: 0, gun: STAT_MAX, reload: 0 }).bulletSpeed * DT;
// Снаряд у чужого танка и не ближе этого к своему — во времени чужих: улетевший от своего танка снаряд успевает
// сойти к нему по правилу «не медленнее половины».
const FAR_FROM_ME = 400;
// Снаряд выше тика чужих, сходящий к нему по правилу «не медленнее половины»: за кадр его тик растёт не больше доли
// хода тика чужих.
const FAR_TICK_TOLERANCE = 1e-6;
// На краю зоны своего танка свой снаряд переходит в его тик ступенькой не больше стольких тиков.
const OWN_ZONE_STEP_TICKS = 1;
// Путь снаряда сервера у места касания — столько тиков в обе стороны: на подлёте снаряд рисуется впереди дорожки на
// запас подлёта.
const TRACK_SPAN_TICKS = 4;
// Самое быстрое сближение своего снаряда с чужим танком за тик: самый быстрый снаряд, разогнанный самым быстрым танком,
// и самый быстрый танк навстречу.
const FASTEST_TANK_SPEED = deriveStats({ armor: 0, engine: STAT_MAX, gun: 0, reload: 0 }).maxSpeed;
const OWN_CLOSING_MAX =
  (deriveStats({ armor: 0, engine: 0, gun: STAT_MAX, reload: 0 }).bulletSpeed + 2 * FASTEST_TANK_SPEED) * DT;
// Самый быстрый ход своего снаряда за тик: самый быстрый снаряд, разогнанный самым быстрым танком.
const OWN_STEP_MAX =
  (deriveStats({ armor: 0, engine: 0, gun: STAT_MAX, reload: 0 }).bulletSpeed + FASTEST_TANK_SPEED) * DT;
// Неподтверждённых своих выстрелов — не больше одного или этой доли сыгранных.
const MAX_UNCONFIRMED_SHOT_SHARE = 0.1;
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

// ownShift — смещение нарисованного своего танка от предсказанного (сглаживание сети); снаряды у своего танка
// нарисованы с тем же сдвигом.
interface Picture {
  myTick: number;
  othersTick: number;
  latestTick: number;
  me: Point | null;
  others: Point[];
  bullets: PictureBullet[];
  ownShift: Point;
}

// ownHits — попадания по своему танку, ownShots — свои выстрелы по предсказанию с начала раунда или матча.
interface CollectedFrame {
  round: number;
  pending: number;
  picture: Picture;
  ownHits: OwnHitCounts;
  ownShots: OwnShotCounts;
}

interface TruthBullet extends Point {
  owner: number;
}

// hitsOnMe — попаданий снарядом по своему танку в этом тике.
interface TruthTick {
  me: Point | null;
  bullets: Map<number, TruthBullet>;
  hitsOnMe: number;
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
  ownPredicted: number;
  ownMispredicted: number;
  ownDoubles: number;
  ownInMyTime: number;
  ownLargestStep: number;
  touchFrames: number;
  touchFramesPlayed: number;
  ownHits: OwnHitCounts;
  ownShots: OwnShotCounts;
  serverHitsOnMe: number;
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
// Кадры, где чужой снаряд у своего танка, где свой снаряд у чужого корпуса и где свой снаряд вдали от чужих (как
// в `judgeOwnInMyTime`), считаются сразу: по ним тест решает, хватит ли боя.
async function startCollecting(page: Page, myOwner: number): Promise<void> {
  await page.evaluate(
    ({ owner, near, hull, approachPerTick }) => {
      interface Debug {
        picture?: unknown;
        matchIndex?: number;
        roundIndex?: number;
        pending?: number;
        ownHits?: OwnHitCounts | null;
        ownShots?: OwnShotCounts | null;
      }
      const scope = window as unknown as {
        tanksGame: { debugState(): Debug | null };
        pictureFrames: unknown[];
        nearFrames: number;
        ownAtHullFrames: number;
        ownFarFrames: number;
        isCollecting: boolean;
      };
      scope.pictureFrames = [];
      scope.nearFrames = 0;
      scope.ownAtHullFrames = 0;
      scope.ownFarFrames = 0;
      scope.isCollecting = true;
      const collect = (): void => {
        const state = scope.tanksGame.debugState();
        const picture = state?.picture as Picture | null | undefined;
        if (picture !== undefined && picture !== null) {
          scope.pictureFrames.push({
            round: state?.matchIndex ?? state?.roundIndex ?? 0,
            pending: state?.pending ?? 0,
            picture,
            ownHits: state?.ownHits ?? { played: 0, confirmed: 0, cancelled: 0, served: 0, doubles: 0 },
            ownShots: state?.ownShots ?? { played: 0, confirmed: 0, unconfirmed: 0 },
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
          const reach =
            near +
            approachPerTick * (picture.myTick - picture.othersTick) +
            2 * Math.hypot(picture.ownShift.x, picture.ownShift.y);
          const isOwnFar = picture.bullets.some(
            (bullet) =>
              me !== null &&
              bullet.owner === owner &&
              picture.others.every((other) => Math.hypot(bullet.x - other.x, bullet.y - other.y) > reach),
          );
          scope.ownFarFrames += isOwnFar ? 1 : 0;
        }
        if (scope.isCollecting) {
          requestAnimationFrame(collect);
        }
      };
      requestAnimationFrame(collect);
    },
    {
      owner: myOwner,
      near: PICTURE_NEAR,
      hull: CONTACT + POSITION_TOLERANCE,
      approachPerTick: PICTURE_APPROACH_SPAN * OWN_CLOSING_MAX,
    },
  );
}

function ownFarFramesSoFar(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { ownFarFrames: number }).ownFarFrames);
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
      (await ownAtHullFramesSoFar(player.page)) >= OWN_AT_HULL_FRAMES_WANTED &&
      (await ownFarFramesSoFar(player.page)) >= OWN_FAR_FRAMES_WANTED;
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
// уходит вперёд своей дорожки и стоит на броне до вспышки, а в кадре ухода с брони его тик переставлен на место
// ухода — этот кадр сверяет judgeOwnSteps по сдвигу.
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
    const isOwnRelease = bullet.owner === myOwner && isLeavingArmor(bullet, was, picture, before);
    if (bullet.tick - picture.othersTick > FAR_TICK_TOLERANCE && !isConverging && !isOwnRelease) {
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

// Со сглаживанием сети снаряд на броне чужого танка рядом со своим сдвинут на смещение своего танка: допуск на него.
function isOnArmor(point: Point, picture: Picture): boolean {
  const tank = nearestOf(point, picture.others);
  const shift = Math.hypot(picture.ownShift.x, picture.ownShift.y);
  return tank !== null && distance(point, tank) <= CONTACT + POSITION_TOLERANCE + shift;
}

// Снаряд в прошлом кадре стоял на броне, а в этом сошёл с неё или сдвинулся относительно танка под ним: место ухода с
// брони лежит на самой окружности касания, и снаряд в этом кадре ещё у корпуса.
function isLeavingArmor(bullet: Point, was: Point, now: Picture, before: Picture): boolean {
  const tank = nearestOf(was, before.others);
  if (tank === null || !isOnArmor(was, before)) {
    return false;
  }
  const tankNow = nearestOf(tank, now.others);
  if (tankNow === null || !isOnArmor(bullet, now)) {
    return true;
  }
  const slide = distance(
    { x: bullet.x - tankNow.x, y: bullet.y - tankNow.y },
    { x: was.x - tank.x, y: was.y - tank.y },
  );
  return slide > POSITION_TOLERANCE;
}

// Свой снаряд у нарисованного чужого танка: не внутри корпуса и не назад против своего полёта — разве что его везёт на
// броне надвигающийся танк; тот же танк в прошлом кадре — ближайший к нему. Полёт — направление последнего шага
// снаряда от кадра к кадру вне брони: на броне снаряд едет с танком, и его шаг — ход танка, а не полёт. Возвращает
// число кадров, где свой снаряд касается чужого корпуса.
// Со сглаживанием сети снаряд, который ближе PICTURE_NEAR к своему танку, сдвинут вместе с нарисованным своим танком,
// дальше — нет: у чужого корпуса рядом со своим танком допуск больше на смещение своего танка в этом и прошлом кадре.
function judgeOwnAtHull(frames: readonly CollectedFrame[], myOwner: number, violations: string[]): number {
  let atHull = 0;
  const flight = new Map<number, Point>();
  for (let index = 1; index < frames.length; index++) {
    const [previous, frame] = [frames[index - 1], frames[index]];
    if (frame === undefined || previous?.round !== frame.round) {
      flight.clear();
      continue;
    }
    const now = frame.picture;
    const before = previous.picture;
    const shift = Math.hypot(now.ownShift.x, now.ownShift.y);
    const shiftSpan = shift + Math.hypot(before.ownShift.x, before.ownShift.y);
    for (const bullet of now.bullets.filter((candidate) => candidate.owner === myOwner)) {
      const was = before.bullets.find((candidate) => candidate.id === bullet.id);
      const tank = nearestOf(bullet, now.others);
      const heading = flight.get(bullet.id);
      if (was !== undefined && !isOnArmor(was, before) && !isOnArmor(bullet, now) && distance(bullet, was) > 0) {
        const step = distance(bullet, was);
        flight.set(bullet.id, { x: (bullet.x - was.x) / step, y: (bullet.y - was.y) / step });
      }
      if (tank === null || distance(bullet, tank) > CONTACT + POSITION_TOLERANCE) {
        continue;
      }
      atHull++;
      if (distance(bullet, tank) < CONTACT - POSITION_TOLERANCE - shift) {
        violations.push(`свой снаряд ${String(bullet.id)} внутри чужого корпуса: ${distance(bullet, tank).toFixed(1)}`);
      }
      const wasTank = nearestOf(tank, before.others);
      if (was === undefined || wasTank === null || heading === undefined) {
        continue;
      }
      const along = (bullet.x - was.x) * heading.x + (bullet.y - was.y) * heading.y;
      if (along < -distance(tank, wasTank) - POSITION_TOLERANCE - shiftSpan) {
        violations.push(
          `свой снаряд ${String(bullet.id)} у чужого корпуса шагнул назад на ${(-along).toFixed(1)}, смещение своего танка ${shift.toFixed(1)}`,
        );
      }
    }
  }
  return atHull;
}

interface OwnShots {
  predicted: number;
  mispredicted: number;
  doubles: number;
}

// Места своих снарядов сервера в дробном тике: между тиками по прямой, до тика рождения — на месте рождения.
function ownServerPlaces(truth: Truth, round: number, tick: number, owner: number): Point[] {
  const after = truth(round, Math.ceil(tick));
  const before = truth(round, Math.floor(tick));
  const t = tick - Math.floor(tick);
  const places: Point[] = [];
  for (const [id, end] of after?.bullets ?? []) {
    if (end.owner !== owner) {
      continue;
    }
    const start = before?.bullets.get(id) ?? end;
    places.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
  }
  return places;
}

// Свой снаряд до подтверждения — предсказание: в своём тике картинки он на месте снаряда сервера, иначе
// подтверждение сдвинет его рывком; у чужого танка не сверяется — там он встаёт на броню до вспышки. Два своих
// снаряда в одной точке — снаряд задвоился на подтверждении.
// Со сглаживанием сети свой снаряд у своего танка нарисован со сдвигом до остатка смещения танка: допуск больше на
// этот остаток.
function judgeOwnShots(frame: CollectedFrame, truth: Truth, myOwner: number, own: OwnShots): void {
  const { round, picture } = frame;
  const tolerance = POSITION_TOLERANCE + Math.hypot(picture.ownShift.x, picture.ownShift.y);
  const mine = picture.bullets.filter((bullet) => bullet.owner === myOwner);
  for (const [index, bullet] of mine.entries()) {
    if (mine.slice(index + 1).some((other) => distance(bullet, other) < POSITION_TOLERANCE)) {
      own.doubles++;
    }
    const isAtOther = picture.others.some((other) => distance(bullet, other) <= PICTURE_NEAR);
    if (!isPredictedBullet(bullet.id) || isAtOther) {
      continue;
    }
    own.predicted++;
    const places = ownServerPlaces(truth, round, bullet.tick, myOwner);
    if (!places.some((place) => distance(place, bullet) <= tolerance)) {
      own.mispredicted++;
    }
  }
}

// Наибольший рост тика своего снаряда от прошлого кадра вне зоны своего танка: ход тика своего танка и отставание
// от него, сокращённое не быстрее хода тика чужих.
function ownCatchUp(picture: Picture, before: Picture): number {
  const othersStep = Math.max(0, picture.othersTick - before.othersTick);
  return Math.max(0, picture.myTick - before.myTick) + (PICTURE_CATCH_UP_RATE - 1) * othersStep;
}

// Свой снаряд не прыгает вперёд во времени: от прошлого кадра его тик вырос не больше хода своего тика и догона
// отставания, а если больше — сдвиг не длиннее пути самого быстрого снаряда за этот рост. В зоне своего танка допуск
// больше на тик: на её краю снаряд переходит в тик своего танка ступенькой не больше тика. Со сглаживанием сети зона
// своего танка на экране сдвинута на смещение танка — допуск на него. Кадр ухода с брони, где тик переставлен на
// место ухода, сверяет judgeOwnSteps по сдвигу.
function judgeOwnForward(
  frame: CollectedFrame,
  previous: CollectedFrame | null,
  myOwner: number,
  violations: string[],
): void {
  const { picture } = frame;
  const before = previous?.round === frame.round ? previous.picture : null;
  if (before === null) {
    return;
  }
  const shift = Math.hypot(picture.ownShift.x, picture.ownShift.y);
  for (const bullet of picture.bullets.filter((candidate) => candidate.owner === myOwner)) {
    const was = before.bullets.find((candidate) => candidate.id === bullet.id);
    if (was === undefined || isLeavingArmor(bullet, was, picture, before)) {
      continue;
    }
    const isAtMe = picture.me !== null && distance(bullet, picture.me) <= PICTURE_NEAR + shift;
    const catchUp = ownCatchUp(picture, before) + (isAtMe ? OWN_ZONE_STEP_TICKS : 0);
    const step = distance(bullet, was);
    const isJump = step > catchUp * OWN_STEP_MAX + POSITION_TOLERANCE;
    if (isJump && bullet.tick - was.tick > catchUp + FAR_TICK_TOLERANCE) {
      violations.push(
        `свой снаряд ${String(bullet.id)} прыгнул вперёд: тик вырос на ${(bullet.tick - was.tick).toFixed(3)}, допустимо ${catchUp.toFixed(3)}, сдвиг ${step.toFixed(1)}`,
      );
    }
  }
}

// Расстояние от точки до пути снаряда сервера в тиках около tick; снаряда на сервере там нет — 0.
function offServerTrack(truth: Truth, round: number, id: number, point: Point, tick: number): number {
  const places: Point[] = [];
  for (let at = Math.floor(tick) - TRACK_SPAN_TICKS; at <= Math.ceil(tick) + TRACK_SPAN_TICKS; at++) {
    const place = truth(round, at)?.bullets.get(id);
    if (place !== undefined) {
      places.push(place);
    }
  }
  if (places.length === 0) {
    return 0;
  }
  let best = Infinity;
  for (const [index, from] of places.entries()) {
    const to = places[index + 1] ?? from;
    const length = distance(from, to) ** 2;
    const t =
      length === 0
        ? 0
        : Math.min(
            1,
            Math.max(0, ((point.x - from.x) * (to.x - from.x) + (point.y - from.y) * (to.y - from.y)) / length),
          );
    best = Math.min(best, distance(point, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }));
  }
  return best;
}

interface Touch {
  tank: Point;
  at: Point;
  tick: number;
}

// Свой снаряд не прыгает с места: за кадр сдвигается не дальше пути самого быстрого снаряда за рост своего тика с
// запасом подлёта (на подлёте снаряд уходит вперёд дорожки быстрее хода времени) или за его спад, не больший спада
// тика своего танка (поправка предсказания отводит время своего танка назад, снаряд у него — следом), плюс смещения
// своего танка в этом и прошлом кадре. На броне в этом или прошлом кадре — плюс ход танка за кадр; в кадре ухода с
// брони (isLeavingArmor или тик снаряда на броне упал) — плюс путь танка с кадра касания (выстрел в упор — с кадра, где
// снаряд появился на броне): место на броне едет с танком
// и уходит с прямой полёта; плюс расстояние от места касания до пути снаряда сервера: предсказанный выстрел, вставший
// на броню, сервер выпустил иначе, и с брони снаряд уходит на путь сервера; и плюс поперечник окружности касания:
// снаряд уходит с брони по другую сторону танка, не проходя сквозь корпус. Возвращает наибольший сдвиг своего снаряда
// за кадр в единицах поля.
function judgeOwnSteps(frames: readonly CollectedFrame[], truth: Truth, myOwner: number, violations: string[]): number {
  let largest = 0;
  const touches = new Map<number, Touch>();
  for (let index = 1; index < frames.length; index++) {
    const [previous, frame] = [frames[index - 1], frames[index]];
    if (frame === undefined || previous?.round !== frame.round) {
      touches.clear();
      continue;
    }
    const now = frame.picture;
    const before = previous.picture;
    const shift = Math.hypot(now.ownShift.x, now.ownShift.y) + Math.hypot(before.ownShift.x, before.ownShift.y);
    for (const bullet of now.bullets.filter((candidate) => candidate.owner === myOwner)) {
      const was = before.bullets.find((candidate) => candidate.id === bullet.id);
      const isOnNow = isOnArmor(bullet, now);
      const tankAtTouch = nearestOf(bullet, now.others);
      if (was === undefined) {
        if (isOnNow && tankAtTouch !== null) {
          touches.set(bullet.id, { tank: tankAtTouch, at: bullet, tick: bullet.tick });
        }
        continue;
      }
      const step = distance(bullet, was);
      largest = Math.max(largest, step);
      const isOnBefore = isOnArmor(was, before);
      const wasTank = nearestOf(isOnBefore ? was : bullet, before.others);
      const tankNow = wasTank === null ? null : nearestOf(wasTank, now.others);
      const tankMove = (isOnBefore || isOnNow) && wasTank !== null && tankNow !== null ? distance(wasTank, tankNow) : 0;
      const touch = touches.get(bullet.id);
      const isRelease =
        touch !== undefined && (isLeavingArmor(bullet, was, now, before) || (isOnBefore && bullet.tick < was.tick));
      const drift = isRelease && wasTank !== null ? distance(wasTank, touch.tank) : 0;
      const offTrack = isRelease ? offServerTrack(truth, frame.round, bullet.id, touch.at, touch.tick) : 0;
      const across = isRelease ? 2 * CONTACT : 0;
      if (isOnNow && touch === undefined && tankAtTouch !== null) {
        touches.set(bullet.id, { tank: tankAtTouch, at: bullet, tick: bullet.tick });
      }
      const flight = Math.max(0, bullet.tick - was.tick) * OWN_STEP_MAX * (1 + PICTURE_LEAD_RATE);
      const myBack = Math.max(0, before.myTick - now.myTick);
      const back = Math.min(myBack, Math.max(0, was.tick - bullet.tick)) * OWN_STEP_MAX;
      const allowed = flight + back + POSITION_TOLERANCE + shift + tankMove + drift + offTrack + across;
      if (step > allowed) {
        violations.push(
          `свой снаряд ${String(bullet.id)} прыгнул с места на ${step.toFixed(1)}, допустимо ${allowed.toFixed(1)}: тик ${was.tick.toFixed(2)} → ${bullet.tick.toFixed(2)}, на броне ${String(isOnBefore)} → ${String(isOnNow)}`,
        );
      }
      if (!isOnNow || isRelease) {
        touches.delete(bullet.id);
      }
    }
  }
  return largest;
}

// Свой снаряд держится во времени своего танка, пока не подлетает к чужому: снаряд, которому до зоны «у танка» каждого
// чужого — и с места этого кадра, и с места прошлого (от него клиент меряет) — дальше PICTURE_APPROACH_SPAN разрывов
// времён самого быстрого сближения, — в тике своего танка, разве что догоняет его двойным ходом времён, пролетев мимо
// чужого или потеряв его. Со сглаживанием сети снаряд нарисован со сдвигом до смещения своего танка: запас больше на
// смещения этого и прошлого кадра. Возвращает число таких снарядов в кадре.
function judgeOwnInMyTime(
  frame: CollectedFrame,
  previous: CollectedFrame | null,
  myOwner: number,
  violations: string[],
): number {
  const { picture } = frame;
  const before = previous?.round === frame.round ? previous.picture : null;
  if (picture.me === null || before === null) {
    return 0;
  }
  const shifts = Math.hypot(picture.ownShift.x, picture.ownShift.y) + Math.hypot(before.ownShift.x, before.ownShift.y);
  const approach = PICTURE_APPROACH_SPAN * (picture.myTick - picture.othersTick) * OWN_CLOSING_MAX;
  const catchUp = ownCatchUp(picture, before);
  let checked = 0;
  for (const bullet of picture.bullets.filter((candidate) => candidate.owner === myOwner)) {
    const was = before.bullets.find((candidate) => candidate.id === bullet.id) ?? bullet;
    const toOthers = picture.others.flatMap((other) => [distance(bullet, other), distance(was, other)]);
    if (Math.min(...toOthers) - PICTURE_NEAR - shifts < approach) {
      continue;
    }
    checked++;
    const isCatchingUp = bullet.tick < picture.myTick && bullet.tick - was.tick >= catchUp - FAR_TICK_TOLERANCE;
    if (Math.abs(bullet.tick - picture.myTick) > FAR_TICK_TOLERANCE && !isCatchingUp) {
      violations.push(
        `свой снаряд ${String(bullet.id)} вдали от чужих в тике ${bullet.tick.toFixed(3)}, а не ${picture.myTick.toFixed(3)}: до чужих ${Math.min(...toOthers).toFixed(0)}, окно подлёта ${approach.toFixed(0)}`,
      );
    }
  }
  return checked;
}

// Свои выстрелы за бой: сумма последних кадров каждого раунда — счётчики живут раунд или матч.
function ownShotsOf(frames: readonly CollectedFrame[]): OwnShotCounts {
  const lastByRound = new Map<number, OwnShotCounts>();
  for (const frame of frames) {
    lastByRound.set(frame.round, frame.ownShots);
  }
  const total: OwnShotCounts = { played: 0, confirmed: 0, unconfirmed: 0 };
  for (const counts of lastByRound.values()) {
    total.played += counts.played;
    total.confirmed += counts.confirmed;
    total.unconfirmed += counts.unconfirmed;
  }
  return total;
}

interface TouchFrames {
  frames: number;
  played: number;
}

// Кадр касания: чужой снаряд в прошлом кадре был у самого своего танка, в этом пропал, а на сервере погиб о свой
// танк не позже тика своего танка: за тик до гибели был у самого своего танка, и в тике гибели снаряд попал по нему —
// погибший рядом о стену или другой танк не в счёт. Попадание сыграно в кадр касания, если счётчик сыгранных вырос к
// этому кадру — или кадром раньше: сборщик и кадр игры — разные вызовы кадра, касание из снимка между ними сборщик
// видит раньше.
function judgeTouchFrames(frames: readonly CollectedFrame[], truth: Truth, myOwner: number): TouchFrames {
  const touches: TouchFrames = { frames: 0, played: 0 };
  for (let index = 2; index < frames.length; index++) {
    const [first, second, third] = [frames[index - 2], frames[index - 1], frames[index]];
    if (first === undefined || second === undefined || third === undefined) {
      continue;
    }
    const isSameRound = first.round === third.round && second.round === third.round;
    const was = second.picture.me;
    if (!isSameRound || was === null || third.picture.me === null) {
      continue;
    }
    for (const bullet of second.picture.bullets) {
      const isGone = !third.picture.bullets.some((candidate) => candidate.id === bullet.id);
      if (bullet.owner === myOwner || distance(bullet, was) > HIT_REACH || !isGone) {
        continue;
      }
      const death = deathTickOf(truth, third.round, bullet.id, third.picture.myTick);
      const before = death === null ? undefined : truth(third.round, death - 1);
      const last = before?.bullets.get(bullet.id);
      const meBefore = before?.me ?? null;
      const isHitOnMe = death !== null && (truth(third.round, death)?.hitsOnMe ?? 0) > 0;
      if (last === undefined || meBefore === null || distance(last, meBefore) > HIT_REACH || !isHitOnMe) {
        continue;
      }
      touches.frames++;
      touches.played += third.ownHits.played > first.ownHits.played ? 1 : 0;
    }
  }
  return touches;
}

// Счётчики касаний за бой: сумма последних кадров каждого раунда — счётчики живут раунд или матч.
function ownHitsOf(frames: readonly CollectedFrame[]): OwnHitCounts {
  const lastByRound = new Map<number, OwnHitCounts>();
  for (const frame of frames) {
    lastByRound.set(frame.round, frame.ownHits);
  }
  const total: OwnHitCounts = { played: 0, confirmed: 0, cancelled: 0, served: 0, doubles: 0 };
  for (const counts of lastByRound.values()) {
    total.played += counts.played;
    total.confirmed += counts.confirmed;
    total.cancelled += counts.cancelled;
    total.served += counts.served;
    total.doubles += counts.doubles;
  }
  return total;
}

// Попаданий снарядом по своему танку на сервере до последнего снимка, пришедшего к последнему кадру раунда, — тех,
// что к этому кадру видели счётчики.
function serverHitsOnMe(frames: readonly CollectedFrame[], truth: Truth): number {
  const lastTickByRound = new Map<number, number>();
  for (const { round, picture } of frames) {
    lastTickByRound.set(round, picture.latestTick);
  }
  let hits = 0;
  for (const [round, lastTick] of lastTickByRound) {
    for (let tick = 0; tick <= lastTick; tick++) {
      hits += truth(round, tick)?.hitsOnMe ?? 0;
    }
  }
  return hits;
}

// Сверка кадров с правдой сервера в тике своего танка: чужой снаряд у своего танка — в этом тике и на месте сервера;
// внутри своего корпуса не рисуется, если и на сервере он не там (танк, въехавший в снаряд, накрывает его до
// проверки попаданий следующего тика); снаряд в тике, который уже пришёл снимком, — живой на сервере. Снаряд у своего
// танка, погибший на сервере после последнего пришедшего снимка о другой танк или стену, — гибель, о которой клиент
// ещё не знает: не ошибка, считается отдельно; погибший так о свой корпус (в тике гибели — попадание по своему танку)
// — ошибка: клиент досчитывает попадание по себе сам. Вторая половина договора — снаряды у чужих танков в тике чужих.
function judge(frames: readonly CollectedFrame[], truth: Truth, myOwner: number): Verdict {
  const violations: string[] = [];
  let nearFrames = 0;
  let mispredicted = 0;
  let unconfirmedDeaths = 0;
  let hullDeaths = 0;
  let insideHull = 0;
  const nearBullets = new Map<number, number>();
  const farBullets = new Set<number>();
  const own: OwnShots = { predicted: 0, mispredicted: 0, doubles: 0 };
  let ownInMyTime = 0;
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
    ownInMyTime += judgeOwnInMyTime(frame, previous, myOwner, violations);
    judgeOwnForward(frame, previous, myOwner, violations);
    previous = frame;
    const me = picture.me;
    const atMine = truth(round, picture.myTick);
    if (me === null || atMine?.me === null || atMine?.me === undefined) {
      continue;
    }
    // Сверка с сервером — в координатах предсказания: нарисованное минус смещение своего танка; у своего танка
    // снаряды сдвинуты на всё смещение, расстояние снаряд — танк на экране от сдвига не меняется.
    const shift = picture.ownShift;
    const unshifted = (point: Point): Point => ({ x: point.x - shift.x, y: point.y - shift.y });
    if (distance(unshifted(me), atMine.me) > PREDICTION_TOLERANCE) {
      mispredicted++;
      continue;
    }
    judgeOwnShots(frame, truth, myOwner, own);
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
          if (isAtMe && (truth(round, death)?.hitsOnMe ?? 0) > 0) {
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
      if (
        Math.abs(screenGap - serverGap) > POSITION_TOLERANCE ||
        distance(unshifted(bullet), server) > POSITION_TOLERANCE
      ) {
        violations.push(
          `снаряд ${String(bullet.id)}: до танка на экране ${screenGap.toFixed(1)}, на сервере ${serverGap.toFixed(1)}`,
        );
      }
    }
    nearFrames += hasNear ? 1 : 0;
  }
  const touches = judgeTouchFrames(frames, truth, myOwner);
  return {
    frames: frames.length,
    nearFrames,
    nearBullets: nearBullets.size,
    mispredicted,
    unconfirmedDeaths,
    hullDeaths,
    insideHull,
    ownAtHull: judgeOwnAtHull(frames, myOwner, violations),
    ownPredicted: own.predicted,
    ownMispredicted: own.mispredicted,
    ownDoubles: own.doubles,
    ownInMyTime,
    ownLargestStep: judgeOwnSteps(frames, truth, myOwner, violations),
    touchFrames: touches.frames,
    touchFramesPlayed: touches.played,
    ownHits: ownHitsOf(frames),
    ownShots: ownShotsOf(frames),
    serverHitsOnMe: serverHitsOnMe(frames, truth),
    farBullets: farBullets.size,
    ...hitsAndMisses(frames, truth, nearBullets),
    violations,
    meanGapTicks: mean(frames.map(({ picture }) => picture.myTick - picture.othersTick)),
    meanPending: mean(frames.map(({ pending }) => pending)),
  };
}

interface Expected {
  minFarBullets: number;
  minOwnAtHull: number;
  minOwnPredicted: number;
  minOwnInMyTime: number;
}

function expectAgreement(verdict: Verdict, what: string, expected: Expected): void {
  const summary = `${what}: кадров ${String(verdict.frames)}, со снарядом у своего танка ${String(verdict.nearFrames)}, снарядов ${String(verdict.nearBullets)}, у чужих танков ${String(verdict.farBullets)}, расхождений предсказания ${String(verdict.mispredicted)}, попаданий ${String(verdict.hits)}, промахов ${String(verdict.misses)}, гибелей до снимка о свой корпус ${String(verdict.hullDeaths)}, о другое ${String(verdict.unconfirmedDeaths)}, внутри корпуса ${String(verdict.insideHull)}, своих у чужого корпуса ${String(verdict.ownAtHull)}, своих предсказанных ${String(verdict.ownPredicted)}, из них не на месте сервера ${String(verdict.ownMispredicted)}, задвоенных ${String(verdict.ownDoubles)}, своих вдали от чужих ${String(verdict.ownInMyTime)}, наибольший сдвиг своего снаряда за кадр ${verdict.ownLargestStep.toFixed(1)}, выстрелов сыграно ${String(verdict.ownShots.played)}, сверено ${String(verdict.ownShots.confirmed)}, неподтверждено ${String(verdict.ownShots.unconfirmed)}, кадров касания ${String(verdict.touchFrames)}, из них с попаданием ${String(verdict.touchFramesPlayed)}, касаний сыграно ${String(verdict.ownHits.played)}, подтверждено ${String(verdict.ownHits.confirmed)}, отменено ${String(verdict.ownHits.cancelled)}, попаданий по себе на сервере ${String(verdict.serverHitsOnMe)}, в снимках ${String(verdict.ownHits.served)}, сыграно повторно ${String(verdict.ownHits.doubles)}, разрыв ${verdict.meanGapTicks.toFixed(2)} тика, неподтверждённых ${verdict.meanPending.toFixed(2)}`;
  console.log(summary);
  test.info().annotations.push({ type: 'картинка', description: summary });
  expect(verdict.violations.slice(0, 10), summary).toEqual([]);
  expect(verdict.hullDeaths, summary).toBe(0);
  expect(verdict.insideHull, summary).toBe(0);
  expect(verdict.nearFrames, summary).toBeGreaterThanOrEqual(MIN_NEAR_FRAMES);
  expect(verdict.nearBullets, summary).toBeGreaterThanOrEqual(MIN_NEAR_BULLETS);
  expect(verdict.farBullets, summary).toBeGreaterThanOrEqual(expected.minFarBullets);
  expect(verdict.ownAtHull, summary).toBeGreaterThanOrEqual(expected.minOwnAtHull);
  expect(verdict.hits, summary).toBeGreaterThanOrEqual(1);
  expect(verdict.mispredicted / Math.max(1, verdict.frames), summary).toBeLessThanOrEqual(MAX_MISPREDICTED_SHARE);
  expect(verdict.ownPredicted, summary).toBeGreaterThanOrEqual(expected.minOwnPredicted);
  expect(verdict.ownMispredicted / Math.max(1, verdict.ownPredicted), summary).toBeLessThanOrEqual(
    MAX_MISPREDICTED_SHARE,
  );
  expect(verdict.ownDoubles, summary).toBe(0);
  expect(verdict.ownInMyTime, summary).toBeGreaterThanOrEqual(expected.minOwnInMyTime);
  expect(verdict.ownShots.unconfirmed, summary).toBeLessThanOrEqual(
    Math.max(1, Math.floor(verdict.ownShots.played * MAX_UNCONFIRMED_SHOT_SHARE)),
  );
  expect(verdict.touchFrames, summary).toBeGreaterThanOrEqual(1);
  expect(verdict.touchFrames - verdict.touchFramesPlayed, summary).toBeLessThanOrEqual(
    Math.max(1, Math.floor(verdict.touchFrames * MAX_TOUCH_UNPLAYED_SHARE)),
  );
  expect(verdict.ownHits.cancelled / Math.max(1, verdict.ownHits.played), summary).toBeLessThanOrEqual(
    MAX_CANCELLED_SHARE,
  );
  // Попаданий по своему танку сыграно — каждое попадание снимка один раз, касанием или снимком, плюс сыгранные
  // повторно — столько же, сколько на сервере.
  expect(verdict.ownHits.served + verdict.ownHits.doubles, summary).toBe(verdict.serverHitsOnMe);
}

// Правда общего боя — прогон журнала сервера движком: положения своего танка и всех снарядов на каждом тике матча.
function ffaTruth(log: string, playerId: number): Truth {
  const byMatch = new Map<FfaMatch, Map<number, TruthTick>>();
  const replay = replayFfaJournal(log.split('\n'), {
    onTick: (match: FfaMatch, _gameTick: number, events: readonly FfaEvent[]) => {
      const ticks = byMatch.get(match) ?? new Map<number, TruthTick>();
      byMatch.set(match, ticks);
      const me = match.world.tanks.find((tank) => tank.id === playerId && tank.isAlive);
      ticks.set(match.world.tick, {
        me: me === undefined ? null : { x: me.x, y: me.y },
        bullets: new Map(
          match.world.bullets.map((bullet) => [bullet.id, { x: bullet.x, y: bullet.y, owner: bullet.owner }]),
        ),
        hitsOnMe: events.filter((event) => event.type === 'hit' && event.tank === playerId && event.cause === 'bullet')
          .length,
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
    // Остановленный раунд — отсчёт и конец раунда — шлёт снимки того же тика без событий.
    if (ticks.has(message.tick)) {
      continue;
    }
    const me = message.tanks[side === 0 ? 0 : 1];
    ticks.set(message.tick, {
      me: me.isAlive ? { x: me.x, y: me.y } : null,
      bullets: new Map(message.bullets.map((bullet) => [bullet.id, { x: bullet.x, y: bullet.y, owner: bullet.owner }])),
      hitsOnMe: message.events.filter(
        (event) => event.kind === 'hit' && event.side === side && isBulletHitFlags(event.flags),
      ).length,
    });
  }
  return (index, tick) => byRound.get(index)?.get(tick);
}

// Догон снаряда на сервере (`SHOT_LEAD_TICKS`): свой предсказанный снаряд должен стоять там же, где серверный.
const LEAD_TICKS = 2;
// Своих предсказанных снарядов в тике своего танка за бой, когда свой танк стреляет.
const MIN_OWN_PREDICTED = 10;
// Своих снарядов вдали от чужих: в общем бою промахи по цели улетают от всех; поле дуэли меньше окна подлёта.
const MIN_OWN_IN_MY_TIME_FFA = 1;

// Снаряд со скоростью танка (`SHOT_INHERIT_PERCENT`): свой снаряд на ходу, выпущенный поперёк хода, — там же, где
// серверный.
const INHERIT_PERCENT = 100;

function shotLeadEnv(leadTicks: number): Record<string, string> {
  return leadTicks === 0 ? {} : { SHOT_LEAD_TICKS: String(leadTicks) };
}

function shotInheritEnv(inheritPercent: number): Record<string, string> {
  return inheritPercent === 0 ? {} : { SHOT_INHERIT_PERCENT: String(inheritPercent) };
}

function leadTitle(leadTicks: number): string {
  return leadTicks === 0 ? '' : `, догон ${String(leadTicks)}`;
}

function inheritTitle(inheritPercent: number): string {
  return inheritPercent === 0 ? '' : `, снаряд со скоростью танка ${String(inheritPercent)} %`;
}

function gameIdOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const scope = window as unknown as { tanksGame: { debugState(): { gameId?: string } } };
    return scope.tanksGame.debugState().gameId ?? '';
  });
}

function networkTitle(delayMs: number, hasNetSmoothing: boolean): string {
  return `${String(delayMs)} мс в каждую сторону${hasNetSmoothing ? ', сглаживание сети' : ''}`;
}

test.describe('картинка совпадает с сервером', () => {
  for (const { delayMs, leadTicks, inheritPercent, hasNetSmoothing } of [
    { delayMs: 30, leadTicks: 0, inheritPercent: 0, hasNetSmoothing: false },
    { delayMs: 75, leadTicks: 0, inheritPercent: 0, hasNetSmoothing: false },
    { delayMs: 75, leadTicks: LEAD_TICKS, inheritPercent: 0, hasNetSmoothing: false },
    { delayMs: 75, leadTicks: 0, inheritPercent: INHERIT_PERCENT, hasNetSmoothing: false },
    { delayMs: 75, leadTicks: 0, inheritPercent: 0, hasNetSmoothing: true },
  ]) {
    const rulesTitle = `${leadTitle(leadTicks)}${inheritTitle(inheritPercent)}`;
    test(`общий бой через посредника ${networkTitle(delayMs, hasNetSmoothing)}${rulesTitle}`, async ({ browser }) => {
      test.setTimeout(180_000);
      const server = new GameServer({
        FFA_LOBBY_WAIT_SECONDS: '1',
        FFA_MINIMUM: '2',
        ...shotLeadEnv(leadTicks),
        ...shotInheritEnv(inheritPercent),
        ...(hasNetSmoothing ? { NET_SMOOTHING: '1' } : {}),
      });
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
      const isSmoothingShown = await player.page.evaluate(() => {
        const scope = window as unknown as { tanksGame: { debugState(): { hasNetSmoothing: boolean } } };
        return scope.tanksGame.debugState().hasNetSmoothing;
      });
      expect(isSmoothingShown).toBe(hasNetSmoothing);
      await startCollecting(player.page, start.playerId ?? -1);
      await chaseNearest(player);
      const frames = (await stopCollecting(player.page)).filter((frame) => frame.round === start.matchIndex);
      const gameId = await gameIdOf(player.page);
      for (const swarm of swarms.splice(0)) {
        await swarm.stop();
      }
      await server.stop();
      const log = server.gameLog(gameId);
      const rulesLine = `rules=\\d+ lead=${String(leadTicks)} inherit=${String(inheritPercent)}`;
      expect(log).toMatch(new RegExp(`game start mode=ffa size=${String(SIZE)} ${rulesLine}\\n`));
      const truth = ffaTruth(log, start.playerId ?? -1);
      expectAgreement(
        judge(frames, truth, start.playerId ?? -1),
        `общий бой, ${networkTitle(delayMs, hasNetSmoothing)}${rulesTitle}`,
        {
          minFarBullets: MIN_FAR_BULLETS_FFA,
          minOwnAtHull: MIN_OWN_AT_HULL_FFA,
          minOwnPredicted: MIN_OWN_PREDICTED,
          minOwnInMyTime: MIN_OWN_IN_MY_TIME_FFA,
        },
      );
    });
  }

  // Своя стрельба в дуэли — только со включённым догоном: прежние сценарии сверяют картинку без неё.
  for (const { delayMs, leadTicks } of [
    { delayMs: 30, leadTicks: 0 },
    { delayMs: 75, leadTicks: 0 },
    { delayMs: 75, leadTicks: LEAD_TICKS },
  ]) {
    test(`дуэль с ботом через посредника ${String(delayMs)} мс в каждую сторону${leadTitle(leadTicks)}`, async ({
      browser,
    }) => {
      test.setTimeout(180_000);
      const server = new GameServer(shotLeadEnv(leadTicks));
      servers.push(server);
      await server.start();
      const proxy = await NetProxy.start(server.listenPort, { delayMs });
      proxies.push(proxy);
      const player = await Player.open(browser, proxy.baseUrl, DUEL_BOT_ROOM, 'Дима', STURDY_STATS);
      players.push(player);
      const start = await player.waitForFight(FIGHT_TIMEOUT_MS);
      const shotLeadTicks = await player.page.evaluate(() => {
        const scope = window as unknown as { tanksGame: { debugState(): { rules: { shotLeadTicks: number } } } };
        return scope.tanksGame.debugState().rules.shotLeadTicks;
      });
      expect(shotLeadTicks).toBe(leadTicks);
      const isFiring = leadTicks > 0;
      await startCollecting(player.page, start.side);
      if (isFiring) {
        const viewport = player.page.viewportSize() ?? { width: 0, height: 0 };
        await player.page.mouse.move(viewport.width / 2 + viewport.height / 3, viewport.height / 2);
        await player.setFiring(true);
      }
      await driveCircles(player.page);
      await player.setFiring(false);
      const frames = await stopCollecting(player.page);
      const gameId = await gameIdOf(player.page);
      await server.stop();
      expect(server.gameLog(gameId)).toMatch(
        new RegExp(`game start room=.* rules=\\d+ lead=${String(leadTicks)} inherit=0\\n`),
      );
      const side = start.side;
      expectAgreement(
        judge(frames, duelTruth(proxy, side), side),
        `дуэль, ${String(delayMs)} мс${leadTitle(leadTicks)}`,
        {
          minFarBullets: MIN_FAR_BULLETS_DUEL,
          minOwnAtHull: 0,
          minOwnPredicted: isFiring ? MIN_OWN_PREDICTED : 0,
          minOwnInMyTime: 0,
        },
      );
    });
  }
});
