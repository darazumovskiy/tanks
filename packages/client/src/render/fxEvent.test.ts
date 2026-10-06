import type { Side } from '@tanks/shared/engine';
import { EventFlag, type SnapshotEvent, type SnapshotEventKind } from '@tanks/shared/protocol';
import { describe, expect, it } from 'vitest';
import { DuelFxPolicy, duelFxEvent } from './fxEvent.js';

const KINDS: readonly SnapshotEventKind[] = [
  'shot',
  'impact',
  'ricochet',
  'fizzle',
  'clash',
  'hit',
  'death',
  'bump',
  'kitSpawn',
  'pickup',
  'zoneStart',
  'roundOver',
];
const QUIET = { shake: 0, flash: 0, announcement: null, hasParticles: true };

function duelEvent(kind: SnapshotEventKind, side: Side | null, flags = 0): SnapshotEvent {
  return { kind, side, x: 120, y: 340, value: 28, dx: 0.6, dy: 0.8, flags };
}

describe('перевод события дуэли в событие эффектов', () => {
  it('каждый вид: номер танка — сторона, место, величина, направление и флаги — как у события', () => {
    for (const kind of KINDS) {
      for (const side of [0, 1, null] as const) {
        const event = duelEvent(kind, side, kind === 'roundOver' ? EventFlag.ByTime : 0);
        expect(duelFxEvent(event), `${kind} ${String(side)}`).toMatchObject({
          kind,
          tank: side,
          x: event.x,
          y: event.y,
          value: event.value,
          dx: event.dx,
          dy: event.dy,
          flags: event.flags,
        });
      }
    }
  });

  it('стрелок есть только у попадания снарядом: у остальных видов `by` — null', () => {
    for (const kind of KINDS.filter((candidate) => candidate !== 'hit')) {
      expect(duelFxEvent(duelEvent(kind, 0)).by, kind).toBeNull();
      expect(duelFxEvent(duelEvent(kind, 1)).by, kind).toBeNull();
    }
  });

  it('попадание: стрелок — другая сторона, и рикошетом тоже', () => {
    expect(duelFxEvent(duelEvent('hit', 0)).by).toBe(1);
    expect(duelFxEvent(duelEvent('hit', 1)).by).toBe(0);
    expect(duelFxEvent(duelEvent('hit', 1, EventFlag.Ricochet)).by).toBe(0);
  });

  it('свой рикошет — стрелок сам танк; урон зоной — стрелка нет', () => {
    expect(duelFxEvent(duelEvent('hit', 0, EventFlag.Self | EventFlag.Ricochet)).by).toBe(0);
    expect(duelFxEvent(duelEvent('hit', 1, EventFlag.Self | EventFlag.Ricochet)).by).toBe(1);
    expect(duelFxEvent(duelEvent('hit', 0, EventFlag.Zone)).by).toBeNull();
    expect(duelFxEvent(duelEvent('hit', null)).by).toBeNull();
  });

  it('смерть: ни убийцы, ни флагов — событие дуэли их не несёт', () => {
    const death = duelFxEvent(duelEvent('death', 1));
    expect(death.tank).toBe(1);
    expect(death.by).toBeNull();
    expect(death.flags).toBe(0);
  });
});

describe('тряска, вспышка и объявления дуэли', () => {
  it('выстрел, перехват и гибель трясут с прежней силой; гибель вспыхивает экраном', () => {
    const policy = new DuelFxPolicy();
    expect(policy.optionsFor(duelEvent('shot', 0))).toEqual({ ...QUIET, shake: 2.5 });
    expect(policy.optionsFor(duelEvent('clash', null))).toEqual({ ...QUIET, shake: 6 });
    expect(policy.optionsFor(duelEvent('death', 1))).toEqual({
      shake: 26,
      flash: 0.55,
      announcement: null,
      hasParticles: true,
    });
  });

  it('начало сжатия — объявление зоны; остальные виды не трогают экран', () => {
    const policy = new DuelFxPolicy();
    expect(policy.optionsFor(duelEvent('zoneStart', null))).toEqual({
      ...QUIET,
      announcement: { kind: 'zoneStart', size: 1, duration: 1 },
    });
    for (const kind of ['impact', 'ricochet', 'fizzle', 'bump', 'kitSpawn', 'pickup', 'roundOver'] as const) {
      expect(policy.optionsFor(duelEvent(kind, 0)), kind).toEqual(QUIET);
    }
  });

  it('P2 первая кровь — одна на раунд, вдвое короче базовой: первое попадание снарядом, рикошетом тоже; дальше только тряска', () => {
    const policy = new DuelFxPolicy();
    expect(policy.optionsFor(duelEvent('hit', 1, EventFlag.Ricochet))).toEqual({
      ...QUIET,
      shake: 9,
      announcement: { kind: 'firstBlood', size: 1, duration: 0.5 },
    });
    expect(policy.optionsFor(duelEvent('hit', 0))).toEqual({ ...QUIET, shake: 9 });
  });

  it('свой рикошет — «сам себя» и первую кровь не тратит; зона экран не трогает и тоже не тратит', () => {
    const policy = new DuelFxPolicy();
    expect(policy.optionsFor(duelEvent('hit', 0, EventFlag.Self | EventFlag.Ricochet))).toEqual({
      ...QUIET,
      shake: 9,
      announcement: { kind: 'selfHit', size: 1, duration: 1 },
    });
    expect(policy.optionsFor(duelEvent('hit', 0, EventFlag.Zone))).toEqual(QUIET);
    expect(policy.optionsFor(duelEvent('hit', null))).toEqual(QUIET);
    expect(policy.optionsFor(duelEvent('hit', 1)).announcement?.kind).toBe('firstBlood');
  });

  it('новый раунд — первая кровь снова впереди', () => {
    const policy = new DuelFxPolicy();
    policy.optionsFor(duelEvent('hit', 1));
    policy.reset();
    expect(policy.optionsFor(duelEvent('hit', 0)).announcement?.kind).toBe('firstBlood');
  });
});
