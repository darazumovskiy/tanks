import { describe, expect, it } from 'vitest';
import {
  BULLET_RADIUS,
  createFfaMatch,
  createRandom,
  createWorld,
  DEFAULT_RULES,
  DEFAULT_STATS,
  deriveStats,
  DT,
  ffaMap,
  IDLE_ACTION,
  MUZZLE_OFFSET,
  nextRandom,
  stepFfaMatch,
  stepWorld,
  TANK_RADIUS,
  type Action,
  type RoundRules,
  type Stats,
  type Tank,
  type World,
  type ZonePlan,
} from '@tanks/shared/engine';
import {
  BulletTracker,
  bulletSnapshot,
  toFfaSnapshotEvent,
  type FfaSnapshotEvent,
  type FfaSnapshotMessage,
} from '@tanks/shared/protocol';
import { OPEN_MAP, placedTank, snapshotOf } from '../testing/ffaServer.js';
import { PLAYOUT_MAX_BEHIND_TICKS } from '../netSmoothing.js';
import {
  EventSchedule,
  eventPlace,
  PICTURE_CATCH_UP_RATE,
  PICTURE_MIN_TIME_RATE,
  PICTURE_NEAR,
  pictureTickAt,
  type DueEvent,
  type PictureClock,
} from '../pictureTime.js';
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

function drawnMe(clock: PictureClock): { x: number; y: number } | null {
  const shift = clock.ownShift ?? { x: 0, y: 0 };
  return clock.me === null ? null : { x: clock.me.x + shift.x, y: clock.me.y + shift.y };
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

  it('пауза связи: команда выстрела подтверждена повтором раньше снаряда сервера — свой снаряд летит до пары', () => {
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
    const fireSeq = 2;
    const lateFireSeq = 4;
    const lastSeq = 6;
    for (let seq = 1; seq <= lastSeq; seq++) {
      client.predict(seq, seq === fireSeq ? FIRE : IDLE_ACTION);
    }
    for (let seq = 1; seq < lateFireSeq; seq++) {
      stepWorld(server, actionsFor(server, IDLE_ACTION));
      client.applySnapshot(snapshotOf(server, { ackSeq: seq, changes: tracker.diff(server.bullets) }), seq * TICK_MS);
      expect(ownIds()).toEqual([PREDICTED_BULLET_ID_BASE + fireSeq]);
      expect(client.takeConfirmedBullets()).toEqual([]);
    }
    stepWorld(server, actionsFor(server, FIRE));
    client.applySnapshot(
      snapshotOf(server, { ackSeq: lateFireSeq, changes: tracker.diff(server.bullets) }),
      lateFireSeq * TICK_MS,
    );
    const serverId = server.bullets.find((bullet) => bullet.owner === ME)?.id ?? -1;
    expect(ownIds()).toEqual([serverId]);
    expect(client.takeConfirmedBullets()).toEqual([{ predictedId: PREDICTED_BULLET_ID_BASE + fireSeq, serverId }]);
  });

  // Сервер в паузе стреляет повтором по своей перезарядке — на шаг раньше или позже предсказания, — или переносит
  // выстрел пришедшей засчитанной команды на следующий шаг.
  for (const shift of [-1, 1, 3]) {
    it(`выстрел сервера на ${String(shift)} шаг от предсказанного — в каждом снимке один свой снаряд`, () => {
      const server = worldOf([placedTank(ME, 500, 600), placedTank(5, 1500, 900)]);
      const tracker = new BulletTracker();
      stepWorld(server, actionsFor(server, IDLE_ACTION));
      const client = prediction();
      client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets) }), 0);
      const ownCount = (): number => client.view(1000).bullets.filter((bullet) => bullet.owner === ME).length;
      const fireSeq = 3;
      const lag = 2;
      const lastSeq = 14;
      const counts: number[] = [];
      for (let seq = 1; seq <= lastSeq; seq++) {
        client.predict(seq, seq === fireSeq ? FIRE : IDLE_ACTION);
        const applied = seq - lag;
        if (applied >= 1) {
          stepWorld(server, actionsFor(server, applied === fireSeq + shift ? FIRE : IDLE_ACTION));
          const changes = tracker.diff(server.bullets);
          client.applySnapshot(snapshotOf(server, { ackSeq: applied, changes }), seq * TICK_MS);
        }
        if (seq >= fireSeq) {
          counts.push(ownCount());
        }
      }
      expect(counts).toEqual(Array<number>(counts.length).fill(1));
      expect(client.view(1000).bullets.find((bullet) => bullet.owner === ME)?.id).toBeLessThan(
        PREDICTED_BULLET_ID_BASE,
      );
    });
  }

  it('свой танк подбит, пока подтверждённый снаряд ждёт пару, — снаряд предсказания пропадает', () => {
    const server = worldOf([placedTank(ME, 500, 600), placedTank(5, 1500, 900)]);
    const tracker = new BulletTracker();
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    const client = prediction();
    client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets) }), 0);
    client.predict(1, FIRE);
    client.predict(2, IDLE_ACTION);
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    client.applySnapshot(snapshotOf(server, { ackSeq: 1, changes: tracker.diff(server.bullets) }), TICK_MS);
    expect(client.view(1000).bullets.filter((bullet) => bullet.owner === ME)).toHaveLength(1);
    meOf(server).isAlive = false;
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    client.applySnapshot(snapshotOf(server, { ackSeq: 2, changes: tracker.diff(server.bullets) }), 2 * TICK_MS);
    expect(client.view(1000).bullets.filter((bullet) => bullet.owner === ME)).toEqual([]);
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

