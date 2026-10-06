import { wallClearance } from '@tanks/analysis';
import { BULLET_RADIUS, isSegmentClear, type Point, type Wall } from '@tanks/shared/engine';
import type { Band } from '../profile.js';
import { findPath, nearestCell, nearestFree, WAYPOINT_REACHED, type Grid } from './path.js';

export interface CoverSettings {
  distanceBand: Band;
  wallDistanceBand: Band;
}

const EXIT_REPLAN_TICKS = 10;

function isInBand(value: number, band: Band): boolean {
  return value >= band.near && value <= band.far;
}

export function hasLineOfSight(walls: readonly Wall[], from: Point, to: Point): boolean {
  return isSegmentClear(walls, from.x, from.y, to.x, to.y, BULLET_RADIUS);
}

// Засада за укрытием: место, где стена закрывает противника, и точка, откуда он выйдет в видимость.
export class Ambush {
  private spotPoint: Point | null = null;
  private exitPoint: Point | null = null;
  private exitTick = -Infinity;

  constructor(private readonly settings: CoverSettings) {}

  get spot(): Point | null {
    return this.spotPoint;
  }

  reset(): void {
    this.spotPoint = null;
    this.exitPoint = null;
    this.exitTick = -Infinity;
  }

  // Ближайшая по пути клетка, где стена закрывает противника, дистанция и расстояние до стены — в полосах
  // позиции. false — подходящей клетки нет.
  choose(grid: Grid, me: Point, enemy: Point): boolean {
    const { distanceBand, wallDistanceBand } = this.settings;
    const spot = nearestCell(grid, nearestFree(grid, me), (center) => {
      const distance = Math.hypot(center.x - enemy.x, center.y - enemy.y);
      return (
        isInBand(distance, distanceBand) &&
        isInBand(wallClearance(grid.walls, center.x, center.y), wallDistanceBand) &&
        !hasLineOfSight(grid.walls, center, enemy)
      );
    });
    this.spotPoint = spot;
    this.exitPoint = null;
    this.exitTick = -Infinity;
    return spot !== null;
  }

  isAtSpot(me: Point): boolean {
    const spot = this.spotPoint;
    return spot !== null && Math.hypot(spot.x - me.x, spot.y - me.y) < WAYPOINT_REACHED;
  }

  // Первая точка пути противника к засаде, видная с места засады; пути нет — сам противник.
  exit(grid: Grid, enemy: Point, tick: number): Point {
    const spot = this.spotPoint;
    if (spot === null) {
      return enemy;
    }
    if (this.exitPoint === null || tick - this.exitTick > EXIT_REPLAN_TICKS) {
      const path = findPath(grid, nearestFree(grid, enemy), nearestFree(grid, spot));
      this.exitPoint = path.find((point) => hasLineOfSight(grid.walls, spot, point)) ?? enemy;
      this.exitTick = tick;
    }
    return this.exitPoint;
  }
}
