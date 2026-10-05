import { describe, expect, it } from 'vitest';
import type { Camera } from '../render/camera.js';
import { ARROW_FRAME_INSET, edgeArrows, MAX_ARROWS, visibleEnemies, type ArrowTank, type EdgeArrow } from './arrows.js';

const ME = 1;
// Телефон 844 × 390 с плотностью 2: окно камеры — вся ширина обзора 1600.
const PHONE = { width: 844, height: 390, pixelRatio: 2 };
const VIEW_WIDTH = 1600;
// Наибольшая стрелка рендера — 18 точек от центра в любую сторону.
const ARROW_REACH = 18;
// Кнопки и табло боя толпы на телефоне 844 × 390, точки экрана: «⌂» слева вверху, «АВТО» у правого края на середине
// высоты, шестерёнка в правом нижнем углу; табло — верхняя полоса выше 19 % высоты.
const HOME_BUTTON = { left: 10, top: 10, right: 44, bottom: 44 };
const AUTO_BUTTON = { left: 782, top: 169, right: 834, bottom: 221 };
const GEAR_BUTTON = { left: 794, top: 340, right: 834, bottom: 380 };
const TOP_STRIP_BOTTOM = 390 * 0.19;

function phoneCamera(centerX: number, centerY: number): Camera {
  const height = (VIEW_WIDTH * PHONE.height) / PHONE.width;
  return {
    x: centerX - VIEW_WIDTH / 2,
    y: centerY - height / 2,
    width: VIEW_WIDTH,
    height,
    scale: (PHONE.width * PHONE.pixelRatio) / VIEW_WIDTH,
  };
}

const CAMERA = phoneCamera(1000, 1000);
const OWN = { id: ME, x: 1000, y: 1000, isAlive: true };

function enemy(id: number, x: number, y: number, isAlive = true): ArrowTank {
  return { id, x, y, isAlive };
}

function arrows(tanks: readonly ArrowTank[], me: { x: number; y: number } | null = OWN, camera = CAMERA): EdgeArrow[] {
  return edgeArrows({ me, myId: ME, tanks: [OWN, ...tanks], camera, pixelRatio: PHONE.pixelRatio });
}

function overlaps(arrow: EdgeArrow, box: { left: number; top: number; right: number; bottom: number }): boolean {
  const isApartX = arrow.x + ARROW_REACH <= box.left || arrow.x - ARROW_REACH >= box.right;
  const isApartY = arrow.y + ARROW_REACH <= box.top || arrow.y - ARROW_REACH >= box.bottom;
  return !isApartX && !isApartY;
}

