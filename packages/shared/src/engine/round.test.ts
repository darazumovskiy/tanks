import { describe, expect, it } from 'vitest';
import { ACCEL, DT, TANK_RADIUS, WALL_HIT_SPEED_FACTOR, WALL_SLIDE_MAX_PERCENT } from './constants.js';
import {
  createRound,
  DEFAULT_RULES,
  IDLE_ACTION,
  stepRound,
  type Round,
  type RoundEvent,
  type RoundRules,
} from './round.js';

const POLYGON = 0;
const LABYRINTH = 1;
const STATS = { armor: 3, engine: 3, gun: 2, reload: 2 };
const MAX_SPEED = 176;
const FULL_THROTTLE = { ...IDLE_ACTION, throttle: 1 };
const NO_SLIDE: RoundRules = { ...DEFAULT_RULES, wallSlidePercent: 0 };
const HALF_SLIDE: RoundRules = { ...DEFAULT_RULES, wallSlidePercent: 50 };
const FULL_SLIDE: RoundRules = { ...DEFAULT_RULES, wallSlidePercent: WALL_SLIDE_MAX_PERCENT };
const DEG_45 = Math.PI / 4;
const DEG_30 = Math.PI / 6;
const TOP_EDGE_Y = TANK_RADIUS;
// Левая грань стены (250, 250, 40, 400) «Лабиринта»: центр танка у неё — x = 226.
const LABYRINTH_WALL_LEFT_X = 250 - TANK_RADIUS;
// Левая грань стены (450, 0, 40, 330) «Лабиринта» у верхнего края.
const LABYRINTH_TOP_WALL_LEFT_X = 450 - TANK_RADIUS;

interface Pose {
  x: number;
  y: number;
  heading: number;
  speed?: number;
}

function roundWith(mapIndex: number, rules: RoundRules, pose: Pose): Round {
  const round = createRound(
    mapIndex,
    [
      { name: 'Водитель', stats: STATS },
      { name: 'Зритель', stats: STATS },
    ],
    rules,
  );
  const me = round.tanks[0];
  me.x = pose.x;
  me.y = pose.y;
  me.heading = pose.heading;
  me.speed = pose.speed ?? 0;
  return round;
}

function drive(round: Round, ticks: number): RoundEvent[] {
  const events: RoundEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    events.push(...stepRound(round, [FULL_THROTTLE, IDLE_ACTION]));
  }
  return events;
}

function bumps(events: RoundEvent[]): number {
  return events.filter((event) => event.type === 'bump').length;
}

// Удары после первых settleTicks тиков касания верхнего края — дробь установившегося скольжения.
function bumpsAfterSettling(round: Round, ticks: number, settleTicks: number): number {
  let firstContact = -1;
  let count = 0;
  for (let tick = 0; tick < ticks; tick++) {
    const events = stepRound(round, [FULL_THROTTLE, IDLE_ACTION]);
    if (firstContact < 0 && round.tanks[0].y === TOP_EDGE_Y) {
      firstContact = tick;
    }
    if (firstContact >= 0 && tick >= firstContact + settleTicks) {
      count += bumps(events);
    }
  }
  expect(firstContact).toBeGreaterThanOrEqual(0);
  return count;
}

describe('правила раунда', () => {
  it('без правил раунд создаётся с умолчанием — всё выключено', () => {
    const round = createRound(POLYGON, [
      { name: 'A', stats: STATS },
      { name: 'B', stats: STATS },
    ]);
    expect(round.rules).toEqual({ wallSlidePercent: 0, shotLeadTicks: 0, shotInheritPercent: 0 });
  });

  it('правила копируются в раунд', () => {
    const rules: RoundRules = { wallSlidePercent: 50, shotLeadTicks: 2, shotInheritPercent: 100 };
    const round = roundWith(POLYGON, rules, { x: 800, y: 450, heading: 0 });
    rules.wallSlidePercent = 0;
    rules.shotLeadTicks = 0;
    rules.shotInheritPercent = 0;
    expect(round.rules).toEqual({ wallSlidePercent: 50, shotLeadTicks: 2, shotInheritPercent: 100 });
  });
});

// Множитель скорости за тик касания — та же формула, что в движке, для проверки выбора контакта.
function contactFactor(rules: RoundRules, facing: number): number {
  const slide = rules.wallSlidePercent / WALL_SLIDE_MAX_PERCENT;
  const headOn = 1 - slide + slide * facing ** 3;
  return 1 - (1 - WALL_HIT_SPEED_FACTOR) * (1 - slide) * headOn;
}

