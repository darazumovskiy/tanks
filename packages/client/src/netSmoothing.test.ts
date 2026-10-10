import { describe, expect, it } from 'vitest';
import { DT } from '@tanks/shared/engine';
import {
  bracketByTick,
  INTERPOLATION_MARGIN_TICKS,
  INTERPOLATION_MAX_TICKS,
  INTERPOLATION_MIN_TICKS,
  JITTER_WINDOW_MS,
  OthersTiming,
  OWN_SMOOTHING_MS,
  OWN_SNAP_DISTANCE,
  OwnSmoothing,
  PLAYOUT_MAX_BEHIND_TICKS,
  PLAYOUT_RATE_SHIFT,
  PLAYOUT_SNAP_TICKS,
  PlayoutClock,
  shiftNearOwn,
  SnapshotJitter,
  type Pose,
} from './netSmoothing.js';
import { PICTURE_NEAR, type PictureBullet, type PictureClock } from './pictureTime.js';

const TICK_MS = DT * 1000;
const FRAME_MS = 1000 / 60;

// Снимок тика игры k сервер шлёт в k·33,3 мс; сеть отдаёт его на ближайшей границе пачек с шагом burstMs.
function burstArrival(gameTick: number, burstMs: number): number {
  const sentAt = gameTick * TICK_MS;
  return Math.ceil(sentAt / burstMs - 1e-9) * burstMs;
}

// Наибольшее ожидание снимка до границы пачки.
function worstWaitMs(burstMs: number, ticks: number): number {
  let worst = 0;
  for (let tick = 0; tick < ticks; tick++) {
    worst = Math.max(worst, burstArrival(tick, burstMs) - tick * TICK_MS);
  }
  return worst;
}

function feed(jitter: SnapshotJitter, fromTick: number, toTick: number, arrival: (tick: number) => number): void {
  for (let tick = fromTick; tick < toTick; tick++) {
    jitter.note(tick, arrival(tick));
  }
}

describe('неровность прихода снимков', () => {
  it('замер пуст — отставание как без сглаживания', () => {
    const jitter = new SnapshotJitter();
    expect(jitter.delayTicks).toBe(INTERPOLATION_MIN_TICKS);
    expect(jitter.earliestOffsetMs).toBeNull();
  });

  it('ровные снимки с шумом ±3 мс — два тика', () => {
    const jitter = new SnapshotJitter();
    feed(jitter, 0, 120, (tick) => 500 + tick * TICK_MS + (tick % 3) * 3 - 3);
    expect(jitter.delayTicks).toBe(INTERPOLATION_MIN_TICKS);
    expect(jitter.earliestOffsetMs).toBeCloseTo(497, 9);
  });

  it('пачки раз в 200 и 250 мс — отставание под самое долгое ожидание; раз в 400 мс — предел', () => {
    for (const burstMs of [200, 250]) {
      const jitter = new SnapshotJitter();
      feed(jitter, 0, 90, (tick) => burstArrival(tick, burstMs));
      const expected = 1 + worstWaitMs(burstMs, 90) / TICK_MS + INTERPOLATION_MARGIN_TICKS;
      expect(jitter.delayTicks).toBeCloseTo(expected, 9);
    }
    expect(1 + worstWaitMs(200, 90) / TICK_MS + INTERPOLATION_MARGIN_TICKS).toBeCloseTo(6.25, 9);
    const slow = new SnapshotJitter();
    feed(slow, 0, 90, (tick) => burstArrival(tick, 400));
    expect(slow.delayTicks).toBe(INTERPOLATION_MAX_TICKS);
  });

  it('после пачек ровная сеть дольше окна замера — снова два тика', () => {
    const jitter = new SnapshotJitter();
    const burstTicks = 60;
    feed(jitter, 0, burstTicks, (tick) => burstArrival(tick, 200));
    expect(jitter.delayTicks).toBeGreaterThan(INTERPOLATION_MIN_TICKS);
    const evenTicks = Math.ceil((JITTER_WINDOW_MS + 100) / TICK_MS);
    feed(jitter, burstTicks, burstTicks + evenTicks, (tick) => tick * TICK_MS + 5);
    expect(jitter.delayTicks).toBe(INTERPOLATION_MIN_TICKS);
  });

  it('сброс забывает замер', () => {
    const jitter = new SnapshotJitter();
    feed(jitter, 0, 30, (tick) => burstArrival(tick, 400));
    jitter.reset();
    expect(jitter.delayTicks).toBe(INTERPOLATION_MIN_TICKS);
    expect(jitter.earliestOffsetMs).toBeNull();
  });
});

