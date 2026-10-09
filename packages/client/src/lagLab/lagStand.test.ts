import { describe, expect, it } from 'vitest';
import { compileArenaBotScript, createBrain, type BotBrain } from '@tanks/bots';
import parallaxSource from '@tanks/bots/parallax.js?raw';
import {
  BULLET_RADIUS,
  DEFAULT_STATS,
  DT,
  IDLE_ACTION,
  mapByIndex,
  normalizeAngle,
  ROUND_SECONDS,
  TANK_RADIUS,
  TICK_RATE,
  type Action,
  type Side,
} from '@tanks/shared/engine';
import type { SnapshotEvent } from '@tanks/shared/protocol';
import { PICTURE_NEAR } from '../pictureTime.js';
import {
  compensationTicks,
  LAG_MAP_INDEX,
  LagStand,
  lagViewAt,
  ROUND_RESTART_TICKS,
  viewLagTicks,
  type LagBrainFactory,
  type LagKnobs,
} from './lagStand.js';

const parallax = compileArenaBotScript(parallaxSource);
const ladderBrain: LagBrainFactory = (level, random) => createBrain(level, random, parallax);
const SEED = 7;
const FIGHT_TICKS = 20 * TICK_RATE;
const STRAIGHT_TICKS = 60;
const SHOT_TICKS = 300;
// Свой танк стоит столько тиков, потом поворачивает вниз и уходит с линии выстрела бота: при пределе 200 судья
// догоняет танк снарядом, выпущенным на нулевом тике (подобрано прогоном).
const DODGE_START_TICK = 38;
const HIT_DISTANCE = 29;
// Бот стоит первые тики раунда, потом кружит: команды, оставшиеся в очереди с прошлого раунда, сдвинули бы его раньше.
const BOT_STILL_TICKS = 6;
const ROUND_TICKS = ROUND_SECONDS * TICK_RATE;
const ROUND_LIMIT_TICKS = ROUND_TICKS + ROUND_RESTART_TICKS + 1;
const SPAWNS = mapByIndex(LAG_MAP_INDEX).spawns;

const CIRCLE: Action = { ...IDLE_ACTION, throttle: 1, turn: 1 };
const CIRCLE_FIRING: Action = { ...CIRCLE, isFiring: true };
const FORWARD: Action = { ...IDLE_ACTION, throttle: 1 };
const BACKWARD: Action = { ...IDLE_ACTION, throttle: -1 };
// Снаряд бота с нулевого тика летит до своего танка около 70 тиков: задний ход с этого тика — бегство по линии
// выстрела, до стены за спиной танк не доезжает.
const FLEE_START_TICK = 45;
const FIRE: Action = { ...IDLE_ACTION, isFiring: true };
const ARMOR_DISTANCE = TANK_RADIUS + BULLET_RADIUS;
const DEPTH_TOLERANCE = 1e-6;
const FRAME_FRACTIONS = [0.25, 0.5, 0.75, 1];
const ARMOR_TICKS = 160;
// Танк уходит с прямой между точками появления вбок на столько тиков, потом задним ходом пересекает её обратно.
const ASIDE_TICKS = 25;
const CROSS_STARTS = [20, 26, 32, 38, 44, 50, 56];
const DODGE_STARTS = [30, 34, 38, 42, 46];
const HEADING_TOLERANCE = 0.05;
const MIN_FAR_STEPS = 10;
// Змейка: полный газ, поворот меняет сторону каждые столько тиков, огонь не отпускается.
const ZIGZAG_HALF_TICKS = 20;
const ZIGZAG_ROUNDS = 4;
const ZIGZAG_LIMIT_TICKS = ZIGZAG_ROUNDS * ROUND_LIMIT_TICKS;
const MY_SIDE: Side = 0;
const BOT_SIDE: Side = 1;

function knobs(partial: Partial<LagKnobs>): LagKnobs {
  return { mode: 'victim', rttMs: 200, capMs: 120, botLevel: 6, ...partial };
}

function scriptedBrain(tick: (roundTick: number) => Action): LagBrainFactory {
  return (): BotBrain => ({ stats: DEFAULT_STATS, reactionTicks: 0, tick: (view) => tick(view.tick) });
}

