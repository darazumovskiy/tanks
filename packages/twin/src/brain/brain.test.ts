import { describe, expect, it } from 'vitest';
import { byBand, calibrationWith, craftView, profileWith, type ViewSpec } from '../fixture.js';
import type { TwinProfile } from '../profile.js';
import { TwinBrain, type TwinDecision, type TwinSituation } from './brain.js';

const PHONE_DECILES = [0, 6.1, 9.4, 14.3, 18.1, 23.2, 31.3, 44, 54.6, 78.6, 135.2];
const SITUATION: TwinSituation = {
  level: 8,
  roundIndex: 0,
  lossStreak: 0,
  mapIndex: 0,
  hasRicochetGuard: true,
  seed: 21,
};
const LONG_START_PAUSE = PHONE_DECILES.map(() => 10);
// Стрелок у левого края «Полигона», башня в край поля: снаряд вернётся рикошетом.
const RETURNING: ViewSpec = { me: { x: 140, y: 450, heading: Math.PI, turret: Math.PI }, enemy: { x: 600, y: 450 } };

function brainOf(profile: TwinProfile, situation: Partial<TwinSituation> = {}): TwinBrain {
  const brain = new TwinBrain(profile);
  brain.init({ ...SITUATION, ...situation });
  return brain;
}

function playScript(brain: TwinBrain, views: readonly ViewSpec[]): TwinDecision[] {
  return views.map((spec) => brain.tick(craftView(spec)));
}

const SCRIPT: ViewSpec[] = Array.from({ length: 240 }, (_, tick) => ({
  me: { x: 300 + tick, y: 120 + (tick % 40), heading: tick / 50, turret: tick / 30 },
  enemy: { x: 900 - tick, y: 150 + tick, heading: Math.PI, speed: 120 },
  tick: tick + 1,
}));

