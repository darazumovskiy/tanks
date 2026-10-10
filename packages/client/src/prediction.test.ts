import { describe, expect, it } from 'vitest';
import {
  BULLET_RADIUS,
  createRound,
  DEFAULT_RULES,
  DEFAULT_STATS,
  deriveStats,
  DT,
  IDLE_ACTION,
  MUZZLE_OFFSET,
  stepRound,
  TANK_RADIUS,
  type Action,
  type Round,
  type RoundRules,
  type Side,
} from '@tanks/shared/engine';
import { MessageType, toSnapshotEvent, type SnapshotEvent, type SnapshotMessage } from '@tanks/shared/protocol';
import { PICTURE_NEAR, pictureTickAt } from './pictureTime.js';
import { PREDICTED_BULLET_ID_BASE, UNPAIRED_SHOT_TICKS } from './predictedShots.js';
import { Prediction, type PictureView } from './prediction.js';

const TICK_MS = 1000 / 30;
const MAP_INDEX = 0;
const ME: Side = 0;
const FIRE: Action = { ...IDLE_ACTION, isFiring: true };
// На верхней полосе «Полигона» между танками стен нет; первые команды — покой, как у сервера без команд.
const LANE_ME = { x: 240, y: 100, heading: Math.PI / 2, turret: 0 };
const LANE_ENEMY = { x: 1180, y: 100, heading: Math.PI, turret: Math.PI };
const WARMUP_SEQ = 8;
// Сервер стреляет за подтверждённую повтором команду, когда она дошла после паузы, — шагами позже.
const SERVER_FIRE_DELAY = 3;
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
// снимок тика, для которого isSnapshotHeld — true, приходит вместе со следующим. serverAction — что сервер сделал
// за подтверждённую команду: повтор в паузе связи подтверждает команду, которой ещё не видел.
function playDuel(
  lag: number,
  ticks: number,
  myAction: (seq: number) => Action,
  enemyAction: (tick: number) => Action,
  prepare: (round: Round) => void = (): void => undefined,
  isSnapshotHeld: (tick: number) => boolean = (): boolean => false,
  serverAction: (seq: number, sent: Action) => Action = (_seq, sent): Action => sent,
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
    const events = stepRound(server, [seq >= 1 ? serverAction(seq, action(seq)) : IDLE_ACTION, enemyAction(tick)]);
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

  it('пауза связи: команда выстрела подтверждена повтором раньше снаряда сервера — свой снаряд не пропадает, пара есть', () => {
    const fireSeq = WARMUP_SEQ + 1;
    const lateFireSeq = fireSeq + SERVER_FIRE_DELAY;
    const { frames, prediction } = playDuel(
      4,
      WARMUP_SEQ + 20,
      (seq) => (seq === fireSeq ? FIRE : IDLE_ACTION),
      () => IDLE_ACTION,
      undefined,
      undefined,
      (seq, sent) => {
        if (seq === fireSeq) {
          return IDLE_ACTION;
        }
        return seq === lateFireSeq ? FIRE : sent;
      },
    );
    const ownIds = frames.map(({ view }) => view.bullets.filter((bullet) => bullet.owner === ME).map((b) => b.id));
    const first = ownIds.findIndex((ids) => ids.includes(PREDICTED_BULLET_ID_BASE + fireSeq));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(ownIds.slice(first).every((ids) => ids.length === 1)).toBe(true);
    const serverId = ownIds.at(-1)?.[0];
    expect(serverId).toBeLessThan(PREDICTED_BULLET_ID_BASE);
    expect(prediction.takeConfirmedBullets()).toEqual([{ predictedId: PREDICTED_BULLET_ID_BASE + fireSeq, serverId }]);
  });

  it('подтверждённый выстрел, которого сервер так и не сделал, — снаряд предсказания пропадает после ожидания пары', () => {
    const fireSeq = WARMUP_SEQ + 1;
    const { frames } = playDuel(
      4,
      WARMUP_SEQ + UNPAIRED_SHOT_TICKS + 10,
      (seq) => (seq === fireSeq ? FIRE : IDLE_ACTION),
      () => IDLE_ACTION,
      undefined,
      undefined,
      (seq, sent) => (seq === fireSeq ? IDLE_ACTION : sent),
    );
    const ownIds = frames.map(({ view }) => view.bullets.filter((bullet) => bullet.owner === ME).map((b) => b.id));
    expect(ownIds.some((ids) => ids.length === 1)).toBe(true);
    expect(ownIds.at(-1)).toEqual([]);
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

describe('дуэль: догон снаряда', () => {
  const LEAD_RULES: RoundRules = { ...DEFAULT_RULES, shotLeadTicks: 2 };
  const FIRE_SEQ = WARMUP_SEQ + 2;
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
      const server = createRound(
        MAP_INDEX,
        [
          { name: SETUPS[0].nickname, stats: DEFAULT_STATS },
          { name: SETUPS[1].nickname, stats: DEFAULT_STATS, isBot: true },
        ],
        LEAD_RULES,
      );
      Object.assign(server.tanks[0], LANE_ME);
      Object.assign(server.tanks[1], LANE_ENEMY);
      const prediction = new Prediction(ME, MAP_INDEX, SETUPS, 0, LEAD_RULES);
      prediction.applySnapshot(snapshotOf(server, 0), 0);
      const history = new Map<number, { x: number; y: number }>();
      const drawn: { id: number; tick: number; x: number; y: number }[] = [];
      for (let tick = 1; tick <= TICKS + lag; tick++) {
        if (tick <= TICKS) {
          prediction.predict(tick === FIRE_SEQ ? FIRE : IDLE_ACTION);
        }
        const seq = tick - lag;
        stepRound(server, [seq === FIRE_SEQ ? FIRE : IDLE_ACTION, IDLE_ACTION]);
        const own = server.bullets.find((bullet) => bullet.owner === ME);
        if (own !== undefined) {
          history.set(server.tick, { x: own.x, y: own.y });
        }
        if (tick > TICKS) {
          continue;
        }
        prediction.applySnapshot(snapshotOf(server, Math.max(0, seq)), tick * TICK_MS);
        const mine = prediction.view(tick * TICK_MS + 1).bullets.filter((bullet) => bullet.owner === ME);
        expect(mine.length).toBeLessThanOrEqual(1);
        drawn.push(...mine);
      }
      expect(drawn.length).toBeGreaterThan(TICKS / 2);
      expect(drawn.some((bullet) => bullet.id >= PREDICTED_BULLET_ID_BASE)).toBe(lag > 0);
      expect(drawn.at(-1)?.id).toBeLessThan(PREDICTED_BULLET_ID_BASE);
      for (const bullet of drawn) {
        const truth = serverAt(history, bullet.tick);
        expect(distance(bullet, truth)).toBeLessThan(1e-6);
      }
      const first = history.get(Math.min(...history.keys())) ?? { x: NaN, y: NaN };
      expect(distance(first, LANE_ME) - MUZZLE_OFFSET).toBeCloseTo(3 * deriveStats(DEFAULT_STATS).bulletSpeed * DT, 6);
    });
  }
});

