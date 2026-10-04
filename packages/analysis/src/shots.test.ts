import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { leadPoint } from './geometry.js';
import { analyzeLogs, type GameSummary } from './index.js';
import {
  countdownFrames,
  DEFAULT_BULLET_SPEED,
  fightFrame,
  HUMAN,
  LANE_Y,
  makeLogDir,
  muzzleOf,
  pose,
  removeLogDirs,
  repeatFrames,
  startDuel,
  type Frame,
  type LogBuilder,
  type Pose,
} from './logFixture.js';

const SHOT_FRAME = 5;
const BOT_STEP_PER_TICK = 4;
const BOT_START_Y = 150;
const AIM_TICKS = 45;

function analyzeSingle(builder: LogBuilder): GameSummary {
  const dir = makeLogDir({ 'SHOT.log': builder.text() });
  const [game] = analyzeLogs(dir, { outDir: join(dir, 'out') }).games;
  if (game === undefined) {
    throw new Error('игра не разобрана');
  }
  return game.summary;
}

// Человек стоит и стреляет на пятом кадре боя; бот либо стоит, либо едет поперёк вниз по полю.
function shotScenario(human: Pose, botAt: (frame: number) => Pose): LogBuilder {
  const builder = startDuel()
    .roundStart(0, 0)
    .frames(countdownFrames([botAt(0), human]));
  const frames: Frame[] = repeatFrames(20, (i) => {
    const poses: [Pose, Pose] = [botAt(i), human];
    if (i !== SHOT_FRAME) {
      return fightFrame(poses);
    }
    const muzzle = muzzleOf(human);
    return fightFrame(poses, { events: [{ kind: 'shot', side: HUMAN, x: muzzle.x, y: muzzle.y, v: human.turret }] });
  });
  return builder.frames(frames);
}

function standingBot(x: number, y: number): (frame: number) => Pose {
  return () => pose(x, y, Math.PI, Math.PI);
}

function crossingBot(frame: number): Pose {
  return pose(800, BOT_START_Y + BOT_STEP_PER_TICK * frame, Math.PI / 2, Math.PI);
}

function roundTurret(angle: number): number {
  return Math.round(angle * 100) / 100;
}

function botAtShot(): Pose {
  return crossingBot(SHOT_FRAME);
}

afterEach(() => {
  removeLogDirs();
});

