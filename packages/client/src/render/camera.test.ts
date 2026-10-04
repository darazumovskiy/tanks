import { ARENA } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import {
  edgeMarker,
  frameCamera,
  isInView,
  resolveAxis,
  screenToWorld,
  smoothCamera,
  TANK_AREA,
  tankBottomLimit,
  voidRange,
  windowRangeFor,
  worldToScreen,
} from './camera.js';

const PHONE = { width: 2200, height: 1000 };
const VIEW_HEIGHT = 560;

describe('frameCamera', () => {
  it('высота окна фиксирована, ширина — по пропорциям экрана', () => {
    const camera = frameCamera({ x: 800, y: 450 }, PHONE.width, PHONE.height, VIEW_HEIGHT);
    expect(camera.height).toBe(VIEW_HEIGHT);
    expect(camera.width).toBeCloseTo(VIEW_HEIGHT * 2.2, 6);
    expect(camera.scale).toBeCloseTo(1000 / VIEW_HEIGHT, 6);
  });

  it('окно центрируется на цели в середине поля', () => {
    const camera = frameCamera({ x: 800, y: 450 }, PHONE.width, PHONE.height, VIEW_HEIGHT);
    expect(camera.x + camera.width / 2).toBeCloseTo(800, 6);
    expect(camera.y + camera.height / 2).toBeCloseTo(450, 6);
  });

  it('у края поля окно прижимается к краю, а не показывает пустоту', () => {
    const corner = frameCamera({ x: 140, y: 100 }, PHONE.width, PHONE.height, VIEW_HEIGHT);
    expect(corner.x).toBe(0);
    expect(corner.y).toBe(0);
    const far = frameCamera({ x: 1550, y: 850 }, PHONE.width, PHONE.height, VIEW_HEIGHT);
    expect(far.x + far.width).toBeCloseTo(ARENA.width, 6);
    expect(far.y + far.height).toBeCloseTo(ARENA.height, 6);
  });

  it('экран шире поля — окно центрируется на поле', () => {
    const camera = frameCamera({ x: 100, y: 450 }, 6000, 1000, VIEW_HEIGHT);
    expect(camera.width).toBeGreaterThan(ARENA.width);
    expect(camera.x + camera.width / 2).toBeCloseTo(ARENA.width / 2, 6);
  });
});

describe('перевод координат', () => {
  it('мир → экран → мир возвращает исходную точку', () => {
    const camera = frameCamera({ x: 800, y: 450 }, PHONE.width, PHONE.height, VIEW_HEIGHT);
    const screen = worldToScreen(camera, { x: 1000, y: 300 });
    const back = screenToWorld(camera, screen);
    expect(back.x).toBeCloseTo(1000, 6);
    expect(back.y).toBeCloseTo(300, 6);
  });

  it('центр окна — центр экрана', () => {
    const camera = frameCamera({ x: 800, y: 450 }, PHONE.width, PHONE.height, VIEW_HEIGHT);
    const screen = worldToScreen(camera, { x: 800, y: 450 });
    expect(screen.x).toBeCloseTo(PHONE.width / 2, 6);
    expect(screen.y).toBeCloseTo(PHONE.height / 2, 6);
  });
});

describe('isInView', () => {
  const camera = frameCamera({ x: 800, y: 450 }, PHONE.width, PHONE.height, VIEW_HEIGHT);

  it('точка внутри и на границе окна — в кадре, за краем — нет', () => {
    expect(isInView(camera, { x: 800, y: 450 })).toBe(true);
    expect(isInView(camera, { x: camera.x, y: camera.y + camera.height })).toBe(true);
    expect(isInView(camera, { x: camera.x - 1, y: 450 })).toBe(false);
    expect(isInView(camera, { x: 800, y: camera.y + camera.height + 1 })).toBe(false);
  });
});