describe('догон снаряда', () => {
  const LEAD_RULES: RoundRules = { ...DEFAULT_RULES, shotLeadTicks: 2 };
  // Выстрел — когда сервер уже применяет команды: до первой он стоит, а предсказание уходит вперёд на лишние тики.
  const FIRE_SEQ = 10;
  const TICKS = 50;

  // Место снаряда сервера в дробном тике картинки: между тиками снаряд летит по прямой, до тика рождения стоит на
  // месте рождения.
  function serverAt(history: ReadonlyMap<number, { x: number; y: number }>, tick: number): { x: number; y: number } {
    const after = history.get(Math.ceil(tick));
    const before = history.get(Math.floor(tick)) ?? after;
    if (before === undefined || after === undefined) {
      return { x: NaN, y: NaN };
    }
    const t = tick - Math.floor(tick);
    return { x: before.x + (after.x - before.x) * t, y: before.y + (after.y - before.y) * t };
  }

  for (const lag of [0, 2, 5]) {
    it(`свой снаряд при догоне 2 — на месте серверного до и после подтверждения, один; ${String(lag)} неподтверждённых`, () => {
      const server = createWorld(
        OPEN_MAP,
        [placedTank(ME, 500, 600), placedTank(5, 1500, 900)],
        LEAD_RULES,
        STILL_ZONE,
      );
      const tracker = new BulletTracker();
      const client = new FfaPrediction(OPEN_MAP, LEAD_RULES, STILL_ZONE, ME, setupOf);
      stepWorld(server, actionsFor(server, IDLE_ACTION));
      client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets) }), 0);
      const history = new Map<number, { x: number; y: number }>();
      const drawn: { id: number; tick: number; x: number; y: number }[] = [];
      for (let tick = 1; tick <= TICKS + lag; tick++) {
        if (tick <= TICKS) {
          client.predict(tick, tick === FIRE_SEQ ? FIRE : IDLE_ACTION);
        }
        const seq = tick - lag;
        stepWorld(server, actionsFor(server, seq === FIRE_SEQ ? FIRE : IDLE_ACTION));
        const own = server.bullets.find((bullet) => bullet.owner === ME);
        if (own !== undefined) {
          history.set(server.tick, { x: own.x, y: own.y });
        }
        if (tick > TICKS) {
          continue;
        }
        client.applySnapshot(
          snapshotOf(server, { ackSeq: Math.max(0, seq), changes: tracker.diff(server.bullets) }),
          tick * TICK_MS,
        );
        const mine = client.view(tick * TICK_MS + 1).bullets.filter((bullet) => bullet.owner === ME);
        expect(mine.length).toBeLessThanOrEqual(1);
        drawn.push(...mine);
      }
      expect(drawn.length).toBeGreaterThan(TICKS / 2);
      expect(drawn.some((bullet) => bullet.id >= PREDICTED_BULLET_ID_BASE)).toBe(lag > 0);
      expect(drawn.at(-1)?.id).toBeLessThan(PREDICTED_BULLET_ID_BASE);
      for (const bullet of drawn) {
        const truth = serverAt(history, bullet.tick);
        expect(Math.hypot(bullet.x - truth.x, bullet.y - truth.y)).toBeLessThan(1e-6);
      }
      const firstTick = Math.min(...history.keys());
      const first = history.get(firstTick) ?? { x: NaN, y: NaN };
      const muzzleGap = Math.hypot(first.x - 500, first.y - 600) - MUZZLE_OFFSET;
      expect(muzzleGap).toBeCloseTo(3 * deriveStats(DEFAULT_STATS).bulletSpeed * DT, 6);
    });
  }

  for (const lag of [0, 2, 5]) {
    it(`снаряд со скоростью танка: свой выстрел на ходу — на месте серверного; ${String(lag)} неподтверждённых`, () => {
      const rules: RoundRules = { ...DEFAULT_RULES, shotInheritPercent: 100 };
      const gasFire: Action = { ...GAS, isFiring: true };
      // До первой команды сервер стоит; дальше — газ и выстрел, как предсказывал клиент.
      const serverAction = (seq: number): Action => {
        if (seq <= 0) {
          return IDLE_ACTION;
        }
        return seq === FIRE_SEQ ? gasFire : GAS;
      };
      const shooter = placedTank(ME, 500, 600);
      shooter.turret = Math.PI / 2;
      const server = createWorld(OPEN_MAP, [shooter, placedTank(5, 1500, 900)], rules, STILL_ZONE);
      const tracker = new BulletTracker();
      const client = new FfaPrediction(OPEN_MAP, rules, STILL_ZONE, ME, setupOf);
      stepWorld(server, actionsFor(server, IDLE_ACTION));
      client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets) }), 0);
      const history = new Map<number, { x: number; y: number }>();
      const drawn: { id: number; tick: number; x: number; y: number }[] = [];
      for (let tick = 1; tick <= TICKS + lag; tick++) {
        if (tick <= TICKS) {
          client.predict(tick, serverAction(tick));
        }
        const seq = tick - lag;
        stepWorld(server, actionsFor(server, serverAction(seq)));
        const own = server.bullets.find((bullet) => bullet.owner === ME);
        if (own !== undefined) {
          expect(own.vx).toBeGreaterThan(0);
          history.set(server.tick, { x: own.x, y: own.y });
        }
        if (tick > TICKS) {
          continue;
        }
        client.applySnapshot(
          snapshotOf(server, { ackSeq: Math.max(0, seq), changes: tracker.diff(server.bullets) }),
          tick * TICK_MS,
        );
        const mine = client.view(tick * TICK_MS + 1).bullets.filter((bullet) => bullet.owner === ME);
        expect(mine.length).toBeLessThanOrEqual(1);
        drawn.push(...mine);
      }
      expect(drawn.length).toBeGreaterThan(TICKS / 2);
      for (const bullet of drawn) {
        const truth = serverAt(history, bullet.tick);
        expect(Math.hypot(bullet.x - truth.x, bullet.y - truth.y)).toBeLessThan(1e-6);
      }
    });
  }
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
  hasNetSmoothing?: boolean;
}

interface ServerTick {
  bullets: Map<number, { x: number; y: number }>;
  me: { x: number; y: number } | null;
  hitsOnMe: number;
  hitTanks: number[];
}

// ownHits — попадания по своему танку, сыгранные по касанию к этому кадру.
interface PictureFrame {
  latestTick: number;
  view: FfaFrameView;
  ownHits: DueEvent<FfaSnapshotEvent>[];
}

// Попадание по своему танку из снимка и сыграно ли оно уже касанием.
interface ServedHit {
  tick: number;
  wasPlayed: boolean;
}

