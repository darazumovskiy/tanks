import { TICK_RATE } from '@tanks/shared/engine';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeLogs, type GameSummary } from './index.js';
import {
  action,
  countdownFrames,
  fightFrame,
  HUMAN,
  IDLE,
  LANE_Y,
  makeLogDir,
  pose,
  removeLogDirs,
  startDuel,
  type Frame,
  type LogAction,
  type LogBuilder,
  type Pose,
} from './logFixture.js';
import type { LogAction as ParsedAction } from './logParser.js';

const BOT_POSE = pose(1400, LANE_Y, Math.PI, Math.PI);
const FULL_SPEED = 150;
const SECONDS_PER_MINUTE = 60;

function analyzeSingle(builder: LogBuilder): GameSummary {
  const dir = makeLogDir({ 'MOVE.log': builder.text() });
  const [game] = analyzeLogs(dir, { outDir: join(dir, 'out') }).games;
  if (game === undefined) {
    throw new Error('игра не разобрана');
  }
  return game.summary;
}

interface Step {
  speed: number;
  throttle: number;
  heading?: number;
  turret?: number;
}

// Человек едет вдоль полосы по заданным скоростям (единиц в секунду, знак — направление по оси X).
function drive(steps: readonly Step[], startX = 400): LogBuilder {
  const builder = startDuel()
    .roundStart(0, 0)
    .frames(countdownFrames([BOT_POSE, pose(startX, LANE_Y)]));
  let x = startX;
  const frames: Frame[] = steps.map((step) => {
    x += step.speed / TICK_RATE;
    const human = pose(x, LANE_Y, step.heading ?? 0, step.turret ?? 0);
    const actions: [LogAction, ParsedAction] = [IDLE, action(step.throttle)];
    return fightFrame([BOT_POSE, human], { actions });
  });
  return builder.frames(frames);
}

function constant(count: number, step: Step): Step[] {
  return Array.from({ length: count }, () => ({ ...step }));
}

function perMinute(count: number, fightTicks: number): number {
  return Math.round((count / (fightTicks / TICK_RATE / SECONDS_PER_MINUTE)) * 10) / 10;
}

afterEach(() => {
  removeLogDirs();
});

