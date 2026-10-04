import { describe, expect, it, vi } from 'vitest';
import {
  AIM_LINE_STYLES,
  aimLineStyleById,
  DEFAULT_AIM_LINE_STYLE_ID,
  drawAimLinePreview,
  isAimLineStyleId,
} from './aimLineStyles.js';

vi.mock('./view.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./view.js')>();
  return {
    ...original,
    makeCanvas: () => ({
      canvas: {} as HTMLCanvasElement,
      ctx: {
        createRadialGradient: () => ({ addColorStop: () => undefined }),
        fillRect: () => undefined,
        set fillStyle(_value: unknown) {
          return;
        },
      } as unknown as CanvasRenderingContext2D,
    }),
  };
});

describe('реестр стилей линии выстрела', () => {
  it('идентификаторы уникальны, умолчание в реестре, неизвестный идентификатор отвергается', () => {
    const ids = AIM_LINE_STYLES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_AIM_LINE_STYLE_ID);
    expect(isAimLineStyleId('dots')).toBe(true);
    expect(isAimLineStyleId('laser')).toBe(false);
    expect(isAimLineStyleId(null)).toBe(false);
    expect(aimLineStyleById('neon').title).toBe('Неон с кольцом');
  });

  it('ядро не тоньше 1 px; штрихи и зерно ползут не быстрее 50 px/с; пульс не чаще 0,6 Гц', () => {
    for (const entry of AIM_LINE_STYLES) {
      expect(entry.style.core.widthPx, entry.id).toBeGreaterThanOrEqual(1);
      expect(entry.style.dash?.speedPxPerS ?? 0, entry.id).toBeLessThanOrEqual(50);
      expect(entry.style.grain?.speedPxPerS ?? 0, entry.id).toBeLessThanOrEqual(50);
      expect(entry.style.pulse.onTarget.hz, entry.id).toBeLessThanOrEqual(0.6);
    }
  });

  it('превью рисует отрезок слева направо нейтральным цветом, без цветов состояний', () => {
    const strokes: string[] = [];
    const points: number[][] = [];
    const ctx = {
      globalCompositeOperation: 'source-over',
      globalAlpha: 1,
      lineWidth: 1,
      lineDashOffset: 0,
      strokeStyle: '' as string | { toString: () => string },
      lineCap: 'butt',
      save: () => undefined,
      restore: () => undefined,
      beginPath: () => undefined,
      moveTo: (x: number, y: number) => points.push([x, y]),
      lineTo: (x: number, y: number) => points.push([x, y]),
      arc: () => undefined,
      translate: () => undefined,
      rotate: () => undefined,
      scale: () => undefined,
      setLineDash: () => undefined,
      drawImage: () => undefined,
      createLinearGradient: () => ({ addColorStop: () => undefined, toString: () => 'gradient' }),
      createPattern: () => ({ toString: () => 'pattern' }),
      stroke() {
        strokes.push(String(this.strokeStyle));
      },
    };
    for (const entry of AIM_LINE_STYLES) {
      strokes.length = 0;
      points.length = 0;
      drawAimLinePreview(ctx as unknown as CanvasRenderingContext2D, entry.style, 160, 16);
      expect(strokes.length, entry.id).toBeGreaterThan(0);
      expect(
        strokes.some((style) => style.includes('232,130,90') || style.includes('93,255,160')),
        entry.id,
      ).toBe(false);
      expect(points[0]?.[0]).toBeLessThan(points[points.length - 1]?.[0] ?? 0);
    }
  });
});
