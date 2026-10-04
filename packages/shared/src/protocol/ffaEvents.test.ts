import { describe, expect, it } from 'vitest';
import type { FfaEvent } from '../engine/index.js';
import { toFfaSnapshotEvent } from './ffaEvents.js';
import { EventFlag, type FfaSnapshotEvent } from './messages.js';

function expected(overrides: Partial<FfaSnapshotEvent> & Pick<FfaSnapshotEvent, 'kind'>): FfaSnapshotEvent {
  return { tank: null, by: null, x: 0, y: 0, value: 0, dx: 0, dy: 0, flags: 0, ...overrides };
}

const CASES: readonly (readonly [FfaEvent, FfaSnapshotEvent])[] = [
  [
    { type: 'shot', tank: 3, x: 10, y: 20, angle: 0 },
    expected({ kind: 'shot', tank: 3, x: 10, y: 20, value: 0, dx: 1, dy: 0 }),
  ],
  [{ type: 'impact', x: 1, y: 2, owner: 4 }, expected({ kind: 'impact', tank: 4, x: 1, y: 2 })],
  [{ type: 'fizzle', x: 1, y: 2, owner: 5 }, expected({ kind: 'fizzle', tank: 5, x: 1, y: 2 })],
  [
    { type: 'ricochet', x: 1, y: 2, owner: 6, nx: 0, ny: -1 },
    expected({ kind: 'ricochet', tank: 6, x: 1, y: 2, dy: -1 }),
  ],
  [{ type: 'clash', x: 7, y: 8 }, expected({ kind: 'clash', x: 7, y: 8 })],
  [{ type: 'kitSpawn', x: 9, y: 10 }, expected({ kind: 'kitSpawn', x: 9, y: 10 })],
  [
    {
      type: 'hit',
      tank: 2,
      x: 100,
      y: 200,
      damage: 28,
      cause: 'bullet',
      by: 7,
      isRicochet: true,
      bulletX: 110,
      bulletY: 190,
      dirX: 0.6,
      dirY: 0.8,
    },
    expected({ kind: 'hit', tank: 2, by: 7, x: 110, y: 190, value: 28, dx: 0.6, dy: 0.8, flags: EventFlag.Ricochet }),
  ],
  [
    { type: 'hit', tank: 2, x: 100, y: 200, damage: 0.5, cause: 'zone', isQuiet: true },
    expected({ kind: 'hit', tank: 2, x: 100, y: 200, value: 0.5, flags: EventFlag.Zone }),
  ],
  [{ type: 'shield', tank: 2, x: 3, y: 4, owner: 9 }, expected({ kind: 'shield', tank: 2, by: 9, x: 3, y: 4 })],
  [
    { type: 'death', tank: 2, x: 5, y: 6, cause: 'self', by: 2, isRicochet: true },
    expected({ kind: 'death', tank: 2, by: 2, x: 5, y: 6, flags: EventFlag.Self | EventFlag.Ricochet }),
  ],
  [
    { type: 'death', tank: 2, x: 5, y: 6, cause: 'zone', by: null, isRicochet: false },
    expected({ kind: 'death', tank: 2, x: 5, y: 6, flags: EventFlag.Zone }),
  ],
  [{ type: 'bump', tank: 1, x: 2, y: 3 }, expected({ kind: 'bump', tank: 1, x: 2, y: 3 })],
  [{ type: 'spawn', tank: 1, x: 2, y: 3 }, expected({ kind: 'spawn', tank: 1, x: 2, y: 3 })],
  [{ type: 'pickup', tank: 1, x: 2, y: 3, healed: 50 }, expected({ kind: 'pickup', tank: 1, x: 2, y: 3, value: 50 })],
  [{ type: 'zoneStart' }, expected({ kind: 'zoneStart' })],
  [{ type: 'suddenDeath' }, expected({ kind: 'suddenDeath' })],
  [{ type: 'matchOver' }, expected({ kind: 'matchOver' })],
];

describe('событие матча → событие снимка', () => {
  it.each(CASES.map(([event, snapshot]) => [event.type, event, snapshot] as const))('%s', (_type, event, snapshot) => {
    expect(toFfaSnapshotEvent(event)).toEqual(snapshot);
  });
});
