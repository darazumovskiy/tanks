import { describe, expect, it } from 'vitest';
import {
  BULLET_RADIUS,
  createRound,
  DEFAULT_RULES,
  DEFAULT_STATS,
  IDLE_ACTION,
  stepRound,
  TANK_RADIUS,
  type Action,
  type Round,
  type Side,
} from '@tanks/shared/engine';
import { MessageType, type SnapshotMessage } from '@tanks/shared/protocol';
import { PICTURE_NEAR, pictureTickAt } from './pictureTime.js';
import { PREDICTED_BULLET_ID_BASE } from './predictedShots.js';
import { Prediction, type PictureView } from './prediction.js';

const TICK_MS = 1000 / 30;
const MAP_INDEX = 0;
const ME: Side = 0;
const FIRE: Action = { ...IDLE_ACTION, isFiring: true };
// На верхней полосе «Полигона» между танками стен нет; первые команды — покой, как у сервера без команд.
const LANE_ME = { x: 240, y: 100, heading: Math.PI / 2, turret: 0 };
const LANE_ENEMY = { x: 1180, y: 100, heading: Math.PI, turret: Math.PI };
const WARMUP_SEQ = 8;
const SETUPS: [{ nickname: string; stats: typeof DEFAULT_STATS }, { nickname: string; stats: typeof DEFAULT_STATS }] = [
  { nickname: 'Дима', stats: DEFAULT_STATS },
  { nickname: 'Бублик', stats: DEFAULT_STATS },
];

function laneRound(): Round {
  const round = createRound(MAP_INDEX, [
    { name: SETUPS[0].nickname, stats: DEFAULT_STATS },
    { name: SETUPS[1].nickname, stats: DEFAULT_STATS },
  ]);
  Object.assign(round.tanks[0], LANE_ME, { hp: 100_000 });
  Object.assign(round.tanks[1], LANE_ENEMY);
  return round;
}

function snapshotOf(round: Round, ackSeq: number): SnapshotMessage {
  return {
    type: MessageType.Snapshot,
    tick: round.tick,
    gameTick: round.tick,
    ackSeq,
    hasSpareInput: false,
    isOver: round.isOver,
    winner: round.winner,
    endReason: round.endReason,
    zoneRadius: round.zone.radius,
    tanks: [0, 1].map((side) => {
      const tank = round.tanks[side === 0 ? 0 : 1];
      return {
        x: tank.x,
        y: tank.y,
        heading: tank.heading,
        turret: tank.turret,
        speed: tank.speed,
        hp: tank.hp,
        reloadLeft: tank.reloadLeft,
        isAlive: tank.isAlive,
      };
    }) as SnapshotMessage['tanks'],
    bullets: round.bullets.map((bullet) => ({
      id: bullet.id,
      owner: bullet.owner === 0 ? 0 : 1,
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
      bouncesLeft: bullet.bouncesLeft,
      hasBounced: bullet.hasBounced,
      age: bullet.age,
    })),
    kits: round.kits.map((kit) => ({ isActive: kit.isActive, respawnIn: kit.respawnIn })),
    events: [],
  };
}

interface DuelTick {
  bullets: Map<number, { x: number; y: number }>;
  me: { x: number; y: number };
  hits: Side[];
}

interface DuelFrame {
  latestTick: number;
  view: PictureView;
}