interface PlayedPicture {
  frames: PictureFrame[];
  history: Map<number, ServerTick>;
  served: ServedHit[];
  client: FfaPrediction;
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

function playPicture(scenario: PictureScenario): PlayedPicture {
  const planned = scenario.myAction ?? ((): Action => IDLE_ACTION);
  const myAction = (seq: number): Action => (seq <= WARMUP_SEQ ? IDLE_ACTION : planned(seq));
  const serverPlanned = scenario.serverMyAction ?? planned;
  const serverMyAction = (seq: number): Action => (seq <= WARMUP_SEQ ? IDLE_ACTION : serverPlanned(seq));
  const otherAction = scenario.otherAction ?? ((): Action => AIM_AT_ME);
  const server = worldOf(scenario.tanks);
  const tracker = new BulletTracker();
  const client = new FfaPrediction(OPEN_MAP, DEFAULT_RULES, STILL_ZONE, ME, setupOf, scenario.hasNetSmoothing === true);
  client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets) }), 0);
  const history = new Map<number, ServerTick>([[server.tick, serverTick(server, [])]]);
  const frames: PictureFrame[] = [];
  const served: ServedHit[] = [];
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
    const snapshot = snapshotOf(server, {
      ackSeq: Math.max(0, seq),
      changes: tracker.diff(server.bullets),
      events: events.map(toFfaSnapshotEvent),
    });
    if (tick > scenario.ticks) {
      continue;
    }
    held.push(snapshot);
    if (scenario.isSnapshotHeld?.(tick) !== true) {
      for (const message of held.splice(0)) {
        client.applySnapshot(message, tick * TICK_MS);
        latestTick = message.tick;
        for (const event of message.events.filter((candidate) => candidate.kind === 'hit' && candidate.tank === ME)) {
          served.push({ tick: message.tick, wasPlayed: client.wasPlayedOnTouch(event) });
        }
      }
    }
    for (const offset of [1, TICK_MS / 2]) {
      frames.push({ latestTick, view: client.view(tick * TICK_MS + offset), ownHits: client.takeOwnHits() });
    }
  }
  return { frames, history, served, client };
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