describe('скольжение вдоль стен', () => {
  it('45° в верхний край: при 0 % танк залипает, при 50 % едет вдоль края без дроби ударов, при 100 % — на полной', () => {
    const pose: Pose = { x: 400, y: 80, heading: -DEG_45 };
    const sticky = roundWith(POLYGON, NO_SLIDE, pose);
    const half = roundWith(POLYGON, HALF_SLIDE, pose);
    const free = roundWith(POLYGON, FULL_SLIDE, pose);
    drive(sticky, 60);
    const halfLateBumps = bumpsAfterSettling(half, 60, 10);
    const freeBumps = bumps(drive(free, 60));

    for (const round of [sticky, half, free]) {
      expect(round.tanks[0].y).toBe(TOP_EDGE_Y);
    }
    expect(sticky.tanks[0].speed).toBeLessThanOrEqual(40);
    expect(half.tanks[0].speed).toBeGreaterThanOrEqual(80);
    expect(half.tanks[0].speed).toBeLessThanOrEqual(100);
    expect(free.tanks[0].speed).toBe(MAX_SPEED);
    expect(half.tanks[0].x).toBeGreaterThan(sticky.tanks[0].x + 50);
    expect(free.tanks[0].x).toBeGreaterThan(half.tanks[0].x + 50);
    expect(halfLateBumps).toBe(0);
    expect(freeBumps).toBe(0);
  });

  it('равновесная скорость у края растёт с процентом скольжения', () => {
    const pose: Pose = { x: 400, y: 80, heading: -DEG_45 };
    const speeds = [0, 25, 50, 75, 100].map((wallSlidePercent) => {
      const round = roundWith(POLYGON, { ...DEFAULT_RULES, wallSlidePercent }, pose);
      drive(round, 60);
      return round.tanks[0].speed;
    });
    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]).toBeGreaterThan(speeds[i - 1] ?? NaN);
    }
  });

  it('лоб в левый край поля: при 0 % и 50 % удар слышен, при 50 % — не больше четырёх; при 100 % трения нет', () => {
    const pose: Pose = { x: 120, y: 450, heading: Math.PI, speed: MAX_SPEED };
    const sticky = roundWith(POLYGON, NO_SLIDE, pose);
    const half = roundWith(POLYGON, HALF_SLIDE, pose);
    const free = roundWith(POLYGON, FULL_SLIDE, pose);
    const stickyBumps = bumps(drive(sticky, 60));
    const halfBumps = bumps(drive(half, 60));
    const freeBumps = bumps(drive(free, 60));

    for (const round of [sticky, half, free]) {
      expect(round.tanks[0].x).toBe(TANK_RADIUS);
    }
    expect(stickyBumps).toBeGreaterThan(0);
    expect(halfBumps).toBeGreaterThan(0);
    expect(halfBumps).toBeLessThanOrEqual(4);
    expect(half.tanks[0].speed).toBeLessThan(sticky.tanks[0].speed * 3);
    expect(freeBumps).toBe(0);
    expect(free.tanks[0].speed).toBe(MAX_SPEED);
  });

  it('30° к стене карты при 50 %: скорость держится, танк остаётся у стены', () => {
    // Курс вниз-вправо под 30° к вертикальной грани, старт на полной скорости чуть левее стены.
    const heading = Math.PI / 2 - (DEG_30 - 0.02);
    const round = roundWith(LABYRINTH, HALF_SLIDE, { x: 200, y: 300, heading, speed: MAX_SPEED });
    drive(round, 45);
    expect(round.tanks[0].x).toBeCloseTo(LABYRINTH_WALL_LEFT_X, 6);
    expect(round.tanks[0].speed).toBeGreaterThanOrEqual(100);
  });

  it('30° к верхнему краю две секунды при 50 %: ни одного удара', () => {
    const round = roundWith(POLYGON, HALF_SLIDE, { x: 200, y: 60, heading: -DEG_30, speed: MAX_SPEED });
    const events = drive(round, 60);
    expect(round.tanks[0].y).toBe(TOP_EDGE_Y);
    expect(bumps(events)).toBe(0);
    expect(round.tanks[0].speed).toBeGreaterThanOrEqual(100);
  });

  it('два контакта за тик — штраф по самому лобовому', () => {
    // Курс почти в верхний край и чуть в стену (450, 0, 40, 330): край лобовой, стена касательная.
    const lean = 0.2;
    const heading = -Math.PI / 2 + lean;
    const speed = 100;
    const round = roundWith(LABYRINTH, HALF_SLIDE, { x: LABYRINTH_TOP_WALL_LEFT_X, y: TOP_EDGE_Y, heading, speed });
    stepRound(round, [IDLE_ACTION, IDLE_ACTION]);

    const coasting = speed - ACCEL * DT;
    const edgeFacing = Math.cos(lean);
    const wallFacing = Math.sin(lean);
    expect(round.tanks[0].x).toBeCloseTo(LABYRINTH_TOP_WALL_LEFT_X, 6);
    expect(round.tanks[0].y).toBe(TOP_EDGE_Y);
    expect(round.tanks[0].speed).toBeCloseTo(coasting * contactFactor(HALF_SLIDE, edgeFacing), 9);
    expect(round.tanks[0].speed).not.toBeCloseTo(coasting * contactFactor(HALF_SLIDE, wallFacing), 1);
  });
});
