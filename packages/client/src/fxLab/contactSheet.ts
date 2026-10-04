import { BODY_FONT, HEAD_FONT } from '../render/view.js';

// Контактный лист: кадры вариантов сеткой на одном холсте, под каждым — тёмная полоса с названием и подписью.

export interface SheetCellRect {
  x: number;
  y: number;
  width: number;
  height: number;
  labelY: number;
}

export interface SheetLayout {
  width: number;
  height: number;
  labelHeight: number;
  cells: SheetCellRect[];
}

export interface SheetCell {
  title: string;
  subtitle: string;
  image: HTMLCanvasElement;
}

const SHEET_COLUMNS = 3;
export const SHEET_LABEL_HEIGHT = 56;
const LABEL_BACKGROUND = '#0b0f0d';
const TITLE_COLOR = '#f4f1e8';
const SUBTITLE_COLOR = 'rgba(244,241,232,0.6)';
const TITLE_FONT_PX = 20;
const SUBTITLE_FONT_PX = 14;
const LABEL_PADDING = 12;
const GRID_LINE = 'rgba(255,255,255,0.12)';

export function sheetLayout(
  count: number,
  cell: { width: number; height: number },
  labelHeight = SHEET_LABEL_HEIGHT,
  columns = SHEET_COLUMNS,
): SheetLayout {
  const usedColumns = Math.max(1, Math.min(columns, count));
  const rows = Math.max(1, Math.ceil(count / usedColumns));
  const rowHeight = cell.height + labelHeight;
  const cells: SheetCellRect[] = [];
  for (let index = 0; index < count; index++) {
    const column = index % usedColumns;
    const row = Math.floor(index / usedColumns);
    cells.push({
      x: column * cell.width,
      y: row * rowHeight,
      width: cell.width,
      height: cell.height,
      labelY: row * rowHeight + cell.height,
    });
  }
  return { width: usedColumns * cell.width, height: rows * rowHeight, labelHeight, cells };
}

export function renderContactSheet(
  ctx: CanvasRenderingContext2D,
  cells: readonly SheetCell[],
  layout: SheetLayout,
): void {
  ctx.save();
  ctx.fillStyle = LABEL_BACKGROUND;
  ctx.fillRect(0, 0, layout.width, layout.height);
  cells.forEach((cell, index) => {
    const rect = layout.cells[index];
    if (rect === undefined) {
      return;
    }
    ctx.drawImage(cell.image, rect.x, rect.y, rect.width, rect.height);
    ctx.fillStyle = LABEL_BACKGROUND;
    ctx.fillRect(rect.x, rect.labelY, rect.width, layout.labelHeight);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = TITLE_COLOR;
    ctx.font = `${String(TITLE_FONT_PX)}px ${HEAD_FONT}`;
    ctx.fillText(cell.title, rect.x + LABEL_PADDING, rect.labelY + 8);
    ctx.fillStyle = SUBTITLE_COLOR;
    ctx.font = `${String(SUBTITLE_FONT_PX)}px ${BODY_FONT}`;
    ctx.fillText(cell.subtitle, rect.x + LABEL_PADDING, rect.labelY + 8 + TITLE_FONT_PX + 6);
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height + layout.labelHeight - 1);
  });
  ctx.restore();
}
