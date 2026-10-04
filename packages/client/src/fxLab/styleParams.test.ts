import { describe, expect, it } from 'vitest';
import { AIM_LINE_STYLE, type AimLineStyle } from '../render/aimLineStyle.js';
import { flattenParams, summarizeStyle, withParam } from './styleParams.js';

const RICH: AimLineStyle = {
  ...AIM_LINE_STYLE,
  core: { widthPx: 2, alpha: 0.9, highlightAlpha: 1, color: '#ffffff' },
  layers: [
    { widthPx: 14, alpha: 0.07 },
    { widthPx: 7, alpha: 0.14 },
  ],
  dash: { onPx: 10, offPx: 14, speedPxPerS: 120, alpha: 0.18 },
  end: { radiusPx: 14, alpha: 0.8, ringRadiusPx: 5, ringWidthPx: 1.5, wallScale: 0.6 },
};

describe('плоские параметры стиля', () => {
  it('собирает числа и hex-цвета на всех уровнях, пропускает null и не-цвета', () => {
    const params = flattenParams(RICH);
    const paths = params.map((param) => param.path);
    expect(paths).toContain('neutral');
    expect(paths).toContain('core.widthPx');
    expect(paths).toContain('core.color');
    expect(paths).toContain('layers.1.alpha');
    expect(paths).toContain('dash.speedPxPerS');
    expect(paths).toContain('pulse.onTarget.hz');
    expect(paths).toContain('end.ringRadiusPx');
    expect(paths).not.toContain('muzzle');
    expect(params.find((param) => param.path === 'layers.0.widthPx')?.value).toBe(14);
  });

  it('у стиля без ядра своего цвета путь core.color отсутствует', () => {
    expect(flattenParams(AIM_LINE_STYLE).map((param) => param.path)).not.toContain('core.color');
  });

  it('withParam меняет копию по пути и не трогает исходник', () => {
    const changed = withParam(RICH, 'layers.1.widthPx', 9);
    expect(changed.layers[1]?.widthPx).toBe(9);
    expect(RICH.layers[1]?.widthPx).toBe(7);
    const recolored = withParam(RICH, 'onTarget', '#ff0000');
    expect(recolored.onTarget).toBe('#ff0000');
    expect(RICH.onTarget).toBe('#e8825a');
  });

  it('неизвестный путь возвращает исходник без изменений', () => {
    expect(withParam(RICH, 'muzzle.radiusPx', 3)).toBe(RICH);
    expect(withParam(RICH, 'nope.deeper', 3)).toBe(RICH);
    expect(withParam(RICH, 'core.widthPx.deeper', 3)).toBe(RICH);
    expect(withParam(RICH, 'layers.5.widthPx', 3)).toBe(RICH);
    expect(withParam(RICH, 'layers.x', 3)).toBe(RICH);
    expect(withParam(RICH, '', 3)).toBe(RICH);
  });

  it('подпись упоминает ядро, слои, штрихи, точку и пульс', () => {
    const summary = summarizeStyle({
      ...RICH,
      pulse: { ...RICH.pulse, onTarget: { hz: 2.5, depth: 0.35 } },
    });
    expect(summary).toContain('ядро 2px');
    expect(summary).toContain('ореол 14px/7px');
    expect(summary).toContain('штрихи 120px/с');
    expect(summary).toContain('точка 14px');
    expect(summary).toContain('пульс 2.5Гц');
    expect(summarizeStyle(AIM_LINE_STYLE)).toContain('без ореола');
  });
});
