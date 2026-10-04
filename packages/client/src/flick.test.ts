import { beforeEach, describe, expect, it } from 'vitest';
import { FLICK_MAX_MS, FlickDetector } from './flick.js';

const deg = (value: number): number => (value * Math.PI) / 180;

function at(angle: number, magnitude: number): { dx: number; dy: number } {
  return { dx: Math.cos(angle) * magnitude, dy: Math.sin(angle) * magnitude };
}

describe('FlickDetector', () => {
  let detector: FlickDetector;

  beforeEach(() => {
    detector = new FlickDetector();
  });

  // Палец на одной стороне, через центр, на другую: события по пути и момент приземления.
  function flick(fromAngle: number, toAngle: number, durationMs: number, dipMagnitude = 0): boolean[] {
    const events = [
      detector.push(at(fromAngle, 1), 0),
      detector.push(at(fromAngle, dipMagnitude), 10),
      detector.push(at(toAngle, 1), durationMs),
    ];
    return events;
  }

  it('бросок через центр за 100 мс — событие в момент выхода наружу', () => {
    expect(flick(0, Math.PI, 100)).toEqual([false, false, true]);
  });

  it('медленный перенос через центр — не бросок', () => {
    expect(flick(0, Math.PI, FLICK_MAX_MS + 100)).toEqual([false, false, false]);
  });

  it('приземление ближе 135° — не бросок, от 135° — бросок', () => {
    expect(flick(0, deg(120), 100).at(-1)).toBe(false);
    detector = new FlickDetector();
    expect(flick(0, deg(140), 100).at(-1)).toBe(true);
  });

  it('ведение по кольцу без провала к центру — не бросок', () => {
    expect(detector.push(at(0, 1), 0)).toBe(false);
    expect(detector.push(at(deg(90), 1), 50)).toBe(false);
    expect(detector.push(at(Math.PI, 1), 100)).toBe(false);
  });

  it('провал только до половины радиуса — не бросок', () => {
    expect(flick(0, Math.PI, 100, 0.5).at(-1)).toBe(false);
  });

  it('свежее касание от центра наружу — не бросок', () => {
    expect(detector.push(at(0, 0), 0)).toBe(false);
    expect(detector.push(at(Math.PI, 1), 50)).toBe(false);
  });

  it('провал к центру и возврат на ту же сторону — не бросок; следующий настоящий бросок узнаётся', () => {
    expect(flick(0, 0, 100).at(-1)).toBe(false);
    expect(detector.push(at(0, 0), 200)).toBe(false);
    expect(detector.push(at(Math.PI, 1), 260)).toBe(true);
  });

  it('два броска подряд — два события', () => {
    expect(flick(0, Math.PI, 100).at(-1)).toBe(true);
    expect(detector.push(at(Math.PI, 0.1), 300)).toBe(false);
    expect(detector.push(at(0, 1), 400)).toBe(true);
  });

  it('время считается от провала: подождал в центре — не бросок', () => {
    expect(detector.push(at(0, 1), 0)).toBe(false);
    expect(detector.push(at(0, 0.2), 10)).toBe(false);
    expect(detector.push(at(0, 0.1), 300)).toBe(false);
    expect(detector.push(at(Math.PI, 1), 320)).toBe(false);
  });

  it('промежуток между центром и краем ничего не меняет: бросок завершается на выходе наружу', () => {
    expect(detector.push(at(0, 1), 0)).toBe(false);
    expect(detector.push(at(0, 0), 10)).toBe(false);
    expect(detector.push(at(Math.PI, 0.5), 50)).toBe(false);
    expect(detector.push(at(Math.PI, 0.7), 90)).toBe(true);
  });
});
