import { FFA } from './constants.js';
import type { Point } from './maps.js';

// Радиус эллипса сдвигов в направлении angle (ось y вниз): полуось вбок — от ширины окна, вниз и вверх — свои
// от высоты. На горизонтали обе половины сходятся на одной полуоси, поэтому радиус непрерывен.
export function ffaViewReach(angle: number): number {
  const side = FFA.viewAheadSide * FFA.viewWidth;
  const vertical = (Math.sin(angle) >= 0 ? FFA.viewAheadDown : FFA.viewAheadUp) * FFA.viewHeight;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return 1 / Math.sqrt((cos * cos) / (side * side) + (sin * sin) / (vertical * vertical));
}

// Точка обзора толпы: танк, сдвинутый вдоль ствола на радиус эллипса; по ней видят и игрок, и бот.
export function ffaViewCenter(tank: Point & { turret: number }): Point {
  const reach = ffaViewReach(tank.turret);
  return { x: tank.x + reach * Math.cos(tank.turret), y: tank.y + reach * Math.sin(tank.turret) };
}
