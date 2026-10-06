import { describe, expect, it } from 'vitest';
import {
  BULLET_RADIUS,
  createFfaMatch,
  createRandom,
  createWorld,
  DEFAULT_RULES,
  DEFAULT_STATS,
  ffaMap,
  IDLE_ACTION,
  nextRandom,
  stepFfaMatch,
  stepWorld,
  TANK_RADIUS,
  type Action,
  type Tank,
  type World,
  type ZonePlan,
} from '@tanks/shared/engine';
import { BulletTracker, bulletSnapshot, toFfaSnapshotEvent, type FfaSnapshotMessage } from '@tanks/shared/protocol';
import { OPEN_MAP, placedTank, snapshotOf } from '../testing/ffaServer.js';
import { PICTURE_CATCH_UP_RATE, PICTURE_MIN_TIME_RATE, PICTURE_NEAR, pictureTickAt } from '../pictureTime.js';
import { PREDICTED_BULLET_ID_BASE } from '../predictedShots.js';
import { FfaPrediction, type FfaFrameView } from './ffaPrediction.js';

const ME = 2;
const TICK_MS = 1000 / 30;
const STILL_ZONE: ZonePlan = { startRadius: 9000, finalRadius: 9000, startShrink: 1000, endShrink: 1001 };
const GAS: Action = { ...IDLE_ACTION, throttle: 1 };
const FIRE: Action = { ...IDLE_ACTION, isFiring: true };
const APPEAR_MS = 150;
const VANISH_MS = 200;
const DELAY_MS = 2 * TICK_MS;

function setupOf(id: number): { name: string; stats: typeof DEFAULT_STATS } {
  return { name: `Т${String(id)}`, stats: DEFAULT_STATS };
}

function prediction(myId = ME, plan: ZonePlan = STILL_ZONE, map = OPEN_MAP): FfaPrediction {
  return new FfaPrediction(map, DEFAULT_RULES, plan, myId, setupOf);
}

function worldOf(tanks: Tank[]): World {
  return createWorld(OPEN_MAP, tanks, DEFAULT_RULES, STILL_ZONE);
}

function actionsFor(world: World, mine: Action): Action[] {
  return world.tanks.map((tank) => (tank.id === ME ? mine : IDLE_ACTION));
}

function meOf(world: World): Tank {
  const me = world.tanks.find((tank) => tank.id === ME);
  if (me === undefined) {
    throw new Error('своего танка нет на поле');
  }
  return me;
}

