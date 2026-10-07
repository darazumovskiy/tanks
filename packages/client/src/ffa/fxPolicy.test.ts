import { describe, expect, it } from 'vitest';
import { EventFlag, type FfaSnapshotEvent } from '@tanks/shared/protocol';
import type { Camera } from '../render/camera.js';
import { FfaFxPolicy } from './fxPolicy.js';

const ME = 7;
const OTHER = 3;
const THIRD = 9;
const CAMERA: Camera = { x: 1000, y: 1000, width: 1600, height: 740, scale: 1 };
const INSIDE = { x: 1800, y: 1300 };
const NEAR_OUTSIDE = { x: 2750, y: 1300 };
const FAR = { x: 5000, y: 300 };

function event(
  kind: FfaSnapshotEvent['kind'],
  tank: number | null,
  at: { x: number; y: number } = INSIDE,
  details: Partial<FfaSnapshotEvent> = {},
): FfaSnapshotEvent {
  return { kind, tank, by: null, x: at.x, y: at.y, value: 0, dx: 0, dy: 0, flags: 0, ...details };
}

function kill(victim: number, killer: number, at = INSIDE): FfaSnapshotEvent {
  return event('death', victim, at, { by: killer });
}

describe('эффекты толпы: частицы, тряска, вспышка', () => {
  it('события далеко за окном — без частиц и без вызова эффектов', () => {
    const policy = new FfaFxPolicy();
    expect(policy.optionsFor(event('shot', OTHER, FAR), ME, CAMERA, null)).toBeNull();
    expect(policy.optionsFor(event('impact', OTHER, FAR), ME, CAMERA, null)).toBeNull();
    expect(policy.optionsFor(kill(THIRD, OTHER, FAR), ME, CAMERA, null)).toBeNull();
  });

  it('у окна в пределах 200 — частицы есть, тряски нет', () => {
    const policy = new FfaFxPolicy();
    expect(policy.optionsFor(event('impact', OTHER, NEAR_OUTSIDE), ME, CAMERA, null)).toEqual({
      shake: 0,
      flash: 0,
      announcement: null,
      hasParticles: true,
      ownKillCount: null,
    });
  });

  it('P1 ни одно событие не трясёт экран и не вспыхивает: свои выстрел, попадание, смерть; чужая смерть в кадре', () => {
    const policy = new FfaFxPolicy();
    const events = [
      event('shot', ME),
      event('hit', ME, INSIDE, { by: OTHER }),
      kill(ME, OTHER),
      event('death', ME, INSIDE, { flags: EventFlag.Zone }),
      kill(THIRD, OTHER),
      event('shot', OTHER),
    ];
    for (const fired of events) {
      expect(policy.optionsFor(fired, ME, CAMERA, null)).toMatchObject({ shake: 0, flash: 0 });
    }
  });
});

describe('объявления толпы', () => {
  it('P1 «ПЕРВАЯ КРОВЬ» нет: ни первое убийство матча своим танком, ни по танку за окном', () => {
    const policy = new FfaFxPolicy();
    expect(policy.optionsFor(kill(OTHER, ME), ME, CAMERA, null)?.announcement).toBeNull();
    expect(policy.optionsFor(kill(THIRD, ME, FAR), ME, CAMERA, null)).toBeNull();
  });

  it('P1 своя смерть от своего рикошета — «САМ СЕБЯ!» в 1,5 раза меньше и на 30 % короче; чужой — без надписи', () => {
    const policy = new FfaFxPolicy();
    const selfFlags = EventFlag.Self | EventFlag.Ricochet;
    expect(
      policy.optionsFor(event('death', OTHER, INSIDE, { by: OTHER, flags: selfFlags }), ME, CAMERA, null),
    ).toMatchObject({ announcement: null });
    const own = policy.optionsFor(event('death', ME, INSIDE, { by: ME, flags: selfFlags }), ME, CAMERA, null);
    expect(own?.announcement).toEqual({ kind: 'selfHit', size: 1 / 1.5, duration: 0.7 });
    expect(
      policy.optionsFor(event('death', THIRD, INSIDE, { flags: EventFlag.Zone }), ME, CAMERA, null)?.announcement,
    ).toBe(null);
  });

  it('свой рикошет в себя далеко за окном — объявление без частиц', () => {
    const policy = new FfaFxPolicy();
    const selfFlags = EventFlag.Self | EventFlag.Ricochet;
    expect(policy.optionsFor(event('death', ME, FAR, { by: ME, flags: selfFlags }), ME, CAMERA, null)).toEqual({
      shake: 0,
      flash: 0,
      announcement: { kind: 'selfHit', size: 1 / 1.5, duration: 0.7 },
      hasParticles: false,
      ownKillCount: null,
    });
  });

  it('«ЗОНА СУЖАЕТСЯ» — всем, в том числе без своего танка, базового размера и длительности', () => {
    const policy = new FfaFxPolicy();
    expect(policy.optionsFor(event('zoneStart', null, { x: 0, y: 0 }), null, CAMERA, null)?.announcement).toEqual({
      kind: 'zoneStart',
      size: 1,
      duration: 1,
    });
    expect(policy.optionsFor(kill(OTHER, THIRD), null, CAMERA, null)?.announcement).toBeNull();
  });
});

describe('свой фраг', () => {
  it('F2 номер своего убийства уходит в эффекты; своё убийство за окном — ничего; без номера — пусто', () => {
    const policy = new FfaFxPolicy();
    expect(policy.optionsFor(kill(OTHER, ME), ME, CAMERA, 3)).toMatchObject({ ownKillCount: 3, hasParticles: true });
    expect(policy.optionsFor(kill(OTHER, ME, FAR), ME, CAMERA, 3)).toBeNull();
    expect(policy.optionsFor(kill(OTHER, THIRD), ME, CAMERA, null)?.ownKillCount).toBeNull();
  });
});

describe('звук толпы', () => {
  const policy = new FfaFxPolicy();

  it('только события в окне камеры; панорама по экрану от −0,8 у левого края до 0,8 у правого, полная громкость', () => {
    expect(policy.soundFor(event('shot', OTHER, { x: CAMERA.x, y: 1200 }), CAMERA, 1)).toEqual({
      name: 'shot',
      pan: -0.8,
      volume: 1,
    });
    expect(policy.soundFor(event('death', OTHER, { x: CAMERA.x + CAMERA.width, y: 1200 }), CAMERA, 1)).toEqual({
      name: 'death',
      pan: 0.8,
      volume: 1,
    });
    expect(policy.soundFor(event('hit', OTHER, { x: CAMERA.x + CAMERA.width / 2, y: 1200 }), CAMERA, 1)).toEqual({
      name: 'hit',
      pan: 0,
      volume: 1,
    });
    expect(policy.soundFor(event('shot', OTHER, NEAR_OUTSIDE), CAMERA, 1)).toBeNull();
  });

  it('начало зоны — тревога по центру; шипение зоны — на каждом седьмом тике; беззвучные виды молчат', () => {
    expect(policy.soundFor(event('zoneStart', null, FAR), CAMERA, 1)).toEqual({ name: 'alarm', pan: 0, volume: 1 });
    const zoneHit = event('hit', OTHER, INSIDE, { flags: EventFlag.Zone });
    expect(policy.soundFor(zoneHit, CAMERA, 14)?.name).toBe('zoneTick');
    expect(policy.soundFor(zoneHit, CAMERA, 15)).toBeNull();
    expect(policy.soundFor(event('spawn', OTHER), CAMERA, 1)).toBeNull();
    expect(policy.soundFor(event('fizzle', OTHER), CAMERA, 1)).toBeNull();
  });
});
