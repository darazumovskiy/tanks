import { normalizeAngle } from '@tanks/shared/engine';
import { stickMagnitude, type StickVector } from './steering.js';

// Бросок: палец резко уходит через центр стика на другую сторону. Отклонение падает ниже центра и снова выходит
// наружу за это время, а направление до и после отличается не меньше чем на этот угол.
export const FLICK_MAX_MS = 200;
const FLICK_CENTER_RATIO = 0.4;
const FLICK_OUTER_RATIO = 0.6;
const FLICK_MIN_TURN = (135 * Math.PI) / 180;

// Жест узнаётся только по пути пальца: ведение по кольцу без провала к центру, пауза пальца и свежее касание
// от центра наружу бросками не считаются.
export class FlickDetector {
  private outerAngle: number | null = null;
  private crossing: { fromAngle: number; startedAt: number } | null = null;

  push(stick: StickVector, now: number): boolean {
    const magnitude = stickMagnitude(stick);
    if (magnitude < FLICK_CENTER_RATIO) {
      this.enterCenter(now);
      return false;
    }
    if (magnitude < FLICK_OUTER_RATIO) {
      return false;
    }
    const angle = Math.atan2(stick.dy, stick.dx);
    const isFlick = this.isLanding(angle, now);
    this.crossing = null;
    this.outerAngle = angle;
    return isFlick;
  }

  private enterCenter(now: number): void {
    if (this.crossing !== null || this.outerAngle === null) {
      return;
    }
    this.crossing = { fromAngle: this.outerAngle, startedAt: now };
  }

  private isLanding(angle: number, now: number): boolean {
    if (this.crossing === null) {
      return false;
    }
    const isQuick = now - this.crossing.startedAt <= FLICK_MAX_MS;
    const isOpposite = Math.abs(normalizeAngle(angle - this.crossing.fromAngle)) >= FLICK_MIN_TURN;
    return isQuick && isOpposite;
  }
}