describe('попадание по своему танку по касанию', () => {
  const STATS = deriveStats(DEFAULT_STATS);
  const SHOOTER = 5;
  const OTHER = 6;
  const BULLET_ID = 1;
  const LAG = 5;
  const TICKS = 70;
  const CONTACT = TANK_RADIUS + BULLET_RADIUS;
  // Щит дольше всего полёта снаряда.
  const LONG_SHIELD_SECONDS = 10;
  const shooterFiresOnce = (id: number, tick: number): Action =>
    id === SHOOTER && tick === 1 ? AIM_AT_ME : IDLE_ACTION;

  function shot(disturb?: (world: World, tick: number) => void, me = placedTank(ME, 600, 600)): PlayedPicture {
    return playPicture({
      tanks: [me, placedTank(SHOOTER, 1300, 600, Math.PI), placedTank(OTHER, 100, 100)],
      lag: LAG,
      ticks: TICKS,
      otherAction: shooterFiresOnce,
      ...(disturb === undefined ? {} : { disturb }),
    });
  }

  function ownHp(frame: PictureFrame | undefined): number {
    return frame?.view.tanks.find((tank) => tank.id === ME)?.hp ?? NaN;
  }

  function hitTickOf(history: ReadonlyMap<number, ServerTick>): number {
    return [...history.entries()].find(([, entry]) => entry.hitsOnMe > 0)?.[0] ?? NaN;
  }

  function touchIndexOf(frames: readonly PictureFrame[]): number {
    return frames.findIndex((frame) => frame.ownHits.length > 0);
  }

  function hasBullet(frame: PictureFrame | undefined): boolean {
    return frame?.view.bullets.some((bullet) => bullet.id === BULLET_ID) === true;
  }

  it('C20 попадание — в кадре, где снаряд пропал у своего танка, раньше снимка; урон стрелка; снимок не повторяет', () => {
    const { frames, history, served, client } = shot();
    const hitTick = hitTickOf(history);
    const index = touchIndexOf(frames);
    const frame = frames[index];
    expect(frames.flatMap((candidate) => candidate.ownHits)).toHaveLength(1);
    const played = frame?.ownHits[0];
    expect(played?.event).toMatchObject({ kind: 'hit', tank: ME, by: SHOOTER, value: STATS.damage, flags: 0 });
    expect(played?.tick).toBe(hitTick);
    expect(hasBullet(frames[index - 1])).toBe(true);
    expect(hasBullet(frame)).toBe(false);
    expect(frame?.latestTick).toBe(hitTick - LAG);
    const me = frame?.view.clock.me ?? { x: NaN, y: NaN };
    expect(distance(played?.event ?? me, me)).toBeLessThan(CONTACT);
    expect(ownHp(frames[index - 1])).toBe(STATS.maxHp);
    for (const later of frames.slice(index)) {
      expect(ownHp(later)).toBe(STATS.maxHp - STATS.damage);
    }
    expect(served).toEqual([{ tick: hitTick, wasPlayed: true }]);
    expect(client.ownHitCounts).toEqual({ played: 1, confirmed: 1, cancelled: 0, served: 1, doubles: 0 });
  });

  it('C21 свой танк на сервере толкнули с линии — отмена через 2 тика, здоровье из снимка, повторов нет', () => {
    const hitTick = hitTickOf(shot().history);
    const { frames, history, served, client } = shot((world, tick) => {
      if (tick === hitTick - 2) {
        const me = world.tanks.find((tank) => tank.id === ME);
        if (me !== undefined) {
          me.y += 80;
        }
      }
    });
    expect(hitsOnMe(history)).toBe(0);
    const index = touchIndexOf(frames);
    expect(frames.flatMap((frame) => frame.ownHits)).toHaveLength(1);
    expect(client.ownHitCounts).toEqual({ played: 1, confirmed: 0, cancelled: 1, served: 0, doubles: 0 });
    expect(served).toEqual([]);
    const cancelIndex = frames.findIndex((frame) => frame.latestTick >= hitTick + 2);
    for (const frame of frames.slice(index, cancelIndex)) {
      expect(ownHp(frame)).toBe(STATS.maxHp - STATS.damage);
    }
    for (const frame of frames.slice(cancelIndex)) {
      expect(ownHp(frame)).toBe(STATS.maxHp);
    }
    expect(frames.slice(index).some(hasBullet)).toBe(true);
  });

  it('C21 сервер засчитал попадание тиком позже — подтверждено, отмен нет', () => {
    const hitTick = hitTickOf(shot().history);
    const step = STATS.bulletSpeed * DT;
    const late = shot((world, tick) => {
      if (tick === hitTick - 1) {
        const me = world.tanks.find((tank) => tank.id === ME);
        if (me !== undefined) {
          me.x -= step;
        }
      }
    });
    expect(hitTickOf(late.history)).toBe(hitTick + 1);
    expect(late.frames.flatMap((frame) => frame.ownHits)).toHaveLength(1);
    expect(late.served).toEqual([{ tick: hitTick + 1, wasPlayed: true }]);
    expect(late.client.ownHitCounts).toEqual({ played: 1, confirmed: 1, cancelled: 0, served: 1, doubles: 0 });
  });

  it('C21 поправка своего танка сдвинула касание на 3 тика — подтверждено, попадание одно', () => {
    const hitTick = hitTickOf(shot().history);
    const step = STATS.bulletSpeed * DT;
    const late = shot((world, tick) => {
      if (tick === hitTick - 2) {
        const me = world.tanks.find((tank) => tank.id === ME);
        if (me !== undefined) {
          me.x -= 3 * step;
        }
      }
    });
    expect(hitTickOf(late.history)).toBe(hitTick + 3);
    expect(late.frames.flatMap((frame) => frame.ownHits)).toHaveLength(1);
    for (const frame of late.frames.slice(touchIndexOf(late.frames))) {
      expect(ownHp(frame)).toBe(STATS.maxHp - STATS.damage);
    }
    expect(late.served).toEqual([{ tick: hitTick + 3, wasPlayed: true }]);
    expect(late.client.ownHitCounts).toEqual({ played: 1, confirmed: 1, cancelled: 0, served: 1, doubles: 0 });
  });

  it('C21 снаряд погиб о другой танк — отмена в снимке его гибели', () => {
    const hitTick = hitTickOf(shot().history);
    const { frames, history, served, client } = shot((world, tick) => {
      if (tick === hitTick - 3) {
        const other = world.tanks.find((tank) => tank.id === OTHER);
        if (other !== undefined) {
          other.x = 600 + 2 * TANK_RADIUS + 10;
          other.y = 600;
        }
      }
    });
    expect(hitsOnMe(history)).toBe(0);
    expect([...history.values()].some((entry) => entry.hitTanks.includes(OTHER))).toBe(true);
    expect(frames.flatMap((frame) => frame.ownHits)).toHaveLength(1);
    expect(served).toEqual([]);
    expect(client.ownHitCounts).toEqual({ played: 1, confirmed: 0, cancelled: 1, served: 0, doubles: 0 });
    expect(ownHp(frames.at(-1))).toBe(STATS.maxHp);
  });

  it('C22 щит — касания нет, своё здоровье не тронуто', () => {
    const me = placedTank(ME, 600, 600);
    me.shieldLeft = LONG_SHIELD_SECONDS;
    const { frames, client } = shot(undefined, me);
    expect(frames.flatMap((frame) => frame.ownHits)).toEqual([]);
    expect(client.ownHitCounts).toEqual({ played: 0, confirmed: 0, cancelled: 0, served: 0, doubles: 0 });
    expect(frames.every((frame) => ownHp(frame) === STATS.maxHp)).toBe(true);
  });

  it('C22 смертельное касание — полоска в ноль, танк жив до снимка с гибелью; второй снаряд следом не играется', () => {
    const me = placedTank(ME, 600, 600);
    me.hp = STATS.damage;
    const { frames, history, client } = playPicture({
      tanks: [me, placedTank(SHOOTER, 1100, 600, Math.PI), placedTank(7, 600, 1150, -Math.PI / 2)],
      lag: LAG,
      ticks: TICKS,
      otherAction: (_id, tick) => (tick === 1 ? AIM_AT_ME : IDLE_ACTION),
    });
    const killTick = hitTickOf(history);
    const index = touchIndexOf(frames);
    const played = frames.flatMap((frame) => frame.ownHits);
    expect(played).toHaveLength(1);
    expect(played[0]?.event.value).toBe(STATS.damage);
    const beforeDeath = frames.slice(index).filter((frame) => frame.latestTick < killTick);
    expect(beforeDeath.length).toBeGreaterThan(0);
    for (const frame of beforeDeath) {
      const own = frame.view.tanks.find((tank) => tank.id === ME);
      expect(own).toMatchObject({ hp: 0, isAlive: true });
    }
    const dead = frames.find((frame) => frame.latestTick >= killTick)?.view.tanks.find((tank) => tank.id === ME);
    expect(dead?.isAlive).toBe(false);
    expect(client.ownHitCounts).toEqual({ played: 1, confirmed: 1, cancelled: 0, served: 1, doubles: 0 });
  });

  it('C22 конец матча до подтверждения — касание отменено, здоровье из снимка', () => {
    const server = worldOf([placedTank(ME, 600, 600), placedTank(SHOOTER, 1300, 600, Math.PI)]);
    const tracker = new BulletTracker();
    const client = prediction();
    stepWorld(
      server,
      server.tanks.map((tank) => (tank.id === SHOOTER ? FIRE : IDLE_ACTION)),
    );
    client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets) }), 0);
    let seq = 0;
    while (client.ownHitCounts.played === 0 && seq < TICKS) {
      seq++;
      client.predict(seq, IDLE_ACTION);
    }
    expect(client.takeOwnHits()).toHaveLength(1);
    expect(client.view(TICK_MS).tanks.find((tank) => tank.id === ME)?.hp).toBe(STATS.maxHp - STATS.damage);
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    const matchOver = toFfaSnapshotEvent({ type: 'matchOver' });
    client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets), events: [matchOver] }), TICK_MS);
    expect(client.ownHitCounts).toEqual({ played: 1, confirmed: 0, cancelled: 1, served: 0, doubles: 0 });
    expect(client.view(2 * TICK_MS).tanks.find((tank) => tank.id === ME)?.hp).toBe(STATS.maxHp);
  });

  it('C22 пачка снимков между кадрами, второй закончил матч, — несыгранное касание не играется', () => {
    const server = worldOf([placedTank(ME, 600, 600), placedTank(SHOOTER, 1300, 600, Math.PI)]);
    const tracker = new BulletTracker();
    const client = prediction();
    stepWorld(
      server,
      server.tanks.map((tank) => (tank.id === SHOOTER ? FIRE : IDLE_ACTION)),
    );
    client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets) }), 0);
    let seq = 0;
    while (client.ownHitCounts.played === 0 && seq < TICKS) {
      seq++;
      client.predict(seq, IDLE_ACTION);
    }
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets) }), TICK_MS);
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    const matchOver = toFfaSnapshotEvent({ type: 'matchOver' });
    client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets), events: [matchOver] }), TICK_MS);
    expect(client.takeOwnHits()).toEqual([]);
    expect(client.ownHitCounts).toEqual({ played: 0, confirmed: 0, cancelled: 0, served: 0, doubles: 0 });
    expect(client.view(2 * TICK_MS).tanks.find((tank) => tank.id === ME)?.hp).toBe(STATS.maxHp);
  });

  it('C22 переподключение с касанием в ожидании — попадание одно, здоровье из снимка', () => {
    const server = worldOf([placedTank(ME, 600, 600), placedTank(SHOOTER, 1300, 600, Math.PI)]);
    const tracker = new BulletTracker();
    const client = prediction();
    stepWorld(
      server,
      server.tanks.map((tank) => (tank.id === SHOOTER ? FIRE : IDLE_ACTION)),
    );
    client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets) }), 0);
    let seq = 0;
    while (client.ownHitCounts.played === 0 && seq < TICKS) {
      seq++;
      client.predict(seq, IDLE_ACTION);
    }
    expect(client.takeOwnHits()).toHaveLength(1);
    client.resetConnection();
    while (server.bullets.length > 0) {
      stepWorld(server, actionsFor(server, IDLE_ACTION));
    }
    expect(meOf(server).hp).toBe(STATS.maxHp - STATS.damage);
    client.resetBullets(server.bullets);
    const fresh = new BulletTracker();
    for (let tick = 0; tick <= 2; tick++) {
      client.applySnapshot(snapshotOf(server, { changes: fresh.diff(server.bullets) }), (2 + tick) * TICK_MS);
      expect(client.takeOwnHits()).toEqual([]);
      expect(client.view((2 + tick) * TICK_MS).tanks.find((tank) => tank.id === ME)?.hp).toBe(
        STATS.maxHp - STATS.damage,
      );
      stepWorld(server, actionsFor(server, IDLE_ACTION));
    }
    expect(client.ownHitCounts.played).toBe(1);
  });
});