const idleBot = scriptedBrain(() => IDLE_ACTION);
const firstTickShooter = scriptedBrain((roundTick) => ({ ...IDLE_ACTION, isFiring: roundTick === 0 }));
const lateCircler = scriptedBrain((roundTick) => (roundTick < BOT_STILL_TICKS ? IDLE_ACTION : CIRCLE));

function position(tank: { x: number; y: number }): { x: number; y: number } {
  return { x: tank.x, y: tank.y };
}

// Стоит до start, затем поворачивает вниз и едет полным ходом.
function dodge(stand: LagStand, tick: number, start = DODGE_START_TICK): Action {
  if (tick < start) {
    return IDLE_ACTION;
  }
  const isTurned = stand.controlledTank.heading >= Math.PI / 2 - 0.05;
  return isTurned ? FORWARD : { ...IDLE_ACTION, turn: 1 };
}

function isFacingDown(heading: number): boolean {
  return Math.abs(normalizeAngle(heading - Math.PI / 2)) < HEADING_TOLERANCE;
}

// С тика start поворачивает вниз (turn — в какую сторону), уходит с прямой между точками появления на ASIDE_TICKS
// тиков и задним ходом пересекает её обратно.
function crossing(start: number, turn: number): (tick: number, heading: number) => Action {
  let turnedAt: number | null = null;
  return (tick, heading) => {
    if (tick < start) {
      return IDLE_ACTION;
    }
    if (turnedAt === null) {
      if (!isFacingDown(heading)) {
        return { ...IDLE_ACTION, turn };
      }
      turnedAt = tick;
    }
    return tick - turnedAt < ASIDE_TICKS ? FORWARD : BACKWARD;
  };
}

function crossingBot(start: number): LagBrainFactory {
  return (): BotBrain => {
    const drive = crossing(start, -1);
    return { stats: DEFAULT_STATS, reactionTicks: 0, tick: (view) => drive(view.tick, view.me.heading) };
  };
}

function firstTickFire(tick: number): Action {
  return tick === 0 ? FIRE : IDLE_ACTION;
}

function zigzag(tick: number): Action {
  const turn = Math.floor(tick / ZIGZAG_HALF_TICKS) % 2 === 0 ? 1 : -1;
  return { ...CIRCLE_FIRING, turn };
}

function isHitOn(side: Side): (event: SnapshotEvent) => boolean {
  return (event) => event.kind === 'hit' && event.side === side;
}

// Бой по картинкам и кадрам между ними: как близко снаряды стрелка shooter подходили к нарисованному танку target, в
// каких шагах снаряд стоял на броне и в каких игралось попадание по target.
function watchArmor(
  stand: LagStand,
  action: (tick: number) => Action,
  shooter: Side,
  target: Side,
): { closest: number; armorSteps: number[]; hitSteps: number[] } {
  let closest = Infinity;
  const armorSteps: number[] = [];
  const hitSteps: number[] = [];
  for (let tick = 0; tick < ARMOR_TICKS; tick++) {
    const before = stand.picture;
    const step = stand.step(action(tick));
    const after = stand.picture;
    if (after.bullets.some((bullet) => bullet.owner === shooter && bullet.isOnArmor)) {
      armorSteps.push(tick);
    }
    if (step.events.some(isHitOn(target))) {
      hitSteps.push(tick);
    }
    for (const fraction of FRAME_FRACTIONS) {
      const { view } = lagViewAt(before, after, fraction);
      const tank = view.tanks[target];
      if (!tank.isAlive) {
        continue;
      }
      for (const bullet of view.bullets.filter((candidate) => candidate.owner === shooter)) {
        closest = Math.min(closest, Math.hypot(bullet.x - tank.x, bullet.y - tank.y));
      }
    }
  }
  return { closest, armorSteps, hitSteps };
}

function runUntilNewRound(stand: LagStand, action: Action): void {
  for (let tick = 0; tick < ROUND_LIMIT_TICKS; tick++) {
    if (stand.step(action).isNewRound) {
      return;
    }
  }
  throw new Error('раунд не кончился');
}

describe('стенд задержки: числа', () => {
  it('задержка 200, предел 120: V = 8, C = 4', () => {
    expect(viewLagTicks(200)).toBe(8);
    expect(compensationTicks(200, 120)).toBe(4);
  });

  it('задержка 50, предел 200: компенсация полная, C = V = 4', () => {
    expect(viewLagTicks(50)).toBe(4);
    expect(compensationTicks(50, 200)).toBe(4);
  });
});

