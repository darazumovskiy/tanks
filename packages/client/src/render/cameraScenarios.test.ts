import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings.js';
import { CAMERA_SCENARIOS, PHONE_SCREENS, checkCameraInvariants } from './cameraScenarios.js';
import { DuelCamera, ZOOM_DEAD_BAND } from './duelCamera.js';

// Каждый сценарий на каждом экране: конвейер камеры до сходимости → инварианты I1–I7.
describe('камера дуэли: сценарии', () => {
  for (const screen of PHONE_SCREENS) {
    describe(screen.id, () => {
      const canvasWidth = screen.width * screen.pixelRatio;
      const canvasHeight = screen.height * screen.pixelRatio;

      for (const scenario of CAMERA_SCENARIOS) {
        it(scenario.title, () => {
          const camera = new DuelCamera(DEFAULT_SETTINGS).settle(
            scenario.me,
            scenario.enemy,
            canvasWidth,
            canvasHeight,
          );
          const violations = checkCameraInvariants(camera, scenario, DEFAULT_SETTINGS);
          expect(violations, violations.map((v) => `${v.invariant}: ${v.detail}`).join('; ')).toEqual([]);
        });
      }

      it('I8: мелкое маневрирование противника не меняет масштаб', () => {
        const duel = new DuelCamera(DEFAULT_SETTINGS);
        const me = { x: 500, y: 450 };
        const enemy = { x: 1100, y: 450 };
        const settled = duel.settle(me, enemy, canvasWidth, canvasHeight);
        const distance = enemy.x - me.x;
        for (const k of [0.92, 1.08, 0.9, 1.1]) {
          const moved = { x: me.x + distance * k, y: 450 };
          const camera = duel.settle(me, moved, canvasWidth, canvasHeight, 1000);
          expect(Math.abs(camera.height - settled.height)).toBeLessThan(1);
        }
        const far = duel.settle(
          me,
          { x: me.x + distance * (1 + ZOOM_DEAD_BAND * 1.5), y: 450 },
          canvasWidth,
          canvasHeight,
        );
        expect(far.height).toBeGreaterThan(settled.height);
      });

      it('I9: новый раунд — камера сразу на новой позиции, без проезда через поле', () => {
        const duel = new DuelCamera(DEFAULT_SETTINGS);
        duel.settle({ x: 60, y: 840 }, { x: 160, y: 760 }, canvasWidth, canvasHeight);
        duel.reset();
        const first = duel.update({ x: 1460, y: 450 }, { x: 140, y: 450 }, canvasWidth, canvasHeight, 16);
        const settled = new DuelCamera(DEFAULT_SETTINGS).settle(
          { x: 1460, y: 450 },
          { x: 140, y: 450 },
          canvasWidth,
          canvasHeight,
        );
        expect(first.x).toBeCloseTo(settled.x, 3);
        expect(first.height).toBeCloseTo(settled.height, 3);
      });
    });
  }
});