describe('дуэль: снаряд со скоростью танка', () => {
  const RULES: RoundRules = { ...DEFAULT_RULES, shotInheritPercent: 100 };
  // Танк уже едет, а снаряд ещё проходит над стеной у верхней полосы.
  const FIRE_SEQ = WARMUP_SEQ + 2;
  const TICKS = 50;
  const GAS: Action = { ...IDLE_ACTION, throttle: 1 };
  const GAS_FIRE: Action = { ...GAS, isFiring: true };

  // Танк едет вниз по полосе, ствол смотрит вправо: выстрел — поперёк хода.
  function actionAt(seq: number): Action {
    if (seq <= 0) {
      return IDLE_ACTION;
    }
    return seq === FIRE_SEQ ? GAS_FIRE : GAS;
  }

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
    it(`свой выстрел на ходу — на месте серверного до и после подтверждения; ${String(lag)} неподтверждённых`, () => {
      const server = createRound(
        MAP_INDEX,
        [
          { name: SETUPS[0].nickname, stats: DEFAULT_STATS },
          { name: SETUPS[1].nickname, stats: DEFAULT_STATS, isBot: true },
        ],
        RULES,
      );
      Object.assign(server.tanks[0], LANE_ME);
      Object.assign(server.tanks[1], LANE_ENEMY);
      const prediction = new Prediction(ME, MAP_INDEX, SETUPS, 0, RULES);
      prediction.applySnapshot(snapshotOf(server, 0), 0);
      const history = new Map<number, { x: number; y: number }>();
      const drawn: { id: number; tick: number; x: number; y: number }[] = [];
      for (let tick = 1; tick <= TICKS + lag; tick++) {
        if (tick <= TICKS) {
          prediction.predict(actionAt(tick));
        }
        const seq = tick - lag;
        stepRound(server, [actionAt(seq), IDLE_ACTION]);
        const own = server.bullets.find((bullet) => bullet.owner === ME);
        if (own !== undefined) {
          expect(own.vy).toBeGreaterThan(0);
          history.set(server.tick, { x: own.x, y: own.y });
        }
        if (tick > TICKS) {
          continue;
        }
        prediction.applySnapshot(snapshotOf(server, Math.max(0, seq)), tick * TICK_MS);
        const mine = prediction.view(tick * TICK_MS + 1).bullets.filter((bullet) => bullet.owner === ME);
        expect(mine.length).toBeLessThanOrEqual(1);
        drawn.push(...mine);
      }
      expect(drawn.length).toBeGreaterThan(TICKS / 3);
      for (const bullet of drawn) {
        const truth = serverAt(history, bullet.tick);
        expect(distance(bullet, truth)).toBeLessThan(1e-6);
      }
    });
  }
});