// Дуэль на верхней полосе: сервер применяет свою команду с отставанием lag, противник стреляет по enemyAction;
// снимок тика, для которого isSnapshotHeld — true, приходит вместе со следующим.
function playDuel(
  lag: number,
  ticks: number,
  myAction: (seq: number) => Action,
  enemyAction: (tick: number) => Action,
  prepare: (round: Round) => void = (): void => undefined,
  isSnapshotHeld: (tick: number) => boolean = (): boolean => false,
): { frames: DuelFrame[]; history: Map<number, DuelTick>; prediction: Prediction } {
  const server = laneRound();
  prepare(server);
  const prediction = new Prediction(ME, MAP_INDEX, SETUPS, 0, DEFAULT_RULES);
  const record = (hits: Side[]): DuelTick => ({
    bullets: new Map(server.bullets.map((bullet) => [bullet.id, { x: bullet.x, y: bullet.y }])),
    me: { x: server.tanks[0].x, y: server.tanks[0].y },
    hits,
  });
  const action = (seq: number): Action => (seq <= WARMUP_SEQ ? IDLE_ACTION : myAction(seq));
  prediction.applySnapshot(snapshotOf(server, 0), 0);
  const history = new Map<number, DuelTick>([[server.tick, record([])]]);
  const frames: DuelFrame[] = [];
  const held: SnapshotMessage[] = [];
  let latestTick = server.tick;
  for (let tick = 1; tick <= ticks + lag; tick++) {
    if (tick <= ticks) {
      prediction.predict(action(tick));
    }
    const seq = tick - lag;
    const events = stepRound(server, [seq >= 1 ? action(seq) : IDLE_ACTION, enemyAction(tick)]);
    const hits = events.flatMap((event): Side[] => (event.type === 'hit' ? [event.tank as Side] : []));
    history.set(server.tick, record([...(history.get(server.tick)?.hits ?? []), ...hits]));
    if (tick > ticks) {
      continue;
    }
    held.push(snapshotOf(server, Math.max(0, seq)));
    if (!isSnapshotHeld(tick)) {
      for (const message of held.splice(0)) {
        prediction.applySnapshot(message, tick * TICK_MS);
        latestTick = message.tick;
      }
    }
    for (const offset of [1, TICK_MS / 2]) {
      frames.push({ latestTick, view: prediction.view(tick * TICK_MS + offset) });
    }
  }
  return { frames, history, prediction };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('дуэль: картинка совпадает с сервером', () => {
  for (const lag of [0, 4, 5]) {
    it(`снаряд противника у своего танка — в его тике и на месте сервера, ${String(lag)} неподтверждённых`, () => {
      const { frames, history } = playDuel(
        lag,
        120,
        (seq) => ({ ...IDLE_ACTION, throttle: Math.floor(seq / 15) % 2 === 0 ? 1 : -1, turn: 0 }),
        () => FIRE,
        (round) => {
          round.tanks[0].heading = 0;
        },
      );
      let near = 0;
      for (const { latestTick, view } of frames) {
        const { me, myTick } = view.clock;
        if (me === null) {
          continue;
        }
        const truth = history.get(myTick);
        expect(distance(me, truth?.me ?? { x: NaN, y: NaN })).toBeLessThan(1e-6);
        for (const bullet of view.bullets) {
          if (bullet.tick <= latestTick) {
            expect(history.get(Math.ceil(bullet.tick))?.bullets.has(bullet.id)).toBe(true);
          }
          if (bullet.owner === ME || distance(bullet, me) > PICTURE_NEAR) {
            continue;
          }
          expect(bullet.tick).toBe(myTick);
          expect(distance(bullet, truth?.bullets.get(bullet.id) ?? { x: NaN, y: NaN })).toBeLessThan(1e-6);
          near++;
        }
      }
      expect(near).toBeGreaterThan(3);
    });
  }

  it('снаряд противника у противника — в его тике', () => {
    const { frames } = playDuel(
      4,
      30,
      () => IDLE_ACTION,
      (tick) => (tick === 1 ? FIRE : IDLE_ACTION),
    );
    const atEnemy = frames.flatMap(({ view }) =>
      view.bullets.filter((bullet) => distance(bullet, view.tanks[1]) <= PICTURE_NEAR).map((bullet) => [bullet, view]),
    );
    expect(atEnemy.length).toBeGreaterThan(0);
    for (const [bullet, view] of atEnemy as [{ tick: number }, PictureView][]) {
      expect(bullet.tick).toBe(view.clock.othersTick);
    }
  });

  it('свой выстрел: номер от команды до подтверждения, затем один снаряд с номером сервера и парой для хвоста', () => {
    const fireSeq = WARMUP_SEQ + 1;
    const { frames, prediction } = playDuel(
      4,
      WARMUP_SEQ + 12,
      (seq) => (seq === fireSeq ? FIRE : IDLE_ACTION),
      () => IDLE_ACTION,
    );
    const ownIds = frames.map(({ view }) => view.bullets.filter((bullet) => bullet.owner === ME).map((b) => b.id));
    const predicted = ownIds.findIndex((ids) => ids.includes(PREDICTED_BULLET_ID_BASE + fireSeq));
    expect(predicted).toBeGreaterThanOrEqual(0);
    expect(ownIds.at(-1)).toHaveLength(1);
    expect(ownIds.at(-1)?.[0]).toBeLessThan(PREDICTED_BULLET_ID_BASE);
    expect(ownIds.every((ids) => ids.length <= 1)).toBe(true);
    expect(prediction.takeConfirmedBullets()).toEqual([
      { predictedId: PREDICTED_BULLET_ID_BASE + fireSeq, serverId: ownIds.at(-1)?.[0] },
    ]);
    expect(prediction.takeConfirmedBullets()).toEqual([]);
  });

  it('своя гибель: убивший снаряд не появляется снова, ни один снаряд и тик своего танка не идут назад', () => {
    const { frames, history } = playDuel(
      4,
      60,
      () => IDLE_ACTION,
      (tick) => (tick === 1 ? FIRE : IDLE_ACTION),
      (round) => {
        round.tanks[0].hp = 1;
        round.tanks[1].x = LANE_ME.x + 300;
      },
    );
    const killTick = [...history.entries()].find(([, entry]) => entry.hits.includes(ME))?.[0] ?? NaN;
    const killerId = [...(history.get(killTick - 1)?.bullets.keys() ?? [])].find(
      (id) => !(history.get(killTick)?.bullets.has(id) ?? true),
    );
    expect(killerId).toBeDefined();
    for (let index = 1; index < frames.length; index++) {
      const before = frames[index - 1]?.view;
      const now = frames[index]?.view;
      expect(now?.clock.myTick).toBeGreaterThanOrEqual((before?.clock.myTick ?? 0) - 1e-9);
      for (const bullet of now?.bullets ?? []) {
        const previous = before?.bullets.find((candidate) => candidate.id === bullet.id);
        expect(bullet.tick).toBeGreaterThanOrEqual((previous?.tick ?? -Infinity) - 1e-9);
      }
    }
    const presence = frames.map(({ view }) => view.bullets.some((bullet) => bullet.id === killerId));
    const firstHidden = presence.indexOf(false, presence.indexOf(true));
    expect(firstHidden).toBeGreaterThan(0);
    expect(presence.indexOf(true, firstHidden)).toBe(-1);
    expect(frames.at(-1)?.view.clock.me).toBeNull();
  });

  // Противник смотрит на свой танк и трогается незадолго до выстрела.
  const ENEMY_START_TICK = 12;
  const ENEMY_MOVES = [
    { name: 'стоит', throttle: 0 },
    { name: 'уезжает задним ходом', throttle: -1 },
    { name: 'едет навстречу', throttle: 1 },
  ];
  for (const move of ENEMY_MOVES) {
    for (const gap of [90, 120, 160, 200]) {
      it(`свой выстрел по противнику в ${String(gap)}, противник ${move.name}: снаряд не входит в корпус, не идёт назад, гаснет на броне в кадре вспышки`, () => {
        const fireSeq = WARMUP_SEQ + 4;
        const runs = [3, 4, 5, 6].flatMap((lag) => [
          { lag, isPaired: false },
          { lag, isPaired: true },
        ]);
        for (const { lag, isPaired } of runs) {
          const { frames, history } = playDuel(
            lag,
            60,
            (seq) => (seq === fireSeq ? FIRE : IDLE_ACTION),
            (tick) => ({ ...IDLE_ACTION, throttle: tick >= ENEMY_START_TICK ? move.throttle : 0 }),
            (round) => {
              Object.assign(round.tanks[1], { x: LANE_ME.x + gap, hp: 100_000 });
            },
            (tick) => isPaired && tick % 2 === 0,
          );
          const hitTick = [...history.entries()].find(([, entry]) => entry.hits.includes(1))?.[0] ?? NaN;
          expect(hitTick).toBeGreaterThan(0);
          const shotFrame = frames.findIndex(({ view }) => view.bullets.some((bullet) => bullet.owner === ME));
          expect(shotFrame).toBeGreaterThan(0);
          let previous: { bullet: { x: number; y: number }; enemy: { x: number; y: number } } | null = null;
          for (const { view } of frames.slice(shotFrame)) {
            const enemy = view.tanks[1];
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
});