describe('предсказание своего танка среди N', () => {
  it('газ: свой танк едет до подтверждения; снимок отрезает подтверждённые; разошлись — переигрывание и поправка', () => {
    const server = worldOf([placedTank(ME, 500, 600)]);
    stepWorld(server, [IDLE_ACTION]);
    const client = prediction();
    client.applySnapshot(snapshotOf(server), 0);
    for (let seq = 1; seq <= 5; seq++) {
      client.predict(seq, GAS);
    }
    expect(client.me?.x).toBeGreaterThan(500);
    expect(client.pendingCount).toBe(5);
    for (let tick = 0; tick < 3; tick++) {
      stepWorld(server, [GAS]);
    }
    const reference = structuredClone(server);
    stepWorld(reference, [GAS]);
    stepWorld(reference, [GAS]);
    client.applySnapshot(snapshotOf(server, { ackSeq: 3 }), 100);
    expect(client.pendingCount).toBe(2);
    expect(client.me?.x).toBeCloseTo(meOf(reference).x, 9);
    expect(client.lastCorrectionPx).toBeLessThan(1e-9);
    meOf(server).x += 50;
    client.applySnapshot(snapshotOf(server, { ackSeq: 3 }), 133);
    expect(client.lastCorrectionPx).toBeCloseTo(50, 9);
  });

  it('упирается в стоящий чужой и в подбитый; порядок снимка не по номерам — как эталонное поле до 1e-6', () => {
    const build = (): World => {
      const world = worldOf([placedTank(5, 700, 600), placedTank(ME, 560, 600), placedTank(9, 560, 690)]);
      const wreck = world.tanks[2];
      if (wreck !== undefined) {
        wreck.isAlive = false;
        wreck.hp = 0;
      }
      stepWorld(world, actionsFor(world, IDLE_ACTION));
      return world;
    };
    const server = build();
    const reference = build();
    const client = prediction();
    client.applySnapshot(snapshotOf(server), 0);
    const lag = 3;
    const sent: Action[] = [];
    for (let seq = 1; seq <= 90; seq++) {
      const action = seq <= 40 ? GAS : { ...GAS, turn: seq <= 50 ? 1 : 0 };
      sent.push(action);
      client.predict(seq, action);
      stepWorld(reference, actionsFor(reference, action));
      const applied = sent[seq - 1 - lag];
      if (applied !== undefined) {
        stepWorld(server, actionsFor(server, applied));
        client.applySnapshot(snapshotOf(server, { ackSeq: seq - lag }), seq * TICK_MS);
      }
      const me = client.me;
      expect(me?.x).toBeCloseTo(meOf(reference).x, 6);
      expect(me?.y).toBeCloseTo(meOf(reference).y, 6);
      expect(me?.heading).toBeCloseTo(meOf(reference).heading, 6);
      expect(client.tanksOnField.map((tank) => tank.id)).toEqual([5, ME, 9]);
    }
    expect(reference.tanks[0]?.x).toBeGreaterThan(700);
    expect(meOf(reference).y).toBeGreaterThan(600);
    const wreck = client.tanksOnField[2];
    expect([wreck?.x, wreck?.y]).toEqual([560, 690]);
  });

  it('на отсчёте (тик 0), без своего танка и после конца матча предсказание не шагает', () => {
    const server = worldOf([placedTank(ME, 500, 600), placedTank(5, 900, 600)]);
    const client = prediction();
    client.applySnapshot(snapshotOf(server), 0);
    client.predict(1, GAS);
    expect(client.me?.x).toBe(500);
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    const matchOver = {
      kind: 'matchOver' as const,
      tank: null,
      by: null,
      x: 0,
      y: 0,
      value: 0,
      dx: 0,
      dy: 0,
      flags: 0,
    };
    client.applySnapshot(snapshotOf(server, { ackSeq: 1, events: [matchOver] }), 33);
    client.predict(2, GAS);
    expect(client.me?.x).toBe(500);
    const watcher = prediction(77);
    watcher.applySnapshot(snapshotOf(server), 0);
    watcher.predict(1, GAS);
    expect(watcher.me).toBeNull();
    expect(watcher.isStepping).toBe(false);
  });

  it('карта 50, 49 танков в рое: свой танк урезанного переигрывания совпадает с полным до 1e-6', () => {
    const map = ffaMap(50);
    const setups = Array.from({ length: 49 }, (_, index) => ({ id: index + 1, name: 'Т', stats: DEFAULT_STATS }));
    const match = createFfaMatch(map, setups, 5, DEFAULT_RULES, 600);
    const centre = meOf(match.world);
    for (const [index, tank] of match.world.tanks
      .filter((candidate) => candidate.id !== ME)
      .slice(0, 12)
      .entries()) {
      const angle = (index / 12) * 2 * Math.PI;
      tank.x = centre.x + Math.cos(angle) * 70;
      tank.y = centre.y + Math.sin(angle) * 70;
      tank.heading = angle + Math.PI;
    }
    const tracker = new BulletTracker();
    const client = new FfaPrediction(map, DEFAULT_RULES, match.world.zonePlan, ME, setupOf);
    const random = createRandom(11);
    const randomAction = (): Action => ({
      throttle: nextRandom(random) * 2 - 1,
      turn: nextRandom(random) * 2 - 1,
      turretTurn: nextRandom(random) * 2 - 1,
      isFiring: nextRandom(random) < 0.5,
    });
    const lag = 6;
    const sent: Action[] = [];
    let checks = 0;
    for (let tick = 1; tick <= 240; tick++) {
      const mine = randomAction();
      sent.push(mine);
      client.predict(tick, mine);
      const actions = new Map<number, Action>();
      for (const setup of setups) {
        actions.set(setup.id, setup.id === ME ? (sent[tick - 1 - lag] ?? IDLE_ACTION) : randomAction());
      }
      const events = stepFfaMatch(match, actions);
      const ackSeq = Math.max(0, tick - lag);
      const changes = tracker.diff(match.world.bullets);
      client.applySnapshot(
        snapshotOf(match.world, { ackSeq, events: events.map(toFfaSnapshotEvent), changes }),
        tick * TICK_MS,
      );
      const full = structuredClone(match.world);
      full.bullets = full.bullets.map((bullet) => ({ ...bullet, damage: 0 }));
      if (!meOf(full).isAlive) {
        break;
      }
      for (const action of sent.slice(ackSeq)) {
        stepWorld(full, actionsFor(full, action));
      }
      const me = client.me;
      expect(me?.x).toBeCloseTo(meOf(full).x, 6);
      expect(me?.y).toBeCloseTo(meOf(full).y, 6);
      expect(me?.heading).toBeCloseTo(meOf(full).heading, 6);
      expect(me?.speed).toBeCloseTo(meOf(full).speed, 6);
      checks++;
    }
    expect(match.world.bullets.length).toBeGreaterThan(20);
    expect(checks).toBeGreaterThan(100);
  }, 30_000);

  it('новое соединение: неподтверждённые команды и буфер снимков пусты', () => {
    const server = worldOf([placedTank(ME, 500, 600), placedTank(5, 900, 600)]);
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    const client = prediction();
    client.applySnapshot(snapshotOf(server), 0);
    client.predict(1, GAS);
    client.predict(2, GAS);
    client.resetConnection();
    expect(client.pendingCount).toBe(0);
    expect(client.view(1000).tanks.map((tank) => tank.id)).toEqual([ME]);
  });
});