describe('дуэль: попадание по своему танку по касанию', () => {
  const STATS = deriveStats(DEFAULT_STATS);
  const LAG = 4;
  const TICKS = 90;
  const ENEMY: Side = 1;

  interface TouchFrame {
    latestTick: number;
    view: PictureView;
    ownHits: SnapshotEvent[];
  }

  // wasPlayed — попадания по своему танку из снимков: сыграны ли уже касанием.
  interface TouchRun {
    frames: TouchFrame[];
    hitTick: number | null;
    wasPlayed: boolean[];
    prediction: Prediction;
  }

  // Противник на верхней полосе стреляет один раз в свой стоящий танк; снимки несут события тика, сервер применяет
  // свои команды на LAG тиков позже. disturb — вмешательство в раунд сервера перед шагом тика.
  function enemyShot(disturb: (round: Round, tick: number) => void = (): void => undefined): TouchRun {
    const server = laneRound();
    server.tanks[ME].hp = STATS.maxHp;
    const prediction = new Prediction(ME, MAP_INDEX, SETUPS, 0, DEFAULT_RULES);
    prediction.applySnapshot(snapshotOf(server, 0), 0);
    const frames: TouchFrame[] = [];
    const wasPlayed: boolean[] = [];
    let hitTick: number | null = null;
    for (let tick = 1; tick <= TICKS; tick++) {
      prediction.predict(IDLE_ACTION);
      disturb(server, tick);
      const events = stepRound(server, [IDLE_ACTION, tick === 1 ? FIRE : IDLE_ACTION]);
      if (events.some((event) => event.type === 'hit' && event.tank === ME)) {
        hitTick = server.tick;
      }
      const message = { ...snapshotOf(server, Math.max(0, tick - LAG)), events: events.map(toSnapshotEvent) };
      prediction.applySnapshot(message, tick * TICK_MS);
      for (const event of message.events.filter((candidate) => candidate.kind === 'hit' && candidate.side === ME)) {
        wasPlayed.push(prediction.wasPlayedOnTouch(event));
      }
      for (const offset of [1, TICK_MS / 2]) {
        const view = prediction.view(tick * TICK_MS + offset);
        frames.push({ latestTick: server.tick, view, ownHits: prediction.takeOwnHits() });
      }
    }
    return { frames, hitTick, wasPlayed, prediction };
  }

  function touchIndexOf(frames: readonly TouchFrame[]): number {
    return frames.findIndex((frame) => frame.ownHits.length > 0);
  }

  function enemyBulletIn(frame: TouchFrame | undefined): boolean {
    return frame?.view.bullets.some((bullet) => bullet.owner === ENEMY) === true;
  }

  it('попадание — в кадре, где снаряд пропал у своего танка, раньше снимка; урон противника; снимок не повторяет', () => {
    const { frames, hitTick, wasPlayed, prediction } = enemyShot();
    const index = touchIndexOf(frames);
    const frame = frames[index];
    expect(frames.flatMap((candidate) => candidate.ownHits)).toEqual([
      expect.objectContaining({ kind: 'hit', side: ME, value: STATS.damage, flags: 0 }),
    ]);
    expect(enemyBulletIn(frames[index - 1])).toBe(true);
    expect(enemyBulletIn(frame)).toBe(false);
    expect(frame?.latestTick).toBe((hitTick ?? NaN) - LAG);
    expect(frames[index - 1]?.view.tanks[ME].hp).toBe(STATS.maxHp);
    for (const later of frames.slice(index)) {
      expect(later.view.tanks[ME].hp).toBe(STATS.maxHp - STATS.damage);
    }
    expect(wasPlayed).toEqual([true]);
    expect(prediction.ownHitCounts).toEqual({ played: 1, confirmed: 1, cancelled: 0, served: 1, doubles: 0 });
  });

  it('свой танк на сервере увели с линии — касание отменено через 2 тика, здоровье из снимка', () => {
    const hitTick = enemyShot().hitTick ?? NaN;
    const { frames, wasPlayed, prediction } = enemyShot((round, tick) => {
      if (tick === hitTick - 2) {
        round.tanks[ME].y -= 70;
      }
    });
    expect(frames.flatMap((frame) => frame.ownHits)).toHaveLength(1);
    expect(wasPlayed).toEqual([]);
    expect(prediction.ownHitCounts).toEqual({ played: 1, confirmed: 0, cancelled: 1, served: 0, doubles: 0 });
    const cancelIndex = frames.findIndex((frame) => frame.latestTick >= hitTick + 2);
    expect(frames[cancelIndex - 1]?.view.tanks[ME].hp).toBe(STATS.maxHp - STATS.damage);
    expect(frames[cancelIndex]?.view.tanks[ME].hp).toBe(STATS.maxHp);
  });

  it('раунд кончился до подтверждения — касание отменено, здоровье из снимка', () => {
    const touchTick = (enemyShot().hitTick ?? NaN) - LAG;
    const { frames, wasPlayed, prediction } = enemyShot((round, tick) => {
      if (tick === touchTick + 1) {
        round.isOver = true;
      }
    });
    expect(frames.flatMap((frame) => frame.ownHits)).toHaveLength(1);
    expect(wasPlayed).toEqual([]);
    expect(prediction.ownHitCounts).toEqual({ played: 1, confirmed: 0, cancelled: 1, served: 0, doubles: 0 });
    expect(frames.at(-1)?.view.tanks[ME].hp).toBe(STATS.maxHp);
  });

  it('поправка своего танка сдвинула касание на 3 тика — подтверждено, попадание одно', () => {
    const hitTick = enemyShot().hitTick ?? NaN;
    const step = STATS.bulletSpeed * DT;
    const {
      frames,
      hitTick: lateTick,
      wasPlayed,
      prediction,
    } = enemyShot((round, tick) => {
      if (tick === hitTick - 2) {
        round.tanks[ME].x -= 3 * step;
      }
    });
    expect(lateTick).toBe(hitTick + 3);
    expect(frames.flatMap((frame) => frame.ownHits)).toHaveLength(1);
    expect(wasPlayed).toEqual([true]);
    expect(prediction.ownHitCounts).toEqual({ played: 1, confirmed: 1, cancelled: 0, served: 1, doubles: 0 });
  });

  it('пачка снимков между кадрами, второй закончил раунд, — несыгранное касание не играется', () => {
    const server = laneRound();
    server.tanks[ME].hp = STATS.maxHp;
    const prediction = new Prediction(ME, MAP_INDEX, SETUPS, 0, DEFAULT_RULES);
    stepRound(server, [IDLE_ACTION, FIRE]);
    prediction.applySnapshot(snapshotOf(server, 0), 0);
    while (prediction.ownHitCounts.played === 0 && prediction.pendingCount < TICKS) {
      prediction.predict(IDLE_ACTION);
    }
    stepRound(server, [IDLE_ACTION, IDLE_ACTION]);
    prediction.applySnapshot(snapshotOf(server, 0), TICK_MS);
    stepRound(server, [IDLE_ACTION, IDLE_ACTION]);
    server.isOver = true;
    prediction.applySnapshot(snapshotOf(server, 0), TICK_MS);
    expect(prediction.takeOwnHits()).toEqual([]);
    expect(prediction.ownHitCounts).toEqual({ played: 0, confirmed: 0, cancelled: 0, served: 0, doubles: 0 });
    expect(prediction.view(2 * TICK_MS).tanks[ME].hp).toBe(STATS.maxHp);
  });
});