describe('время картинки чужих', () => {
  it('первый вызов — нужный тик, но не дальше последнего снимка', () => {
    expect(new PlayoutClock().advance(0, 10, 20)).toBe(10);
    expect(new PlayoutClock().advance(0, 10, 7)).toBe(7);
  });

  it('нужное отставание выросло на 7 тиков — время замедляется не больше чем до 0,8 и догоняет', () => {
    const clock = new PlayoutClock();
    let now = 0;
    let tick = clock.advance(now, 100 - 2, 100);
    const targetAt = (time: number): number => 100 + time / TICK_MS - 9;
    let caughtAt: number | null = null;
    for (let frame = 0; frame < 120; frame++) {
      now += FRAME_MS;
      const next = clock.advance(now, targetAt(now), 100 + now / TICK_MS);
      const step = (next - tick) / (FRAME_MS / TICK_MS);
      expect(step).toBeGreaterThanOrEqual(1 - PLAYOUT_RATE_SHIFT - 1e-9);
      expect(step).toBeLessThanOrEqual(1 + 1e-9);
      tick = next;
      if (caughtAt === null && Math.abs(tick - targetAt(now)) < 0.05) {
        caughtAt = now;
      }
    }
    expect(caughtAt).not.toBeNull();
    expect(caughtAt ?? Infinity).toBeLessThan(1500);
  });

  it('нужное отставание упало — время ускоряется не больше чем до 1,2', () => {
    const clock = new PlayoutClock();
    let now = 0;
    let tick = clock.advance(now, 100 - 9, 100);
    for (let frame = 0; frame < 120; frame++) {
      now += FRAME_MS;
      const next = clock.advance(now, 100 + now / TICK_MS - 2, 100 + now / TICK_MS);
      const step = (next - tick) / (FRAME_MS / TICK_MS);
      expect(step).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(step).toBeLessThanOrEqual(1 + PLAYOUT_RATE_SHIFT + 1e-9);
      tick = next;
    }
    expect(tick).toBeCloseTo(100 + now / TICK_MS - 2, 1);
  });

  it('расхождение больше предела — время переставляется сразу', () => {
    const clock = new PlayoutClock();
    clock.advance(0, 100, 1000);
    expect(clock.advance(FRAME_MS, 100 + PLAYOUT_SNAP_TICKS + 5, 1000)).toBe(100 + PLAYOUT_SNAP_TICKS + 5);
  });

  it('снимок опоздал в пределах отставания — время стоит на последнем, потом догоняет не быстрее 1,2', () => {
    const clock = new PlayoutClock();
    let now = 0;
    let tick = clock.advance(now, 50, 52);
    for (let frame = 0; frame < 20; frame++) {
      now += FRAME_MS;
      tick = clock.advance(now, 50 + now / TICK_MS, 52);
    }
    expect(tick).toBe(52);
    for (let frame = 0; frame < 30; frame++) {
      now += FRAME_MS;
      const next = clock.advance(now, 50 + now / TICK_MS, 52 + now / TICK_MS);
      expect((next - tick) / (FRAME_MS / TICK_MS)).toBeLessThanOrEqual(1 + PLAYOUT_RATE_SHIFT + 1e-9);
      tick = next;
    }
  });

  it('пауза снимков дольше замеренной — после неё время сразу у нужного, а не догоняет', () => {
    const clock = new PlayoutClock();
    let now = 0;
    clock.advance(now, 50, 52);
    for (let frame = 0; frame < 40; frame++) {
      now += FRAME_MS;
      clock.advance(now, 50 + now / TICK_MS, 52);
    }
    const target = 50 + (now + FRAME_MS) / TICK_MS;
    const latest = 52 + PLAYOUT_MAX_BEHIND_TICKS + 10;
    expect(clock.advance(now + FRAME_MS, target, latest)).toBe(target);
    expect(target - 52).toBeGreaterThan(PLAYOUT_MAX_BEHIND_TICKS / 2);
  });

  it('замер и время вместе: ровная сеть — тик игры на два позади, без снимков — последний', () => {
    const timing = new OthersTiming();
    expect(timing.gameTickAt(1000, 7)).toBe(7);
    for (let tick = 0; tick < 60; tick++) {
      timing.note(tick, 300 + tick * TICK_MS);
    }
    const now = 300 + 59 * TICK_MS + 10;
    expect(timing.gameTickAt(now, 59)).toBeCloseTo((now - 300) / TICK_MS - INTERPOLATION_MIN_TICKS, 9);
    expect(timing.delayTicks).toBe(INTERPOLATION_MIN_TICKS);
    timing.reset();
    expect(timing.gameTickAt(now, 59)).toBe(59);
  });
});

describe('снимки вокруг тика', () => {
  const snapshots = [{ tick: 10 }, { tick: 11 }, { tick: 13 }];
  const tickOf = (item: { tick: number }): number => item.tick;

  it('между двумя — соседние и доля; через пропуск — линейно', () => {
    expect(bracketByTick(snapshots, tickOf, 10.25)).toEqual({ older: snapshots[0], newer: snapshots[1], t: 0.25 });
    expect(bracketByTick(snapshots, tickOf, 12)).toEqual({ older: snapshots[1], newer: snapshots[2], t: 0.5 });
  });

  it('раньше первого — первый; позже последнего — последний; пусто — null', () => {
    expect(bracketByTick(snapshots, tickOf, 3)).toEqual({ older: snapshots[0], newer: snapshots[0], t: 1 });
    expect(bracketByTick(snapshots, tickOf, 20)).toEqual({ older: snapshots[2], newer: snapshots[2], t: 1 });
    expect(bracketByTick([], tickOf, 1)).toBeNull();
  });
});

