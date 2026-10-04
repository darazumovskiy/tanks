import { describe, expect, it, vi } from 'vitest';
import { PLAIN_AIM_LINE_STYLE, type AimLineStyle } from '../render/aimLineStyle.js';
import { mountParamPanel } from './paramPanel.js';

const STYLE: AimLineStyle = {
  ...PLAIN_AIM_LINE_STYLE,
  core: { widthPx: 2, alpha: 0.9, highlightAlpha: 1, color: '#ffffff' },
  layers: [{ widthPx: 14, alpha: 0.07 }],
};

function inputAt(root: HTMLElement, path: string): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>(`input[data-path="${path}"]`);
  if (input === null) {
    throw new Error(`нет ползунка ${path}`);
  }
  return input;
}

describe('панель параметров', () => {
  it('строит range для чисел и color для цветов с подписями путей', () => {
    const root = document.createElement('div');
    mountParamPanel(root, STYLE, { onChange: vi.fn(), onReset: vi.fn() });
    const width = inputAt(root, 'layers.0.widthPx');
    expect(width.type).toBe('range');
    expect(Number(width.max)).toBeGreaterThanOrEqual(14);
    expect(width.step).toBe('1');
    expect(inputAt(root, 'core.alpha').step).toBe('0.01');
    expect(inputAt(root, 'core.color').type).toBe('color');
    expect(root.textContent).toContain('layers.0.widthPx');
  });

  it('движение ползунка и выбор цвета зовут onChange с путём и значением', () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    mountParamPanel(root, STYLE, { onChange, onReset: vi.fn() });
    const width = inputAt(root, 'layers.0.widthPx');
    width.value = '20';
    width.dispatchEvent(new Event('input'));
    expect(onChange).toHaveBeenCalledWith('layers.0.widthPx', 20);
    const color = inputAt(root, 'core.color');
    color.value = '#ff0000';
    color.dispatchEvent(new Event('input'));
    expect(onChange).toHaveBeenCalledWith('core.color', '#ff0000');
  });

  it('«сбросить» зовёт onReset; update подставляет значения, при другой форме стиля перестраивает панель', () => {
    const root = document.createElement('div');
    const onReset = vi.fn();
    const panel = mountParamPanel(root, STYLE, { onChange: vi.fn(), onReset });
    root.querySelector('button')?.click();
    expect(onReset).toHaveBeenCalledTimes(1);
    panel.update({ ...STYLE, layers: [{ widthPx: 9, alpha: 0.07 }] });
    expect(inputAt(root, 'layers.0.widthPx').value).toBe('9');
    panel.update(PLAIN_AIM_LINE_STYLE);
    expect(root.querySelector('input[data-path="layers.0.widthPx"]')).toBeNull();
    expect(root.querySelector('input[data-path="core.widthPx"]')).not.toBeNull();
  });
});
