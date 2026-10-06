import { BULLET_RADIUS, MUZZLE_OFFSET, TANK_RADIUS, TICK_RATE } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import {
  action,
  BOT,
  countdownFrames,
  DEFAULT_BULLET_SPEED,
  fightFrame,
  HUMAN,
  IDLE,
  pose,
  profileRoundsOf,
  roundOver,
  shotEvent,
  startDuel,
  type EventSpec,
  type LogAction,
  type Pose,
} from '../logFixture.js';
import { profileMetrics } from './index.js';

const OPEN_Y = 100;
const SHOT_TICK = 20;
const BOT_POSE = pose(200, OPEN_Y, 0, 0);
const HUMAN_START_X = 900;
const HUMAN_STEP = -4;
const REACT_TICKS = 7;
const SWERVE_STEP = 6;
const SUBSTEP_LENGTH = 6;

interface TickSpec {
  human: Pose;
  humanAction: LogAction;
  events: EventSpec[];
}

function roundLog(ticks: number, tickAt: (tick: number) => TickSpec, winner: 0 | 1 = BOT): string {
  const first = tickAt(0);
  const builder = startDuel()
    .roundStart(0, 0)
    .frames(countdownFrames([BOT_POSE, first.human]));
  for (let tick = 0; tick < ticks; tick++) {
    const spec = tickAt(tick);
    builder.frame(
      fightFrame([BOT_POSE, spec.human], {
        actions: [IDLE, spec.humanAction],
        events: tick === ticks - 1 ? [...spec.events, roundOver(winner)] : spec.events,
      }),
    );
  }
  return builder.text();
}

// Тик попадания по прямой: снаряд летит подшагами движка, танк едет навстречу с прежней скоростью.
function straightImpact(bulletX: number, humanX: number, humanStep: number): number {
  const perTick = DEFAULT_BULLET_SPEED / TICK_RATE;
  const substeps = Math.ceil(perTick / SUBSTEP_LENGTH);
  for (let k = 0; ; k++) {
    for (let s = 1; s <= substeps; s++) {
      const x = bulletX + perTick * k + (perTick * s) / substeps;
      if (humanX + humanStep * k - x < TANK_RADIUS + BULLET_RADIUS) {
        return k;
      }
    }
  }
}