describe('сглаживание дёрганой сети', () => {
  const ENEMY: Side = 1;
  const ENEMY_STEP = 4;
  const FRAME_MS = 1000 / 60;
  const BURST_MS = 200;
  const WARMUP_MS = 2000;
  const STATS = deriveStats(DEFAULT_STATS);
  const FLIGHT_TICKS = 70;

  function smoothPrediction(): Prediction {
    return new Prediction(ME, MAP_INDEX, SETUPS, 0, DEFAULT_RULES, true);
  }

  // Противник едет вдоль x на ENEMY_STEP за тик; снимок тика k сеть отдаёт на ближайшей границе пачек.
  function burstyEnemyFrames(prediction: Prediction, durationMs: number): number[] {
    const round = laneRound();
    const xs: number[] = [];
    let nextTick = 1;
    for (let now = 0; now <= durationMs; now += FRAME_MS) {
      while (Math.ceil((nextTick * TICK_MS) / BURST_MS - 1e-9) * BURST_MS <= now) {
        round.tick = nextTick;
        round.tanks[ENEMY].x = 300 + ENEMY_STEP * nextTick;
        prediction.applySnapshot(snapshotOf(round, 0), now);
        nextTick++;
      }
      xs.push(prediction.view(now).tanks[ENEMY].x);
    }
    return xs;
  }

  it('пачки раз в 200 мс — противник едет в каждом кадре без прыжков; без сглаживания стоит и прыгает', () => {
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
    const plain = new Prediction(ME, MAP_INDEX, SETUPS, 0, DEFAULT_RULES);
    const plainSteps = stepsAfterWarmup(burstyEnemyFrames(plain, 5000));
    expect(plainSteps.filter((step) => step === 0).length).toBeGreaterThan(plainSteps.length / 4);
    expect(Math.max(...plainSteps)).toBeGreaterThan(3 * frameStep);
    expect(plain.interpolationTicks).toBe(2);
  });

  it('поправка своего танка: в миг снимка танк на прежнем месте, за 120 мс догоняет; точка касания — на нарисованном', () => {
    const server = laneRound();
    stepRound(server, [IDLE_ACTION, IDLE_ACTION]);
    const prediction = smoothPrediction();
    prediction.applySnapshot(snapshotOf(server, 0), 0);
    expect(prediction.view(10).tanks[ME].x).toBe(LANE_ME.x);
    stepRound(server, [IDLE_ACTION, IDLE_ACTION]);
    server.tanks[ME].x += 30;
    prediction.applySnapshot(snapshotOf(server, 0), 100);
    expect(prediction.me.x).toBe(LANE_ME.x + 30);
    const at = (now: number): { mine: number; clock: number | undefined; shift: number | undefined } => {
      const view = prediction.view(now);
      return { mine: view.tanks[ME].x, clock: view.clock.me?.x, shift: view.clock.ownShift?.x };
    };
    expect(at(100)).toEqual({ mine: LANE_ME.x, clock: LANE_ME.x + 30, shift: -30 });
    expect(at(160).mine).toBeCloseTo(LANE_ME.x + 15, 9);
    expect(at(220).mine).toBeCloseTo(LANE_ME.x + 30, 9);
    server.isOver = true;
    prediction.applySnapshot(snapshotOf(server, 0), 230);
    expect(prediction.view(240).clock.ownShift).toEqual({ x: 0, y: 0 });
  });

  it('попадание по касанию в остатке смещения — в точке на нарисованном танке', () => {
    const server = laneRound();
    server.tanks[ME].hp = STATS.maxHp;
    const prediction = smoothPrediction();
    stepRound(server, [IDLE_ACTION, FIRE]);
    prediction.applySnapshot(snapshotOf(server, 0), 0);
    server.tanks[ME].y += 6;
    stepRound(server, [IDLE_ACTION, IDLE_ACTION]);
    prediction.applySnapshot(snapshotOf(server, 0), TICK_MS);
    while (prediction.ownHitCounts.played === 0 && prediction.pendingCount < FLIGHT_TICKS) {
      prediction.predict(IDLE_ACTION);
    }
    const view = prediction.view(TICK_MS + 1);
    const [hit] = prediction.takeOwnHits();
    const drawn = view.tanks[ME];
    expect(Math.abs(view.clock.ownShift?.y ?? 0)).toBeGreaterThan(1);
    expect(Math.hypot((hit?.x ?? NaN) - drawn.x, (hit?.y ?? NaN) - drawn.y)).toBeLessThan(TANK_RADIUS + BULLET_RADIUS);
  });
});