describe('чужие танки — интерполяция по номерам', () => {
  function snapshotAt(tanks: Tank[], tick: number): ReturnType<typeof snapshotOf> {
    const world = worldOf(tanks);
    world.tick = tick;
    return snapshotOf(world);
  }

  it('номер в обоих снимках — плавно; появившийся рисуется с первого снимка и проявляется за 150 мс', () => {
    const client = prediction(ME);
    client.applySnapshot(snapshotAt([placedTank(3, 100, 100)], 1), 0);
    client.applySnapshot(snapshotAt([placedTank(3, 110, 100), placedTank(4, 500, 500)], 2), TICK_MS);
    const firstSeen = DELAY_MS + TICK_MS / 2;
    const view = client.view(firstSeen);
    expect(view.tanks.find((tank) => tank.id === 3)?.x).toBeCloseTo(105, 9);
    const appeared = view.tanks.find((tank) => tank.id === 4);
    expect([appeared?.x, appeared?.y, appeared?.presence]).toEqual([500, 500, 0]);
    expect(client.view(firstSeen + APPEAR_MS / 2).tanks.find((tank) => tank.id === 4)?.presence).toBeCloseTo(0.5, 9);
    expect(client.view(firstSeen + APPEAR_MS).tanks.find((tank) => tank.id === 4)?.presence).toBe(1);
  });

  it('пропавший гаснет за 200 мс и больше не рисуется', () => {
    const client = prediction(ME);
    client.applySnapshot(snapshotAt([placedTank(3, 100, 100), placedTank(4, 500, 500)], 1), 0);
    expect(client.view(DELAY_MS - TICK_MS / 2).tanks.find((tank) => tank.id === 3)?.x).toBe(100);
    client.applySnapshot(snapshotAt([placedTank(4, 500, 500)], 2), TICK_MS);
    const goneAt = DELAY_MS + TICK_MS / 2;
    expect(client.view(goneAt).tanks.find((tank) => tank.id === 3)?.presence).toBe(1);
    expect(client.view(goneAt + VANISH_MS / 2).tanks.find((tank) => tank.id === 3)?.presence).toBeCloseTo(0.5, 9);
    expect(client.view(goneAt + VANISH_MS).tanks.some((tank) => tank.id === 3)).toBe(false);
    expect(client.view(goneAt + VANISH_MS + 500).tanks.some((tank) => tank.id === 3)).toBe(false);
  });

  it('скачок дальше 200 между соседними снимками не растягивается', () => {
    const client = prediction(ME);
    client.applySnapshot(snapshotAt([placedTank(4, 500, 500)], 1), 0);
    client.applySnapshot(snapshotAt([placedTank(4, 1000, 900)], 2), TICK_MS);
    const between = client.view(DELAY_MS + TICK_MS / 2).tanks.find((tank) => tank.id === 4);
    expect([between?.x, between?.y]).toEqual([1000, 900]);
  });
});