describe('стенд задержки: жертва', () => {
  it('предел 0: свой танк в судье и на картинке совпадает каждый тик; попаданий компенсацией нет', () => {
    const stand = new LagStand(knobs({ capMs: 0 }), ladderBrain, SEED);
    for (let tick = 0; tick < FIGHT_TICKS; tick++) {
      stand.step(CIRCLE_FIRING);
      const { me } = stand.debugState();
      expect(position(me.picture)).toEqual(position(me.judge));
    }
    expect(stand.counters.hitsTaken).toBeGreaterThan(0);
    expect(stand.counters.compensatedHits).toBe(0);
  });

  it('предел 120, свой танк едет прямо: в судье отстаёт от картинки ровно на 4 тика хода', () => {
    const stand = new LagStand(knobs({ capMs: 120 }), idleBot, SEED);
    const judge: { x: number; y: number }[] = [];
    const picture: { x: number; y: number }[] = [];
    for (let tick = 0; tick < STRAIGHT_TICKS; tick++) {
      stand.step(FORWARD);
      const { me } = stand.debugState();
      judge.push(position(me.judge));
      picture.push(position(me.picture));
    }
    expect(picture[STRAIGHT_TICKS - 1]?.x).toBeGreaterThan(SPAWNS[0].x);
    for (let tick = 0; tick + 4 < STRAIGHT_TICKS; tick++) {
      expect(judge[tick + 4]).toEqual(picture[tick]);
    }
  });

  it('задержка 200, свой танк едет прямо: «видит стрелок» — картинка V тиков назад при любом пределе, «проверяет сервер» — C', () => {
    const shooterViews: { x: number; y: number }[][] = [];
    for (const capMs of [0, 120, 200]) {
      const stand = new LagStand(knobs({ rttMs: 200, capMs }), idleBot, SEED);
      const { viewLagTicks, compensationTicks } = stand.debugState();
      const start = stand.debugState().me.picture;
      const picture: { x: number; y: number }[] = [];
      const shooterView: { x: number; y: number }[] = [];
      const serverView: { x: number; y: number }[] = [];
      for (let tick = 0; tick < STRAIGHT_TICKS; tick++) {
        stand.step(FORWARD);
        const state = stand.debugState();
        picture.push(position(state.me.picture));
        shooterView.push(position(state.shooterView ?? { x: NaN, y: NaN }));
        serverView.push(position(state.serverView ?? { x: NaN, y: NaN }));
      }
      expect(viewLagTicks).toBe(8);
      expect(shooterView[0]).toEqual(position(start));
      for (let tick = viewLagTicks; tick < STRAIGHT_TICKS; tick++) {
        expect(shooterView[tick]).toEqual(picture[tick - viewLagTicks]);
      }
      for (let tick = compensationTicks; tick < STRAIGHT_TICKS; tick++) {
        expect(serverView[tick]).toEqual(picture[tick - compensationTicks]);
      }
      shooterViews.push(shooterView);
    }
    expect(shooterViews[1]).toEqual(shooterViews[0]);
    expect(shooterViews[2]).toEqual(shooterViews[0]);
  });

  it('снаряд проходит в стороне от нарисованного танка и попадает в танк судьи: попадание компенсацией', () => {
    const stand = new LagStand(knobs({ capMs: 200 }), firstTickShooter, SEED);
    const hits = [];
    for (let tick = 0; tick < SHOT_TICKS && stand.counters.hitsTaken === 0; tick++) {
      const step = stand.step(dodge(stand, tick));
      if (step.compensatedHit !== null) {
        hits.push(step.compensatedHit);
      }
    }
    expect(stand.counters.hitsTaken).toBe(1);
    expect(stand.counters.compensatedHits).toBe(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.distance).toBeGreaterThan(HIT_DISTANCE);
    expect(stand.counters.averageMissPx).toBeGreaterThan(HIT_DISTANCE);
  });

  it('тот же уворот при пределе 0: снаряд мимо', () => {
    const stand = new LagStand(knobs({ capMs: 0 }), firstTickShooter, SEED);
    for (let tick = 0; tick < SHOT_TICKS; tick++) {
      stand.step(dodge(stand, tick));
    }
    expect(stand.counters.hitsTaken).toBe(0);
  });

  it('уезжаю по линии выстрела, снаряд догоняет: попал бы и без компенсации — компенсацией не считается', () => {
    const stand = new LagStand(knobs({ capMs: 200 }), firstTickShooter, SEED);
    let gapAtHit = 0;
    for (let tick = 0; tick < SHOT_TICKS && stand.counters.hitsTaken === 0; tick++) {
      expect(stand.step(tick < FLEE_START_TICK ? IDLE_ACTION : BACKWARD).compensatedHit).toBeNull();
      const { me } = stand.debugState();
      gapAtHit = me.judge.x - me.picture.x;
    }
    expect(stand.counters.hitsTaken).toBe(1);
    expect(stand.counters.compensatedHits).toBe(0);
    expect(gapAtHit).toBeGreaterThan(HIT_DISTANCE / 2);
  });

  it('задержка 300, предел 200: снаряд бота не заходит в нарисованный танк; касание было — значит, судья попал', () => {
    const scripts = [
      ...DODGE_STARTS.map((start) => (stand: LagStand) => (tick: number) => dodge(stand, tick, start)),
      ...CROSS_STARTS.map((start) => (stand: LagStand) => {
        const drive = crossing(start, 1);
        return (tick: number): Action => drive(tick, stand.controlledTank.heading);
      }),
    ];
    const outcomes: boolean[] = [];
    for (const script of scripts) {
      const stand = new LagStand(knobs({ rttMs: 300, capMs: 200 }), firstTickShooter, SEED);
      const watch = watchArmor(stand, script(stand), BOT_SIDE, MY_SIDE);
      const isHit = stand.counters.hitsTaken > 0;
      const { touchHits } = stand.debugState();
      expect(watch.closest).toBeGreaterThan(ARMOR_DISTANCE - DEPTH_TOLERANCE);
      expect(watch.armorSteps).toEqual([]);
      expect(touchHits.played > 0).toBe(isHit);
      expect(touchHits.cancelled).toBe(0);
      expect(watch.hitSteps.length).toBe(isHit ? 1 : 0);
      outcomes.push(isHit);
    }
    expect(outcomes).toContain(true);
    expect(outcomes).toContain(false);
  });

  it('задержка 300, предел 200, бот стреляет в стоящий танк: попадание в шаге касания, судья подтверждает без повтора', () => {
    const stand = new LagStand(knobs({ rttMs: 300, capMs: 200 }), firstTickShooter, SEED);
    const botStats = stand.round.tanks[BOT_SIDE].stats;
    const tickTravel = botStats.bulletSpeed * DT;
    let touchStep: number | null = null;
    let judgeStep: number | null = null;
    const hitSteps: number[] = [];
    for (let tick = 0; tick < SHOT_TICKS; tick++) {
      const before = stand.picture;
      const bulletBefore = before.bullets.find((bullet) => bullet.owner === BOT_SIDE);
      const result = stand.step(IDLE_ACTION);
      const { bullets, tanks } = stand.picture;
      expect(bullets.some((bullet) => bullet.owner === BOT_SIDE && bullet.isOnArmor)).toBe(false);
      const hits = result.events.filter(isHitOn(MY_SIDE));
      if (hits.length > 0) {
        hitSteps.push(tick);
      }
      if (judgeStep === null && stand.counters.hitsTaken > 0) {
        judgeStep = tick;
      }
      const isGone = bulletBefore !== undefined && !bullets.some((bullet) => bullet.id === bulletBefore.id);
      if (touchStep !== null || !isGone) {
        continue;
      }
      touchStep = tick;
      const me = tanks[MY_SIDE];
      expect(Math.hypot(bulletBefore.x - me.x, bulletBefore.y - me.y)).toBeLessThan(ARMOR_DISTANCE + tickTravel);
      expect(hits).toHaveLength(1);
      expect(Math.hypot((hits[0]?.x ?? 0) - me.x, (hits[0]?.y ?? 0) - me.y)).toBeCloseTo(ARMOR_DISTANCE);
      expect(me.hp).toBe(before.tanks[MY_SIDE].hp - botStats.damage);
      expect(stand.round.tanks[MY_SIDE].hp).toBe(before.tanks[MY_SIDE].hp);
      expect(stand.counters.hitsTaken).toBe(0);
    }
    expect(touchStep).not.toBeNull();
    expect(hitSteps).toEqual([touchStep]);
    expect(judgeStep).toBe((touchStep ?? 0) + stand.compensation);
    expect(stand.picture.tanks[MY_SIDE].hp).toBe(stand.round.tanks[MY_SIDE].hp);
    expect(stand.counters.hitsTaken).toBe(1);
    expect(stand.debugState().touchHits).toEqual({ played: 1, confirmed: 1, cancelled: 0 });
  });

  it('предел 0, тот же выстрел: касание и вердикт судьи в одном шаге, событие попадания одно', () => {
    const stand = new LagStand(knobs({ rttMs: 300, capMs: 0 }), firstTickShooter, SEED);
    let judgeStep: number | null = null;
    const hitSteps: number[] = [];
    for (let tick = 0; tick < SHOT_TICKS; tick++) {
      const result = stand.step(IDLE_ACTION);
      expect(stand.picture.bullets.some((bullet) => bullet.isOnArmor)).toBe(false);
      if (result.events.some(isHitOn(MY_SIDE))) {
        hitSteps.push(tick);
      }
      if (judgeStep === null && stand.counters.hitsTaken > 0) {
        judgeStep = tick;
      }
    }
    expect(judgeStep).not.toBeNull();
    expect(hitSteps).toEqual([judgeStep]);
    expect(stand.debugState().touchHits.cancelled).toBe(0);
  });

  it('задержка 300, предел 200, змейка с огнём против бота лестницы 6: каждое касание подтверждено судьёй', () => {
    const stand = new LagStand(knobs({ rttMs: 300, capMs: 200, botLevel: 6 }), ladderBrain, SEED);
    for (let tick = 0; tick < ZIGZAG_LIMIT_TICKS && stand.roundIndex < ZIGZAG_ROUNDS; tick++) {
      stand.step(zigzag(tick));
    }
    const { touchHits } = stand.debugState();
    expect(stand.roundIndex).toBe(ZIGZAG_ROUNDS);
    expect(touchHits.played).toBeGreaterThan(0);
    expect(touchHits.confirmed).toBe(touchHits.played);
    expect(touchHits.cancelled).toBe(0);
  });

  it('снаряд попадает и в нарисованный танк, и в танк судьи: компенсацией не считается', () => {
    const stand = new LagStand(knobs({ capMs: 200 }), firstTickShooter, SEED);
    for (let tick = 0; tick < SHOT_TICKS && stand.counters.hitsTaken === 0; tick++) {
      expect(stand.step(IDLE_ACTION).compensatedHit).toBeNull();
    }
    expect(stand.counters.hitsTaken).toBe(1);
    expect(stand.counters.compensatedHits).toBe(0);
  });
});

