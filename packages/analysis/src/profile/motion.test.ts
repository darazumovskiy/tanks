import { TICK_RATE } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import {
  action,
  countdownFrames,
  fightFrame,
  HUMAN,
  IDLE,
  pose,
  profileRoundsOf,
  roundOver,
  shotEvent,
  startDuel,
  type LogAction,
  type Pose,
} from '../logFixture.js';
import { profileMetrics } from './index.js';

const OPEN_Y = 100;
const BOT_POSE = pose(1400, OPEN_Y, Math.PI, Math.PI);

interface TickSpec {
  human: Pose;
  humanAction: LogAction;
}

// Раунд выигран человеком — входит в выборку при любом бое; выстрел на первом тике.
function roundLog(ticks: number, tickAt: (tick: number) => TickSpec): string {
  const first = tickAt(0);
  const builder = startDuel()
    .roundStart(0, 0)
    .frames(countdownFrames([BOT_POSE, first.human]));
  for (let tick = 0; tick < ticks; tick++) {
    const spec = tickAt(tick);
    const events = tick === 0 ? [shotEvent(HUMAN, spec.human)] : [];
    builder.frame(
      fightFrame([BOT_POSE, spec.human], {
        actions: [IDLE, spec.humanAction],
        events: tick === ticks - 1 ? [...events, roundOver(HUMAN)] : events,
      }),
    );
  }
  return builder.text();
}

describe('движение', () => {
  it('газ на прямой — только тики с поворотом меньше 0,3', () => {
    const log = roundLog(60, (tick) => ({
      human: pose(200 + 3 * tick, OPEN_Y),
      humanAction: tick % 2 === 0 ? action(0.8) : action(0.4, 0.5),
    }));
    const straight = profileMetrics(profileRoundsOf({ 'STRT.log': log })).movement.straightThrottle;

    expect(straight).toMatchObject({ n: 30, median: 0.8 });
    expect(straight?.deciles[0]).toBe(0.8);
    expect(straight?.deciles[10]).toBe(0.8);
  });

  it('оси, задний ход, смены хода, скорость, кайтинг, видимость и стены', () => {
    const half = 60;
    const step = 4;
    // Первая половина — от противника налево с башней назад, вторая — задним ходом обратно.
    const log = roundLog(2 * half, (tick) => {
      const x = tick < half ? 800 - step * tick : 800 - step * half + step * (tick - half);
      return {
        human: pose(x, OPEN_Y, Math.PI, 0),
        humanAction: tick < half ? action(1) : action(-1),
      };
    });
    const movement = profileMetrics(profileRoundsOf({ 'AXES.log': log })).movement;
    const ticks = 2 * half;

    expect(movement.ticks).toBe(ticks);
    expect(movement.throttle['±1']).toMatchObject({ part: ticks, total: ticks });
    expect(movement.turn['0']).toMatchObject({ part: ticks, total: ticks });
    expect(movement.reverse).toMatchObject({ part: half, total: ticks });
    expect(movement.fullThrottle).toMatchObject({ part: ticks, total: ticks });
    expect(movement.flipsPerMinute).toBeCloseTo(1 / (ticks / TICK_RATE / 60), 6);
    expect(movement.speed?.median).toBeCloseTo(step * TICK_RATE, 6);
    expect(movement.kite).toMatchObject({ part: half, total: ticks });
    // Тик 0 — с места; поворот назад виден по позам на тик позже смены газа.
    expect(movement.motionBySight.still.sight).toMatchObject({ part: 1, total: ticks });
    expect(movement.motionBySight.away.sight).toMatchObject({ part: half, total: ticks });
    expect(movement.motionBySight.toward.sight).toMatchObject({ part: half - 1, total: ticks });
    // Весь ход дальше 600: угол 180° от противника и 0° к нему, стоящий тик в угол не идёт.
    const far = movement.courseDeg.sight['>600'];
    expect(far?.n).toBe(ticks - 1);
    expect(far?.deciles[0]).toBeCloseTo(0, 6);
    expect(far?.deciles[10]).toBeCloseTo(180, 6);
    expect(movement.courseAllDeg).toEqual(far);
    expect(movement.courseDeg.sight['<300']).toBeNull();
    expect(Object.values(movement.courseDeg.hidden).every((value) => value === null)).toBe(true);
    expect(movement.sight).toMatchObject({ part: ticks, total: ticks });
    expect(movement.wallDistance?.median).toBeCloseTo(OPEN_Y, 6);
    expect(movement.nearWall.part).toBe(0);
  });
});