describe('снаряды зеркалом', () => {
  it('матч 300 тиков: чужие снаряды кадра совпадают с серверными; свои предсказанные — с номерами дальше сервера', () => {
    const map = ffaMap(10);
    const setups = [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `Т${String(id)}`, stats: DEFAULT_STATS }));
    const match = createFfaMatch(map, setups, 42, DEFAULT_RULES);
    const tracker = new BulletTracker();
    const client = new FfaPrediction(map, DEFAULT_RULES, match.world.zonePlan, ME, setupOf);
    client.applySnapshot(snapshotOf(match.world, { changes: tracker.diff(match.world.bullets) }), 0);
    const random = createRandom(7);
    const randomAction = (): Action => ({
      throttle: nextRandom(random) * 2 - 1,
      turn: nextRandom(random) * 2 - 1,
      turretTurn: nextRandom(random) * 2 - 1,
      isFiring: nextRandom(random) < 0.3,
    });
    const lag = 2;
    const sent: Action[] = [];
    let ownChecks = 0;
    let atOthers = 0;
    for (let tick = 1; tick <= 300; tick++) {
      const mine = randomAction();
      sent.push(mine);
      client.predict(tick, mine);
      const actions = new Map<number, Action>();
      for (const setup of setups) {
        actions.set(setup.id, setup.id === ME ? (sent[tick - 1 - lag] ?? IDLE_ACTION) : randomAction());
      }
      const events = stepFfaMatch(match, actions);
      const changes = tracker.diff(match.world.bullets);
      const ackSeq = Math.max(0, tick - lag);
      client.applySnapshot(
        snapshotOf(match.world, { ackSeq, events: events.map(toFfaSnapshotEvent), changes }),
        tick * TICK_MS,
      );
      const view = client.view(tick * TICK_MS + 1000);
      const drawn = new Map(view.bullets.map((bullet) => [bullet.id, bullet]));
      const meOnServer = match.world.tanks.find((tank) => tank.id === ME);
      const others = match.world.tanks.filter((tank) => tank.id !== ME && tank.isAlive);
      for (const bullet of match.world.bullets.filter((candidate) => candidate.owner !== ME)) {
        const isFarFromMe =
          meOnServer === undefined || Math.hypot(bullet.x - meOnServer.x, bullet.y - meOnServer.y) > 300;
        // Вес считается от места снаряда в прошлом кадре — запас на его шаг за тик.
        const isAtOther = others.some((tank) => Math.hypot(bullet.x - tank.x, bullet.y - tank.y) <= PICTURE_NEAR - 25);
        if (isFarFromMe && isAtOther) {
          expect(drawn.get(bullet.id)).toEqual({ id: bullet.id, owner: bullet.owner, x: bullet.x, y: bullet.y, tick });
          atOthers++;
        }
      }
      for (const bullet of view.bullets) {
        expect(bullet.tick).toBeGreaterThanOrEqual(tick);
        expect(bullet.tick).toBeLessThanOrEqual(view.clock.myTick);
      }
      const serverIds = new Set(match.world.bullets.map((bullet) => bullet.id));
      const largestServerId = Math.max(0, ...serverIds);
      for (const bullet of view.bullets.filter((candidate) => candidate.owner === ME)) {
        expect(serverIds.has(bullet.id) || bullet.id > largestServerId).toBe(true);
        ownChecks++;
      }
    }
    expect(ownChecks).toBeGreaterThan(0);
    expect(atOthers).toBeGreaterThan(0);
  });

  it('свой выстрел виден до рождения от сервера; после подтверждения снаряд один, с номером сервера', () => {
    const server = worldOf([placedTank(ME, 500, 600), placedTank(5, 1500, 900)]);
    const tracker = new BulletTracker();
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    const client = prediction();
    client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets) }), 0);
    client.predict(1, FIRE);
    const predicted = client.view(100).bullets.filter((bullet) => bullet.owner === ME);
    expect(predicted).toHaveLength(1);
    expect(predicted[0]?.id).toBeGreaterThanOrEqual(1000);
    client.predict(2, IDLE_ACTION);
    stepWorld(server, actionsFor(server, FIRE));
    client.applySnapshot(snapshotOf(server, { ackSeq: 1, changes: tracker.diff(server.bullets) }), TICK_MS);
    const confirmed = client.view(200).bullets.filter((bullet) => bullet.owner === ME);
    expect(confirmed.map((bullet) => bullet.id)).toEqual([server.bullets[0]?.id]);
  });

  it('номер своего снаряда — от команды выстрела, не меняется до подтверждения; подтверждение даёт пару с номером сервера', () => {
    const server = worldOf([placedTank(ME, 500, 600), placedTank(5, 1500, 900)]);
    const tracker = new BulletTracker();
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    const client = prediction();
    client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets) }), 0);
    const ownIds = (): number[] =>
      client
        .view(1000)
        .bullets.filter((bullet) => bullet.owner === ME)
        .map((bullet) => bullet.id);
    client.predict(1, IDLE_ACTION);
    client.predict(2, FIRE);
    expect(ownIds()).toEqual([PREDICTED_BULLET_ID_BASE + 2]);
    for (let tick = 1; tick <= 3; tick++) {
      client.predict(2 + tick, IDLE_ACTION);
      stepWorld(server, [IDLE_ACTION, FIRE]);
      client.applySnapshot(snapshotOf(server, { ackSeq: 1, changes: tracker.diff(server.bullets) }), tick * TICK_MS);
      expect(ownIds()).toEqual([PREDICTED_BULLET_ID_BASE + 2]);
      expect(client.takeConfirmedBullets()).toEqual([]);
    }
    stepWorld(server, actionsFor(server, FIRE));
    client.applySnapshot(snapshotOf(server, { ackSeq: 2, changes: tracker.diff(server.bullets) }), 4 * TICK_MS);
    const serverId = server.bullets.find((bullet) => bullet.owner === ME)?.id ?? -1;
    expect(ownIds()).toEqual([serverId]);
    expect(client.takeConfirmedBullets()).toEqual([{ predictedId: PREDICTED_BULLET_ID_BASE + 2, serverId }]);
    expect(client.takeConfirmedBullets()).toEqual([]);
  });

  it('вход в идущий матч: снаряды из полного списка видны с первым снимком', () => {
    const server = worldOf([placedTank(ME, 500, 600), placedTank(5, 900, 300)]);
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    stepWorld(server, [IDLE_ACTION, FIRE]);
    const tracker = new BulletTracker();
    tracker.diff(server.bullets);
    const client = prediction();
    client.resetBullets(server.bullets.map(bulletSnapshot));
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets) }), 0);
    const theirs = client.view(1000).bullets;
    expect(theirs).toEqual([
      { id: server.bullets[0]?.id, owner: 5, x: server.bullets[0]?.x, y: server.bullets[0]?.y, tick: server.tick },
    ]);
  });
});

