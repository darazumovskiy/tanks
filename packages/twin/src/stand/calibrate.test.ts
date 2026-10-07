import { movementMetrics, profileMetrics } from '@tanks/analysis';
import { calibrationWith } from '@tanks/bots/twinFixture';
import type { BotLevel } from '@tanks/shared/protocol';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { twinProfile, type TwinReference } from '../profile.js';
import { CALIBRATION_INPUTS, calibrationOf, valuesOf, type CalibrationInput, type ParamValues } from './calibrate.js';
import type { PlayerMetrics } from './honesty.js';
import { standPlan } from './plan.js';
import { runStand } from './run.js';

function referenceOf(name: string): TwinReference {
  return JSON.parse(readFileSync(new URL(`../../reference/${name}.json`, import.meta.url), 'utf8')) as TwinReference;
}

const PHONE = referenceOf('phone');
const PC = referenceOf('pc');
const BASE = valuesOf(
  calibrationWith({
    correlationTicks: 10,
    lagTicks: 2,
    reverseChance: 0.5,
  }),
);
// Концы диапазона — на десятой доле от краёв: параметр двигается почти на весь размах.
const LOW_SHARE = 0.1;
const HIGH_SHARE = 0.9;
const ROUNDS = 48;

async function metricsOf(
  reference: TwinReference,
  values: Readonly<ParamValues>,
  level: BotLevel,
): Promise<PlayerMetrics> {
  const profile = twinProfile(reference, calibrationOf(values));
  const games = standPlan(reference, { levels: [level], roundsOf: () => ROUNDS, mixOf: () => ROUNDS, seed: 3 });
  const result = await runStand({ profile, games, logDir: null }, 1);
  return { main: profileMetrics(result.rounds), movement: movementMetrics(result.rounds) };
}

// Доля диапазона — по шкале сетки входа, как у калибровки.
function at(input: CalibrationInput, share: number): number {
  const [low, high] = input.range;
  if (input.scale === 'log') {
    return low * Math.pow(high / low, share);
  }
  return low + (high - low) * share;
}

// Чем реже решения манёвра, тем прямее путь; чем чаще двойник замечает опасный рикошет, тем реже стреляет в себя.
const FALLING_INPUTS: ReadonlySet<string> = new Set(['decisionMeanS', 'returnAvoidShare']);
// Против восьмого уровня раунды коротки и аптечки почти не появляются — ход к ним мерится против третьего.
const KIT_LEVEL: BotLevel = 3;
const LEVEL: BotLevel = 8;
// Доведение поездки мерится на поездках к аптечке: у этого параметра ход к ней включён.
const KIT_SHARE_ON = 0.5;

function baseFor(input: CalibrationInput): ParamValues {
  if (input.param !== 'kitFollowShare') {
    return BASE;
  }
  return { ...BASE, 'kit closer': KIT_SHARE_ON, 'kit farther': KIT_SHARE_ON };
}

// Задний ход есть только у компьютера; цели башни без видимости — тоже на его руке: ошибка руки телефона около 24°
// размывает окно цели в 10°, и на 48 раундах сдвиг метрики тонет в шуме.
function referenceFor(input: CalibrationInput): TwinReference {
  return input.param === 'reverseChance' || input.param.startsWith('hiddenAim') ? PC : PHONE;
}

// Привязка «параметр → метрика» поведением: параметр двигается от низа к верху диапазона, остальные стоят, —
// его метрика растёт, а у параметров из FALLING_INPUTS — падает.
describe('калибровка: каждый параметр двигает свою метрику', () => {
  const cases = CALIBRATION_INPUTS.filter((input) => input.param !== 'coverHoldShare').map((input) => ({
    input,
    reference: referenceFor(input),
  }));

  it.each(cases.map((item) => [item.input.param, item] as const))(
    '%s',
    async (_, { input, reference }) => {
      const level = input.param.startsWith('kit') ? KIT_LEVEL : LEVEL;
      const base = baseFor(input);
      const low = await metricsOf(reference, { ...base, [input.param]: at(input, LOW_SHARE) }, level);
      const high = await metricsOf(reference, { ...base, [input.param]: at(input, HIGH_SHARE) }, level);

      const lowValue = input.measure(low) ?? NaN;
      const highValue = input.measure(high) ?? NaN;

      expect(FALLING_INPUTS.has(input.param) ? lowValue - highValue : highValue - lowValue).toBeGreaterThan(0);
    },
    60000,
  );
});
