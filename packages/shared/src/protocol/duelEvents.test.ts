import { describe, expect, it } from 'vitest';
import type { DuelEvent } from '../engine/index.js';
import { duelSide, toSnapshotEvent } from './duelEvents.js';
import { EventFlag, type SnapshotEvent } from './messages.js';

function expected(overrides: Partial<SnapshotEvent> & Pick<SnapshotEvent, 'kind'>): SnapshotEvent {
  return { side: null, x: 0, y: 0, value: 0, dx: 0, dy: 0, flags: 0, ...overrides };
}

const CASES: readonly (readonly [string, DuelEvent, SnapshotEvent])[] = [
  [
    'выстрел',
    { type: 'shot', tank: 1, x: 10, y: 20, angle: 0 },
    expected({ kind: 'shot', side: 1, x: 10, y: 20, value: 0, dx: 1, dy: 0 }),
  ],
  ['удар о стену', { type: 'impact', x: 1, y: 2, owner: 0 }, expected({ kind: 'impact', side: 0, x: 1, y: 2 })],
  ['снаряд угас', { type: 'fizzle', x: 1, y: 2, owner: 1 }, expected({ kind: 'fizzle', side: 1, x: 1, y: 2 })],
  [
    'рикошет',
    { type: 'ricochet', x: 1, y: 2, owner: 0, nx: 0, ny: -1 },
    expected({ kind: 'ricochet', side: 0, x: 1, y: 2, dy: -1 }),
  ],
  ['перехват', { type: 'clash', x: 7, y: 8 }, expected({ kind: 'clash', x: 7, y: 8 })],
  [
    'попадание рикошетом',
    {
      type: 'hit',
      tank: 1,
      x: 100,
      y: 200,
      damage: 28,
      cause: 'bullet',
      by: 0,
      isRicochet: true,
      bulletX: 110,
      bulletY: 190,
      dirX: 0.6,
      dirY: 0.8,
    },
    expected({ kind: 'hit', side: 1, x: 110, y: 190, value: 28, dx: 0.6, dy: 0.8, flags: EventFlag.Ricochet }),
  ],
  [
    'попадание в себя',
    { type: 'hit', tank: 0, x: 100, y: 200, damage: 23, cause: 'self', by: 0 },
    expected({ kind: 'hit', side: 0, x: 100, y: 200, value: 23, flags: EventFlag.Self }),
  ],
  [
    'урон зоной',
    { type: 'hit', tank: 1, x: 100, y: 200, damage: 0.5, cause: 'zone', isQuiet: true },
    expected({ kind: 'hit', side: 1, x: 100, y: 200, value: 0.5, flags: EventFlag.Zone }),
  ],
  [
    'гибель',
    { type: 'death', tank: 1, x: 5, y: 6, cause: 'bullet', by: 0, isRicochet: false },
    expected({ kind: 'death', side: 1, x: 5, y: 6 }),
  ],
  ['толчок о стену', { type: 'bump', tank: 0, x: 2, y: 3 }, expected({ kind: 'bump', side: 0, x: 2, y: 3 })],
  ['аптечка появилась', { type: 'kitSpawn', x: 9, y: 10 }, expected({ kind: 'kitSpawn', x: 9, y: 10 })],
  [
    'аптечка подобрана',
    { type: 'pickup', tank: 1, x: 2, y: 3, healed: 50 },
    expected({ kind: 'pickup', side: 1, x: 2, y: 3, value: 50 }),
  ],
  ['зона сужается', { type: 'zoneStart' }, expected({ kind: 'zoneStart' })],
  ['конец раунда гибелью', { type: 'roundOver', winner: 0, reason: 'kill' }, expected({ kind: 'roundOver', side: 0 })],
  [
    'конец раунда по времени вничью',
    { type: 'roundOver', winner: null, reason: 'time' },
    expected({ kind: 'roundOver', flags: EventFlag.ByTime }),
  ],
];

describe('событие дуэли → событие снимка', () => {
  it.each(CASES)('%s', (_title, event, snapshot) => {
    expect(toSnapshotEvent(event)).toEqual(snapshot);
  });

  it('номер танка дуэли — его сторона', () => {
    expect(duelSide(0)).toBe(0);
    expect(duelSide(1)).toBe(1);
  });
});
