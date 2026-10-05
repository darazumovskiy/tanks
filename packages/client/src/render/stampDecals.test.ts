import { describe, expect, it } from 'vitest';
import type { Camera } from './camera.js';
import { StampDecals } from './stampDecals.js';

const STAMP_LIMIT = 400;
const FADE = 0.95;
const WINDOW: Camera = { x: 0, y: 0, width: 1600, height: 900, scale: 1 };
const WHOLE_FIELD: Camera = { x: -100, y: -100, width: 10_000, height: 10_000, scale: 1 };

interface Drawn {
  kind: 'rect' | 'arc';
  x: number;
  y: number;
  alpha: number;
}

// Холст, который запоминает прямоугольники следов и круги подпалин с прозрачностью и сдвигом на момент рисования.
function recordingContext(): { ctx: CanvasRenderingContext2D; drawn: Drawn[] } {
  const drawn: Drawn[] = [];
  const state = { globalAlpha: 1, x: 0, y: 0 };
  const stack: { globalAlpha: number; x: number; y: number }[] = [];
  const ctx = {
    get globalAlpha(): number {
      return state.globalAlpha;
    },
    set globalAlpha(value: number) {
      state.globalAlpha = value;
    },
    fillStyle: '',
    save(): void {
      stack.push({ ...state });
    },
    restore(): void {
      Object.assign(state, stack.pop());
    },
    translate(x: number, y: number): void {
      state.x += x;
      state.y += y;
    },
    rotate(): void {
      return undefined;
    },
    fillRect(): void {
      drawn.push({ kind: 'rect', x: state.x, y: state.y, alpha: state.globalAlpha });
    },
    createRadialGradient: () => ({ addColorStop: (): void => undefined }),
    beginPath(): void {
      return undefined;
    },
    arc(x: number, y: number): void {
      drawn.push({ kind: 'arc', x, y, alpha: state.globalAlpha });
    },
    fill(): void {
      return undefined;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
}

function draw(decals: StampDecals, camera: Camera): Drawn[] {
  const { ctx, drawn } = recordingContext();
  decals.draw(ctx, camera);
  return drawn;
}

describe('следы и подпалины отметками', () => {
  it('рисуются только отметки в окне камеры: след — два отпечатка гусениц, подпалина — круг', () => {
    const decals = new StampDecals();
    decals.tread(100, 100, 0);
    decals.tread(5000, 5000, 0);
    decals.scorch(1590, 450, 30, 0.5);
    decals.scorch(1700, 450, 30, 0.5);
    const drawn = draw(decals, WINDOW);
    expect(drawn.filter((item) => item.kind === 'rect')).toHaveLength(2);
    expect(drawn.filter((item) => item.kind === 'arc')).toEqual([{ kind: 'arc', x: 1590, y: 450, alpha: 1 }]);
    expect(drawn.every((item) => item.x < 2000)).toBe(true);
  });

  it('не больше 400 отметок: самые старые уходят первыми', () => {
    const decals = new StampDecals();
    decals.tread(-1000, -1000, 0);
    for (let index = 0; index < STAMP_LIMIT; index++) {
      decals.tread(100 + index, 100, 0);
    }
    expect(draw(decals, WHOLE_FIELD).filter((item) => item.kind === 'rect')).toHaveLength(STAMP_LIMIT * 2);
    expect(draw(decals, { x: -1100, y: -1100, width: 200, height: 200, scale: 1 })).toEqual([]);
  });

  it('выцветают все разом и, став невидимыми, уходят', () => {
    const decals = new StampDecals();
    decals.scorch(500, 500, 40, 0.6);
    decals.fade();
    decals.fade();
    expect(draw(decals, WINDOW)[0]?.alpha).toBeCloseTo(FADE * FADE, 12);
    for (let index = 0; index < 80; index++) {
      decals.fade();
    }
    expect(draw(decals, WINDOW)).toEqual([]);
  });

  it('сброс убирает всё; прозрачность холста после рисования прежняя', () => {
    const decals = new StampDecals();
    decals.tread(100, 100, 0);
    decals.clear();
    const { ctx, drawn } = recordingContext();
    decals.draw(ctx, WINDOW);
    expect(drawn).toEqual([]);
    expect(ctx.globalAlpha).toBe(1);
  });
});
