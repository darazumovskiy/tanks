import { ARENA } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { edgeMarker, followCenter, frameCamera, screenToWorld, worldToScreen } from './camera.js';

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

describe('followCenter', () => {
  const view = { width: 1000, height: 500 };
  const rigid = { boxXPercent: 0, boxYPercent: 0, lagMs: 0 };
  const boxed = { boxXPercent: 40, boxYPercent: 40, lagMs: 0 };

  it('первый кадр — центр на цели', () => {
    expect(followCenter(null, { x: 300, y: 200 }, view, boxed, 16)).toEqual({ x: 300, y: 200 });
  });

  it('без свободы и догона — жёсткая привязка', () => {
    expect(followCenter({ x: 0, y: 0 }, { x: 300, y: 200 }, view, rigid, 16)).toEqual({ x: 300, y: 200 });
  });

  it('цель внутри свободного прямоугольника — камера не двигается', () => {
    const center = { x: 500, y: 250 };
    expect(followCenter(center, { x: 650, y: 330 }, view, boxed, 16)).toEqual(center);
  });

  it('цель вышла за прямоугольник — камера сдвигается ровно до его границы', () => {
    const center = { x: 500, y: 250 };
    const moved = followCenter(center, { x: 800, y: 250 }, view, boxed, 16);
    expect(moved.x).toBe(600);
    expect(moved.y).toBe(250);
    const up = followCenter(center, { x: 500, y: 100 }, view, boxed, 16);
    expect(up.y).toBe(200);
  });

  it('доли по осям независимы: узкая по горизонтали, широкая по вертикали', () => {
    const follow = { boxXPercent: 10, boxYPercent: 60, lagMs: 0 };
    const center = { x: 500, y: 250 };
    expect(followCenter(center, { x: 600, y: 250 }, view, follow, 16).x).toBe(550);
    expect(followCenter(center, { x: 500, y: 380 }, view, follow, 16).y).toBe(250);
  });

  it('догон: за lagMs проходится половина пути, за долгое время — почти весь', () => {
    const lagged = { boxXPercent: 0, boxYPercent: 0, lagMs: 100 };
    const half = followCenter({ x: 0, y: 0 }, { x: 100, y: 0 }, view, lagged, 100);
    expect(half.x).toBeCloseTo(50, 6);
    const almost = followCenter({ x: 0, y: 0 }, { x: 100, y: 0 }, view, lagged, 1000);
    expect(almost.x).toBeGreaterThan(99.8);
  });
});
