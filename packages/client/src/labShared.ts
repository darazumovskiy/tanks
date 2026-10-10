import type { AimLine } from './aimLine.js';
import { NO_NET_WARNING } from './netWarning.js';
import type { HudInfo } from './render/renderer.js';
import type { Settings } from './settings.js';
import type { StickState } from './touch.js';

// Общее для лабораторий камеры и эффектов: выпадающий список и пустой HUD без сети.

export function buildSelect<T extends { id: string }>(
  items: readonly T[],
  title: (item: T) => string,
): HTMLSelectElement {
  const select = document.createElement('select');
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = title(item);
    select.append(option);
  }
  return select;
}

export const LAB_NAMES: [string, string] = ['Я', 'Противник'];

export function labHud(sticks: StickState[], frameMs: number, aimLine: AimLine | null): HudInfo {
  return {
    names: LAB_NAMES,
    score: [0, 0],
    roundIndex: 0,
    gameId: 'LAB',
    gameTick: 0,
    mySide: 0,
    rttMs: 0,
    correctionPx: 0,
    fps: 0,
    worstFrameMs: 0,
    isMuted: true,
    netWarning: NO_NET_WARNING,
    sticks,
    isShotGuarded: false,
    isZoneFiring: false,
    isReversing: false,
    aimLine,
    frameMs,
    frameTimes: [],
  };
}

const THUMB_LEFT = { fx: 0.12, fy: 0.75 };
const THUMB_RIGHT = { fx: 0.88, fy: 0.75 };

// Стики там, где обычно лежат большие пальцы, — чтобы видеть, что они перекрывают.
export function thumbSticks(width: number, height: number, settings: Readonly<Settings>): StickState[] {
  const make = (role: 'move' | 'aim', spot: { fx: number; fy: number }): StickState => ({
    role,
    baseX: width * spot.fx,
    baseY: height * spot.fy,
    dx: 0,
    dy: 0,
    radiusPx: settings.stickRadiusPx,
    deadZone: settings.deadZone,
    fireRing: settings.hasFireRing ? settings.fireRing : null,
    isActive: false,
    isFiring: false,
  });
  return [make('move', THUMB_LEFT), make('aim', THUMB_RIGHT)];
}