describe('мозг двойника', () => {
  it('без калибровки мозг не создаётся', () => {
    expect(() => new TwinBrain(profileWith({ calibration: null }))).toThrow('нет калибровки');
  });

  it('телефон: намерение огня снято — огня нет и башня стоит; компьютер — башня продолжает вести', () => {
    const paused = { ...profileWith().fire, noStartPauseShare: 0, startPauseDecilesS: LONG_START_PAUSE };
    const phone = brainOf(profileWith({ fire: paused }));
    const pc = brainOf(profileWith({ control: 'mouseKeys', fire: paused }));
    const view: ViewSpec = { me: { x: 300, y: 120, turret: 0 }, enemy: { x: 600, y: 300 } };
    const phoneDecision = phone.tick(craftView(view));
    const pcDecision = pc.tick(craftView(view));

    expect(phoneDecision.action.isFiring).toBe(false);
    expect(phoneDecision.action.turretTurn).toBe(0);
    expect(pcDecision.action.isFiring).toBe(false);
    expect(pcDecision.action.turretTurn).toBeGreaterThan(0);
  });

  it('намерение есть и пушка готова — isFiring в этом же тике', () => {
    const decision = brainOf(profileWith()).tick(craftView({ me: { x: 300, y: 120 }, enemy: { x: 600, y: 120 } }));

    expect(decision.action.isFiring).toBe(true);
    expect(decision.isGuardHolding).toBe(false);
  });

  it('ствол в стену, рикошет вернётся: предохранитель держит огонь; противник на первом отрезке — стреляет', () => {
    const guarded = brainOf(profileWith()).tick(craftView(RETURNING));
    const enemyOnPath = brainOf(profileWith()).tick(craftView({ ...RETURNING, enemy: { x: 70, y: 450 } }));
    const unguarded = brainOf(profileWith(), { hasRicochetGuard: false }).tick(craftView(RETURNING));

    expect(guarded).toMatchObject({ action: { isFiring: false }, isGuardHolding: true });
    expect(enemyOnPath).toMatchObject({ action: { isFiring: true }, isGuardHolding: false });
    expect(unguarded).toMatchObject({ action: { isFiring: true }, isGuardHolding: false });
  });

  it('огонь не зажат — предохранитель не держит, даже когда рикошет вернётся', () => {
    const paused = { ...profileWith().fire, noStartPauseShare: 0, startPauseDecilesS: LONG_START_PAUSE };
    const decision = brainOf(profileWith({ fire: paused })).tick(craftView(RETURNING));

    expect(decision).toMatchObject({ action: { isFiring: false }, isGuardHolding: false });
  });

  it('огонь по контексту видимости: противник за стеной — доля «не виден», на виду — доля «виден»', () => {
    const holdShare = {
      'visible|<300': 1,
      'visible|300–600': 1,
      'visible|>600': 1,
      'hidden|<300': 0,
      'hidden|300–600': 0,
      'hidden|>600': 0,
    };
    const profile = profileWith({ calibration: calibrationWith({ holdShare }) });
    const behindWall: ViewSpec = { me: { x: 220, y: 260 }, enemy: { x: 480, y: 260 } };
    const open: ViewSpec = { me: { x: 300, y: 120 }, enemy: { x: 600, y: 120 } };
    const fired = (spec: ViewSpec): boolean[] =>
      playScript(
        brainOf(profile, { hasRicochetGuard: false }),
        Array.from({ length: 30 }, (_, tick) => ({ ...spec, tick: tick + 1 })),
      ).map((decision) => decision.action.isFiring);

    expect(fired(behindWall).slice(1).some(Boolean)).toBe(false);
    expect(fired(open).every(Boolean)).toBe(true);
  });

  it('снаряды противника двойник не смотрит: со снарядом в виде и без — одинаковые команды', () => {
    const profile = profileWith({
      hand: { errorDecilesDeg: byBand(PHONE_DECILES), leadShare: 0 },
      calibration: calibrationWith({ correlationTicks: 8 }),
    });
    const bullet = {
      id: 1,
      x: 500,
      y: 140,
      vx: -500,
      vy: 0,
      isMine: false,
      bouncesLeft: 1,
      damage: 30,
      canHitOwner: false,
    };
    const plain = playScript(brainOf(profile), SCRIPT);
    const withBullets = playScript(
      brainOf(profile),
      SCRIPT.map((spec) => ({ ...spec, bullets: [bullet] })),
    );

    expect(withBullets).toEqual(plain);
  });

  it('детерминизм: один сид и виды — одинаковые команды, другой сид — другие', () => {
    const profile = profileWith({
      hand: { errorDecilesDeg: byBand(PHONE_DECILES), leadShare: 0 },
      fire: { ...profileWith().fire, noStartPauseShare: 0.5 },
      calibration: calibrationWith({
        correlationTicks: 8,
        holdShare: { ...calibrationWith().holdShare, 'visible|300–600': 0.6 },
      }),
    });

    expect(playScript(brainOf(profile), SCRIPT)).toEqual(playScript(brainOf(profile), SCRIPT));
    expect(playScript(brainOf(profile, { seed: 22 }), SCRIPT)).not.toEqual(playScript(brainOf(profile), SCRIPT));
  });

  it('второй раунд: init сбрасывает паузы, режим, укрытие и память ошибки — раунд повторяется с тем же сидом', () => {
    const profile = profileWith({
      hand: { errorDecilesDeg: byBand(PHONE_DECILES), leadShare: 0 },
      fire: {
        ...profileWith().fire,
        noStartPauseShare: 0,
        startPauseDecilesS: PHONE_DECILES.map((value) => value / 20),
      },
      calibration: calibrationWith({ correlationTicks: 15, lagTicks: 3 }),
    });
    const brain = brainOf(profile);
    const first = playScript(brain, SCRIPT);
    brain.init(SITUATION);
    const second = playScript(brain, SCRIPT);

    expect(second).toEqual(first);
    expect(brain.mode).toBe('manoeuvre');
  });
});
