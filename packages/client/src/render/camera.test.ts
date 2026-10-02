import { ARENA } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { CAMERA_VIEW_HEIGHT, edgeMarker, frameCamera, screenToWorld, worldToScreen } from './camera.js';

const PHONE = { width: 2200, height: 1000 };

describe('frameCamera', () => {
  it('высота окна фиксирована, ширина — по пропорциям экрана', () => {
    const camera = frameCamera({ x: 800, y: 450 }, PHONE.width, PHONE.height);
    expect(camera.height).toBe(CAMERA_VIEW_HEIGHT);
    expect(camera.width).toBeCloseTo(CAMERA_VIEW_HEIGHT * 2.2, 6);
    expect(camera.scale).toBeCloseTo(1000 / CAMERA_VIEW_HEIGHT, 6);
  });

  it('окно центрируется на цели в середине поля', () => {
    const camera = frameCamera({ x: 800, y: 450 }, PHONE.width, PHONE.height);
    expect(camera.x + camera.width / 2).toBeCloseTo(800, 6);
    expect(camera.y + camera.height / 2).toBeCloseTo(450, 6);
  });

  it('у края поля окно прижимается к краю, а не показывает пустоту', () => {
    const corner = frameCamera({ x: 140, y: 100 }, PHONE.width, PHONE.height);
    expect(corner.x).toBe(0);
    expect(corner.y).toBe(0);
    const far = frameCamera({ x: 1550, y: 850 }, PHONE.width, PHONE.height);
    expect(far.x + far.width).toBeCloseTo(ARENA.width, 6);
    expect(far.y + far.height).toBeCloseTo(ARENA.height, 6);
  });

  it('экран шире поля — окно центрируется на поле', () => {
    const camera = frameCamera({ x: 100, y: 450 }, 6000, 1000);
    expect(camera.width).toBeGreaterThan(ARENA.width);
    expect(camera.x + camera.width / 2).toBeCloseTo(ARENA.width / 2, 6);
  });
});

describe('перевод координат', () => {
  it('мир → экран → мир возвращает исходную точку', () => {
    const camera = frameCamera({ x: 800, y: 450 }, PHONE.width, PHONE.height);
    const screen = worldToScreen(camera, { x: 1000, y: 300 });
    const back = screenToWorld(camera, screen);
    expect(back.x).toBeCloseTo(1000, 6);
    expect(back.y).toBeCloseTo(300, 6);
  });

  it('центр окна — центр экрана', () => {
    const camera = frameCamera({ x: 800, y: 450 }, PHONE.width, PHONE.height);
    const screen = worldToScreen(camera, { x: 800, y: 450 });
    expect(screen.x).toBeCloseTo(PHONE.width / 2, 6);
    expect(screen.y).toBeCloseTo(PHONE.height / 2, 6);
  });
});

describe('edgeMarker', () => {
  const camera = frameCamera({ x: 800, y: 450 }, PHONE.width, PHONE.height);

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