describe('edgeMarker', () => {
  const camera = frameCamera({ x: 800, y: 450 }, PHONE.width, PHONE.height, VIEW_HEIGHT);

  it('точка в кадре — метки нет', () => {
    expect(edgeMarker(camera, { x: 900, y: 500 }, 40)).toBeNull();
  });

  it('точка справа за кадром — метка у правого края на высоте цели', () => {
    const marker = edgeMarker(camera, { x: 1600, y: 450 }, 40);
    expect(marker).not.toBeNull();
    expect(marker?.x).toBeCloseTo(PHONE.width - 40, 6);
    expect(marker?.y).toBeCloseTo(PHONE.height / 2, 6);
    expect(marker?.angle).toBeCloseTo(0, 6);
  });

  it('точка сверху за кадром — метка у верхнего края', () => {
    const marker = edgeMarker(camera, { x: 800, y: 0 }, 40);
    expect(marker?.y).toBeCloseTo(40, 6);
    expect(marker?.x).toBeCloseTo(PHONE.width / 2, 6);
    expect(marker?.angle).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('точка по диагонали — метка в пределах рамки с отступом', () => {
    const marker = edgeMarker(camera, { x: 1600, y: 0 }, 40);
    expect(marker).not.toBeNull();
    expect(marker?.x).toBeLessThanOrEqual(PHONE.width - 40 + 1e-6);
    expect(marker?.y).toBeGreaterThanOrEqual(40 - 1e-6);
  });
});

describe('высота окна — параметр', () => {
  it('окно во всё поле по высоте на экране 16:9 показывает поле целиком', () => {
    const camera = frameCamera({ x: 140, y: 450 }, 1600, 900, ARENA.height);
    expect(camera.x).toBe(0);
    expect(camera.width).toBeCloseTo(ARENA.width, 6);
    expect(camera.height).toBe(ARENA.height);
  });
});

describe('разрешённая область своего танка', () => {
  it('нижняя граница: половина экрана у боков, три четверти в середине, линейный переход между', () => {
    expect(tankBottomLimit(0.1)).toBe(TANK_AREA.bottomAtSides);
    expect(tankBottomLimit(0.32)).toBe(TANK_AREA.bottomAtSides);
    expect(tankBottomLimit(0.385)).toBeCloseTo((TANK_AREA.bottomAtSides + TANK_AREA.bottomAtCenter) / 2, 6);
    expect(tankBottomLimit(0.5)).toBe(TANK_AREA.bottomAtCenter);
    expect(tankBottomLimit(0.615)).toBeCloseTo((TANK_AREA.bottomAtSides + TANK_AREA.bottomAtCenter) / 2, 6);
    expect(tankBottomLimit(0.9)).toBe(TANK_AREA.bottomAtSides);
  });
});

describe('интервалы по оси', () => {
  it('windowRangeFor: начала окна, при которых точка стоит в заданных долях', () => {
    const range = windowRangeFor(500, 1000, 0.2, 0.6);
    expect(range).toEqual({ min: -100, max: 300 });
  });

  it('voidRange: пустота не больше лимита; окно шире поля с запасами — центр поля', () => {
    expect(voidRange(1000, 1600, 100)).toEqual({ min: -100, max: 700 });
    const centered = voidRange(2000, 1600, 100);
    expect(centered.min).toBe(-200);
    expect(centered.max).toBe(-200);
  });

  it('resolveAxis: последний интервал важнее — при конфликте значение на его границе, ближайшей к предыдущим', () => {
    expect(resolveAxis(50, [{ min: 0, max: 100 }])).toBe(50);
    expect(resolveAxis(-50, [{ min: 0, max: 100 }])).toBe(0);
    expect(
      resolveAxis(50, [
        { min: 0, max: 100 },
        { min: 200, max: 300 },
      ]),
    ).toBe(200);
    expect(
      resolveAxis(250, [
        { min: 0, max: 100 },
        { min: 80, max: 300 },
      ]),
    ).toBe(100);
  });
});

describe('smoothCamera', () => {
  const smoothing = { moveLagMs: 100, zoomInLagMs: 400, zoomOutLagMs: 200, maxSpeed: 1e9 };
  const from = { x: 0, y: 0, width: 1000, height: 500, scale: 2 };
  const to = { x: 400, y: 200, width: 1600, height: 800, scale: 1.25 };

  it('первый кадр — сразу цель', () => {
    expect(smoothCamera(null, to, smoothing, 16)).toEqual(to);
  });

  it('за lagMs центр проходит половину пути, высота — свою половину за свой lagMs', () => {
    const step = smoothCamera(from, to, smoothing, 100);
    const fromCenterX = from.x + from.width / 2;
    const toCenterX = to.x + to.width / 2;
    expect(step.x + step.width / 2).toBeCloseTo((fromCenterX + toCenterX) / 2, 6);
    expect(step.height).toBeCloseTo(500 + 300 * (1 - Math.pow(0.5, 100 / 200)), 6);
    const back = smoothCamera(to, from, smoothing, 100);
    expect(back.height).toBeCloseTo(800 - 300 * (1 - Math.pow(0.5, 100 / 400)), 6);
    expect(step.width / step.height).toBeCloseTo(to.width / to.height, 6);
    expect(step.scale * step.height).toBeCloseTo(to.scale * to.height, 6);
  });

  it('нулевые паузы — мгновенно', () => {
    expect(smoothCamera(from, to, { moveLagMs: 0, zoomInLagMs: 0, zoomOutLagMs: 0, maxSpeed: 1e9 }, 16)).toEqual(to);
  });

  it('потолок скорости: за кадр центр проходит не больше maxSpeed · dt', () => {
    const capped = smoothCamera(from, to, { ...smoothing, moveLagMs: 0, maxSpeed: 100 }, 100);
    const dx = capped.x + capped.width / 2 - (from.x + from.width / 2);
    const dy = capped.y + capped.height / 2 - (from.y + from.height / 2);
    expect(Math.hypot(dx, dy)).toBeCloseTo(10, 6);
  });
});