describe('edgeArrows', () => {
  it('стрелки — только на живых чужих за кадром: в кадре, подбитые и свой — без стрелки', () => {
    const shown = arrows([enemy(2, 1300, 1100), enemy(3, 2100, 1000), enemy(4, 1000, 1600, false), enemy(5, 400, 400)]);
    expect(shown.map((arrow) => arrow.id)).toEqual([5, 3]);
  });

  it('за кадром больше трёх — три ближайших к своему танку, ближние первыми; меньше трёх — сколько есть', () => {
    const far = [
      enemy(2, 3500, 1000),
      enemy(3, 1000, 1500),
      enemy(4, -400, 1000),
      enemy(5, 1000, 3000),
      enemy(6, 2000, 1000),
    ];
    expect(arrows(far).map((arrow) => arrow.id)).toEqual([3, 6, 4]);
    expect(arrows(far)).toHaveLength(MAX_ARROWS);
    expect(arrows([enemy(2, 3500, 1000)]).map((arrow) => arrow.id)).toEqual([2]);
    expect(arrows([])).toEqual([]);
  });

  it('свой танк не на поле (подбит, ждёт, зритель) — ни одной стрелки', () => {
    expect(arrows([enemy(2, 3500, 1000), enemy(3, 1000, 1500)], null)).toEqual([]);
  });

  it('ближе — крупнее и ярче; дальше дальнего порога — не мельче и не тусклее предела', () => {
    const [near, middle, far] = arrows([enemy(2, 1000, 1400), enemy(3, 1000, 2400), enemy(4, 1000, 5000)]);
    expect(near?.scale).toBe(1);
    expect(near?.alpha).toBe(1);
    expect(middle?.scale).toBeLessThan(near?.scale ?? 0);
    expect(middle?.alpha).toBeLessThan(near?.alpha ?? 0);
    expect(far?.scale).toBeLessThan(middle?.scale ?? 0);
    expect(far?.alpha).toBeLessThan(middle?.alpha ?? 0);
    expect(far?.scale).toBeCloseTo(0.6, 9);
    expect(far?.alpha).toBeCloseTo(0.7, 9);
  });

  it('стрелка на рамке по лучу от своего танка к врагу, остриё смотрит на врага', () => {
    const ownOnScreen = { x: ((1000 - CAMERA.x) / 2) * CAMERA.scale, y: ((1000 - CAMERA.y) / 2) * CAMERA.scale };
    const [right] = arrows([enemy(2, 2500, 1000)]);
    expect(right?.x).toBeCloseTo(PHONE.width - ARROW_FRAME_INSET.right, 9);
    expect(right?.angle).toBe(0);
    expect(right?.y).toBeCloseTo(ownOnScreen.y, 9);
    const [below] = arrows([enemy(3, 1000, 1500)]);
    expect(below?.x).toBeCloseTo(ownOnScreen.x, 9);
    expect(below?.y).toBeCloseTo(PHONE.height - ARROW_FRAME_INSET.bottom, 9);
    expect(below?.angle).toBeCloseTo(Math.PI / 2, 9);
    const [upLeft] = arrows([enemy(4, 0, 0)]);
    expect(upLeft?.angle).toBeCloseTo(Math.atan2(-1000 * CAMERA.scale, -1000 * CAMERA.scale), 9);
    const isOnLeft = Math.abs((upLeft?.x ?? 0) - ARROW_FRAME_INSET.left) < 1e-9;
    const isOnTop = Math.abs((upLeft?.y ?? 0) - (PHONE.height * 0.19 + ARROW_FRAME_INSET.top)) < 1e-9;
    expect(isOnLeft || isOnTop).toBe(true);
  });

  it('враг у самого края за кадром — стрелка у этого края; на шаг внутрь — стрелки нет', () => {
    const edge = CAMERA.x + CAMERA.width;
    const [justOutside] = arrows([enemy(2, edge + 1, 1000)]);
    expect(justOutside?.x).toBeCloseTo(PHONE.width - ARROW_FRAME_INSET.right, 9);
    expect(arrows([enemy(2, edge - 1, 1000)])).toEqual([]);
  });

  it('свой танк выше рамки стрелок (у верха разрешённой области) — стрелка внутри рамки, не по другую сторону', () => {
    const ownY = CAMERA.y + ((TOP_STRIP_BOTTOM + 6) * VIEW_WIDTH) / PHONE.width;
    const ownScreenX = ((1000 - CAMERA.x) * CAMERA.scale) / PHONE.pixelRatio;
    const frame = {
      left: ARROW_FRAME_INSET.left,
      top: TOP_STRIP_BOTTOM + ARROW_FRAME_INSET.top,
      right: PHONE.width - ARROW_FRAME_INSET.right,
      bottom: PHONE.height - ARROW_FRAME_INSET.bottom,
    };
    for (const dx of [-3000, -1500, -300, 300, 1500, 3000]) {
      const target = enemy(2, 1000 + dx, ownY - 1500);
      const [arrow] = arrows([target], { x: 1000, y: ownY });
      if (arrow === undefined) {
        throw new Error(`нет стрелки при сдвиге ${String(dx)}`);
      }
      expect((arrow.x - ownScreenX) * Math.sign(dx), `сдвиг ${String(dx)}`).toBeGreaterThanOrEqual(-1e-9);
      expect(arrow.x).toBeGreaterThanOrEqual(frame.left - 1e-9);
      expect(arrow.x).toBeLessThanOrEqual(frame.right + 1e-9);
      expect(arrow.y).toBeGreaterThanOrEqual(frame.top - 1e-9);
      expect(arrow.y).toBeLessThanOrEqual(frame.bottom + 1e-9);
    }
  });

  it('на телефоне 844 × 390 стрелки не заходят на «⌂», «АВТО», шестерёнку и табло при любом направлении и месте танка', () => {
    const ownSpots = [
      { x: 1000, y: 1000 },
      { x: 760, y: 900 },
      { x: 1240, y: 1150 },
    ];
    for (const spot of ownSpots) {
      for (let step = 0; step < 72; step++) {
        const angle = (step / 72) * Math.PI * 2;
        const target = enemy(2, spot.x + Math.cos(angle) * 3000, spot.y + Math.sin(angle) * 3000);
        const camera = phoneCamera(1000, 1000);
        const shown = edgeArrows({ me: spot, myId: ME, tanks: [target], camera, pixelRatio: PHONE.pixelRatio });
        const [arrow] = shown;
        if (arrow === undefined) {
          throw new Error(`нет стрелки под углом ${String(step * 5)}°`);
        }
        for (const box of [HOME_BUTTON, AUTO_BUTTON, GEAR_BUTTON]) {
          expect(overlaps(arrow, box), `угол ${String(step * 5)}°`).toBe(false);
        }
        expect(arrow.y - ARROW_REACH).toBeGreaterThanOrEqual(TOP_STRIP_BOTTOM);
        expect(arrow.x - ARROW_REACH).toBeGreaterThanOrEqual(0);
        expect(arrow.y + ARROW_REACH).toBeLessThanOrEqual(PHONE.height);
      }
    }
  });
});

describe('visibleEnemies', () => {
  it('живые чужие в окне камеры — без своего, подбитых и тех, кто за кадром', () => {
    const tanks = [OWN, enemy(2, 1300, 1100), enemy(3, 2100, 1000), enemy(4, 900, 900, false), enemy(5, 1700, 700)];
    expect(visibleEnemies(tanks, ME, CAMERA).map((tank) => tank.id)).toEqual([2, 5]);
  });
});