describe('движение и динамика', () => {
  it('газ 1 на всех тиках боя — полный газ 100 %, корзина ±1 на всех тиках, молчание и перезапись считаются', () => {
    const poses: [Pose, Pose] = [BOT_POSE, pose(400, LANE_Y)];
    const builder = startDuel().roundStart(0, 0).frames(countdownFrames(poses));
    for (let i = 0; i < 30; i++) {
      builder.frame(
        fightFrame(poses, {
          actions: [IDLE, action(1, 0.5, -0.2)],
          inputs: [1, i === 0 ? 3 : 1],
          isSilent: [false, i === 1],
        }),
      );
    }
    builder.droppedInput(HUMAN);
    const game = analyzeSingle(builder);

    expect(game.movement).toMatchObject({
      fight_ticks: 30,
      full_throttle_pct: 100,
      reverse_pct: 0,
      idle_pct: 0,
      mean_speed: 0,
      silent_ticks: 1,
      batched_inputs: 2,
      dropped_inputs: 1,
    });
    expect(game.hist).toEqual({ throttle: { '±1': 30 }, turn: { '0.3–0.7': 30 }, turretTurn: { '|v|<0.3': 30 } });
  });

  it('газ 1 → −1 → 1 с разгоном — две смены хода, тиков до разгона по позициям, задний ход', () => {
    const steps: Step[] = [
      ...constant(10, { speed: FULL_SPEED, throttle: 1 }),
      { speed: 100, throttle: -1 },
      { speed: 50, throttle: -1 },
      { speed: 0, throttle: -1 },
      { speed: -50, throttle: -1 },
      ...constant(16, { speed: -FULL_SPEED, throttle: -1 }),
      { speed: -100, throttle: 1 },
      { speed: -50, throttle: 1 },
      { speed: 0, throttle: 1 },
      { speed: 50, throttle: 1 },
      ...constant(16, { speed: FULL_SPEED, throttle: 1 }),
    ];
    const game = analyzeSingle(drive(steps));
    const fightTicks = steps.length;

    expect(game.dynamics.throttle_flips_per_min).toBe(perMinute(2, fightTicks));
    expect(game.dynamics.flip_settle_ticks_median).toBe(3);
    expect(game.dynamics.reverse_speed_pct).toBe(Math.round((100 * 19 * 10) / fightTicks) / 10);
    expect(game.movement.reverse_pct).toBe(Math.round((100 * 20 * 10) / fightTicks) / 10);
    expect(game.dynamics.sharp_stops_per_min).toBe(perMinute(2, fightTicks));
  });

  it('скорость 150 → 10 за 5 тиков — одна резкая остановка', () => {
    const steps: Step[] = [
      ...constant(20, { speed: FULL_SPEED, throttle: 1 }),
      ...[122, 94, 66, 38, 10].map((speed) => ({ speed, throttle: 0 })),
      ...constant(10, { speed: 10, throttle: 0 }),
    ];
    const game = analyzeSingle(drive(steps));

    expect(game.dynamics.sharp_stops_per_min).toBe(perMinute(1, steps.length));
    expect(game.dynamics.throttle_flips_per_min).toBe(0);
    expect(game.movement.mean_speed).toBeCloseTo((20 * FULL_SPEED + 330 + 100) / steps.length, 0);
  });

  it('поворот курса на 120° за 30 тиков с перерывом в 2 тика — один разворот длиной 30; обратный на 100° — второй', () => {
    const turningTicks = 28;
    const stepRad = (120 * Math.PI) / 180 / turningTicks;
    const backStepRad = (100 * Math.PI) / 180 / 20;
    let heading = 0;
    const steps: Step[] = [];
    for (let i = 0; i < 30; i++) {
      const isPause = i === 14 || i === 15;
      heading += isPause ? 0 : stepRad;
      steps.push({ speed: 0, throttle: 0, heading });
    }
    steps.push(...constant(10, { speed: 0, throttle: 0, heading }));
    for (let i = 0; i < 20; i++) {
      heading -= backStepRad;
      steps.push({ speed: 0, throttle: 0, heading });
    }
    const game = analyzeSingle(drive(steps));

    expect(game.dynamics.turnarounds_per_min).toBe(perMinute(2, steps.length));
    expect(game.dynamics.turnaround_ticks_median).toBe(25);
  });

  it('кружение вокруг противника на постоянной дистанции — кружение на всех тиках, кайтинг 0, стены далеко', () => {
    const center = pose(1000, 220, Math.PI, Math.PI);
    const radius = 60;
    const stepRad = 100 / TICK_RATE / radius;
    // Корпус и башня смотрят по касательной — по ходу движения.
    const humanAt = (i: number): Pose => {
      const angle = stepRad * i;
      const forward = angle + Math.PI / 2;
      return pose(center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle), forward, forward);
    };
    const builder = startDuel()
      .roundStart(0, 0)
      .frames(countdownFrames([center, humanAt(0)]));
    for (let i = 1; i <= 30; i++) {
      builder.frame(fightFrame([center, humanAt(i)], { actions: [IDLE, action(1, 0, -0.8)] }));
    }
    const game = analyzeSingle(builder);

    // Первый тик боя не сравнить с предыдущей дистанцией: 29 из 30.
    expect(game.dynamics.circle_pct).toBe(96.7);
    expect(game.dynamics.kite_pct).toBe(0);
    expect(game.dynamics.near_wall_pct).toBe(0);
    expect(game.dynamics.mean_distance).toBe(radius);
    expect(game.hist.turretTurn).toEqual({ '0.7–0.99': 30 });
  });

  it('раунд без тиков боя — доли движения и динамики не определены', () => {
    const poses: [Pose, Pose] = [BOT_POSE, pose(400, LANE_Y)];
    const game = analyzeSingle(startDuel().roundStart(0, 0).frames(countdownFrames(poses, 5)));

    expect(game.movement).toMatchObject({
      fight_ticks: 0,
      full_throttle_pct: null,
      mean_speed: null,
      bumps_per_min: null,
    });
    expect(game.dynamics).toMatchObject({ throttle_flips_per_min: null, kite_pct: null, mean_distance: null });
    expect(game.rounds[0]?.duration_s).toBe(0);
  });

  it('скорость 100 от противника, башня назад — кайтинг 100 %; у стены и дистанция', () => {
    const steps = constant(30, { speed: 100, throttle: 1, turret: Math.PI });
    const builder = startDuel()
      .roundStart(0, 0)
      .frames(countdownFrames([pose(100, LANE_Y), pose(600, LANE_Y)]));
    let x = 600;
    for (const step of steps) {
      x += step.speed / TICK_RATE;
      builder.frame(fightFrame([pose(100, LANE_Y), pose(x, LANE_Y, 0, Math.PI)], { actions: [IDLE, action(1)] }));
    }
    const game = analyzeSingle(builder);

    expect(game.dynamics.kite_pct).toBe(100);
    expect(game.dynamics.circle_pct).toBe(0);
    expect(game.dynamics.near_wall_pct).toBe(100);
    expect(game.dynamics.touching_wall_pct).toBe(0);
    expect(game.dynamics.mean_distance).toBe(552);
  });

  it('клиентские команды с поворотом 1, −1, 1 — две смены знака, обе полные', () => {
    const poses: [Pose, Pose] = [BOT_POSE, pose(400, LANE_Y)];
    const builder = startDuel().roundStart(0, 0).frames(countdownFrames(poses));
    builder.client(HUMAN, 'in seq=1 a=0.00,1.00,0.00,0');
    builder.client(HUMAN, 'in seq=2 a=0.50,-1.00,0.00,0');
    builder.client(HUMAN, 'in seq=3 a=0.50,1.00,0.00,1');
    builder.client(HUMAN, 'in seq=4 a=0.50,1.00,0.00,1');
    builder.client(HUMAN, 'in seq=5 a=0.50,-0.50,0.00,1');
    builder.client(HUMAN, 'in seq=6 a=broken');
    builder.client(HUMAN, 'in seq=7');
    builder.client(HUMAN, 'sec fps=60 worst=20 rtt=50 pend=1 snaps=30 ins=30');
    builder.client(HUMAN, 'sec fps=58 worst=25 rtt=70 pend=1 snaps=30 ins=30');
    builder.frames([fightFrame(poses), fightFrame(poses)]);
    const game = analyzeSingle(builder);

    expect(game.client_inputs).toMatchObject({
      inputs: 5,
      turn_sign_flips: 3,
      turn_full_flips: 2,
      turn_changes: 3,
      throttle_changes: 1,
    });
    expect(game.client_inputs.turn_changes_pct).toBe(60);
    expect(game.client.rtt_median).toBe(60);
    expect(game.client.fps_median).toBe(59);
  });

  it('шаги `in skip` среди команд — считаются пропущенными, идут в минуты игры, смены поворота не рвут', () => {
    const poses: [Pose, Pose] = [BOT_POSE, pose(400, LANE_Y)];
    const builder = startDuel().roundStart(0, 0).frames(countdownFrames(poses));
    builder.client(HUMAN, 'in seq=1 a=0.00,1.00,0.00,0');
    builder.client(HUMAN, 'in skip next=2');
    builder.client(HUMAN, 'in seq=2 a=0.00,-1.00,0.00,0');
    builder.client(HUMAN, 'in skip next=3');
    builder.frames([fightFrame(poses), fightFrame(poses)]);
    const game = analyzeSingle(builder);

    expect(game.client_inputs).toMatchObject({ inputs: 2, skipped_inputs: 2, turn_sign_flips: 1, turn_changes: 1 });
    expect(game.client_inputs.minutes).toBe(Math.round((4 / TICK_RATE / SECONDS_PER_MINUTE) * 100) / 100);
  });
});