describe('дуэль: свой выстрел и свой снаряд', () => {
  function started(): { server: Round; prediction: Prediction } {
    const server = laneRound();
    stepRound(server, [IDLE_ACTION, IDLE_ACTION]);
    const prediction = new Prediction(ME, MAP_INDEX, SETUPS, 0, DEFAULT_RULES);
    prediction.applySnapshot(snapshotOf(server, 0), 0);
    return { server, prediction };
  }

  // Шаг сервера со своей командой и снимок с его событиями; результат — выстрелы своей стороны в снимке.
  function serve(server: Round, prediction: Prediction, action: Action, ackSeq: number): SnapshotEvent[] {
    const events = stepRound(server, [action, IDLE_ACTION]).map(toSnapshotEvent);
    const message = { ...snapshotOf(server, ackSeq), events };
    prediction.applySnapshot(message, server.tick * TICK_MS);
    return message.events.filter((event) => event.kind === 'shot' && event.side === ME);
  }

  it('выстрел — в шаге ввода у дула, один раз; снимок с выстрелом его не играет; без выстрела — неподтверждённый', () => {
    const { server, prediction } = started();
    prediction.predict(FIRE);
    const shots = prediction.takeOwnShots();
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ kind: 'shot', side: ME, y: LANE_ME.y, dx: 1 });
    expect(shots[0]?.x).toBeCloseTo(LANE_ME.x + MUZZLE_OFFSET, 9);
    prediction.predict(IDLE_ACTION);
    prediction.predict(IDLE_ACTION);
    expect(serve(server, prediction, IDLE_ACTION, 0)).toEqual([]);
    expect(prediction.takeOwnShots()).toEqual([]);
    const served = serve(server, prediction, FIRE, 1);
    expect(served).toHaveLength(1);
    expect(served.every((event) => prediction.wasShotPlayed(event))).toBe(true);
    expect(prediction.ownShotCounts).toEqual({ played: 1, confirmed: 1, unconfirmed: 0 });

    const lost = started();
    lost.prediction.predict(FIRE);
    lost.prediction.takeOwnShots();
    for (let ackSeq = 1; ackSeq <= 16; ackSeq++) {
      lost.prediction.predict(IDLE_ACTION);
      expect(serve(lost.server, lost.prediction, IDLE_ACTION, ackSeq)).toEqual([]);
    }
    expect(lost.prediction.takeOwnShots()).toEqual([]);
    expect(lost.prediction.ownShotCounts).toEqual({ played: 1, confirmed: 0, unconfirmed: 1 });
  });

  it('сервер подбил свой танк раньше сыгранного выстрела — выстрел сразу неподтверждённый', () => {
    const { server, prediction } = started();
    prediction.predict(FIRE);
    expect(prediction.takeOwnShots()).toHaveLength(1);
    server.tanks[ME].isAlive = false;
    server.tanks[ME].hp = 0;
    expect(serve(server, prediction, IDLE_ACTION, 1)).toEqual([]);
    expect(prediction.ownShotCounts).toEqual({ played: 1, confirmed: 0, unconfirmed: 1 });
  });

  it('свой снаряд вдали от противника — в своём тике; у зоны противника — в его тике или сходит к нему', () => {
    const fireSeq = WARMUP_SEQ + 1;
    const { frames } = playDuel(
      4,
      WARMUP_SEQ + 70,
      (seq) => (seq === fireSeq ? FIRE : IDLE_ACTION),
      () => IDLE_ACTION,
    );
    const bulletSpeed = deriveStats(DEFAULT_STATS).bulletSpeed;
    let farFrames = 0;
    let nearFrames = 0;
    let previous: { tick: number; othersTick: number } | null = null;
    for (const { view } of frames) {
      const bullet = view.bullets.find((candidate) => candidate.owner === ME);
      const enemy = view.tanks[1];
      if (bullet === undefined) {
        previous = null;
        continue;
      }
      const gap = view.clock.myTick - view.clock.othersTick;
      const window = 3 * gap * (bulletSpeed + 220) * DT + PICTURE_NEAR;
      const away = distance(bullet, enemy);
      if (away > window + bulletSpeed * DT) {
        farFrames++;
        expect(bullet.tick).toBe(view.clock.myTick);
      }
      if (away <= PICTURE_NEAR - bulletSpeed * DT && previous !== null) {
        nearFrames++;
        const floor = previous.tick + 0.5 * (view.clock.othersTick - previous.othersTick);
        expect(bullet.tick).toBeLessThanOrEqual(Math.max(view.clock.othersTick, floor) + 1e-9);
      }
      previous = { tick: bullet.tick, othersTick: view.clock.othersTick };
    }
    expect(farFrames).toBeGreaterThan(0);
    expect(nearFrames).toBeGreaterThan(0);
  });
});
