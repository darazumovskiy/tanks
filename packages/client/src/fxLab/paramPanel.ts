import type { AimLineStyle } from '../render/aimLineStyle.js';
import { flattenParams } from './styleParams.js';

// Ползунки по плоским параметрам стиля: число — `range` с шагом по порядку величины, цвет — `color`.

export interface ParamPanelHandlers {
  onChange: (path: string, value: number | string) => void;
  onReset: () => void;
}

export interface ParamPanel {
  update: (style: AimLineStyle) => void;
}

const RANGE_MULTIPLIER = 3;

function rangeStep(value: number): number {
  if (value < 1) {
    return 0.01;
  }
  if (value < 10) {
    return 0.1;
  }
  return 1;
}

function rangeMax(value: number): number {
  return Math.max(1, Math.ceil(value * RANGE_MULTIPLIER));
}

export function mountParamPanel(root: HTMLElement, style: AimLineStyle, handlers: ParamPanelHandlers): ParamPanel {
  const inputs = new Map<string, HTMLInputElement>();
  const build = (current: AimLineStyle): void => {
    root.innerHTML = '';
    inputs.clear();
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'сбросить';
    reset.addEventListener('click', handlers.onReset);
    root.append(reset);
    for (const param of flattenParams(current)) {
      const label = document.createElement('label');
      label.className = 'fx-param';
      const name = document.createElement('span');
      name.textContent = param.path;
      const input = document.createElement('input');
      input.dataset.path = param.path;
      if (typeof param.value === 'number') {
        input.type = 'range';
        input.min = '0';
        input.max = String(rangeMax(param.value));
        input.step = String(rangeStep(param.value));
        input.value = String(param.value);
        input.addEventListener('input', () => {
          handlers.onChange(param.path, Number(input.value));
        });
      } else {
        input.type = 'color';
        input.value = param.value;
        input.addEventListener('input', () => {
          handlers.onChange(param.path, input.value);
        });
      }
      inputs.set(param.path, input);
      label.append(name, input);
      root.append(label);
    }
  };
  build(style);
  return {
    update: (current) => {
      const params = flattenParams(current);
      const isSameShape = params.length === inputs.size && params.every((param) => inputs.has(param.path));
      if (!isSameShape) {
        build(current);
        return;
      }
      for (const param of params) {
        const input = inputs.get(param.path);
        if (input !== undefined) {
          input.value = String(param.value);
        }
      }
    },
  };
}
