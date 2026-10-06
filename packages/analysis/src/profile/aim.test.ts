import { TANK_RADIUS, TICK_RATE } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { leadPoint } from '../geometry.js';
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
  type Pose,
} from '../logFixture.js';
import { toDegrees } from '../numbers.js';
import { profileMetrics } from './index.js';

const OPEN_Y = 100;
const WALL_Y = 260;
const FIGHT_TICKS = 200;

interface TickSpec {
  human: Pose;
  bot: Pose;
  isShot: boolean;
}

function roundLog(tickAt: (tick: number) => TickSpec, ticks = FIGHT_TICKS): string {
  const first = tickAt(0);
  const builder = startDuel()
    .roundStart(0, 0)
    .frames(countdownFrames([first.bot, first.human]));
  for (let tick = 0; tick < ticks; tick++) {
    const spec = tickAt(tick);
    const events = spec.isShot ? [shotEvent(HUMAN, spec.human)] : [];
    builder.frame(
      fightFrame([spec.bot, spec.human], {
        actions: [IDLE, action(0, 0, 1)],
        events: tick === ticks - 1 ? [...events, roundOver(BOT)] : events,
      }),
    );
  }
  return builder.text();
}

describe('реакция на появление в видимости', () => {
  it('эпизод после 0,5 с без видимости: задержка выстрела и задержка от готовности пушки; видимость пропала дольше 10 тиков — без выстрела', () => {
    const isVisible = (tick: number): boolean => tick < 10 || (tick >= 60 && tick < 80) || (tick >= 115 && tick < 120);
    const shots = new Set([30, 50, 73]);
    const log = roundLog((tick) => {
      const y = isVisible(tick) ? OPEN_Y : WALL_Y;
      return { human: pose(200, y), bot: pose(650, y, Math.PI, Math.PI), isShot: shots.has(tick) };
    });
    const reaction = profileMetrics(profileRoundsOf({ 'SEEN.log': log })).reaction;

    expect(reaction.sightEpisodes).toBe(2);
    expect(reaction.firstShotTicks).toMatchObject({ n: 1, median: 13 });
    expect(reaction.firstAfterReadyTicks).toMatchObject({ n: 1, median: 3 });
    expect(reaction.firstAimedTicks).toMatchObject({ n: 1, median: 13 });
    expect(reaction.noShotEpisodes).toMatchObject({ part: 1, total: 2 });
    expect(reaction.noAimedEpisodes).toMatchObject({ part: 1, total: 2 });
    expect(reaction.roundStartFirstShotTicks).toBeNull();
  });
});

describe('эпизод видимости', () => {
  it('новый эпизод — после 0,5 с без видимости и не раньше', () => {
    const episodesAfterGap = (gap: number): number => {
      const isVisible = (tick: number): boolean => tick < 10 || tick >= 10 + gap;
      const log = roundLog((tick) => {
        const y = isVisible(tick) ? OPEN_Y : WALL_Y;
        return { human: pose(200, y), bot: pose(650, y, Math.PI, Math.PI), isShot: tick === 0 };
      });
      return profileMetrics(profileRoundsOf({ 'GAPS.log': log })).reaction.sightEpisodes;
    };

    expect(episodesAfterGap(TICK_RATE / 2)).toBe(1);
    expect(episodesAfterGap(TICK_RATE / 2 - 1)).toBe(0);
  });
});

describe('прицел в выстреле', () => {
  it('по стоящему: ошибка до корпуса и угловой размер танка atan(TANK_RADIUS / дистанция)', () => {
    const human = pose(200, OPEN_Y, 0, 0.1);
    const bot = pose(750, OPEN_Y, Math.PI, Math.PI);
    const aim = profileMetrics(
      profileRoundsOf({ 'STND.log': roundLog((tick) => ({ human, bot, isShot: tick === 20 })) }),
    ).aim;
    const bucket = aim.byBucket['300–600'];

    expect(bucket?.standingErrDeg?.n).toBe(1);
    expect(bucket?.standingErrDeg?.median).toBeCloseTo(toDegrees(0.1), 0);
    expect(bucket?.tankSizeDeg?.median).toBeCloseTo(toDegrees(Math.atan(TANK_RADIUS / 550)), 6);
    expect(bucket?.movingErrCurDeg).toBeNull();
    expect(aim.standingErrDeg?.n).toBe(1);
  });

  it('по движущемуся: башня на точке упреждения — ошибка до упреждения около нуля, доля упреждения около единицы', () => {
    const step = 4;
    const shotTick = 20;
    const botAt = (tick: number): Pose => pose(750, OPEN_Y + 50 + step * tick, Math.PI / 2, Math.PI);
    const human = pose(200, OPEN_Y);
    const target = botAt(shotTick);
    const lead = leadPoint(human, target, { x: 0, y: step * TICK_RATE }, DEFAULT_BULLET_SPEED);
    human.turret = Math.round(Math.atan2(lead.y - human.y, lead.x - human.x) * 100) / 100;
    const log = roundLog((tick) => ({ human, bot: botAt(tick), isShot: tick === shotTick }), 60);
    const winLog = log.replace('kind=roundOver side=0', 'kind=roundOver side=1');
    const aim = profileMetrics(profileRoundsOf({ 'MOVE.log': winLog })).aim;
    const bucket = aim.byBucket['300–600'];

    expect(bucket?.movingErrLeadDeg?.median).toBeLessThan(1);
    expect(bucket?.movingErrCurDeg?.median).toBeGreaterThan(3);
    expect(aim.leadFraction?.median).toBeCloseTo(1, 0);
    expect(aim.movingKinds).toEqual({ lead: 1, current: 0, neither: 0 });
  });
});