describe('угрозы и уклонение', () => {
  it('снаряд бота в танк, едущий прямо; танк свернул — угроза, увернулся, время до попадания по прямой; реакция 7 тиков', () => {
    const humanAt = (tick: number): Pose => {
      const swerveStart = SHOT_TICK + REACT_TICKS;
      const x = HUMAN_START_X + HUMAN_STEP * Math.min(tick, swerveStart);
      const y = OPEN_Y + SWERVE_STEP * Math.max(0, tick - swerveStart);
      return pose(x, y, Math.PI, Math.PI);
    };
    const log = roundLog(
      220,
      (tick) => ({
        human: humanAt(tick),
        humanAction: tick < SHOT_TICK + REACT_TICKS ? action(1) : action(0.5),
        events: tick === SHOT_TICK ? [shotEvent(BOT, BOT_POSE)] : [],
      }),
      HUMAN,
    );
    const dodge = profileMetrics(profileRoundsOf({ 'DDGE.log': log })).dodge;

    expect(dodge.threatsOfBotShots).toMatchObject({ part: 1, total: 1 });
    expect(dodge.dodge.dodged).toMatchObject({ part: 1, total: 1 });
    expect(dodge.impactTicks?.median).toBe(
      straightImpact(BOT_POSE.x + MUZZLE_OFFSET, HUMAN_START_X + HUMAN_STEP * SHOT_TICK, HUMAN_STEP),
    );
    expect(dodge.reactTicks?.median).toBe(REACT_TICKS);
    expect(dodge.reacted.dodged).toMatchObject({ part: 1, total: 1 });
    expect(dodge.moving.dodged).toMatchObject({ part: 1, total: 1 });
    expect(dodge.botHitsNotThreat.total).toBe(0);
  });

  it('скорость танка для прямой езды — по смещению позы за 3 тика до выстрела бота', () => {
    // Танк тронулся за два тика до выстрела: за три тика он сместился на 8, а не на 12.
    const startTick = SHOT_TICK - 1;
    const humanAt = (tick: number): Pose =>
      pose(
        HUMAN_START_X + HUMAN_STEP * Math.max(0, tick - startTick + 1),
        OPEN_Y + (tick > SHOT_TICK ? 200 : 0),
        Math.PI,
        Math.PI,
      );
    const log = roundLog(
      220,
      (tick) => ({
        human: humanAt(tick),
        humanAction: action(1),
        events: tick === SHOT_TICK ? [shotEvent(BOT, BOT_POSE)] : [],
      }),
      HUMAN,
    );
    const dodge = profileMetrics(profileRoundsOf({ 'ACCL.log': log })).dodge;
    const shotX = humanAt(SHOT_TICK).x;

    expect(dodge.impactTicks?.median).toBe(
      straightImpact(BOT_POSE.x + MUZZLE_OFFSET, shotX, (shotX - HUMAN_START_X) / 3),
    );
  });

  it('снаряд сбит встречным — в отдельный счёт, в долю уклонения не входит', () => {
    // Дула в 550 друг от друга: снаряды сходятся в одной точке к концу 15-го тика полёта.
    const human = pose(BOT_POSE.x + 2 * MUZZLE_OFFSET + 550, OPEN_Y, Math.PI, Math.PI);
    const log = roundLog(200, (tick) => ({
      human,
      humanAction: action(0, 0, 1),
      events: tick === SHOT_TICK ? [shotEvent(BOT, BOT_POSE), shotEvent(HUMAN, human)] : [],
    }));
    const dodge = profileMetrics(profileRoundsOf({ 'CLSH.log': log })).dodge;

    expect(dodge.dodge.clashed).toMatchObject({ part: 1, total: 1 });
    expect(dodge.dodge.dodged).toMatchObject({ part: 0, total: 0 });
    expect(dodge.standing.clashed).toMatchObject({ part: 1, total: 1 });
  });

  it('раунд кончился раньше расчётного попадания — угроза не оценивается', () => {
    const human = pose(800, OPEN_Y, Math.PI, Math.PI);
    const events = (tick: number): EventSpec[] => {
      if (tick === SHOT_TICK) {
        return [shotEvent(BOT, BOT_POSE)];
      }
      return tick === SHOT_TICK + 5 ? [{ kind: 'death', side: BOT, x: BOT_POSE.x, y: BOT_POSE.y }] : [];
    };
    const cut = roundLog(200, (tick) => ({ human, humanAction: action(0, 0, 1), events: events(tick) }), HUMAN);
    const open = roundLog(
      SHOT_TICK + 5,
      (tick) => ({ human, humanAction: action(0, 0, 1), events: events(tick) }),
      HUMAN,
    );
    for (const log of [cut, open]) {
      const dodge = profileMetrics(profileRoundsOf({ 'LATE.log': log })).dodge;
      expect(dodge.threatsOfBotShots).toMatchObject({ part: 1, total: 1 });
      expect(dodge.dodge.dodged).toMatchObject({ part: 0, total: 0 });
      expect(dodge.impactTicks).toBeNull();
    }
  });

  it('гибель ровно в тик расчётного попадания — угроза оценивается', () => {
    const human = pose(800, OPEN_Y, Math.PI, Math.PI);
    const impact = straightImpact(BOT_POSE.x + MUZZLE_OFFSET, human.x, 0);
    const log = roundLog(
      200,
      (tick) => {
        const shot = tick === SHOT_TICK ? [shotEvent(BOT, BOT_POSE)] : [];
        const death = tick === SHOT_TICK + impact ? [{ kind: 'death', side: BOT, x: BOT_POSE.x, y: BOT_POSE.y }] : [];
        return { human, humanAction: action(0, 0, 1), events: [...shot, ...death] };
      },
      HUMAN,
    );
    const dodge = profileMetrics(profileRoundsOf({ 'EDGE.log': log })).dodge;

    expect(dodge.impactTicks).toMatchObject({ n: 1, median: impact });
  });

  it('попадание симуляции засчитано, только если в журнале есть попадание не дальше тика; без пары — увернулся', () => {
    const human = pose(800, OPEN_Y, Math.PI, Math.PI);
    const impact = straightImpact(BOT_POSE.x + MUZZLE_OFFSET, human.x, 0);
    const dodgeWithLogHitAfter = (lag: number | null): { dodged: number; total: number } => {
      const log = roundLog(
        200,
        (tick) => {
          const shot = tick === SHOT_TICK ? [shotEvent(BOT, BOT_POSE)] : [];
          const isHitTick = lag !== null && tick === SHOT_TICK + impact + lag;
          const hit = isHitTick ? [{ kind: 'hit', side: HUMAN, x: human.x, y: human.y, v: 1 }] : [];
          return { human, humanAction: action(0, 0, 1), events: [...shot, ...hit] };
        },
        HUMAN,
      );
      const { part, total } = profileMetrics(profileRoundsOf({ 'PAIR.log': log })).dodge.dodge.dodged;
      return { dodged: part, total };
    };

    expect(dodgeWithLogHitAfter(1)).toEqual({ dodged: 0, total: 1 });
    expect(dodgeWithLogHitAfter(2)).toEqual({ dodged: 1, total: 1 });
    expect(dodgeWithLogHitAfter(null)).toEqual({ dodged: 1, total: 1 });
  });

  it('фон: смена команды от каждого третьего тика видимости по тем же правилам', () => {
    const human = pose(800, OPEN_Y, Math.PI, Math.PI);
    const period = 6;
    const log = roundLog(200, (tick) => ({
      human,
      humanAction: Math.floor(tick / period) % 2 === 0 ? action(1) : action(0),
      events: tick === 0 ? [shotEvent(HUMAN, human)] : [],
    }));
    const baseline = profileMetrics(profileRoundsOf({ 'BASE.log': log })).dodge.baselineTicks;

    expect(baseline?.deciles[0]).toBe(period / 2);
    expect(baseline?.deciles[10]).toBe(period);
    expect(baseline?.n).toBe(Math.ceil(200 / 3) - 1);
  });
});
