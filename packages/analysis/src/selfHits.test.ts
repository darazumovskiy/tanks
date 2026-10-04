import { BULLET_RADIUS } from '@tanks/shared/engine';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeLogs, type GameSummary } from './index.js';
import {
  bulletTravel,
  countdownFrames,
  DEFAULT_DAMAGE,
  fightFrame,
  HUMAN,
  LANE_Y,
  makeLogDir,
  muzzleOf,
  pose,
  removeLogDirs,
  standingFrames,
  startDuel,
  type LogBuilder,
  type Pose,
} from './logFixture.js';

// Стена «Полигона» (330, 160, 44×200): снаряд упирается в неё на x = 325.
const WALL_FACE_X = 330 - BULLET_RADIUS;

function analyzeSingle(builder: LogBuilder): GameSummary {
  const dir = makeLogDir({ 'SELF.log': builder.text() });
  const [game] = analyzeLogs(dir, { outDir: join(dir, 'out') }).games;
  if (game === undefined) {
    throw new Error('игра не разобрана');
  }
  return game.summary;
}

interface Bounce {
  wallX: number;
  outTicks: number;
  backTicks: number;
}

// Человек стреляет по оси X, снаряд отскакивает от преграды на wallX и возвращается в стрелка.
function appendSelfHit(builder: LogBuilder, poses: [Pose, Pose], bounce: Bounce): LogBuilder {
  const human = poses[HUMAN];
  const muzzle = muzzleOf(human);
  const direction = Math.cos(human.turret) > 0 ? 1 : -1;
  const returnX = bounce.wallX - direction * bulletTravel(bounce.backTicks);
  return builder
    .frame(fightFrame(poses, { events: [{ kind: 'shot', side: HUMAN, x: muzzle.x, y: muzzle.y, v: human.turret }] }))
    .frames(standingFrames(poses, bounce.outTicks - 1))
    .frame(fightFrame(poses, { events: [{ kind: 'ricochet', side: HUMAN, x: bounce.wallX, y: human.y }] }))
    .frames(standingFrames(poses, bounce.backTicks - 1))
    .frame(fightFrame(poses, { events: [{ kind: 'hit', side: HUMAN, x: returnX, y: human.y, v: DEFAULT_DAMAGE }] }))
    .frames(standingFrames(poses, 5));
}

const POINT_BLANK: { poses: [Pose, Pose]; bounce: Bounce } = {
  poses: [pose(539, 260, Math.PI, Math.PI), pose(139, LANE_Y, 0, Math.PI)],
  bounce: { wallX: BULLET_RADIUS, outTicks: 5, backTicks: 6 },
};

afterEach(() => {
  removeLogDirs();
});

describe('самопопадания', () => {
  it('башня в край поля в 100 единицах, противник за стеной — «в упор в стену без цели», угол к нормали 0', () => {
    const builder = startDuel().roundStart(0, 0).frames(countdownFrames(POINT_BLANK.poses));
    const game = analyzeSingle(appendSelfHit(builder, POINT_BLANK.poses, POINT_BLANK.bounce));

    expect(game.self_hits).toMatchObject({
      count: 1,
      kinds: { 'в упор в стену без цели': 1 },
      incidence_median_deg: 0,
      wall_distance_median: 100,
      with_los: 0,
      standing: 1,
      toward_wall: 0,
      autofire_on: 0,
      damage: DEFAULT_DAMAGE,
      pct_of_shots: 100,
      pct_of_damage_taken: 100,
      flight_ticks_median: 11,
    });
  });

  it('башня на противника, стена между, танк едет в стену — «целился, но стена ближе»', () => {
    const poses: [Pose, Pose] = [pose(1000, 250, Math.PI, Math.PI), pose(200, 250)];
    const approaching: [Pose, Pose] = [poses[0], pose(195, 250)];
    const builder = startDuel().roundStart(0, 0).frames(countdownFrames(approaching));
    const game = analyzeSingle(appendSelfHit(builder, poses, { wallX: WALL_FACE_X, outTicks: 4, backTicks: 6 }));

    expect(game.self_hits.kinds).toEqual({ 'целился, но стена ближе': 1 });
    expect(game.self_hits.wall_distance_median).toBe(WALL_FACE_X - muzzleOf(poses[HUMAN]).x);
    expect(game.self_hits.with_los).toBe(0);
    expect(game.self_hits.toward_wall).toBe(1);
    expect(game.self_hits.standing).toBe(0);
    expect(game.shooting_human.self_hits).toBe(1);
  });

  it('выстрел вниз в стену: луч упирается в горизонтальную грань, нормаль по вертикали', () => {
    const poses: [Pose, Pose] = [pose(1200, 700, Math.PI, Math.PI), pose(352, LANE_Y, 0, Math.PI / 2)];
    const muzzle = muzzleOf(poses[HUMAN]);
    const wallTopY = 160 - BULLET_RADIUS;
    const builder = startDuel()
      .roundStart(0, 0)
      .frames(countdownFrames(poses))
      .frame(fightFrame(poses, { events: [{ kind: 'shot', side: HUMAN, x: muzzle.x, y: muzzle.y, v: Math.PI / 2 }] }))
      .frame(fightFrame(poses, { events: [{ kind: 'ricochet', side: HUMAN, x: muzzle.x, y: wallTopY }] }))
      .frames(standingFrames(poses, 2))
      .frame(
        fightFrame(poses, { events: [{ kind: 'hit', side: HUMAN, x: muzzle.x, y: LANE_Y + 10, v: DEFAULT_DAMAGE }] }),
      )
      .frames(standingFrames(poses, 3));
    const game = analyzeSingle(builder);

    expect(game.self_hits.count).toBe(1);
    expect(game.self_hits.wall_distance_median).toBe(wallTopY - muzzle.y);
    expect(game.self_hits.incidence_median_deg).toBe(0);
  });

  it('авто-огонь включён до выстрела и сброшен новым раундом: первый возврат с авто-огнём, второй — без', () => {
    const builder = startDuel().roundStart(0, 0).frames(countdownFrames(POINT_BLANK.poses));
    builder.client(HUMAN, 'autofire on=1');
    appendSelfHit(builder, POINT_BLANK.poses, POINT_BLANK.bounce);
    builder.roundStart(1, 0, '0:0').frames(countdownFrames(POINT_BLANK.poses));
    builder.client(HUMAN, 'net roundstart game=TEST idx=1 map=0 score=0:0');
    appendSelfHit(builder, POINT_BLANK.poses, POINT_BLANK.bounce);
    const game = analyzeSingle(builder);

    expect(game.self_hits.count).toBe(2);
    expect(game.self_hits.autofire_on).toBe(1);
    expect(game.client.autofire_on_count).toBe(1);
  });

  it('два возврата издалека в одном раунде, когда ни цели, ни стены рядом — «рикошет издалека вернулся»', () => {
    const poses: [Pose, Pose] = [pose(800, 700, Math.PI, Math.PI), pose(600, LANE_Y, 0, Math.PI)];
    const bounce = { wallX: BULLET_RADIUS, outTicks: 30, backTicks: 31 };
    const builder = startDuel().roundStart(0, 0).frames(countdownFrames(poses));
    appendSelfHit(builder, poses, bounce);
    appendSelfHit(builder, poses, bounce);
    const game = analyzeSingle(builder);

    expect(game.self_hits.kinds).toEqual({ 'рикошет издалека вернулся': 2 });
    expect(game.self_hits.flight_ticks_median).toBe(61);
  });
});
