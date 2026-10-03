import { ARENA } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import {
  edgeMarker,
  frameCamera,
  frameTargets,
  keepTargetOutOfThumbZones,
  screenToWorld,
  smoothCamera,
  stabilizedHeight,
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

describe('keepTargetOutOfThumbZones', () => {
  const zones = { side: 0.24, cornerTop: 0.55, top: 0.12 };
  const full = frameTargets(
    [
      { x: 140, y: 450 },
      { x: 1460, y: 450 },
    ],
    2200,
    1000,
    540,
    { side: 0.12, top: 0.14, bottom: 0.32 },
  );

  it('старт раунда: танк у бока на середине высоты — вне зоны пальца, окно не трогается', () => {
    expect(keepTargetOutOfThumbZones(full, { x: 1460, y: 450 }, zones)).toEqual(full);
  });

  it('танк в нижнем левом углу — сдвиг по горизонтали до границы зоны', () => {
    const target = { x: 60, y: 720 };
    const kept = keepTargetOutOfThumbZones(full, target, zones);
    expect((target.x - kept.x) / kept.width).toBeCloseTo(zones.side, 6);
    expect(kept.y).toBe(full.y);
  });

  it('танк чуть ниже границы зоны у самого бока — дешевле поднять окно, чем сдвигать вбок', () => {
    const target = { x: -150, y: 540 };
    const kept = keepTargetOutOfThumbZones(full, target, zones);
    expect((target.y - kept.y) / kept.height).toBeCloseTo(zones.cornerTop, 6);
    expect(kept.x).toBe(full.x);
  });

  it('танк внизу по центру — не зона пальца, окно не трогается', () => {
    expect(keepTargetOutOfThumbZones(full, { x: 800, y: 880 }, zones)).toEqual(full);
  });

  it('танк под панелями сверху — окно поднимается', () => {
    const kept = keepTargetOutOfThumbZones(full, { x: 800, y: 20 }, zones);
    expect((20 - kept.y) / kept.height).toBeCloseTo(zones.top, 6);
  });
});

describe('frameTargets', () => {
  const insets = { side: 0.12, top: 0.14, bottom: 0.32 };
  const MIN_VIEW = 540;

  it('танки далеко друг от друга — поле целиком по высоте, окно центрировано на поле', () => {
    const camera = frameTargets(
      [
        { x: 140, y: 450 },
        { x: 1460, y: 450 },
      ],
      2200,
      1000,
      MIN_VIEW,
      insets,
    );
    expect(camera.height).toBe(ARENA.height);
    expect(camera.y).toBe(0);
    expect(camera.x + camera.width / 2).toBeCloseTo(ARENA.width / 2, 6);
  });

  it('танки рядом — приближение до минимума, оба в безопасной области, центр целей выше середины экрана', () => {
    const me = { x: 800, y: 600 };
    const enemy = { x: 900, y: 560 };
    const camera = frameTargets([me, enemy], 2200, 1000, MIN_VIEW, insets);
    expect(camera.height).toBe(MIN_VIEW);
    for (const point of [me, enemy]) {
      const fx = (point.x - camera.x) / camera.width;
      const fy = (point.y - camera.y) / camera.height;
      expect(fx).toBeGreaterThan(insets.side);
      expect(fx).toBeLessThan(1 - insets.side);
      expect(fy).toBeGreaterThan(insets.top);
      expect(fy).toBeLessThan(1 - insets.bottom);
    }
    const targetsCenterY = (me.y + enemy.y) / 2;
    expect((targetsCenterY - camera.y) / camera.height).toBeCloseTo(
      insets.top + (1 - insets.top - insets.bottom) / 2,
      6,
    );
  });

  it('танки на среднем расстоянии — высота подбирается так, чтобы оба влезли с запасом', () => {
    const camera = frameTargets(
      [
        { x: 300, y: 450 },
        { x: 1100, y: 450 },
      ],
      2200,
      1000,
      MIN_VIEW,
      insets,
    );
    expect(camera.height).toBeGreaterThan(MIN_VIEW);
    expect(camera.height).toBeLessThan(ARENA.height);
    const spanNeeded = 800 + 220;
    expect(camera.width * (1 - insets.side * 2)).toBeCloseTo(spanNeeded, 6);
  });

  it('оба танка в левом нижнем углу — окно прижато к углу поля, не к центру', () => {
    const camera = frameTargets(
      [
        { x: 150, y: 780 },
        { x: 300, y: 700 },
      ],
      2200,
      1000,
      MIN_VIEW,
      insets,
    );
    expect(camera.x).toBe(0);
    expect(camera.y + camera.height).toBeCloseTo(ARENA.height, 6);
    expect(camera.height).toBeCloseTo((80 + 220) / (1 - insets.top - insets.bottom), 6);
  });

  it('зафиксированная высота используется вместо нужной, но в пределах минимума и поля', () => {
    const targets = [
      { x: 800, y: 600 },
      { x: 900, y: 560 },
    ];
    expect(frameTargets(targets, 2200, 1000, MIN_VIEW, insets, 700).height).toBe(700);
    expect(frameTargets(targets, 2200, 1000, MIN_VIEW, insets, 100).height).toBe(MIN_VIEW);
    expect(frameTargets(targets, 2200, 1000, MIN_VIEW, insets, 5000).height).toBe(ARENA.height);
  });

  it('одна цель — минимальное приближение вокруг неё', () => {
    const camera = frameTargets([{ x: 800, y: 450 }], 2200, 1000, MIN_VIEW, insets);
    expect(camera.height).toBe(MIN_VIEW);
    expect(camera.x + camera.width / 2).toBeCloseTo(800, 6);
  });
});

describe('stabilizedHeight', () => {
  it('без зафиксированной — нужная', () => {
    expect(stabilizedHeight(null, 700, 0.2)).toBe(700);
  });

  it('внутри порога — зафиксированная, за порогом — нужная', () => {
    expect(stabilizedHeight(700, 800, 0.2)).toBe(700);
    expect(stabilizedHeight(700, 600, 0.2)).toBe(700);
    expect(stabilizedHeight(700, 900, 0.2)).toBe(900);
    expect(stabilizedHeight(700, 540, 0.2)).toBe(540);
  });
});

describe('smoothCamera', () => {
  const smoothing = { moveLagMs: 100, zoomInLagMs: 400, zoomOutLagMs: 200 };
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
    expect(smoothCamera(from, to, { moveLagMs: 0, zoomInLagMs: 0, zoomOutLagMs: 0 }, 16)).toEqual(to);
  });
});