describe('кружение', () => {
  it('дуга вокруг противника на постоянной дистанции — кружение на всех тиках, кроме первого', () => {
    const radius = 300;
    const step = 4 / radius;
    const ticks = 60;
    const log = roundLog(ticks, (tick) => {
      const angle = Math.PI / 2 + step * tick;
      const x = BOT_POSE.x + radius * Math.cos(angle);
      const y = BOT_POSE.y + radius * Math.sin(angle);
      return { human: pose(x, y, angle + Math.PI / 2, 0), humanAction: action(1, 0.5) };
    });
    const movement = profileMetrics(profileRoundsOf({ 'CIRC.log': log })).movement;

    expect(movement.circle).toMatchObject({ part: ticks - 1, total: ticks });
    // Часть дуги за стеной: тики делятся между «на виду» и «не виден» по той же видимости, что movement.sight.
    const { sight, hidden } = movement.motionBySight.side;
    expect(sight.total).toBe(movement.sight.part);
    expect(hidden.total).toBe(ticks - movement.sight.part);
    expect(hidden.total).toBeGreaterThan(0);
    expect(sight.part + hidden.part).toBe(ticks - 1);
    const courses = [...Object.values(movement.courseDeg.sight), ...Object.values(movement.courseDeg.hidden)];
    expect(courses.reduce((total, course) => total + (course?.n ?? 0), 0)).toBe(ticks - 1);
    for (const course of courses) {
      expect(course === null || Math.abs(course.median - 90) < 1).toBe(true);
    }
    expect(movement.sideRunTicks).toMatchObject({ n: 1, median: ticks - 1 });
    expect(movement.distance?.median).toBeCloseTo(radius, 0);
  });
});

describe('отрезки сближения и отдаления', () => {
  const run = 40;
  const lane = (x: number): TickSpec => ({ human: pose(x, OPEN_Y), humanAction: action(1) });

  it('от противника, к нему и снова от него — в счёт только средний отрезок', () => {
    const log = roundLog(3 * run, (tick) => {
      if (tick < run) {
        return lane(800 - 4 * tick);
      }
      return tick < 2 * run ? lane(640 + 4 * (tick - run)) : lane(800 - 4 * (tick - 2 * run));
    });
    const movement = profileMetrics(profileRoundsOf({ 'RADL.log': log })).movement;

    expect(movement.radialRunTicks).toMatchObject({ n: 1, median: run });
  });

  it('дистанция меняется на 2 за тик и медленнее — направление не переключается', () => {
    const log = roundLog(3 * run, (tick) => {
      if (tick < run) {
        return lane(800 - 4 * tick);
      }
      return tick < 2 * run ? lane(640 + 2 * (tick - run)) : lane(720 - 4 * (tick - 2 * run));
    });
    const movement = profileMetrics(profileRoundsOf({ 'SLOW.log': log })).movement;

    expect(movement.radialRunTicks).toBeNull();
  });
});

