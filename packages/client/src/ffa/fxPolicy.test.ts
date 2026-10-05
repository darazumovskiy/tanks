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
    expect(policy.optionsFor(event('shot', OTHER, FAR), ME, CAMERA)).toBeNull();
    expect(policy.optionsFor(event('impact', OTHER, FAR), ME, CAMERA)).toBeNull();
    expect(policy.optionsFor(kill(THIRD, OTHER, FAR), ME, CAMERA)).toBeNull();
  });

  it('у окна в пределах 200 — частицы есть, тряски нет', () => {
    const policy = new FfaFxPolicy();
    expect(policy.optionsFor(event('impact', OTHER, NEAR_OUTSIDE), ME, CAMERA)).toEqual({
      shake: 0,
      flash: 0,
      announcement: null,
      hasParticles: true,
    });
  });

  it('чужая смерть в кадре — тряска вдвое слабее своей, без вспышки; за краем кадра — без тряски', () => {
    const policy = new FfaFxPolicy();
    policy.optionsFor(kill(OTHER, THIRD), ME, CAMERA);
    expect(policy.optionsFor(event('death', THIRD), ME, CAMERA)).toMatchObject({ shake: 13, flash: 0 });
    expect(policy.optionsFor(event('death', THIRD, NEAR_OUTSIDE), ME, CAMERA)).toMatchObject({ shake: 0, flash: 0 });
  });

  it('свои события трясут как в дуэли; своя смерть — тряска и вспышка; урон зоной экран не трогает', () => {
    const policy = new FfaFxPolicy();
    expect(policy.optionsFor(event('shot', ME), ME, CAMERA)).toMatchObject({ shake: 2.5, flash: 0 });
    expect(policy.optionsFor(event('hit', ME, INSIDE, { by: OTHER }), ME, CAMERA)).toMatchObject({ shake: 9 });
    expect(policy.optionsFor(event('hit', ME, INSIDE, { flags: EventFlag.Zone }), ME, CAMERA)).toMatchObject({
      shake: 0,
    });
    expect(policy.optionsFor(event('death', ME, INSIDE, { flags: EventFlag.Zone }), ME, CAMERA)).toEqual({
      shake: 26,
      flash: 0.55,
      announcement: null,
      hasParticles: true,
    });
    expect(policy.optionsFor(event('shot', OTHER), ME, CAMERA)).toMatchObject({ shake: 0, flash: 0 });
    expect(policy.optionsFor(event('hit', OTHER, INSIDE, { by: ME }), ME, CAMERA)).toMatchObject({ shake: 0 });
  });
});

describe('объявления толпы', () => {
  it('первое убийство матча своим танком — «ПЕРВАЯ КРОВЬ», второе — нет', () => {
    const policy = new FfaFxPolicy();
    expect(policy.optionsFor(kill(OTHER, ME), ME, CAMERA)?.announcement).toBe('firstBlood');
    expect(policy.optionsFor(kill(THIRD, ME), ME, CAMERA)?.announcement).toBeNull();
  });

  it('первое убийство чужим — своё следующее уже не первое', () => {
    const policy = new FfaFxPolicy();
    expect(policy.optionsFor(kill(THIRD, OTHER, FAR), ME, CAMERA)).toBeNull();
    expect(policy.optionsFor(kill(OTHER, ME), ME, CAMERA)?.announcement).toBeNull();
  });

  it('своя первая кровь по танку далеко за окном — объявление без частиц', () => {
    const policy = new FfaFxPolicy();
    expect(policy.optionsFor(kill(OTHER, ME, FAR), ME, CAMERA)).toEqual({
      shake: 0,
      flash: 0,
      announcement: 'firstBlood',
      hasParticles: false,
    });
  });

  it('своя смерть от своего рикошета — «САМ СЕБЯ!», первое убийство не тратит; чужой свой рикошет — без надписи', () => {
    const policy = new FfaFxPolicy();
    const selfFlags = EventFlag.Self | EventFlag.Ricochet;
    expect(policy.optionsFor(event('death', OTHER, INSIDE, { by: OTHER, flags: selfFlags }), ME, CAMERA)).toMatchObject(
      { announcement: null },
    );
    expect(policy.optionsFor(event('death', ME, INSIDE, { by: ME, flags: selfFlags }), ME, CAMERA)).toMatchObject({
      announcement: 'selfHit',
    });
    expect(policy.optionsFor(event('death', THIRD, INSIDE, { flags: EventFlag.Zone }), ME, CAMERA)?.announcement).toBe(
      null,
    );
    expect(policy.optionsFor(kill(OTHER, ME), ME, CAMERA)?.announcement).toBe('firstBlood');
  });

  it('«ЗОНА СУЖАЕТСЯ» — всем, в том числе без своего танка; новый матч снова ждёт первой крови', () => {
    const policy = new FfaFxPolicy();
    expect(policy.optionsFor(event('zoneStart', null, { x: 0, y: 0 }), null, CAMERA)?.announcement).toBe('zoneStart');
    expect(policy.optionsFor(kill(OTHER, THIRD), null, CAMERA)?.announcement).toBeNull();
    policy.reset();
    expect(policy.optionsFor(kill(OTHER, ME), ME, CAMERA)?.announcement).toBe('firstBlood');
  });

  it('счёт с убийствами — первая кровь пролита до входа; счёт без убийств её не трогает', () => {
    const row = (
      id: number,
      kills: number,
    ): { id: number; kills: number; deaths: number; damageDealt: number; damageTaken: number } => ({
      id,
      kills,
      deaths: 0,
      damageDealt: 0,
      damageTaken: 0,
    });
    const fresh = new FfaFxPolicy();
    fresh.noteScore([row(ME, 0), row(OTHER, 0)]);
    expect(fresh.optionsFor(kill(OTHER, ME), ME, CAMERA)?.announcement).toBe('firstBlood');
    const joiner = new FfaFxPolicy();
    joiner.noteScore([row(ME, 0), row(OTHER, 2)]);
    expect(joiner.optionsFor(kill(OTHER, ME), ME, CAMERA)?.announcement).toBeNull();
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