// Бой на эталонном поле: сервер применяет свою команду с отставанием lag, клиент рисует два кадра на тик.
// После боя каждый кадр сверяется с историей сервера — в том числе с тиками, которые клиент досчитал вперёд.
interface PictureScenario {
  tanks: Tank[];
  lag: number;
  ticks: number;
  myAction?: (seq: number) => Action;
  serverMyAction?: (seq: number) => Action;
  otherAction?: (id: number, tick: number) => Action;
  isSnapshotHeld?: (tick: number) => boolean;
  // Вмешательство в поле сервера перед шагом тика — толчок, которого клиент предсказать не мог.
  disturb?: (world: World, tick: number) => void;
}

interface ServerTick {
  bullets: Map<number, { x: number; y: number }>;
  me: { x: number; y: number } | null;
  hitsOnMe: number;
  hitTanks: number[];
}

interface PictureFrame {
  latestTick: number;
  view: FfaFrameView;
}

const AIM_AT_ME: Action = { ...IDLE_ACTION, isFiring: true };
// Первые команды — покой: пока сервер не получил ни одной, он держит танк на месте, и предсказание с ним совпадает.
const WARMUP_SEQ = 8;

function serverTick(world: World, hitTanks: number[]): ServerTick {
  const me = world.tanks.find((tank) => tank.id === ME && tank.isAlive);
  return {
    bullets: new Map(world.bullets.map((bullet) => [bullet.id, { x: bullet.x, y: bullet.y }])),
    me: me === undefined ? null : { x: me.x, y: me.y },
    hitsOnMe: hitTanks.filter((id) => id === ME).length,
    hitTanks,
  };
}

function playPicture(scenario: PictureScenario): { frames: PictureFrame[]; history: Map<number, ServerTick> } {
  const planned = scenario.myAction ?? ((): Action => IDLE_ACTION);
  const myAction = (seq: number): Action => (seq <= WARMUP_SEQ ? IDLE_ACTION : planned(seq));
  const serverPlanned = scenario.serverMyAction ?? planned;
  const serverMyAction = (seq: number): Action => (seq <= WARMUP_SEQ ? IDLE_ACTION : serverPlanned(seq));
  const otherAction = scenario.otherAction ?? ((): Action => AIM_AT_ME);
  const server = worldOf(scenario.tanks);
  const tracker = new BulletTracker();
  const client = prediction();
  client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets) }), 0);
  const history = new Map<number, ServerTick>([[server.tick, serverTick(server, [])]]);
  const frames: PictureFrame[] = [];
  const held: FfaSnapshotMessage[] = [];
  let latestTick = server.tick;
  for (let tick = 1; tick <= scenario.ticks + scenario.lag; tick++) {
    if (tick <= scenario.ticks) {
      client.predict(tick, myAction(tick));
    }
    const seq = tick - scenario.lag;
    scenario.disturb?.(server, tick);
    const actions = server.tanks.map((tank) => {
      if (tank.id !== ME) {
        return otherAction(tank.id, tick);
      }
      return seq >= 1 ? serverMyAction(seq) : IDLE_ACTION;
    });
    const events = stepWorld(server, actions);
    const hitTanks = events.flatMap((event) => (event.type === 'hit' ? [event.tank] : []));
    history.set(server.tick, serverTick(server, hitTanks));
    const snapshot = snapshotOf(server, { ackSeq: Math.max(0, seq), changes: tracker.diff(server.bullets) });
    if (tick > scenario.ticks) {
      continue;
    }
    held.push(snapshot);
    if (scenario.isSnapshotHeld?.(tick) !== true) {
      for (const message of held.splice(0)) {
        client.applySnapshot(message, tick * TICK_MS);
        latestTick = message.tick;
      }
    }
    for (const offset of [1, TICK_MS / 2]) {
      frames.push({ latestTick, view: client.view(tick * TICK_MS + offset) });
    }
  }
  return { frames, history };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Чужие снаряды у своего танка — в его тике и там же, где на сервере в этом тике; свой танк — там же, где на
// сервере. Снаряд в тике не позже последнего снимка, которого на сервере в этом тике нет, — призрак.
function checkPicture(frames: readonly PictureFrame[], history: ReadonlyMap<number, ServerTick>): number {
  let nearChecks = 0;
  for (const { latestTick, view } of frames) {
    const { me, myTick } = view.clock;
    for (const bullet of view.bullets) {
      if (bullet.tick <= latestTick) {
        expect(history.get(Math.ceil(bullet.tick))?.bullets.has(bullet.id)).toBe(true);
      }
    }
    if (me === null) {
      continue;
    }
    const truth = history.get(myTick);
    expect(distance(me, truth?.me ?? { x: NaN, y: NaN })).toBeLessThan(1e-6);
    for (const bullet of view.bullets.filter((candidate) => candidate.owner !== ME)) {
      if (distance(bullet, me) > PICTURE_NEAR) {
        continue;
      }
      expect(bullet.tick).toBe(myTick);
      expect(distance(bullet, truth?.bullets.get(bullet.id) ?? { x: NaN, y: NaN })).toBeLessThan(1e-6);
      nearChecks++;
    }
  }
  return nearChecks;
}

