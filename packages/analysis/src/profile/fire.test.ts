import { TICK_RATE } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import {
  action,
  BOT,
  countdownFrames,
  fightFrame,
  HUMAN,
  IDLE,
  pose,
  profileRoundsOf,
  roundOver,
  shotEvent,
  startDuel,
  type LogBuilder,
  type Pose,
} from '../logFixture.js';
import { profileMetrics, type FireContext } from './index.js';

interface Stage {
  human: Pose;
  bot: Pose;
  ticks: number;
  firingTicks: number;
}

const OPEN_Y = 100;
// Стена Полигона x 330–374, y 160–360 закрывает противника на полосе y = 260.
const WALL_Y = 260;
const EARLY_TICKS = 45;
const STAGE_TICKS = 60;
const STAGE_FIRING = 15;

function fireRound(builder: LogBuilder, stages: readonly Stage[], shotTicks: ReadonlySet<number>): LogBuilder {
  const first = stages[0];
  if (first === undefined) {
    return builder;
  }
  builder.roundStart(0, 0).frames(countdownFrames([first.bot, first.human]));
  let tick = 0;
  stages.forEach((stage, index) => {
    for (let k = 0; k < stage.ticks; k++, tick++) {
      const isLast = index === stages.length - 1 && k === stage.ticks - 1;
      const events = shotTicks.has(tick) ? [shotEvent(HUMAN, stage.human)] : [];
      builder.frame(
        fightFrame([stage.bot, stage.human], {
          actions: [IDLE, action(0, 0, 1, k < stage.firingTicks)],
          events: isLast ? [...events, roundOver(BOT)] : events,
        }),
      );
    }
  });
  return builder;
}

function stage(humanX: number, botX: number, y: number): Stage {
  return {
    human: pose(humanX, y),
    bot: pose(botX, y, Math.PI, Math.PI),
    ticks: STAGE_TICKS,
    firingTicks: STAGE_FIRING,
  };
}

describe('огонь по контекстам', () => {
  it('доли зажатого огня по шести контекстам; первые 1,5 с — отдельно', () => {
    const stages: Stage[] = [
      { ...stage(200, 400, OPEN_Y), ticks: EARLY_TICKS, firingTicks: 0 },
      stage(200, 400, OPEN_Y),
      stage(200, 650, OPEN_Y),
      stage(200, 1000, OPEN_Y),
      stage(250, 450, WALL_Y),
      stage(200, 550, WALL_Y),
      stage(200, 900, WALL_Y),
    ];
    const rounds = profileRoundsOf({ 'FIRE.log': fireRound(startDuel(), stages, new Set([0])).text() });
    const fire = profileMetrics(rounds).fire;
    const contexts: FireContext[] = [
      'visible|<300',
      'visible|300–600',
      'visible|>600',
      'hidden|<300',
      'hidden|300–600',
      'hidden|>600',
    ];
    for (const context of contexts) {
      expect(fire.heldByContext[context]).toMatchObject({ part: STAGE_FIRING, total: STAGE_TICKS });
      expect(fire.readyNotFiringByContext[context]).toMatchObject({
        part: STAGE_TICKS - STAGE_FIRING,
        total: STAGE_TICKS,
      });
    }
    expect(fire.heldEarly).toMatchObject({ part: 0, total: EARLY_TICKS });
    expect(fire.held).toMatchObject({ part: 6 * STAGE_FIRING, total: EARLY_TICKS + 6 * STAGE_TICKS });
    expect(fire.heldLate).toMatchObject({ part: 6 * STAGE_FIRING, total: 6 * STAGE_TICKS });
  });
});