describe('выстрелы человека', () => {
  it('по стоящему противнику с ошибкой меньше углового размера — «стоящий: в цель», больше — «мимо»', () => {
    const onTarget = analyzeSingle(shotScenario(pose(200, LANE_Y), standingBot(800, LANE_Y)));
    expect(onTarget.shot_kinds).toEqual({ 'стоящий: в цель': 1 });
    expect(onTarget.shots_standing).toEqual({ shots: 1, hits: 0, pct: 0 });
    expect(onTarget.shots_moving.shots).toBe(0);
    expect(onTarget.shots_by_bucket['>600']?.shots).toBe(1);
    expect(onTarget.shot_distance_median).toBe(600);
    expect(onTarget.err_cur_median_deg).toBe(0);

    const offTarget = analyzeSingle(shotScenario(pose(200, LANE_Y, 0, 0.17), standingBot(800, LANE_Y)));
    expect(offTarget.shot_kinds).toEqual({ 'стоящий: мимо': 1 });
    expect(offTarget.err_cur_median_deg).toBeCloseTo(9.7, 1);
  });

  it('противник едет поперёк, башня на точке упреждения — «упреждение», доля упреждения ≈ 1', () => {
    const human = pose(200, LANE_Y);
    const bot = botAtShot();
    const lead = leadPoint(human, bot, { x: 0, y: BOT_STEP_PER_TICK * 30 }, DEFAULT_BULLET_SPEED);
    human.turret = roundTurret(Math.atan2(lead.y - human.y, lead.x - human.x));
    const game = analyzeSingle(shotScenario(human, crossingBot));

    expect(game.shot_kinds).toEqual({ упреждение: 1 });
    expect(game.lead_share_pct).toBe(100);
    expect(game.shots_moving.shots).toBe(1);
    expect(game.lead_fraction_median).toBeCloseTo(1, 1);
    expect(game.rounds[0]?.human_lead_pct).toBe(100);
  });

  it('башня на корпусе движущегося — «текущее», доля ≈ 0', () => {
    const human = pose(200, LANE_Y);
    const bot = botAtShot();
    human.turret = roundTurret(Math.atan2(bot.y - human.y, bot.x - human.x));
    const game = analyzeSingle(shotScenario(human, crossingBot));

    expect(game.shot_kinds).toEqual({ текущее: 1 });
    expect(game.lead_share_pct).toBe(0);
    expect(game.lead_fraction_median).toBeCloseTo(0, 1);
  });

  it('медленный противник вблизи: корпус и упреждение оба в размере — выбирается меньшая ошибка', () => {
    const human = pose(200, LANE_Y);
    const slowBot = (frame: number): Pose => pose(400, 150 + 1.2 * frame, Math.PI / 2, Math.PI);
    const bot = slowBot(SHOT_FRAME);
    const lead = leadPoint(human, bot, { x: 0, y: 36 }, DEFAULT_BULLET_SPEED);
    human.turret = roundTurret(Math.atan2(lead.y - human.y, lead.x - human.x));
    const onLead = analyzeSingle(shotScenario(human, slowBot));
    expect(onLead.shot_kinds).toEqual({ упреждение: 1 });

    human.turret = roundTurret(Math.atan2(bot.y - human.y, bot.x - human.x));
    const onHull = analyzeSingle(shotScenario(human, slowBot));
    expect(onHull.shot_kinds).toEqual({ текущее: 1 });
    expect(onHull.shots_by_bucket['<300']?.shots).toBe(1);
  });

  it('выстрел на первом тике раунда не разбирается: нет предыдущего тика для скорости противника', () => {
    const human = pose(200, LANE_Y);
    const bot = pose(800, LANE_Y, Math.PI, Math.PI);
    const muzzle = muzzleOf(human);
    const builder = startDuel()
      .roundStart(0, 0)
      .frame(fightFrame([bot, human], { events: [{ kind: 'shot', side: HUMAN, x: muzzle.x, y: muzzle.y, v: 0 }] }))
      .frames(repeatFrames(5, () => fightFrame([bot, human])));
    const game = analyzeSingle(builder);

    expect(game.shooting_human.shots).toBe(1);
    expect(game.shot_kinds).toEqual({});
  });

  it('башня мимо корпуса и точки упреждения — «мимо обоих»', () => {
    const game = analyzeSingle(shotScenario(pose(200, LANE_Y, 0, 0.5), crossingBot));

    expect(game.shot_kinds).toEqual({ 'мимо обоих': 1 });
    expect(game.lead_fraction_median).toBeGreaterThan(1);
  });

  it('стена между танками — выстрел без прямой видимости, ошибка башни при видимости не считается', () => {
    const game = analyzeSingle(shotScenario(pose(500, 322), standingBot(900, 322)));

    expect(game.shots_no_los).toEqual({ shots: 1, hits: 0, pct: 0 });
    expect(game.rounds[0]?.human_los_pct).toBe(0);
    expect(game.aim_err_median_deg).toBeNull();
    expect(game.aim_err_under5_pct).toBeNull();
  });

  it('ошибка башни больше 30°, через 45 тиков меньше 5° — время наведения 45; доля тиков под 5°', () => {
    const bot = pose(800, LANE_Y, Math.PI, Math.PI);
    const builder = startDuel()
      .roundStart(0, 0)
      .frames(countdownFrames([bot, pose(200, LANE_Y, 0, 0.6)]));
    builder.frames(repeatFrames(60, (i) => fightFrame([bot, pose(200, LANE_Y, 0, i < AIM_TICKS ? 0.6 : 0)])));
    const game = analyzeSingle(builder);

    expect(game.aim_time_ticks).toEqual([AIM_TICKS]);
    expect(game.aim_time_median_ticks).toBe(AIM_TICKS);
    expect(game.aim_err_under5_pct).toBe(25);
    expect(game.aim_err_median_deg).toBeCloseTo(34.4, 1);
  });
});
