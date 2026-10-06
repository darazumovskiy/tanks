import { deriveStats, DEFAULT_STATS, TICK_RATE } from '@tanks/shared/engine';
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
  type EventSpec,
  type LogAction,
  type LogBuilder,
  type Pose,
} from '../logFixture.js';
import { profileMetrics, type Coefficients } from './index.js';
import { fitSwitchCoefficients, modeSamples, type ModeSample } from './modeSwitch.js';
import type { ModeFeatures } from './rounds.js';

const ENEMY = pose(1460, 450, Math.PI, Math.PI);
// На Полигоне из левой точки появления до стены рукой подать, из правого верхнего угла — укрыться негде.
const COVERED = pose(140, 450);
const EXPOSED = pose(1500, 200);
const DEFAULT_MAX_HP = deriveStats(DEFAULT_STATS).maxHp;
const HIT_DAMAGE = 30;

interface TickSpec {
  human: Pose;
  humanAction: LogAction;
  events?: EventSpec[];
}

function addRound(
  builder: LogBuilder,
  idx: number,
  ticks: number,
  winner: 0 | 1 | null,
  tickAt: (tick: number) => TickSpec,
): void {
  const first = tickAt(0);
  builder.roundStart(idx, 0).frames(countdownFrames([ENEMY, first.human]));
  for (let tick = 0; tick < ticks; tick++) {
    const spec = tickAt(tick);
    const events = [...(tick === 0 ? [shotEvent(HUMAN, spec.human)] : []), ...(spec.events ?? [])];
    builder.frame(
      fightFrame([ENEMY, spec.human], {
        actions: [IDLE, spec.humanAction],
        events: tick === ticks - 1 ? [...events, roundOver(winner)] : events,
      }),
    );
  }
}

describe('признаки выбора режима', () => {
  it('проигранные подряд — по победителям раундов, ничья серию обрывает; урон за 5 с — по попаданиям; укрытие рядом — да и нет на одной карте', () => {
    const builder = startDuel();
    const driving = (): TickSpec => ({ human: COVERED, humanAction: action(1) });
    addRound(builder, 0, 160, BOT, driving);
    addRound(builder, 1, 160, HUMAN, driving);
    addRound(builder, 2, 160, BOT, driving);
    addRound(builder, 3, 160, BOT, driving);
    addRound(builder, 4, 160, null, driving);
    addRound(builder, 5, 220, HUMAN, (tick) => ({
      human: tick >= TICK_RATE && tick < 2 * TICK_RATE ? EXPOSED : COVERED,
      humanAction: action(1),
      events: tick === 10 ? [{ kind: 'hit', side: HUMAN, x: COVERED.x, y: COVERED.y, v: HIT_DAMAGE }] : [],
    }));
    const rounds = profileRoundsOf({ 'MODE.log': builder.text() });
    const last = rounds.find((round) => round.idx === 5);
    const streakOf = (idx: number): number | undefined =>
      rounds.find((round) => round.idx === idx)?.detail?.seconds[0]?.features.lossStreak;
    const seconds = last?.detail?.seconds ?? [];
    const at = (index: number): ModeFeatures | undefined => seconds.find((second) => second.index === index)?.features;

    expect([1, 2, 3, 4].map(streakOf)).toEqual([1, 0, 1, 2]);
    expect(at(0)).toMatchObject({
      lossStreak: 0,
      roundIndex: 5,
      recentDamageShare: 0,
      hasCover: true,
      botClass: '3–7',
    });
    expect(at(30)).toMatchObject({ hasCover: false, fightSeconds: 1 });
    expect(at(30)?.recentDamageShare).toBeCloseTo(HIT_DAMAGE / DEFAULT_MAX_HP, 9);
    expect(at(150)?.recentDamageShare).toBeCloseTo(HIT_DAMAGE / DEFAULT_MAX_HP, 9);
    expect(at(180)?.recentDamageShare).toBe(0);
    expect(at(180)?.healthShare).toBeCloseTo(1 - HIT_DAMAGE / DEFAULT_MAX_HP, 9);
    expect(at(180)?.exchangeShare).toBeCloseTo(-HIT_DAMAGE / DEFAULT_MAX_HP, 9);
    expect(seconds.map((second) => second.index)).toEqual([0, 30, 60, 90, 120, 150, 180]);
  });

  it('посекундные отсчёты: вход в позицию за секунду и выход из неё; позиция до конца боя — не выход', () => {
    const builder = startDuel();
    const standFrom = 45;
    const standTo = 105;
    addRound(builder, 0, 205, HUMAN, (tick) => {
      if (tick >= standFrom && tick < standTo) {
        return { human: pose(400 + 4 * (standFrom - 1), 100), humanAction: action(0, 0, 0, true) };
      }
      const x = tick < standFrom ? 400 + 4 * tick : 400 + 4 * (tick - (standTo - standFrom));
      return { human: pose(x, 100), humanAction: action(1) };
    });
    const samples = modeSamples(profileRoundsOf({ 'SWCH.log': builder.text() }));
    const view = samples.map((sample) => [sample.isInPosition, sample.hasSwitched, sample.positionSeconds]);

    expect(view).toEqual([
      [false, false, 0],
      [false, true, 0],
      [true, false, 0.5],
      [true, true, 1.5],
      [false, false, 0],
      [false, false, 0],
    ]);
  });

  it('позиция, дожившая до конца боя, — не выход: последняя неполная секунда в отсчёты не идёт', () => {
    const builder = startDuel();
    const standFrom = 45;
    const ticks = 125;
    addRound(builder, 0, ticks, HUMAN, (tick) => {
      if (tick >= standFrom) {
        return { human: pose(400 + 4 * (standFrom - 1), 100), humanAction: action(0, 0, 0, true) };
      }
      return { human: pose(400 + 4 * tick, 100), humanAction: action(1) };
    });
    const samples = modeSamples(profileRoundsOf({ 'TILL.log': builder.text() }));
    const view = samples.map((sample) => [sample.isInPosition, sample.hasSwitched]);

    expect(view).toEqual([
      [false, false],
      [false, true],
      [true, false],
      [true, false],
    ]);
  });
});