describe('огонь и предохранитель раунда', () => {
  it('огонь по контекстам — отдельно для раундов с предохранителем и без; предохранитель — по строке flags раунда', () => {
    const human = pose(200, OPEN_Y);
    const bot = pose(400, OPEN_Y, Math.PI, Math.PI);
    const builder = startDuel();
    const firingTicks = [10, 30];
    firingTicks.forEach((firing, idx) => {
      builder.client(HUMAN, `flags autoaim=0 guard=${idx === 0 ? '1' : '0'}`);
      builder.roundStart(idx, 0).frames(countdownFrames([bot, human]));
      for (let tick = 0; tick < EARLY_TICKS + 2 * STAGE_TICKS; tick++) {
        const isLast = tick === EARLY_TICKS + 2 * STAGE_TICKS - 1;
        const events = tick === 0 ? [shotEvent(HUMAN, human)] : [];
        const isFiring = tick >= EARLY_TICKS && tick < EARLY_TICKS + firing;
        builder.frame(
          fightFrame([bot, human], {
            actions: [IDLE, action(0, 0, 1, isFiring)],
            events: isLast ? [...events, roundOver(BOT)] : events,
          }),
        );
      }
    });
    const fire = profileMetrics(profileRoundsOf({ 'GARD.log': builder.text() })).fire;

    expect(fire.heldByGuard.guardOn['visible|<300']).toMatchObject({ part: 10, total: 2 * STAGE_TICKS });
    expect(fire.heldByGuard.guardOff['visible|<300']).toMatchObject({ part: 30, total: 2 * STAGE_TICKS });
    expect(fire.heldByContext['visible|<300']).toMatchObject({ part: 40, total: 4 * STAGE_TICKS });
    expect(fire.heldGuardOn).toMatchObject({ part: 10, total: EARLY_TICKS + 2 * STAGE_TICKS });
  });

  it('стартовая пауза — только с первого тика боя; доля раундов без неё — со счётом', () => {
    const human = pose(200, OPEN_Y);
    const bot = pose(650, OPEN_Y, Math.PI, Math.PI);
    const firingFrom: ((tick: number) => boolean)[] = [
      (tick) => tick < 10 || tick >= 20,
      (tick) => tick === 0 || tick >= 40,
      (tick) => tick >= TICK_RATE,
    ];
    const files = Object.fromEntries(
      firingFrom.map((isFiring, index) => {
        const builder = startDuel();
        builder.roundStart(0, 0).frames(countdownFrames([bot, human]));
        for (let tick = 0; tick < 160; tick++) {
          const events = tick === TICK_RATE ? [shotEvent(HUMAN, human)] : [];
          builder.frame(
            fightFrame([bot, human], {
              actions: [IDLE, action(0, 0, 1, isFiring(tick))],
              events: tick === 159 ? [...events, roundOver(BOT)] : events,
            }),
          );
        }
        return [`STP${String(index)}.log`, builder.text()];
      }),
    );
    const fire = profileMetrics(profileRoundsOf(files)).fire;

    expect(fire.noStartPause).toMatchObject({ part: 2, total: 3 });
    expect(fire.startPauseS).toMatchObject({ n: 1, median: 1 });
    expect(fire.midPauses).toBe(2);
  });
});

describe('паузы огня', () => {
  it('стартовая пауза, паузы посреди боя по длительностям, удержание предохранителем в пределах 3 тиков до начала', () => {
    const human = pose(200, OPEN_Y);
    const bot = pose(650, OPEN_Y, Math.PI, Math.PI);
    // Огонь: пауза 60 тиков на старте, затем паузы 10, 20 и 70 тиков (последняя — до конца раунда).
    const firing = (tick: number): boolean =>
      (tick >= 60 && tick < 160) || (tick >= 170 && tick < 220) || (tick >= 240 && tick < 260);
    const guardAfter = new Set([158, 215]);
    const shots = new Set([60, 90, 120]);
    const builder = startDuel();
    builder.client(HUMAN, 'flags autoaim=0 guard=1');
    builder.roundStart(0, 0).frames(countdownFrames([bot, human]));
    const fightTicks = 330;
    for (let tick = 0; tick < fightTicks; tick++) {
      const events = shots.has(tick) ? [shotEvent(HUMAN, human)] : [];
      builder.frame(
        fightFrame([bot, human], {
          actions: [IDLE, action(0, 0, 1, firing(tick))],
          events: tick === fightTicks - 1 ? [...events, roundOver(BOT)] : events,
        }),
      );
      if (guardAfter.has(tick)) {
        builder.client(HUMAN, 'guard hold');
      }
    }
    const fire = profileMetrics(profileRoundsOf({ 'PAUS.log': builder.text() })).fire;
    const minutes = fightTicks / TICK_RATE / 60;

    expect(fire.startPauseS).toMatchObject({ n: 1, median: 2 });
    expect(fire.startPauseSight).toMatchObject({ part: 60, total: 60 });
    expect(fire.midPauses).toBe(3);
    expect(fire.pausesByLength['<0,5 с']).toMatchObject({
      count: { part: 1, total: 3 },
      guarded: { part: 1, total: 1 },
    });
    expect(fire.pausesByLength['0,5–1 с']).toMatchObject({
      count: { part: 1, total: 3 },
      guarded: { part: 0, total: 1 },
    });
    expect(fire.pausesByLength['2–5 с']).toMatchObject({
      count: { part: 1, total: 3 },
      guarded: { part: 0, total: 1 },
    });
    expect(fire.pausesByLength['2–5 с']?.time).toMatchObject({ part: 70, total: 100 });
    expect(fire.releaseMeanS).toBeCloseTo(20 / TICK_RATE, 6);
    expect(fire.longPausesPerMinute).toBeCloseTo(1 / minutes, 6);
    expect(fire.longPauseS?.median).toBeCloseTo(70 / TICK_RATE, 6);
    expect(fire.guardHoldsPerMinute).toBeCloseTo(2 / minutes, 6);
    expect(fire.readyShots).toMatchObject({ part: 2, total: 2 });
    expect(fire.intervalExcessTicks).toMatchObject({ n: 2, median: 0 });
    expect(fire.shotsPerMinute).toBeCloseTo(3 / minutes, 6);
  });
});
