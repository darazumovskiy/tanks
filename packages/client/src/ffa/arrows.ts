import { clamp, type Point } from '@tanks/shared/engine';
import { isInView, TANK_AREA, worldToScreen, type Camera } from '../render/camera.js';

// Больше трёх стрелок разом — частокол по краю, в котором не видно ближнего.
export const MAX_ARROWS = 3;
// Ближе этого — стрелка полного размера и яркости, дальше дальнего — самая мелкая и тусклая. Тусклее предела
// мелкая стрелка на светлом полу теряет направление.
const NEAR_DISTANCE = 400;
const FAR_DISTANCE = 2400;
const FAR_SCALE = 0.6;
const FAR_ALPHA = 0.7;
// Рамка стрелок в точках экрана: ниже верхней полосы табло (она выше разрешённой области своего танка), левее
// «АВТО» и шестерёнки у правого края, выше строки игры внизу. Запас — на стрелку до 18 точек от центра.
export const ARROW_FRAME_INSET = { top: 22, left: 26, right: 86, bottom: 36 } as const;

export interface ArrowTank extends Point {
  id: number;
  isAlive: boolean;
}

// Стрелка на рамке экрана в точках: остриё смотрит на врага; `scale` и `alpha` — доли полного размера и яркости.
export interface EdgeArrow {
  id: number;
  x: number;
  y: number;
  angle: number;
  scale: number;
  alpha: number;
}

export interface ArrowsInput {
  // Свой танк на поле; `null` — своего нет: подбит, ждёт или зритель.
  me: Point | null;
  myId: number | null;
  tanks: readonly ArrowTank[];
  camera: Camera;
  // Окно камеры переводится в точки холста; плотность возвращает их к точкам экрана.
  pixelRatio: number;
}

interface Frame {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function isOther(tank: ArrowTank, myId: number | null): boolean {
  return tank.id !== myId && tank.isAlive;
}

// Живые чужие в окне камеры — цели линии выстрела и помощников.
export function visibleEnemies<T extends ArrowTank>(tanks: readonly T[], myId: number | null, camera: Camera): T[] {
  return tanks.filter((tank) => isOther(tank, myId) && isInView(camera, tank));
}

function frameOf(width: number, height: number): Frame {
  return {
    left: ARROW_FRAME_INSET.left,
    top: height * TANK_AREA.top + ARROW_FRAME_INSET.top,
    right: width - ARROW_FRAME_INSET.right,
    bottom: height - ARROW_FRAME_INSET.bottom,
  };
}

// Расстояние по лучу от точки внутри рамки до её края по одной оси; луч вдоль другой оси края не достигает.
function reachAlong(from: number, step: number, min: number, max: number): number {
  if (step > 0) {
    return (max - from) / step;
  }
  if (step < 0) {
    return (min - from) / step;
  }
  return Infinity;
}

// Ближе — крупнее и ярче: доля дальности между ближним и дальним порогом.
function farness(distance: number): number {
  return clamp((distance - NEAR_DISTANCE) / (FAR_DISTANCE - NEAR_DISTANCE), 0, 1);
}

// Стрелки на трёх ближайших к своему танку живых чужих за окном камеры — на рамке экрана, по лучу от своего танка.
export function edgeArrows(input: ArrowsInput): EdgeArrow[] {
  const { me, camera, pixelRatio } = input;
  if (me === null) {
    return [];
  }
  const toScreen = (point: Point): Point => {
    const onCanvas = worldToScreen(camera, point);
    return { x: onCanvas.x / pixelRatio, y: onCanvas.y / pixelRatio };
  };
  const frame = frameOf((camera.width * camera.scale) / pixelRatio, (camera.height * camera.scale) / pixelRatio);
  const ownOnScreen = toScreen(me);
  const origin = {
    x: clamp(ownOnScreen.x, frame.left, frame.right),
    y: clamp(ownOnScreen.y, frame.top, frame.bottom),
  };
  return input.tanks
    .filter((tank) => isOther(tank, input.myId) && !isInView(camera, tank))
    .map((tank) => ({ tank, distance: Math.hypot(tank.x - me.x, tank.y - me.y) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_ARROWS)
    .map(({ tank, distance }) => {
      const target = toScreen(tank);
      const dx = target.x - origin.x;
      const dy = target.y - origin.y;
      const reach = Math.min(
        reachAlong(origin.x, dx, frame.left, frame.right),
        reachAlong(origin.y, dy, frame.top, frame.bottom),
      );
      const share = farness(distance);
      return {
        id: tank.id,
        x: origin.x + dx * reach,
        y: origin.y + dy * reach,
        angle: Math.atan2(dy, dx),
        scale: 1 - (1 - FAR_SCALE) * share,
        alpha: 1 - (1 - FAR_ALPHA) * share,
      };
    });
}
