import { movementMetrics, profileMetrics } from '@tanks/analysis';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calibrationWith } from '../fixture.js';
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

async function metricsOf(reference: TwinReference, values: Readonly<ParamValues>): Promise<PlayerMetrics> {
  const profile = twinProfile(reference, calibrationOf(values));
  const games = standPlan(reference, { levels: [8], roundsOf: () => ROUNDS, mixOf: () => ROUNDS, seed: 3 });
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

// Привязка «параметр → метрика» поведением: параметр двигается от низа к верху диапазона, остальные стоят, —
// его метрика растёт.
describe('калибровка: каждый параметр двигает свою метрику', () => {
  const cases = [
    ...CALIBRATION_INPUTS.filter((input) => input.param !== 'reverseChance' && input.param !== 'coverHoldShare').map(
      (input) => ({ input, reference: PHONE }),
    ),
    ...CALIBRATION_INPUTS.filter((input) => input.param === 'reverseChance').map((input) => ({ input, reference: PC })),
  ];

  it.each(cases.map((item) => [item.input.param, item] as const))(
    '%s',
    async (_, { input, reference }) => {
      const low = await metricsOf(reference, { ...BASE, [input.param]: at(input, LOW_SHARE) });
      const high = await metricsOf(reference, { ...BASE, [input.param]: at(input, HIGH_SHARE) });

      expect(input.measure(high) ?? -Infinity).toBeGreaterThan(input.measure(low) ?? Infinity);
    },
    60000,
  );
});
