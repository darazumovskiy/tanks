import { ARENA } from './constants.js';
import type { Field, Wall } from './geometry.js';

export interface Point {
  x: number;
  y: number;
}

export interface Spawn extends Point {
  heading: number;
}

// Карта для поля боя: размеры, стены и места аптечек.
export interface BattleMap extends Field {
  name: string;
  walls: Wall[];
  kits: Point[];
}

export interface MapDef extends BattleMap {
  spawns: [Spawn, Spawn];
}

const W = ARENA.width;
const H = ARENA.height;

// Каждая карта точечно-симметрична относительно центра: обе точки появления равноценны.
function mirrorWall(wall: Wall): Wall {
  return { x: W - wall.x - wall.w, y: H - wall.y - wall.h, w: wall.w, h: wall.h };
}

function buildMap(name: string, half: Wall[], kits: Point[]): MapDef {
  const walls: Wall[] = [];
  for (const wall of half) {
    walls.push({ ...wall }, mirrorWall(wall));
  }
  return {
    name,
    width: W,
    height: H,
    walls,
    spawns: [
      { x: 140, y: H / 2, heading: 0 },
      { x: W - 140, y: H / 2, heading: Math.PI },
    ],
    kits,
  };
}

export const MAPS: readonly MapDef[] = [
  buildMap(
    'Полигон',
    [
      { x: 330, y: 160, w: 44, h: 200 },
      { x: 330, y: 540, w: 44, h: 200 },
      { x: 600, y: 300, w: 160, h: 44 },
      { x: 770, y: 390, w: 30, h: 120 },
    ],
    [
      { x: 800, y: 130 },
      { x: 800, y: 770 },
    ],
  ),
  buildMap(
    'Лабиринт',
    [
      { x: 250, y: 250, w: 40, h: 400 },
      { x: 450, y: 0, w: 40, h: 330 },
      { x: 450, y: 570, w: 40, h: 330 },
      { x: 640, y: 200, w: 200, h: 40 },
      { x: 780, y: 330, w: 20, h: 240 },
    ],
    [
      { x: 800, y: 110 },
      { x: 800, y: 790 },
    ],
  ),
  buildMap(
    'Крепости',
    [
      { x: 230, y: 330, w: 40, h: 240 },
      { x: 90, y: 290, w: 180, h: 40 },
      { x: 90, y: 570, w: 180, h: 40 },
      { x: 560, y: 120, w: 44, h: 220 },
      { x: 560, y: 560, w: 44, h: 220 },
      { x: 740, y: 420, w: 60, h: 60 },
    ],
    [
      { x: 800, y: 130 },
      { x: 800, y: 770 },
    ],
  ),
  buildMap(
    'Каньон',
    [
      { x: 300, y: 280, w: 420, h: 40 },
      { x: 300, y: 580, w: 260, h: 40 },
      { x: 780, y: 110, w: 40, h: 160 },
    ],
    [
      { x: 620, y: 450 },
      { x: 980, y: 450 },
    ],
  ),
];

export function mapByIndex(index: number): MapDef {
  const map = MAPS[index % MAPS.length];
  if (map === undefined) {
    throw new Error(`нет карты с индексом ${String(index)}`);
  }
  return map;
}

// Раунд i матча: карты идут по кругу, каждая играется с обеих сторон.
export function roundPlan(index: number): { mapIndex: number; isSwapped: boolean } {
  return { mapIndex: index % MAPS.length, isSwapped: (index + Math.floor(index / MAPS.length)) % 2 === 1 };
}
