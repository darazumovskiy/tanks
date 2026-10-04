import { describe, expect, it } from 'vitest';
import { ACCEL, DT, TANK_RADIUS, WALL_SLIDE_PENALTY } from './constants.js';
import { createRound, IDLE_ACTION, stepRound, type Round, type RoundEvent, type RoundRules } from './round.js';

const POLYGON = 0;
const LABYRINTH = 1;
const STATS = { armor: 3, engine: 3, gun: 2, reload: 2 };
const FULL_THROTTLE = { ...IDLE_ACTION, throttle: 1 };
const SLIDE: RoundRules = { hasWallSlide: true };
const NO_SLIDE: RoundRules = { hasWallSlide: false };
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
    expect(round.rules).toEqual({ hasWallSlide: false });
  });

  it('правила копируются в раунд', () => {
    const rules: RoundRules = { hasWallSlide: true };
    const round = roundWith(POLYGON, rules, { x: 800, y: 450, heading: 0 });
    rules.hasWallSlide = false;
    expect(round.rules.hasWallSlide).toBe(true);
  });
});

describe('скольжение вдоль стен', () => {
  it('45° в верхний край: без правила танк залипает, с правилом едет вдоль края без дроби ударов', () => {
    const pose: Pose = { x: 400, y: 80, heading: -DEG_45 };
    const sticky = roundWith(POLYGON, NO_SLIDE, pose);
    const sliding = roundWith(POLYGON, SLIDE, pose);
    drive(sticky, 60);
    const lateBumps = bumpsAfterSettling(sliding, 60, 10);

    expect(sticky.tanks[0].y).toBe(TOP_EDGE_Y);
    expect(sliding.tanks[0].y).toBe(TOP_EDGE_Y);
    expect(sticky.tanks[0].speed).toBeLessThanOrEqual(40);
    expect(sliding.tanks[0].speed).toBeGreaterThanOrEqual(120);
    expect(sliding.tanks[0].x).toBeGreaterThan(sticky.tanks[0].x + 50);
    expect(lateBumps).toBe(0);
  });

  it('лоб в левый край поля: удар слышен в обоих режимах, с правилом — не больше четырёх', () => {
    const pose: Pose = { x: 120, y: 450, heading: Math.PI };
    const sticky = roundWith(POLYGON, NO_SLIDE, pose);
    const sliding = roundWith(POLYGON, SLIDE, pose);
    const stickyBumps = bumps(drive(sticky, 60));
    const slidingBumps = bumps(drive(sliding, 60));

    expect(sticky.tanks[0].x).toBe(TANK_RADIUS);
    expect(sliding.tanks[0].x).toBe(TANK_RADIUS);
    expect(stickyBumps).toBeGreaterThan(0);
    expect(slidingBumps).toBeGreaterThan(0);
    expect(slidingBumps).toBeLessThanOrEqual(4);
  });

  it('30° к стене карты: скорость держится, танк остаётся у стены', () => {
    // Курс вниз-вправо под 30° к вертикальной грани, старт на полной скорости чуть левее стены.
    const heading = Math.PI / 2 - (DEG_30 - 0.02);
    const round = roundWith(LABYRINTH, SLIDE, { x: 200, y: 300, heading, speed: 176 });
    drive(round, 45);
    expect(round.tanks[0].x).toBeCloseTo(LABYRINTH_WALL_LEFT_X, 6);
    expect(round.tanks[0].speed).toBeGreaterThanOrEqual(150);
  });

  it('30° к верхнему краю две секунды: ни одного удара', () => {
    const round = roundWith(POLYGON, SLIDE, { x: 200, y: 60, heading: -DEG_30, speed: 176 });
    const events = drive(round, 60);
    expect(round.tanks[0].y).toBe(TOP_EDGE_Y);
    expect(bumps(events)).toBe(0);
    expect(round.tanks[0].speed).toBeGreaterThanOrEqual(150);
  });

  it('два контакта за тик — штраф по самому лобовому', () => {
    // Курс почти в верхний край и чуть в стену (450, 0, 40, 330): край лобовой, стена касательная.
    const lean = 0.2;
    const heading = -Math.PI / 2 + lean;
    const speed = 100;
    const round = roundWith(LABYRINTH, SLIDE, { x: LABYRINTH_TOP_WALL_LEFT_X, y: TOP_EDGE_Y, heading, speed });
    stepRound(round, [IDLE_ACTION, IDLE_ACTION]);

    const coasting = speed - ACCEL * DT;
    const edgeFacing = Math.cos(lean);
    const wallFacing = Math.sin(lean);
    expect(round.tanks[0].x).toBeCloseTo(LABYRINTH_TOP_WALL_LEFT_X, 6);
    expect(round.tanks[0].y).toBe(TOP_EDGE_Y);
    expect(round.tanks[0].speed).toBeCloseTo(coasting * (1 - WALL_SLIDE_PENALTY * edgeFacing ** 3), 9);
    expect(round.tanks[0].speed).not.toBeCloseTo(coasting * (1 - WALL_SLIDE_PENALTY * wallFacing ** 3), 1);
  });
});