describe('классы выстрелов по движущемуся', () => {
  const kindsOf = (step: number, botX: number, turretOf: (human: Pose, bot: Pose, lead: Pose) => number): unknown => {
    const shotTick = 20;
    const botAt = (tick: number): Pose => pose(botX, OPEN_Y + 50 + step * tick, Math.PI / 2, Math.PI);
    const human = pose(200, OPEN_Y);
    const target = botAt(shotTick);
    const lead = leadPoint(human, target, { x: 0, y: step * TICK_RATE }, DEFAULT_BULLET_SPEED);
    human.turret = Math.round(turretOf(human, target, pose(lead.x, lead.y)) * 100) / 100;
    const log = roundLog((tick) => ({ human, bot: botAt(tick), isShot: tick === shotTick }), 60).replace(
      'kind=roundOver side=0',
      'kind=roundOver side=1',
    );
    return profileMetrics(profileRoundsOf({ 'KIND.log': log })).aim.movingKinds;
  };
  const toward = (from: Pose, to: Pose): number => Math.atan2(to.y - from.y, to.x - from.x);

  it('башня на корпусе — «текущее», мимо обоих — «мимо обоих»; вблизи медленный — меньшая из ошибок', () => {
    expect(kindsOf(4, 750, (human, bot) => toward(human, bot))).toEqual({ lead: 0, current: 1, neither: 0 });
    expect(kindsOf(4, 750, (human, bot) => toward(human, bot) - 0.5)).toEqual({ lead: 0, current: 0, neither: 1 });
    expect(kindsOf(1.2, 300, (human, _bot, lead) => toward(human, lead))).toEqual({ lead: 1, current: 0, neither: 0 });
    expect(kindsOf(1.2, 300, (human, bot) => toward(human, bot))).toEqual({ lead: 0, current: 1, neither: 0 });
  });
});

describe('ошибка башни по тикам', () => {
  it('ошибка 30° → 5° за 45 тиков — время наведения 45; знак ошибки меняется каждые 12 тиков — длительность по одну сторону 12', () => {
    const bot = pose(800, OPEN_Y, Math.PI, Math.PI);
    const turretAt = (tick: number): number => {
      if (tick < 45) {
        return 0.6;
      }
      return Math.floor((tick - 45) / 12) % 2 === 0 ? -0.05 : 0.05;
    };
    const log = roundLog((tick) => ({ human: pose(200, OPEN_Y, 0, turretAt(tick)), bot, isShot: tick === 0 }));
    const aim = profileMetrics(profileRoundsOf({ 'TURN.log': log }));

    expect(aim.reaction.aimTicks).toMatchObject({ n: 1, median: 45 });
    expect(aim.reaction.aimWithSightTicks).toMatchObject({ n: 1, median: 45 });
    expect(aim.aim.sameSideTicks).toMatchObject({ median: 12, q1: 12, q3: 12 });
    expect(aim.aim.sameSideTicks?.deciles[0]).toBe(12);
    expect(aim.aim.sameSideTicks?.deciles[10]).toBe(12);
    expect(aim.aim.sightErrorUnder5).toMatchObject({ part: FIGHT_TICKS - 45, total: FIGHT_TICKS });
  });
});

describe('подгонка ошибки по ходу цели', () => {
  it('башня отстаёт на 3 тика хода цели и держит сдвиг ±0,2 по 12 тиков — отставание 3, остаток по одну сторону 12', () => {
    const lag = 3;
    const turnPerTick = 0.05;
    const radius = 60;
    const offset = 0.2;
    const block = 12;
    const samples = 20 * block;
    const human = pose(1000, OPEN_Y);
    const botAt = (tick: number): Pose => {
      const angle = turnPerTick * tick;
      return pose(human.x + radius * Math.cos(angle), human.y + radius * Math.sin(angle));
    };
    const builder = startDuel()
      .roundStart(0, 0)
      .frames(countdownFrames([botAt(0), human]));
    // Тик 0 — цель ещё стоит, в подгонку не идёт; дальше ровно 20 блоков сдвига.
    for (let tick = 0; tick <= samples; tick++) {
      const side = Math.floor((tick - 1) / block) % 2 === 0 ? 1 : -1;
      const turret = turnPerTick * tick - lag * turnPerTick + side * offset;
      const me = pose(human.x, human.y, 0, Math.round(turret * 100) / 100);
      builder.frame(
        fightFrame([botAt(tick), me], {
          actions: [IDLE, action(0, 0, 0, true)],
          events: [...(tick === 1 ? [shotEvent(HUMAN, me)] : []), ...(tick === samples ? [roundOver(BOT)] : [])],
        }),
      );
    }
    const fit = profileMetrics(profileRoundsOf({ 'AFIT.log': builder.text() })).aim.aimFit;

    expect(fit.n).toBe(samples);
    expect(fit.lagTicks).toBeCloseTo(lag, 0);
    expect(fit.residualSameSideTicks).toMatchObject({ n: 18, median: block });
  });
});