function sturdy(tank: Tank): Tank {
  tank.hp = 100_000;
  return tank;
}

function hitsOnMe(history: ReadonlyMap<number, ServerTick>): number {
  return [...history.values()].reduce((sum, entry) => sum + entry.hitsOnMe, 0);
}

describe('картинка совпадает с сервером', () => {
  for (const lag of [0, 4, 5]) {
    it(`чужие снаряды у своего едущего танка — в его тике и на месте сервера, ${String(lag)} неподтверждённых`, () => {
      const { frames, history } = playPicture({
        tanks: [sturdy(placedTank(ME, 500, 420, Math.PI / 2)), placedTank(5, 1100, 600, Math.PI)],
        lag,
        ticks: 150,
        myAction: (seq) => ({ ...GAS, throttle: Math.floor(seq / 40) % 2 === 0 ? 1 : -1 }),
      });
      expect(checkPicture(frames, history)).toBeGreaterThan(5);
      expect(hitsOnMe(history)).toBeGreaterThan(0);
    });
  }

  it('у стоящего своего танка рядом с чужим снаряды у чужого — в тике чужих', () => {
    const { frames } = playPicture({
      tanks: [sturdy(placedTank(ME, 300, 900)), placedTank(5, 1100, 600, Math.PI), placedTank(6, 700, 600)],
      lag: 4,
      ticks: 60,
      otherAction: (id) => (id === 5 ? AIM_AT_ME : IDLE_ACTION),
    });
    let atOther = 0;
    for (const { view } of frames) {
      const other = view.tanks.find((tank) => tank.id === 6);
      for (const bullet of view.bullets) {
        if (other !== undefined && distance(bullet, other) <= PICTURE_NEAR - 10) {
          expect(bullet.tick).toBe(view.clock.othersTick);
          atOther++;
        }
      }
    }
    expect(atOther).toBeGreaterThan(0);
  });

  it('рикошет у своего танка досчитан вперёд: место в его тике — как на сервере', () => {
    // Отскок от верхнего края в точке, откуда отражённый путь идёт в свой танк: углы падения и отражения равны.
    const shooterTurret = Math.atan2(5 - 400, 592 - 300);
    const shooter = placedTank(5, 300, 400, shooterTurret);
    const { frames, history } = playPicture({
      tanks: [sturdy(placedTank(ME, 640, 70)), shooter],
      lag: 4,
      ticks: 60,
    });
    expect(checkPicture(frames, history)).toBeGreaterThan(0);
  });

  it('снаряд погиб на сервере на другом танке, пока рисовался досчитанным: после снимка с гибелью его нет', () => {
    const blockerId = 6;
    const { frames, history } = playPicture({
      tanks: [
        sturdy(placedTank(ME, 500, 600)),
        placedTank(5, 1300, 600, Math.PI),
        placedTank(blockerId, 640, 480, Math.PI / 2),
      ],
      lag: 5,
      ticks: 60,
      otherAction: (id, tick) => {
        if (id === blockerId) {
          return { ...IDLE_ACTION, throttle: tick >= 12 ? 1 : 0 };
        }
        return tick === 1 ? AIM_AT_ME : IDLE_ACTION;
      },
    });
    const bulletId = 1;
    const deathTick = [...history.entries()].find(([tick, entry]) => tick > 1 && !entry.bullets.has(bulletId))?.[0];
    expect(history.get(deathTick ?? 0)?.hitsOnMe).toBe(0);
    const drawnAhead = frames.filter(
      ({ latestTick, view }) =>
        latestTick < (deathTick ?? 0) && view.bullets.some((b) => b.id === bulletId && b.tick > latestTick),
    );
    expect(drawnAhead.length).toBeGreaterThan(0);
    const afterDeath = frames.filter((frame) => frame.latestTick >= (deathTick ?? Infinity));
    for (const { view } of afterDeath) {
      const bullet = view.bullets.find((candidate) => candidate.id === bulletId);
      expect(bullet === undefined || bullet.tick <= (deathTick ?? 0) - 1).toBe(true);
    }
    expect(afterDeath.at(-1)?.view.bullets.some((bullet) => bullet.id === bulletId)).toBe(false);
  });

  it('досчитанное касание своего танка гасит снаряд до вердикта; сервер решил «мимо» — снаряд снова на месте', () => {
    // Снаряд касается своего танка на тике 35; за два тика до того танк на сервере толкнули в сторону.
    const pushTick = 33;
    const { frames, history } = playPicture({
      tanks: [sturdy(placedTank(ME, 600, 600)), placedTank(5, 1300, 600, Math.PI)],
      lag: 5,
      ticks: 60,
      otherAction: (_id, tick) => (tick === 1 ? AIM_AT_ME : IDLE_ACTION),
      disturb: (world, tick) => {
        if (tick === pushTick) {
          meOf(world).y += 80;
        }
      },
    });
    expect(hitsOnMe(history)).toBe(0);
    const bulletId = 1;
    const presence = frames.map(({ view }) => view.bullets.some((bullet) => bullet.id === bulletId));
    const firstHidden = presence.indexOf(false, presence.indexOf(true));
    expect(firstHidden).toBeGreaterThan(0);
    expect(presence.indexOf(true, firstHidden)).toBeGreaterThan(firstHidden);
  });

  it('выстрел в упор: у своего танка снаряд в его тике, после досчитанного касания не рисуется', () => {
    const { frames, history } = playPicture({
      tanks: [sturdy(placedTank(ME, 600, 600)), placedTank(5, 680, 600, Math.PI)],
      lag: 4,
      ticks: 40,
      otherAction: (_id, tick) => (tick === 1 ? AIM_AT_ME : IDLE_ACTION),
    });
    checkPicture(frames, history);
    expect(hitsOnMe(history)).toBe(1);
    for (const { view } of frames) {
      const me = view.clock.me;
      for (const bullet of view.bullets) {
        expect(me === null || distance(bullet, me) >= TANK_RADIUS + BULLET_RADIUS - 1e-9).toBe(true);
      }
    }
  });

  // Тик ни одного снаряда не убывает от кадра к кадру; тик своего танка не убывает.
  function checkMonotonic(frames: readonly PictureFrame[]): void {
    for (let index = 1; index < frames.length; index++) {
      const before = frames[index - 1]?.view;
      const now = frames[index]?.view;
      expect(now?.clock.myTick).toBeGreaterThanOrEqual((before?.clock.myTick ?? 0) - 1e-9);
      for (const bullet of now?.bullets ?? []) {
        const previous = before?.bullets.find((candidate) => candidate.id === bullet.id);
        expect(bullet.tick).toBeGreaterThanOrEqual((previous?.tick ?? -Infinity) - 1e-9);
      }
    }
  }

  it('своя гибель: убивший снаряд не появляется снова, ни один снаряд не летит назад, P плавно догоняет R', () => {
    const me = placedTank(ME, 600, 600);
    me.hp = 1;
    const { frames, history } = playPicture({
      tanks: [me, placedTank(5, 900, 600, Math.PI), placedTank(6, 900, 200, Math.PI)],
      lag: 4,
      ticks: 60,
      otherAction: (id, tick) => (id === 5 ? { ...IDLE_ACTION, isFiring: tick === 1 } : FIRE),
    });
    const killTick = [...history.entries()].find(([, entry]) => entry.hitsOnMe > 0)?.[0] ?? NaN;
    const beforeKill = history.get(killTick - 1)?.bullets ?? new Map<number, { x: number; y: number }>();
    const killerId = [...beforeKill.keys()].find((id) => !(history.get(killTick)?.bullets.has(id) ?? true));
    expect(killerId).toBeDefined();
    checkMonotonic(frames);
    const presence = frames.map(({ view }) => view.bullets.some((bullet) => bullet.id === killerId));
    const firstHidden = presence.indexOf(false, presence.indexOf(true));
    expect(firstHidden).toBeGreaterThan(0);
    expect(presence.indexOf(true, firstHidden)).toBe(-1);
    const deathFrame = frames.findIndex(({ view }) => view.clock.me === null);
    for (let index = deathFrame + 1; index < frames.length; index++) {
      const before = frames[index - 1]?.view.clock;
      const now = frames[index]?.view.clock;
      const othersStep = (now?.othersTick ?? 0) - (before?.othersTick ?? 0);
      const ownStep = (now?.myTick ?? 0) - (before?.myTick ?? 0);
      const isCaughtUp = now?.myTick === now?.othersTick;
      expect(isCaughtUp || ownStep >= PICTURE_MIN_TIME_RATE * othersStep - 1e-9).toBe(true);
    }
    const after = frames.slice(-10);
    for (const { view } of after) {
      expect(view.clock.me).toBeNull();
      expect(view.clock.myTick).toBe(view.clock.othersTick);
      for (const bullet of view.bullets) {
        expect(bullet.tick).toBe(view.clock.othersTick);
      }
    }
    expect(after.some(({ view }) => view.bullets.length > 0)).toBe(true);
  });

  it('возрождение: P догоняет тик предсказания без скачка; дальше снаряды у своего танка — в его тике', () => {
    const me = placedTank(ME, 600, 600);
    me.hp = 1;
    const respawnTick = 30;
    const sniper = 6;
    const { frames, history } = playPicture({
      tanks: [me, placedTank(5, 900, 600, Math.PI), placedTank(sniper, 1100, 900, Math.PI)],
      lag: 4,
      ticks: 120,
      otherAction: (id, tick) => ({ ...IDLE_ACTION, isFiring: id === sniper ? tick > 60 : tick === 1 }),
      disturb: (world, tick) => {
        if (tick === respawnTick) {
          const tank = meOf(world);
          tank.isAlive = true;
          tank.hp = 100_000;
          tank.y = 900;
        }
      },
    });
    checkMonotonic(frames);
    const back = frames.findIndex(
      ({ view }, index) => index > 0 && view.clock.me !== null && frames[index - 1]?.view.clock.me === null,
    );
    expect(back).toBeGreaterThan(0);
    const before = frames[back - 1]?.view.clock;
    const now = frames[back]?.view.clock;
    const othersStep = (now?.othersTick ?? 0) - (before?.othersTick ?? 0);
    expect((now?.myTick ?? 0) - (before?.myTick ?? 0)).toBeLessThanOrEqual(PICTURE_CATCH_UP_RATE * othersStep + 1e-9);
    expect(checkPicture(frames.slice(-60), history)).toBeGreaterThan(0);
  });

  // Враг трогается незадолго до выстрела: в упор он не успевает упереться в свой танк.
  const ENEMY_START_TICK = 12;
  const ENEMY_MOVES = [
    { name: 'стоит', heading: Math.PI, throttle: 0 },
    { name: 'уезжает', heading: 0, throttle: 1 },
    { name: 'едет навстречу задним ходом', heading: 0, throttle: -1 },
  ];
  for (const move of ENEMY_MOVES) {
    for (const gap of [90, 120, 160, 200]) {
      it(`свой выстрел по врагу в ${String(gap)}, враг ${move.name}: снаряд не входит в корпус, не идёт назад, гаснет на броне в кадре вспышки`, () => {
        const enemyId = 5;
        const runs = [3, 4, 5, 6].flatMap((lag) => [
          { lag, isPaired: false },
          { lag, isPaired: true },
        ]);
        for (const { lag, isPaired } of runs) {
          const { frames, history } = playPicture({
            tanks: [sturdy(placedTank(ME, 600, 600)), sturdy(placedTank(enemyId, 600 + gap, 600, move.heading))],
            lag,
            ticks: 60,
            myAction: (seq) => ({ ...IDLE_ACTION, isFiring: seq === 12 }),
            otherAction: (_id, tick) => ({ ...IDLE_ACTION, throttle: tick >= ENEMY_START_TICK ? move.throttle : 0 }),
            isSnapshotHeld: (tick) => isPaired && tick % 2 === 0,
          });
          const hitTick = [...history.entries()].find(([, entry]) => entry.hitTanks.includes(enemyId))?.[0] ?? NaN;
          expect(hitTick).toBeGreaterThan(0);
          const shotFrame = frames.findIndex(({ view }) => view.bullets.some((bullet) => bullet.owner === ME));
          expect(shotFrame).toBeGreaterThan(0);
          let previous: { bullet: { x: number; y: number }; enemy: { x: number; y: number } } | null = null;
          for (const { view } of frames.slice(shotFrame)) {
            const enemy = view.tanks.find((tank) => tank.id === enemyId);
            if (enemy === undefined) {
              throw new Error('враг пропал с картинки');
            }
            const isFlashDue = pictureTickAt(view.clock, enemy) > hitTick - 1;
            const bullet = view.bullets.find((candidate) => candidate.owner === ME);
            expect(bullet !== undefined).toBe(!isFlashDue);
            if (bullet === undefined) {
              if (previous !== null) {
                expect(distance(previous.bullet, previous.enemy)).toBeLessThan(TANK_RADIUS + BULLET_RADIUS + 1e-6);
              }
              break;
            }
            expect(distance(bullet, enemy)).toBeGreaterThanOrEqual(TANK_RADIUS + BULLET_RADIUS - 1e-6);
            if (previous !== null) {
              const push = Math.min(0, enemy.x - previous.enemy.x);
              expect(bullet.x - previous.bullet.x).toBeGreaterThanOrEqual(push - 1e-6);
            }
            previous = { bullet, enemy };
          }
        }
      });
    }
  }

  it('снимки парами: снаряды не мигают, у своего танка — в его тике и на месте сервера', () => {
    const { frames, history } = playPicture({
      tanks: [sturdy(placedTank(ME, 500, 600, Math.PI / 2)), placedTank(5, 1100, 600, Math.PI)],
      lag: 4,
      ticks: 120,
      myAction: (seq) => ({ ...IDLE_ACTION, turn: seq % 20 < 10 ? 1 : -1 }),
      isSnapshotHeld: (tick) => tick % 2 === 0,
    });
    expect(checkPicture(frames, history)).toBeGreaterThan(0);
    for (let index = 1; index + 1 < frames.length; index++) {
      const ids = (frame: PictureFrame | undefined): Set<number> => new Set(frame?.view.bullets.map((b) => b.id));
      const [before, now, after] = [ids(frames[index - 1]), ids(frames[index]), ids(frames[index + 1])];
      for (const id of before) {
        expect(!after.has(id) || now.has(id)).toBe(true);
      }
    }
  });
});