describe('сглаживание дёрганой сети', () => {
  const ENEMY = 5;
  const ENEMY_STEP = 4;
  const FRAME_MS = 1000 / 60;
  const BURST_MS = 200;
  // Разгон: замер набирается, время чужих замедляется под новое отставание.
  const WARMUP_MS = 2000;

  function smoothPrediction(): FfaPrediction {
    return new FfaPrediction(OPEN_MAP, DEFAULT_RULES, STILL_ZONE, ME, setupOf, true);
  }

  // Чужой едет вдоль x на ENEMY_STEP за тик, свой стоит.
  function enemySnapshot(tick: number): FfaSnapshotMessage {
    const world = worldOf([placedTank(ME, 500, 600), placedTank(ENEMY, 300 + ENEMY_STEP * tick, 300)]);
    world.tick = tick;
    return snapshotOf(world);
  }

  function enemyX(view: FfaFrameView): number {
    return view.tanks.find((tank) => tank.id === ENEMY)?.x ?? NaN;
  }

  // Снимок тика k уходит в k·33,3 мс, сеть отдаёт его на ближайшей границе пачек; кадры — 60 в секунду.
  function burstyEnemyFrames(client: FfaPrediction, durationMs: number): number[] {
    const xs: number[] = [];
    let nextTick = 1;
    for (let now = 0; now <= durationMs; now += FRAME_MS) {
      while (Math.ceil((nextTick * TICK_MS) / BURST_MS - 1e-9) * BURST_MS <= now) {
        client.applySnapshot(enemySnapshot(nextTick), now);
        nextTick++;
      }
      xs.push(enemyX(client.view(now)));
    }
    return xs;
  }

  it('ровные снимки — чужой и тик чужих как без сглаживания', () => {
    const plain = prediction();
    const smooth = smoothPrediction();
    for (let tick = 1; tick <= 60; tick++) {
      const snapshot = enemySnapshot(tick);
      plain.applySnapshot(snapshot, tick * TICK_MS);
      smooth.applySnapshot(snapshot, tick * TICK_MS);
      for (const offset of [1, TICK_MS / 2]) {
        const now = tick * TICK_MS + offset;
        const [a, b] = [plain.view(now), smooth.view(now)];
        if (tick > 3) {
          expect(b.clock.othersTick).toBeCloseTo(a.clock.othersTick, 6);
          expect(enemyX(b)).toBeCloseTo(enemyX(a), 6);
        }
      }
    }
    expect(smooth.interpolationTicks).toBe(2);
  });

  it('пачки раз в 200 мс — чужой едет в каждом кадре без прыжков; без сглаживания стоит и прыгает', () => {
    const frameStep = (ENEMY_STEP * FRAME_MS) / TICK_MS;
    const stepsAfterWarmup = (xs: number[]): number[] =>
      xs
        .slice(Math.ceil(WARMUP_MS / FRAME_MS))
        .flatMap((x, index, rest) => (index === 0 ? [] : [x - (rest[index - 1] ?? x)]));
    const smooth = smoothPrediction();
    const smoothSteps = stepsAfterWarmup(burstyEnemyFrames(smooth, 5000));
    expect(Math.min(...smoothSteps)).toBeGreaterThan(0);
    expect(Math.max(...smoothSteps)).toBeLessThanOrEqual(1.5 * frameStep);
    expect(smooth.interpolationTicks).toBeGreaterThan(6);
    const plainSteps = stepsAfterWarmup(burstyEnemyFrames(prediction(), 5000));
    expect(plainSteps.filter((step) => step === 0).length).toBeGreaterThan(plainSteps.length / 4);
    expect(Math.max(...plainSteps)).toBeGreaterThan(3 * frameStep);
  });

  // Снимки до PAUSE_FROM_MS сеть отдаёт по arrival, отправленные за паузу — разом в её конце; на каждом снимке —
  // выстрел чужого и искра в поле рядом с ним. Счёт: сколько событий не вышло и наибольшее отставание тика чужих
  // от последнего снимка.
  const PAUSE_FROM_MS = 3000;
  const PAUSE_MS = 700;
  const PAUSE_RUN_MS = 6000;

  function eventsThroughPause(arrival: (tick: number) => number): { lost: number; worstBehind: number } {
    const client = smoothPrediction();
    const schedule = new EventSchedule<FfaSnapshotEvent>();
    const delivered = (tick: number): number => {
      const sentAt = tick * TICK_MS;
      const isInPause = sentAt >= PAUSE_FROM_MS && sentAt < PAUSE_FROM_MS + PAUSE_MS;
      return isInPause ? Math.max(arrival(tick), PAUSE_FROM_MS + PAUSE_MS) : arrival(tick);
    };
    let nextTick = 1;
    let added = 0;
    let released = 0;
    let worstBehind = 0;
    for (let now = 0; now <= PAUSE_RUN_MS + 1000; now += FRAME_MS) {
      while (nextTick * TICK_MS <= PAUSE_RUN_MS && delivered(nextTick) <= now) {
        const message = enemySnapshot(nextTick);
        client.applySnapshot(message, now);
        const enemy = message.tanks.find((tank) => tank.id === ENEMY) ?? null;
        const at = { x: enemy?.x ?? NaN, y: enemy?.y ?? NaN };
        const shot: FfaSnapshotEvent = { kind: 'shot', tank: ENEMY, by: null, ...at, value: 0, dx: 1, dy: 0, flags: 0 };
        const spark: FfaSnapshotEvent = { ...shot, kind: 'impact', tank: null, y: at.y + 40 };
        schedule.add(shot, message.tick, eventPlace('shot', enemy, ME), now);
        schedule.add(spark, message.tick, eventPlace('impact', null, ME), now);
        added += 2;
        nextTick++;
      }
      const view = client.view(now);
      worstBehind = Math.max(worstBehind, client.latestTick - view.clock.othersTick);
      const drawnTank = (id: number): FfaFrameView['tanks'][number] | null =>
        view.tanks.find((tank) => tank.id === id) ?? null;
      released += schedule.release(view.clock, drawnTank, now).length;
    }
    return { lost: added - released, worstBehind };
  }

  it('пауза снимков 700 мс на ровной и ночной сети — события о чужих не теряются, чужие не отстают за предел', () => {
    const even = eventsThroughPause((tick) => tick * TICK_MS + 5);
    const night = eventsThroughPause((tick) => Math.ceil((tick * TICK_MS) / 250 - 1e-9) * 250);
    for (const run of [even, night]) {
      expect(run.lost).toBe(0);
      expect(run.worstBehind).toBeLessThanOrEqual(PLAYOUT_MAX_BEHIND_TICKS);
    }
  });

  it('отсчёт с тиком матча 0: тик чужих 0, отставание считается по тику игры', () => {
    const client = smoothPrediction();
    for (let gameTick = 1; gameTick <= 30; gameTick++) {
      const world = worldOf([placedTank(ME, 500, 600), placedTank(ENEMY, 300, 300)]);
      client.applySnapshot(snapshotOf(world, { gameTick }), gameTick * TICK_MS);
      expect(client.view(gameTick * TICK_MS + 1).clock.othersTick).toBe(0);
    }
    expect(client.interpolationTicks).toBe(2);
  });

  it('поправка своего танка: в миг снимка танк на прежнем месте, за 120 мс догоняет предсказанный', () => {
    const server = worldOf([placedTank(ME, 500, 600), placedTank(ENEMY, 900, 600)]);
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    const client = smoothPrediction();
    client.applySnapshot(snapshotOf(server), 0);
    const ownX = (now: number): number => client.view(now).tanks.find((tank) => tank.id === ME)?.x ?? NaN;
    expect(ownX(10)).toBe(500);
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    meOf(server).x += 50;
    client.applySnapshot(snapshotOf(server), 100);
    expect(client.me?.x).toBe(550);
    expect(ownX(100)).toBeCloseTo(500, 9);
    expect(client.view(100).clock.ownShift?.x).toBeCloseTo(-50, 9);
    expect(client.view(100).clock.me?.x).toBe(550);
    expect(ownX(160)).toBeCloseTo(525, 9);
    expect(ownX(220)).toBeCloseTo(550, 9);
    expect(client.view(220).clock.me?.x).toBeCloseTo(550, 9);
  });

  it('свой танк ушёл с поля — смещение сразу ноль', () => {
    const server = worldOf([placedTank(ME, 500, 600), placedTank(ENEMY, 900, 600)]);
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    const client = smoothPrediction();
    client.applySnapshot(snapshotOf(server), 0);
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    meOf(server).x += 50;
    client.applySnapshot(snapshotOf(server), 100);
    expect(client.view(110).clock.ownShift?.x).not.toBe(0);
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    meOf(server).isAlive = false;
    client.applySnapshot(snapshotOf(server), 133);
    expect(client.view(140).clock.ownShift).toEqual({ x: 0, y: 0 });
  });

  it('чужой снаряд у своего танка в остатке смещения: на картинке до танка — как в предсказании, касание в том же кадре', () => {
    const shooterFiresOnce = (id: number, tick: number): Action =>
      id === ENEMY && tick === 1 ? AIM_AT_ME : IDLE_ACTION;
    const tanks = (): Tank[] => [placedTank(ME, 600, 600), placedTank(ENEMY, 1300, 600, Math.PI)];
    const base = playPicture({ tanks: tanks(), lag: 5, ticks: 70, otherAction: shooterFiresOnce });
    const hitTick = [...base.history.entries()].find(([, entry]) => entry.hitsOnMe > 0)?.[0] ?? NaN;
    const nudge = (world: World, tick: number): void => {
      if (tick === hitTick - 6) {
        meOf(world).y += 6;
      }
    };
    const scenario = { tanks: tanks(), lag: 5, ticks: 70, otherAction: shooterFiresOnce, disturb: nudge };
    const plain = playPicture(scenario);
    const smooth = playPicture({ ...scenario, tanks: tanks(), hasNetSmoothing: true });
    const touchOf = (frames: readonly PictureFrame[]): number => frames.findIndex((frame) => frame.ownHits.length > 0);
    const touch = touchOf(plain.frames);
    expect(touch).toBeGreaterThan(0);
    expect(touchOf(smooth.frames)).toBe(touch);
    let nearChecks = 0;
    for (const [index, frame] of smooth.frames.entries()) {
      const plainFrame = plain.frames[index];
      const drawn = drawnMe(frame.view.clock);
      const predicted = plainFrame?.view.clock.me ?? null;
      if (drawn === null || predicted === null) {
        continue;
      }
      for (const bullet of frame.view.bullets.filter((candidate) => distance(candidate, drawn) <= PICTURE_NEAR)) {
        const twin = plainFrame?.view.bullets.find((candidate) => candidate.id === bullet.id);
        expect(bullet.x - drawn.x).toBeCloseTo((twin?.x ?? NaN) - predicted.x, 6);
        expect(bullet.y - drawn.y).toBeCloseTo((twin?.y ?? NaN) - predicted.y, 6);
        nearChecks++;
      }
    }
    expect(nearChecks).toBeGreaterThan(0);
    const touchFrame = smooth.frames[touch];
    const drawnAtTouch = (touchFrame === undefined ? null : drawnMe(touchFrame.view.clock)) ?? { x: NaN, y: NaN };
    const predictedAtTouch = plain.frames[touch]?.view.clock.me ?? { x: NaN, y: NaN };
    expect(distance(drawnAtTouch, predictedAtTouch)).toBeGreaterThan(1);
    expect(distance(touchFrame?.ownHits[0]?.event ?? drawnAtTouch, drawnAtTouch)).toBeLessThan(
      TANK_RADIUS + BULLET_RADIUS,
    );
  });
});