function pose(x: number, y = 0, heading = 0, turret = 0): Pose {
  return { x, y, heading, turret };
}

describe('свой танк догоняет поправку', () => {
  it('поправка 20: в миг снимка танк на прежнем месте, за 60 мс — половина, за 120 мс — ноль', () => {
    const smoothing = new OwnSmoothing();
    smoothing.correct(pose(100), pose(80), 1000);
    expect(smoothing.at(1000).x).toBeCloseTo(20, 9);
    expect(smoothing.at(1000 + OWN_SMOOTHING_MS / 2).x).toBeCloseTo(10, 9);
    expect(smoothing.at(1000 + OWN_SMOOTHING_MS).x).toBe(0);
    expect(smoothing.at(1000 + 5 * OWN_SMOOTHING_MS).x).toBe(0);
  });

  it('две поправки подряд складываются, отсчёт — от второй', () => {
    const smoothing = new OwnSmoothing();
    smoothing.correct(pose(100), pose(90), 1000);
    smoothing.correct(pose(50), pose(40), 1000 + OWN_SMOOTHING_MS / 2);
    expect(smoothing.at(1000 + OWN_SMOOTHING_MS / 2).x).toBeCloseTo(15, 9);
    expect(smoothing.at(1000 + OWN_SMOOTHING_MS).x).toBeCloseTo(7.5, 9);
  });

  it('снимок без поправки не начинает отсчёт заново', () => {
    const smoothing = new OwnSmoothing();
    smoothing.correct(pose(100), pose(80), 1000);
    smoothing.correct(pose(80), pose(80), 1000 + OWN_SMOOTHING_MS / 2);
    expect(smoothing.at(1000 + OWN_SMOOTHING_MS).x).toBe(0);
  });

  it('поправка дальше предела, суммарное смещение дальше предела, танка нет — сразу ноль', () => {
    const far = new OwnSmoothing();
    far.correct(pose(0), pose(OWN_SNAP_DISTANCE + 10), 0);
    expect(far.at(0)).toEqual(pose(0));
    const piled = new OwnSmoothing();
    piled.correct(pose(0), pose(-OWN_SNAP_DISTANCE * 0.7), 0);
    piled.correct(pose(0), pose(-OWN_SNAP_DISTANCE * 0.7), 0);
    expect(piled.at(0)).toEqual(pose(0));
    const gone = new OwnSmoothing();
    gone.correct(pose(0), pose(10), 0);
    gone.correct(null, pose(10), 10);
    expect(gone.at(10)).toEqual(pose(0));
  });

  it('корпус через ±π — по кратчайшему углу', () => {
    const smoothing = new OwnSmoothing();
    smoothing.correct(pose(0, 0, Math.PI - 0.05, 0), pose(0, 0, -Math.PI + 0.05, -0.1), 0);
    expect(smoothing.at(0).heading).toBeCloseTo(-0.1, 9);
    expect(smoothing.at(0).turret).toBeCloseTo(0.1, 9);
  });
});

describe('снаряды у своего танка сдвигаются вместе с ним', () => {
  const clock: PictureClock = {
    myTick: 10,
    othersTick: 6,
    me: { x: 0, y: 0 },
    others: [{ x: 600, y: 0 }],
    ownShift: { x: 3, y: -4 },
  };
  const bullet = (x: number): PictureBullet => ({ id: 1, owner: 2, x, y: 0, tick: 8 });

  it('у своего — полный сдвиг, у чужого — без сдвига, посередине — по весу', () => {
    const [near, middle, far] = shiftNearOwn([bullet(PICTURE_NEAR - 1), bullet(300), bullet(590)], clock);
    expect(near).toMatchObject({ x: PICTURE_NEAR - 1 + 3, y: -4 });
    expect(far).toMatchObject({ x: 590, y: 0 });
    expect(middle?.x).toBeCloseTo(300 + 3 * 0.5, 9);
    expect(middle?.y).toBeCloseTo(-4 * 0.5, 9);
  });

  it('своего танка нет или смещения нет — без сдвига', () => {
    expect(shiftNearOwn([bullet(10)], { ...clock, me: null })).toEqual([bullet(10)]);
    expect(shiftNearOwn([bullet(10)], { ...clock, ownShift: { x: 0, y: 0 } })).toEqual([bullet(10)]);
    const unshifted: PictureClock = { myTick: 10, othersTick: 6, me: { x: 0, y: 0 }, others: clock.others };
    expect(shiftNearOwn([bullet(10)], unshifted)).toEqual([bullet(10)]);
  });
});