describe('стенд задержки: стрелок', () => {
  it('C = V: нарисованный бот совпадает с ботом судьи', () => {
    const stand = new LagStand(knobs({ mode: 'shooter', rttMs: 50, capMs: 200 }), ladderBrain, SEED);
    let hasBotMoved = false;
    for (let tick = 0; tick < FIGHT_TICKS; tick++) {
      stand.step(CIRCLE_FIRING);
      const { bot } = stand.debugState();
      expect(position(bot.picture)).toEqual(position(bot.judge));
      hasBotMoved ||= bot.judge.x !== SPAWNS[1].x;
    }
    expect(hasBotMoved).toBe(true);
    expect(stand.counters.shots).toBeGreaterThan(0);
  });

  it('предел 0: нарисованный бот отстаёт от бота судьи на V тиков', () => {
    const stand = new LagStand(knobs({ mode: 'shooter', rttMs: 200, capMs: 0 }), ladderBrain, SEED);
    const lag = viewLagTicks(200);
    const judge: { x: number; y: number }[] = [];
    const picture: { x: number; y: number }[] = [];
    for (let tick = 0; tick < FIGHT_TICKS; tick++) {
      stand.step(CIRCLE_FIRING);
      const { bot } = stand.debugState();
      judge.push(position(bot.judge));
      picture.push(position(bot.picture));
    }
    expect(judge.some((point) => point.x !== SPAWNS[1].x)).toBe(true);
    for (let tick = lag; tick < FIGHT_TICKS; tick++) {
      expect(picture[tick]).toEqual(judge[tick - lag]);
    }
  });

  it.each([0, 200])(
    'задержка 300, предел %i: свой снаряд не заходит в нарисованного бота; встал на броню — попал',
    (capMs) => {
      const outcomes: boolean[] = [];
      for (const start of CROSS_STARTS) {
        const stand = new LagStand(knobs({ mode: 'shooter', rttMs: 300, capMs }), crossingBot(start), SEED);
        const watch = watchArmor(stand, firstTickFire, MY_SIDE, BOT_SIDE);
        const isHit = stand.counters.hits > 0;
        expect(watch.closest).toBeGreaterThan(ARMOR_DISTANCE - DEPTH_TOLERANCE);
        expect(watch.armorSteps.length > 0).toBe(isHit);
        expect(watch.hitSteps).toEqual(watch.armorSteps.slice(0, 1));
        outcomes.push(isHit);
      }
      expect(outcomes).toContain(true);
      expect(outcomes).toContain(false);
    },
  );
});