describe('свой выстрел по предсказанию', () => {
  const FAR_ENEMY = 5;

  interface ShotSetup {
    server: World;
    client: FfaPrediction;
    serve: (action: Action, ackSeq: number) => FfaSnapshotEvent[];
  }

  // Свой танк и враг вдали; serve — шаг сервера с командой своего танка и снимок с его событиями; результат — выстрелы
  // своего танка в снимке.
  function setup(tanks: Tank[], rules: RoundRules = DEFAULT_RULES): ShotSetup {
    const server = createWorld(OPEN_MAP, tanks, rules, STILL_ZONE);
    const tracker = new BulletTracker();
    stepWorld(server, actionsFor(server, IDLE_ACTION));
    const client = new FfaPrediction(OPEN_MAP, rules, STILL_ZONE, ME, setupOf);
    client.applySnapshot(snapshotOf(server, { changes: tracker.diff(server.bullets) }), 0);
    const serve = (action: Action, ackSeq: number): FfaSnapshotEvent[] => {
      const events = stepWorld(server, actionsFor(server, action));
      const message = snapshotOf(server, {
        ackSeq,
        changes: tracker.diff(server.bullets),
        events: events.map(toFfaSnapshotEvent),
      });
      client.applySnapshot(message, server.tick * TICK_MS);
      return message.events.filter((event) => event.kind === 'shot' && event.tank === ME);
    };
    return { server, client, serve };
  }

  function openField(): Tank[] {
    return [placedTank(ME, 500, 600), placedTank(FAR_ENEMY, 1500, 900)];
  }

  it('C24 выстрел — в шаге ввода у дула, один раз; переигрывания не повторяют; снимок с выстрелом его не играет', () => {
    const { client, serve } = setup(openField());
    client.predict(1, IDLE_ACTION);
    client.predict(2, FIRE);
    expect(client.view(100).bullets.some((bullet) => bullet.id === PREDICTED_BULLET_ID_BASE + 2)).toBe(true);
    const shots = client.takeOwnShots();
    expect(shots).toHaveLength(1);
    expect(shots[0]?.event).toMatchObject({ kind: 'shot', tank: ME, y: 600, dx: 1, dy: 0 });
    expect(shots[0]?.event.x).toBeCloseTo(500 + MUZZLE_OFFSET, 9);
    for (let seq = 3; seq <= 5; seq++) {
      client.predict(seq, IDLE_ACTION);
    }
    expect(serve(IDLE_ACTION, 1)).toEqual([]);
    expect(client.takeOwnShots()).toEqual([]);
    const served = serve(FIRE, 2);
    expect(served).toHaveLength(1);
    expect(served.every((event) => client.wasShotPlayed(event))).toBe(true);
    expect(client.takeOwnShots()).toEqual([]);
    expect(client.ownShotCounts).toEqual({ played: 1, confirmed: 1, unconfirmed: 0 });
  });

  it('C25 сервер подтвердил команду без выстрела — после перезарядки неподтверждённый, второй вспышки нет', () => {
    const { client, serve } = setup(openField());
    client.predict(1, FIRE);
    expect(client.takeOwnShots()).toHaveLength(1);
    for (let seq = 2; seq <= 20; seq++) {
      client.predict(seq, IDLE_ACTION);
    }
    for (let ackSeq = 1; ackSeq <= 16; ackSeq++) {
      expect(serve(IDLE_ACTION, ackSeq)).toEqual([]);
      expect(client.takeOwnShots()).toEqual([]);
    }
    expect(client.ownShotCounts).toEqual({ played: 1, confirmed: 0, unconfirmed: 1 });
  });

  it('C25 перезарядка на сервере дольше — переигрывание переносит выстрел, вспышка одна, выстрел снимка сыгран', () => {
    const { server, client, serve } = setup(openField());
    client.predict(1, IDLE_ACTION);
    for (let seq = 2; seq <= 6; seq++) {
      client.predict(seq, FIRE);
    }
    expect(client.takeOwnShots()).toHaveLength(1);
    meOf(server).reloadLeft = 2.5 * DT;
    serve(IDLE_ACTION, 1);
    expect(client.view(200).bullets.some((bullet) => bullet.id === PREDICTED_BULLET_ID_BASE + 2)).toBe(false);
    expect(client.takeOwnShots()).toEqual([]);
    let served = 0;
    let played = 0;
    for (let seq = 2; seq <= 4; seq++) {
      const shots = serve(FIRE, seq);
      served += shots.length;
      played += shots.filter((event) => client.wasShotPlayed(event)).length;
    }
    expect([served, played]).toEqual([1, 1]);
    expect(client.takeOwnShots()).toEqual([]);
    expect(client.ownShotCounts).toEqual({ played: 1, confirmed: 1, unconfirmed: 0 });
  });

  it('C25 сервер выстрелил повтором прошлой команды до подтверждения сыгранной — снимок не играет, позже ничего', () => {
    const { client, serve } = setup(openField());
    client.predict(1, FIRE);
    expect(client.takeOwnShots()).toHaveLength(1);
    const early = serve(FIRE, 0);
    expect(early).toHaveLength(1);
    expect(early.every((event) => client.wasShotPlayed(event))).toBe(true);
    expect(serve(FIRE, 1)).toEqual([]);
    expect(client.takeOwnShots()).toEqual([]);
    expect(client.ownShotCounts).toEqual({ played: 1, confirmed: 1, unconfirmed: 0 });
  });

  it('C25 сервер подбил танк раньше сыгранного выстрела, танк возродился — первый выстрел со вспышкой', () => {
    const { server, client, serve } = setup(openField());
    client.predict(1, FIRE);
    expect(client.takeOwnShots()).toHaveLength(1);
    meOf(server).isAlive = false;
    meOf(server).hp = 0;
    expect(serve(IDLE_ACTION, 1)).toEqual([]);
    meOf(server).isAlive = true;
    meOf(server).hp = meOf(server).stats.maxHp;
    serve(IDLE_ACTION, 1);
    client.predict(2, FIRE);
    expect(client.takeOwnShots()).toHaveLength(1);
    const served = serve(FIRE, 2);
    expect(served).toHaveLength(1);
    expect(served.every((event) => client.wasShotPlayed(event))).toBe(true);
    expect(client.ownShotCounts).toEqual({ played: 2, confirmed: 1, unconfirmed: 1 });
  });

  it('C25 сервер выстрелил без сыгранного по предсказанию — выстрел снимка играется', () => {
    const { client, serve } = setup(openField());
    client.predict(1, IDLE_ACTION);
    const served = serve(FIRE, 0);
    expect(served).toHaveLength(1);
    expect(served.some((event) => client.wasShotPlayed(event))).toBe(false);
  });

  it('C25 в упор с догоном — снаряд погас в шаге рождения; дуло в стене — снаряда нет; выстрел сыгран один раз', () => {
    const rules: RoundRules = { ...DEFAULT_RULES, shotLeadTicks: 2 };
    const pointBlank = setup([placedTank(ME, 500, 600), placedTank(FAR_ENEMY, 500 + 2 * TANK_RADIUS + 20, 600)], rules);
    pointBlank.client.predict(1, FIRE);
    expect(pointBlank.client.view(100).bullets.filter((bullet) => bullet.owner === ME)).toEqual([]);
    expect(pointBlank.client.takeOwnShots()).toHaveLength(1);
    pointBlank.client.predict(2, IDLE_ACTION);
    expect(pointBlank.serve(IDLE_ACTION, 0)).toEqual([]);
    expect(pointBlank.client.takeOwnShots()).toEqual([]);
    const served = pointBlank.serve(FIRE, 1);
    expect(served.every((event) => pointBlank.client.wasShotPlayed(event))).toBe(true);

    const walled = setup([placedTank(ME, TANK_RADIUS + 2, 600, Math.PI), placedTank(FAR_ENEMY, 1500, 900)]);
    walled.client.predict(1, FIRE);
    expect(walled.client.view(100).bullets.filter((bullet) => bullet.owner === ME)).toEqual([]);
    expect(walled.client.takeOwnShots()).toHaveLength(1);
    walled.client.predict(2, IDLE_ACTION);
    walled.serve(IDLE_ACTION, 0);
    expect(walled.client.takeOwnShots()).toEqual([]);
  });

  it('C26 выстрел найден переигрыванием, вкладка скрыта: не играется ни по досчёту, ни по снимку', () => {
    const { server, client, serve } = setup(openField());
    meOf(server).reloadLeft = 10 * DT;
    serve(IDLE_ACTION, 0);
    for (let seq = 1; seq <= 3; seq++) {
      client.predict(seq, FIRE);
    }
    expect(client.takeOwnShots()).toEqual([]);
    meOf(server).reloadLeft = 0;
    serve(IDLE_ACTION, 0);
    client.discardOwnShots();
    expect(client.takeOwnShots()).toEqual([]);
    const served = serve(FIRE, 1);
    expect(served).toHaveLength(1);
    expect(served.every((event) => client.wasShotPlayed(event))).toBe(true);
    expect(client.ownShotCounts.played).toBe(0);
  });

  it('C25 новое соединение: несверенный выстрел забыт, выстрел снимка нового соединения играется', () => {
    const { client, serve } = setup(openField());
    client.predict(1, FIRE);
    client.takeOwnShots();
    client.resetConnection();
    const served = serve(FIRE, 0);
    expect(served).toHaveLength(1);
    expect(served.some((event) => client.wasShotPlayed(event))).toBe(false);
  });
});

describe('чем стреляет танк', () => {
  it('M8 скорость орудия — из характеристик танка, у ушедшего — из состава; доля сноса — из правил игры', () => {
    const gunner: Stats = { ...DEFAULT_STATS, gun: DEFAULT_STATS.gun + 2 };
    const setups = (id: number): { name: string; stats: Stats } => ({
      name: `Т${String(id)}`,
      stats: id === 5 ? gunner : DEFAULT_STATS,
    });
    const client = new FfaPrediction(OPEN_MAP, { ...DEFAULT_RULES, shotInheritPercent: 100 }, STILL_ZONE, ME, setups);
    expect(client.shotOf(5)).toEqual({ bulletSpeed: deriveStats(gunner).bulletSpeed, shotInheritPercent: 100 });
    expect(client.shotOf(ME)).toEqual({
      bulletSpeed: deriveStats(DEFAULT_STATS).bulletSpeed,
      shotInheritPercent: 100,
    });
  });
});