describe('отрезки хода поперёк линии', () => {
  const leg = 30;
  const step = 4;
  // Поперёк линии на противника — по вертикали; вставка — ход к противнику по горизонтали.
  function sideLog(gap: number, secondSign: number): string {
    return roundLog(2 * leg + gap, (tick) => {
      if (tick < leg) {
        return { human: pose(800, OPEN_Y + step * tick), humanAction: action(1) };
      }
      const turnY = OPEN_Y + step * (leg - 1);
      if (tick < leg + gap) {
        return { human: pose(800 + step * (tick - leg + 1), turnY), humanAction: action(1) };
      }
      const x = 800 + step * gap;
      return { human: pose(x, turnY + secondSign * step * (tick - leg - gap + 1)), humanAction: action(1) };
    });
  }
  it('перерыв в ходе поперёк до 0,5 с не рвёт отрезок, длиннее — рвёт', () => {
    const gap = TICK_RATE / 2;
    const merged = profileMetrics(profileRoundsOf({ 'SIDE.log': sideLog(gap, 1) })).movement.sideRunTicks;
    const split = profileMetrics(profileRoundsOf({ 'SIDE.log': sideLog(gap + 1, 1) })).movement.sideRunTicks;

    expect(merged).toMatchObject({ n: 1, median: 2 * leg - 1 });
    expect(split?.n).toBe(2);
    expect(split?.deciles[0]).toBe(leg - 1);
  });

  it('смена стороны закрывает отрезок сразу', () => {
    const flipped = profileMetrics(profileRoundsOf({ 'SIDE.log': sideLog(0, -1) })).movement.sideRunTicks;

    expect(flipped?.n).toBe(2);
    expect(flipped?.deciles[0]).toBe(leg - 1);
    expect(flipped?.deciles[10]).toBe(leg);
  });
});

describe('позиция', () => {
  const still = (x: number): TickSpec => ({ human: pose(x, OPEN_Y), humanAction: action(0, 0, 0, true) });

  it('стоит 3 с с зажатым огнём, сдвигается на 0,5 с и снова стоит 2 с — один отрезок позиции', () => {
    const stand = 3 * TICK_RATE;
    const move = TICK_RATE / 2;
    const again = 2 * TICK_RATE;
    const total = 1 + stand + move + again;
    const log = roundLog(total, (tick) => {
      if (tick <= stand) {
        return still(400);
      }
      if (tick <= stand + move) {
        return { human: pose(400 + 4 * (tick - stand), OPEN_Y), humanAction: action(1) };
      }
      return still(400 + 4 * move);
    });
    const position = profileMetrics(profileRoundsOf({ 'HOLD.log': log })).position;

    expect(position.segments).toBe(1);
    expect(position.segmentS?.median).toBeCloseTo(total / TICK_RATE, 6);
    expect(position.share).toMatchObject({ part: total, total });
    expect(position.holdStyleRounds).toHaveLength(1);
    expect(position.peeksS).toMatchObject({ n: 1, median: move / TICK_RATE });
    expect(position.segmentSightRunsS).toMatchObject({ n: 1, median: total / TICK_RATE });
    expect(position.sightRunsStartedStill).toMatchObject({ part: 1, total: 1 });
  });

  it('отрезки позиции сливаются, только если сдвиг между ними короче 1 с', () => {
    const segmentsAfterMove = (move: number): number => {
      const stand = 2 * TICK_RATE;
      const log = roundLog(1 + 2 * stand + move, (tick) => {
        if (tick <= stand) {
          return still(400);
        }
        if (tick <= stand + move) {
          return { human: pose(400 + 4 * (tick - stand), OPEN_Y), humanAction: action(1) };
        }
        return still(400 + 4 * move);
      });
      return profileMetrics(profileRoundsOf({ 'MERG.log': log })).position.segments;
    };

    expect(segmentsAfterMove(TICK_RATE - 1)).toBe(1);
    expect(segmentsAfterMove(TICK_RATE)).toBe(2);
  });

  it('стоит 3 с без башни и огня — не позиция; стоит 0,5 с с огнём — не позиция', () => {
    const idle = roundLog(3 * TICK_RATE, () => ({ human: pose(400, OPEN_Y), humanAction: IDLE }));
    const short = roundLog(2 * TICK_RATE, (tick) =>
      tick < TICK_RATE / 2 ? still(400) : { human: pose(400 + 4 * tick, OPEN_Y), humanAction: action(1) },
    );
    for (const log of [idle, short]) {
      const position = profileMetrics(profileRoundsOf({ 'NOPE.log': log })).position;
      expect(position.segments).toBe(0);
      expect(position.share.part).toBe(0);
    }
  });
});
