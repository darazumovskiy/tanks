import { describe, expect, it } from 'vitest';
import { createBrain } from './ladder.js';
import { PROFILES } from './profile.js';
import { compileArenaBotScript } from './scriptBot.js';

const SCRIPT_STATS = { armor: 2, engine: 1, gun: 2, reload: 5 };
const SCRIPT = `export default {
  name: 'Скрипт',
  stats: { armor: 2, engine: 1, gun: 2, reload: 5 },
  init() {},
  tick() {
    return { throttle: 0, turn: 0, turretTurn: 0, fire: false };
  },
};`;

function noRandom(): number {
  return 0;
}

describe('уровень лестницы → мозг', () => {
  it('уровни 1–9 — Охотник с профилем уровня', () => {
    const script = compileArenaBotScript(SCRIPT);
    for (const level of [1, 5, 9] as const) {
      const brain = createBrain(level, noRandom, script);
      expect(brain.stats).toEqual(PROFILES[level].stats);
      expect(brain.reactionTicks).toBe(PROFILES[level].reactionTicks);
    }
  });

  it('уровень 10 — свежий экземпляр переданного скрипта', () => {
    const brain = createBrain(10, noRandom, compileArenaBotScript(SCRIPT));
    expect(brain.stats).toEqual(SCRIPT_STATS);
    expect(brain.reactionTicks).toBe(0);
  });
});
