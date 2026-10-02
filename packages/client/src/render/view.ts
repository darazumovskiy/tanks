export const HEAD_FONT = '"Russo One", "Arial Black", sans-serif';
export const BODY_FONT = '"Inter", "Segoe UI", system-ui, sans-serif';
export const SIDE_COLORS: readonly [string, string] = ['#e8825a', '#4fc3c9'];

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function easeOut(t: number): number {
  return 1 - Math.pow(1 - clamp(t, 0, 1), 3);
}

// Только шестизначный hex вида #rrggbb.
export function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${String(r)},${String(g)},${String(b)},${String(alpha)})`;
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function makeCanvas(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('Canvas 2D недоступен');
  }
  return { canvas, ctx };
}
