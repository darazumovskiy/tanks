import { describe, expect, it } from 'vitest';
import {
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
  type Action,
  type Tank,
  type World,
  type ZonePlan,
} from '@tanks/shared/engine';
import { BulletTracker, bulletSnapshot, toFfaSnapshotEvent } from '@tanks/shared/protocol';
import { OPEN_MAP, placedTank, snapshotOf } from '../testing/ffaServer.js';
import { FfaPrediction, PREDICTED_BULLET_ID_BASE } from './ffaPrediction.js';

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
      const byId = (a: { id: number }, b: { id: number }): number => a.id - b.id;
      const theirs = view.bullets.filter((bullet) => bullet.owner !== ME).sort(byId);
      const serverTheirs = match.world.bullets
        .filter((bullet) => bullet.owner !== ME)
        .map((bullet) => ({ id: bullet.id, owner: bullet.owner, x: bullet.x, y: bullet.y }))
        .sort(byId);
      expect(theirs).toEqual(serverTheirs);
      const serverIds = new Set(match.world.bullets.map((bullet) => bullet.id));
      const largestServerId = Math.max(0, ...serverIds);
      for (const bullet of view.bullets.filter((candidate) => candidate.owner === ME)) {
        expect(serverIds.has(bullet.id) || bullet.id > largestServerId).toBe(true);
        ownChecks++;
      }
    }
    expect(ownChecks).toBeGreaterThan(0);
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
    expect(theirs).toEqual([{ id: server.bullets[0]?.id, owner: 5, x: server.bullets[0]?.x, y: server.bullets[0]?.y }]);
  });
});