describe('стенд задержки: снаряды на картинке', () => {
  it.each([
    { title: 'стрелок 300/0, свой снаряд', chosen: knobs({ mode: 'shooter', rttMs: 300, capMs: 0 }), owner: MY_SIDE },
    { title: 'жертва 300/200, снаряд бота', chosen: knobs({ rttMs: 300, capMs: 200 }), owner: BOT_SIDE },
  ])('$title: вдали от обоих танков в каждой картинке летит вперёд', ({ chosen, owner }) => {
    const brain = owner === BOT_SIDE ? firstTickShooter : idleBot;
    const direction = owner === BOT_SIDE ? -1 : 1;
    const stand = new LagStand(chosen, brain, SEED);
    let lastX: number | null = null;
    let farSteps = 0;
    for (let tick = 0; tick < ARMOR_TICKS; tick++) {
      stand.step(owner === MY_SIDE ? firstTickFire(tick) : IDLE_ACTION);
      const { tanks, bullets } = stand.picture;
      const bullet = bullets.find((candidate) => candidate.owner === owner);
      const isFar =
        bullet !== undefined && tanks.every((tank) => Math.hypot(bullet.x - tank.x, bullet.y - tank.y) > PICTURE_NEAR);
      if (!isFar) {
        lastX = null;
        continue;
      }
      if (lastX !== null) {
        expect((bullet.x - lastX) * direction).toBeGreaterThan(0);
        farSteps++;
      }
      lastX = bullet.x;
    }
    expect(farSteps).toBeGreaterThan(MIN_FAR_STEPS);
  });
});

