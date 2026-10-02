// Эталон детерминизма: прогоняет сценарии на оригинальном движке tank-arena и пишет fixtures.json.
//   node packages/shared/test/determinism/generate.mjs ../tank-arena/kit/arena/engine.js
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_TICKS, SCENARIOS, buildSchedule, digest } from './scenario.mjs';

const enginePath = process.argv[2];
if (enginePath === undefined) {
  console.error('укажи путь к оригинальному engine.js');
  process.exit(1);
}
const E = await import(pathToFileURL(resolve(enginePath)).href);

function snapshotOriginal(round) {
  return {
    tick: round.tick,
    tanks: round.tanks.map((t) => [t.x, t.y, t.heading, t.turret, t.speed, t.hp, t.reloadLeft, t.alive]),
    bullets: round.bullets.map((b) => [b.id, b.owner, b.x, b.y, b.vx, b.vy, b.bouncesLeft, b.bounced, b.age]),
    kits: round.kits.map((k) => [k.active, k.respawnIn]),
    zone: round.zone.radius,
    over: round.over,
    winner: round.winner,
    endReason: round.endReason,
    tally: round.tanks.map((t) => Object.values(t.tally)),
  };
}

const fixtures = SCENARIOS.map((scenario) => {
  const round = E.createRound({
    mapIndex: scenario.mapIndex,
    tanks: scenario.stats.map((stats, i) => ({ name: `T${i}`, stats })),
  });
  const schedule = buildSchedule(scenario.seed, MAX_TICKS, scenario.fireChance);
  const digests = [];
  for (const actions of schedule) {
    const events = E.stepRound(round, actions);
    digests.push(
      digest(
        snapshotOriginal(round),
        events.map((e) => e.type),
      ),
    );
    if (round.over) {
      break;
    }
  }
  return {
    mapIndex: scenario.mapIndex,
    seed: scenario.seed,
    fireChance: scenario.fireChance,
    ticks: digests.length,
    endReason: round.endReason,
    winner: round.winner,
    digests: digests.join(''),
  };
});

const out = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures.json');
await writeFile(out, JSON.stringify(fixtures, null, 1));
for (const f of fixtures) {
  console.log(`map ${f.mapIndex}: ${f.ticks} ticks, ${f.endReason}, winner ${f.winner}`);
}
