import { mapByIndex } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { gridOf, nearestFree, PathFollower, WAYPOINT_REACHED } from './path.js';

const POLYGON = mapByIndex(0);
const CELL = 25;

describe('сетка и путь двойника', () => {
  it('вокруг точки всё занято — ближайшая свободная клетка — её собственная', () => {
    const solid = gridOf({ ...POLYGON, walls: [{ x: 0, y: 0, w: POLYGON.width, h: POLYGON.height }] });
    const point = { x: 612, y: 437 };

    expect(nearestFree(solid, point)).toBe(Math.floor(point.y / CELL) * solid.cols + Math.floor(point.x / CELL));
  });

  it('цель в своей клетке — точка пути достигнута и снята, следующий запрос строит путь заново', () => {
    const grid = gridOf(POLYGON);
    const follower = new PathFollower();
    const me = { x: 112, y: 112 };
    const goal = { x: 114, y: 113 };
    const waypoint = follower.waypoint(grid, me, goal, 0);

    expect(Math.hypot(waypoint.x - me.x, waypoint.y - me.y)).toBeLessThan(WAYPOINT_REACHED);
    expect(follower.waypoint(grid, me, goal, 1)).toEqual(waypoint);
  });
});