describe('стенд задержки: раунды и ручки', () => {
  it('стрелок, новый раунд: очередь бота и история поз с нуля, счётчики копятся; смена ручки их обнуляет', () => {
    const stand = new LagStand(knobs({ mode: 'shooter', rttMs: 200, capMs: 120 }), lateCircler, SEED);
    runUntilNewRound(stand, FIRE);
    const shotsBefore = stand.counters.shots;
    expect(shotsBefore).toBeGreaterThan(0);
    expect(stand.roundIndex).toBe(1);
    for (let tick = 0; tick < BOT_STILL_TICKS; tick++) {
      stand.step(IDLE_ACTION);
      const { bot } = stand.debugState();
      expect(position(bot.judge)).toEqual(position(SPAWNS[1]));
      expect(position(bot.picture)).toEqual(position(SPAWNS[1]));
    }
    expect(stand.counters.shots).toBe(shotsBefore);

    stand.setKnobs(knobs({ mode: 'shooter', rttMs: 300, capMs: 120 }));
    expect(stand.counters).toEqual({
      hitsTaken: 0,
      compensatedHits: 0,
      averageMissPx: null,
      shots: 0,
      hits: 0,
      accuracy: null,
    });
    expect(stand.roundIndex).toBe(0);
    expect(stand.debugState()).toMatchObject({ rttMs: 300, viewLagTicks: 11, compensationTicks: 4, judgeTick: 0 });
  });

  it('жертва, новый раунд: очередь своих команд с нуля', () => {
    const stand = new LagStand(knobs({ capMs: 120 }), idleBot, SEED);
    runUntilNewRound(stand, CIRCLE);
    for (let tick = 0; tick < compensationTicks(200, 120) + 2; tick++) {
      stand.step(IDLE_ACTION);
      const { me } = stand.debugState();
      expect(position(me.judge)).toEqual(position(SPAWNS[0]));
      expect(position(me.picture)).toEqual(position(SPAWNS[0]));
    }
  });
});
