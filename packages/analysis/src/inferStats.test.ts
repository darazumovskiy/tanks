import { DT } from '@tanks/shared/engine';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeLogs, type GameSummary } from './index.js';
import {
  BOT,
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
  standingFrames,
  startDuel,
  type EventSpec,
  type LogBuilder,
  type Pose,
} from './logFixture.js';

const SHOT_INTERVAL_TICKS = 30;
const RICOCHET_AFTER_TICKS = 10;
const DRIVE_TICKS = 20;
const DRIVE_STEP = 5.9;
const KIT_HEAL = 25;
const BIG_HIT = 100;

function analyzeSingle(builder: LogBuilder): GameSummary {
  const dir = makeLogDir({ 'STAT.log': builder.text() });
  const [game] = analyzeLogs(dir, { outDir: join(dir, 'out') }).games;
  if (game === undefined) {
    throw new Error('игра не разобрана');
  }
  return game.summary;
}

// Человек проезжает вправо, останавливается и стреляет вдоль полосы; каждому выстрелу — рикошет на заданной скорости.
function shootingGame(measuredSpeeds: readonly number[]): LogBuilder {
  const bot = pose(1400, LANE_Y, Math.PI, Math.PI);
  const builder = startDuel()
    .roundStart(0, 0)
    .frames(countdownFrames([bot, pose(100, LANE_Y)]))
    .frames(repeatFrames(DRIVE_TICKS, (i) => fightFrame([bot, pose(100 + DRIVE_STEP * (i + 1), LANE_Y)])));
  const human = pose(100 + DRIVE_STEP * DRIVE_TICKS, LANE_Y);
  const muzzle = muzzleOf(human);
  builder.frames(standingFrames([bot, human], 2));
  for (const speed of measuredSpeeds) {
    const shot: EventSpec = { kind: 'shot', side: HUMAN, x: muzzle.x, y: muzzle.y, v: 0 };
    const distance = speed * (RICOCHET_AFTER_TICKS + 0.5) * DT;
    const ricochet: EventSpec = { kind: 'ricochet', side: HUMAN, x: muzzle.x + distance, y: LANE_Y };
    builder.frame(fightFrame([bot, human], { events: [shot] }));
    builder.frames(standingFrames([bot, human], RICOCHET_AFTER_TICKS - 1));
    builder.frame(fightFrame([bot, human], { events: [ricochet] }));
    builder.frames(standingFrames([bot, human], SHOT_INTERVAL_TICKS - RICOCHET_AFTER_TICKS - 1));
  }
  return builder;
}

afterEach(() => {
  removeLogDirs();
});

describe('характеристики по журналу', () => {
  it('скорость снаряда 650 по трём рикошетам 640–660; мотор и перезарядка по скорости и интервалу', () => {
    const game = analyzeSingle(shootingGame([640, 660, 650]));

    expect(game.human_stats).toMatchObject({
      bulletSpeed: 650,
      bulletSpeedRaw: 650,
      gun: 4,
      damage: 38,
      maxSpeedObserved: 177,
      engine: 3,
      minShotIntervalTicks: SHOT_INTERVAL_TICKS,
      reload: 2,
      armor: null,
      maxHpObserved: null,
    });
    expect(game.shooting_human.shots).toBe(3);
  });

  it('меньше трёх измерений — скорость по умолчанию 550', () => {
    const game = analyzeSingle(shootingGame([640, 660]));

    expect(game.human_stats.bulletSpeed).toBe(DEFAULT_BULLET_SPEED);
    expect(game.human_stats.bulletSpeedRaw).toBeNull();
    expect(game.human_stats.gun).toBe(2);
    expect(game.bot_stats).toMatchObject({ bulletSpeed: DEFAULT_BULLET_SPEED, engine: null, reload: null });
  });

  it('здоровье по урону в раунде со смертью: 200 урона и аптечка 25 дают 175', () => {
    const human: Pose = pose(800, 450);
    const bot: Pose = pose(300, LANE_Y);
    const poses: [Pose, Pose] = [bot, human];
    const builder = startDuel()
      .roundStart(0, 0)
      .frames(countdownFrames(poses))
      .frame(fightFrame(poses, { events: [{ kind: 'hit', side: HUMAN, x: 800, y: 450, v: BIG_HIT }] }))
      .frame(fightFrame(poses, { events: [{ kind: 'pickup', side: HUMAN, x: 800, y: 450, v: KIT_HEAL }] }))
      .frame(
        fightFrame(poses, {
          events: [
            { kind: 'hit', side: HUMAN, x: 800, y: 450, v: BIG_HIT },
            { kind: 'death', side: HUMAN, x: 800, y: 450 },
            { kind: 'roundOver', side: BOT },
          ],
        }),
      )
      .roundStart(1, 1, '1:0')
      .frames(countdownFrames(poses))
      .frame(fightFrame(poses, { events: [{ kind: 'hit', side: HUMAN, x: 800, y: 450, v: BIG_HIT }] }));
    const game = analyzeSingle(builder);

    expect(game.human_stats.maxHpObserved).toBe(2 * BIG_HIT - KIT_HEAL);
    expect(game.human_stats.armor).toBe(3);
    expect(game.shooting_human.kits).toBe(1);
    expect(game.shooting_human.deaths).toBe(1);
    expect(game.wins_bot).toBe(1);
  });
});
