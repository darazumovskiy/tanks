import { describe, expect, it } from 'vitest';
import { renderContactSheet, SHEET_LABEL_HEIGHT, sheetLayout, type SheetCell } from './contactSheet.js';

const CELL = { width: 1688, height: 780 };

function isOverlapping(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  const isApartX = a.x + a.width <= b.x || b.x + b.width <= a.x;
  const isApartY = a.y + a.height <= b.y || b.y + b.height <= a.y;
  return !isApartX && !isApartY;
}

describe('раскладка контактного листа', () => {
  it('шесть ячеек в три столбца: две строки, размеры листа, ячейки не перекрываются', () => {
    const layout = sheetLayout(6, CELL);
    expect(layout.width).toBe(3 * CELL.width);
    expect(layout.height).toBe(2 * (CELL.height + SHEET_LABEL_HEIGHT));
    expect(layout.cells).toHaveLength(6);
    expect(layout.cells[3]).toMatchObject({
      x: 0,
      y: CELL.height + SHEET_LABEL_HEIGHT,
      labelY: 2 * CELL.height + SHEET_LABEL_HEIGHT,
    });
    const boxes = layout.cells.map((cell) => ({ ...cell, height: cell.height + layout.labelHeight }));
    for (const [index, a] of boxes.entries()) {
      for (const b of boxes.slice(index + 1)) {
        expect(isOverlapping(a, b)).toBe(false);
      }
    }
  });

  it('одна ячейка — один столбец и одна строка', () => {
    const layout = sheetLayout(1, CELL);
    expect(layout.width).toBe(CELL.width);
    expect(layout.height).toBe(CELL.height + SHEET_LABEL_HEIGHT);
  });

  it('отрисовка: drawImage на каждую ячейку и подписи с названием', () => {
    const calls: string[] = [];
    const texts: string[] = [];
    const ctx = {
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      fillRect: () => calls.push('fillRect'),
      strokeRect: () => calls.push('strokeRect'),
      drawImage: () => calls.push('drawImage'),
      fillText: (text: string) => {
        calls.push('fillText');
        texts.push(text);
      },
    } as unknown as CanvasRenderingContext2D;
    const cells: SheetCell[] = [
      { title: 'Холодный', subtitle: 'ядро 1.6px', image: {} as HTMLCanvasElement },
      { title: 'Горячий', subtitle: 'ядро 2px', image: {} as HTMLCanvasElement },
    ];
    renderContactSheet(ctx, cells, sheetLayout(cells.length, CELL));
    expect(calls.filter((call) => call === 'drawImage')).toHaveLength(2);
    expect(texts).toEqual(['Холодный', 'ядро 1.6px', 'Горячий', 'ядро 2px']);
    expect(calls[calls.length - 1]).toBe('restore');
  });
});