function sample(recentDamageShare: number, hasSwitched: boolean): ModeSample {
  return {
    roundId: 'SYN#0',
    isInPosition: false,
    hasSwitched,
    positionSeconds: 0,
    features: {
      botClass: '9',
      lossStreak: 0,
      roundIndex: 0,
      recentDamageShare,
      healthShare: 1,
      exchangeShare: 0,
      hasCover: true,
      fightSeconds: 5,
      hasSight: false,
      distance: 500,
    },
  };
}

function logistic(coefficients: Coefficients, values: Partial<Record<keyof Coefficients['weights'], number>>): number {
  let z = coefficients.intercept;
  for (const [name, value] of Object.entries(values)) {
    z += coefficients.weights[name as keyof Coefficients['weights']] * value;
  }
  return 1 / (1 + Math.exp(-z));
}

const DRIVE_STEP = 4;
const HIT_TICK = 20;
const ENTER_TICK = 50;
const TRAINING_TICKS = 200;

// Раунд синтетического журнала: человек едет; после попадания в первую секунду встаёт в позицию с огнём.
function trainingTick(isHurt: boolean, isEntering: boolean): (tick: number) => TickSpec {
  return (tick) => {
    const isStanding = isEntering && tick >= ENTER_TICK;
    const x = 200 + DRIVE_STEP * (isStanding ? ENTER_TICK - 1 : tick);
    const human = pose(x, 100);
    const isHit = isHurt && tick === HIT_TICK;
    return {
      human,
      humanAction: isStanding ? action(0, 0, 0, true) : action(1),
      events: isHit ? [{ kind: 'hit', side: HUMAN, x: human.x, y: human.y, v: HIT_DAMAGE }] : [],
    };
  };
}

describe('обучение коэффициентов выбора режима', () => {
  it('по синтетическому журналу: после урона встаёт в позицию чаще — коэффициент урона положителен', () => {
    const builder = startDuel();
    const rounds = [
      { isHurt: true, isEntering: true },
      { isHurt: true, isEntering: true },
      { isHurt: true, isEntering: true },
      { isHurt: true, isEntering: false },
      { isHurt: false, isEntering: false },
      { isHurt: false, isEntering: false },
      { isHurt: false, isEntering: false },
      { isHurt: false, isEntering: true },
    ];
    rounds.forEach((round, idx) => {
      addRound(builder, idx, TRAINING_TICKS, HUMAN, trainingTick(round.isHurt, round.isEntering));
    });
    const profileRounds = profileRoundsOf({ 'TRAN.log': builder.text() });
    const metrics = profileMetrics(profileRounds);
    const enter = metrics.modeSwitch.enter;
    if (enter === null) {
      throw new Error('коэффициенты входа не подобраны');
    }
    const hurtShare = HIT_DAMAGE / deriveStats(DEFAULT_STATS).maxHp;
    const enters = modeSamples(profileRounds).filter((item) => !item.isInPosition && item.hasSwitched);

    expect(enters).toHaveLength(4);
    expect(enter.weights.recentDamageShare).toBeGreaterThan(0);
    expect(logistic(enter, { recentDamageShare: hurtShare, fightSeconds: 1 })).toBeGreaterThan(
      logistic(enter, { fightSeconds: 1 }),
    );
  });

  it('переход после урона с известной частотой: частоты восстановлены с точностью 10 %', () => {
    const perGroup = 4000;
    const calmRate = 0.02;
    const hurtRate = 0.08;
    const hurt = 0.3;
    const otherClasses: ModeSample[] = (['3–7', '8', '10'] as const).flatMap((botClass) =>
      [false, true].map((hasSwitched) => {
        const base = sample(0, hasSwitched);
        return { ...base, features: { ...base.features, botClass, hasCover: !hasSwitched } };
      }),
    );
    const samples = [
      ...Array.from({ length: perGroup }, (_, i) => sample(0, i < perGroup * calmRate)),
      ...Array.from({ length: perGroup }, (_, i) => sample(hurt, i < perGroup * hurtRate)),
      ...otherClasses,
    ];
    const coefficients = fitSwitchCoefficients(samples);
    if (coefficients === null) {
      throw new Error('коэффициенты не подобраны');
    }
    const base = { class9: 1, healthShare: 1, hasCover: 1, fightSeconds: 5 };

    expect(logistic(coefficients, base) / calmRate).toBeCloseTo(1, 1);
    expect(logistic(coefficients, { ...base, recentDamageShare: hurt }) / hurtRate).toBeCloseTo(1, 1);
  });

  it('без переходов или с переходом в каждом отсчёте коэффициентов нет', () => {
    expect(fitSwitchCoefficients([sample(0, false), sample(0.3, false)])).toBeNull();
    expect(fitSwitchCoefficients([sample(0, true)])).toBeNull();
    expect(fitSwitchCoefficients([])).toBeNull();
  });

  it('профиль несёт коэффициенты обоих потоков и число отсчётов', () => {
    const builder = startDuel();
    addRound(builder, 0, 120, HUMAN, () => ({ human: COVERED, humanAction: action(1) }));
    const metrics = profileMetrics(profileRoundsOf({ 'NONE.log': builder.text() }));

    expect(metrics.modeSwitch).toMatchObject({ enter: null, leave: null, enterSamples: 3, leaveSamples: 0 });
  });
});
