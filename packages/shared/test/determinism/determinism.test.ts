import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRound, DEFAULT_RULES, stepRound, type Round, type RoundRules } from '../../src/engine/index.js';
import { MAX_TICKS, SCENARIOS, buildSchedule, digest, type Scenario } from './scenario.mjs';

interface Fixture {
  mapIndex: number;
  seed: number;
  fireChance: number;
  ticks: number;
  endReason: string | null;
  winner: number | null;
  digests: string;
}

const DIGEST_LENGTH = 8;
const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')) as Fixture[];

function snapshot(round: Round): unknown {
  return {
    tick: round.tick,
    tanks: round.tanks.map((t) => [t.x, t.y, t.heading, t.turret, t.speed, t.hp, t.reloadLeft, t.isAlive]),
    bullets: round.bullets.map((b) => [b.id, b.owner, b.x, b.y, b.vx, b.vy, b.bouncesLeft, b.hasBounced, b.age]),
    kits: round.kits.map((k) => [k.isActive, k.respawnIn]),
    zone: round.zone.radius,
    over: round.isOver,
    winner: round.winner,
    endReason: round.endReason,
    tally: round.tanks.map((t) => [
      t.tally.shots,
      t.tally.hits,
      t.tally.damageDealt,
      t.tally.damageTaken,
      t.tally.selfDamage,
      t.tally.ricochetHits,
      t.tally.intercepts,
      t.tally.kits,
      t.tally.zoneDamage,
    ]),
  };
}

function runDigests(scenario: Scenario, rules: RoundRules): string[] {
  const round = createRound(
    scenario.mapIndex,
    [
      { name: 'T0', stats: scenario.stats[0] },
      { name: 'T1', stats: scenario.stats[1] },
    ],
    rules,
  );
  const digests: string[] = [];
  for (const [a, b] of buildSchedule(scenario.seed, MAX_TICKS, scenario.fireChance)) {
    const events = stepRound(round, [
      { throttle: a.throttle, turn: a.turn, turretTurn: a.turretTurn, isFiring: a.fire },
      { throttle: b.throttle, turn: b.turn, turretTurn: b.turretTurn, isFiring: b.fire },
    ]);
    digests.push(
      digest(
        snapshot(round),
        events.map((event) => event.type),
      ),
    );
    if (round.isOver) {
      break;
    }
  }
  return digests;
}

describe('движок повторяет оригинал tank-arena тик в тик', () => {
  it.each(SCENARIOS.map((scenario, index) => [index, scenario] as const))('сценарий %i', (index, scenario) => {
    const fixture = fixtures[index];
    expect(fixture, 'эталон для сценария отсутствует — перегенерируй fixtures.json').toBeDefined();
    if (fixture === undefined) {
      return;
    }
    expect(fixture.mapIndex).toBe(scenario.mapIndex);
    expect(fixture.seed).toBe(scenario.seed);

    const round = createRound(scenario.mapIndex, [
      { name: 'T0', stats: scenario.stats[0] },
      { name: 'T1', stats: scenario.stats[1] },
    ]);
    const schedule = buildSchedule(scenario.seed, MAX_TICKS, scenario.fireChance);

    let tick = 0;
    for (const [a, b] of schedule) {
      const events = stepRound(round, [
        { throttle: a.throttle, turn: a.turn, turretTurn: a.turretTurn, isFiring: a.fire },
        { throttle: b.throttle, turn: b.turn, turretTurn: b.turretTurn, isFiring: b.fire },
      ]);
      const expected = fixture.digests.slice(tick * DIGEST_LENGTH, (tick + 1) * DIGEST_LENGTH);
      const actual = digest(
        snapshot(round),
        events.map((event) => event.type),
      );
      expect(actual, `расхождение на тике ${String(tick)}`).toBe(expected);
      tick++;
      if (round.isOver) {
        break;
      }
    }
    expect(tick).toBe(fixture.ticks);
    expect(round.endReason).toBe(fixture.endReason);
    expect(round.winner).toBe(fixture.winner);
  });
});

describe('скольжение вдоль стен детерминировано', () => {
  // Сценарий без стрельбы: раунд идёт всё время, танки много ездят и трутся о стены.
  const scenario = SCENARIOS[4];
  const fixture = fixtures[4];

  it('два прогона с одинаковым вводом совпадают побитово и отличаются от эталона без правила', () => {
    expect(scenario).toBeDefined();
    expect(fixture).toBeDefined();
    if (scenario === undefined || fixture === undefined) {
      return;
    }
    const first = runDigests(scenario, { ...DEFAULT_RULES, wallSlidePercent: 50 });
    const second = runDigests(scenario, { ...DEFAULT_RULES, wallSlidePercent: 50 });
    expect(second).toEqual(first);
    expect(first.join('')).not.toBe(fixture.digests);
  });
});

describe('догон снаряда детерминирован', () => {
  it('сценарий со стрельбой при догоне 2: два прогона совпадают побитово и отличаются от эталона без правила', () => {
    const index = SCENARIOS.findIndex((candidate) => candidate.fireChance > 0);
    const scenario = SCENARIOS[index];
    const fixture = fixtures[index];
    expect(scenario).toBeDefined();
    expect(fixture).toBeDefined();
    if (scenario === undefined || fixture === undefined) {
      return;
    }
    const lead = { ...DEFAULT_RULES, shotLeadTicks: 2 };
    const first = runDigests(scenario, lead);
    expect(runDigests(scenario, lead)).toEqual(first);
    expect(first.join('')).not.toBe(fixture.digests);
    expect(runDigests(scenario, { ...DEFAULT_RULES, shotLeadTicks: 0 }).join('')).toBe(fixture.digests);
  });
});

describe('снаряд со скоростью танка детерминирован', () => {
  it('сценарий со стрельбой при 100 %: два прогона совпадают побитово и отличаются от эталона; при 0 — эталон', () => {
    const index = SCENARIOS.findIndex((candidate) => candidate.fireChance > 0);
    const scenario = SCENARIOS[index];
    const fixture = fixtures[index];
    expect(scenario).toBeDefined();
    expect(fixture).toBeDefined();
    if (scenario === undefined || fixture === undefined) {
      return;
    }
    const inherit = { ...DEFAULT_RULES, shotInheritPercent: 100 };
    const first = runDigests(scenario, inherit);
    expect(runDigests(scenario, inherit)).toEqual(first);
    expect(first.join('')).not.toBe(fixture.digests);
    expect(runDigests(scenario, { ...DEFAULT_RULES, shotInheritPercent: 0 }).join('')).toBe(fixture.digests);
  });
});
