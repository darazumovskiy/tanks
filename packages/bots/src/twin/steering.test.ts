import { describe, expect, it } from 'vitest';
import { aimTurret, IDLE_HULL, keysToward, steerHull, type HullSteering, type StickVector } from './steering.js';
import { craftView } from './fixture.js';

interface SteeringModule {
  steerHull: typeof steerHull;
  aimTurret: typeof aimTurret;
}

// Клиент — браузерный пакет и в пакет ботов не входит; его модуль берётся только тестом, путём от этого файла.
const CLIENT_STEERING = '../../../client/src/steering.ts';

const ANGLES = Array.from({ length: 24 }, (_, index) => -Math.PI + (index * Math.PI) / 12 + 0.01);
const MAGNITUDES = [0.2, 0.7, 1];
const TURN_RATES = [1.5, 3];
const PIVOTS = [0, 0.6, 1];
const PREVIOUS: HullSteering[] = [
  IDLE_HULL,
  { throttle: 0.5, turn: -1, isReversing: false },
  { throttle: -0.5, turn: 1, isReversing: true },
];

describe('управление двойника', () => {
  it('копии steerHull и aimTurret совпадают с клиентскими на сетке стиков, курсов, башен и настроек', async () => {
    const client = (await import(CLIENT_STEERING)) as SteeringModule;
    let compared = 0;
    for (const angle of ANGLES) {
      for (const heading of ANGLES) {
        expect(aimTurret(angle, heading)).toBe(client.aimTurret(angle, heading));
        for (const magnitude of MAGNITUDES) {
          const stick: StickVector = { dx: Math.cos(angle) * magnitude, dy: Math.sin(angle) * magnitude };
          for (const turnRate of TURN_RATES) {
            for (const pivot of PIVOTS) {
              for (const previous of PREVIOUS) {
                expect(steerHull(stick, heading, turnRate, previous, pivot)).toEqual(
                  client.steerHull(stick, heading, turnRate, previous, pivot),
                );
                compared++;
              }
            }
          }
        }
      }
    }
    expect(compared).toBe(
      ANGLES.length * ANGLES.length * MAGNITUDES.length * TURN_RATES.length * PIVOTS.length * PREVIOUS.length,
    );
  });

  it('клавиши компьютера: поворот к точке за пределами зоны нечувствительности, задним ходом — кормой', () => {
    const me = craftView({ me: { x: 400, y: 400, heading: 0 }, enemy: { x: 900, y: 400 } }).me;

    expect(keysToward(me, { x: 600, y: 400 }, false)).toEqual({ throttle: 1, turn: 0 });
    expect(keysToward(me, { x: 600, y: 600 }, false)).toEqual({ throttle: 1, turn: 1 });
    expect(keysToward(me, { x: 200, y: 400 }, true)).toEqual({ throttle: -1, turn: 0 });
    expect(keysToward(me, { x: 200, y: 300 }, true)).toEqual({ throttle: -1, turn: 1 });
  });
});
