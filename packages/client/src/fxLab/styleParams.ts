import type { AimLineStyle } from '../render/aimLineStyle.js';

// Плоский вид объекта стиля для ползунков и подписей: числа и hex-цвета на любой глубине, путь через точку.

export interface StyleParam {
  path: string;
  value: number | string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

type Json = number | string | boolean | null | Json[] | { [key: string]: Json };

function collect(node: Json, prefix: string, out: StyleParam[]): void {
  if (typeof node === 'number') {
    out.push({ path: prefix, value: node });
    return;
  }
  if (typeof node === 'string') {
    if (HEX_COLOR.test(node)) {
      out.push({ path: prefix, value: node });
    }
    return;
  }
  if (node === null || typeof node === 'boolean') {
    return;
  }
  const entries = Array.isArray(node)
    ? node.map((item, index): [string, Json] => [String(index), item])
    : Object.entries(node);
  for (const [key, child] of entries) {
    collect(child, prefix === '' ? key : `${prefix}.${key}`, out);
  }
}

export function flattenParams(style: AimLineStyle): StyleParam[] {
  const out: StyleParam[] = [];
  collect(style as unknown as Json, '', out);
  return out;
}

export function withParam(style: AimLineStyle, path: string, value: number | string): AimLineStyle {
  const copy = structuredClone(style) as unknown as Record<string, Json>;
  const keys = path.split('.');
  const last = keys.pop();
  if (last === undefined) {
    return style;
  }
  let node: Json = copy;
  for (const key of keys) {
    if (node === null || typeof node !== 'object') {
      return style;
    }
    const next: Json | undefined = Array.isArray(node) ? node[Number(key)] : node[key];
    if (next === undefined) {
      return style;
    }
    node = next;
  }
  if (node === null || typeof node !== 'object') {
    return style;
  }
  if (Array.isArray(node)) {
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index >= node.length) {
      return style;
    }
    node[index] = value;
  } else {
    if (!Object.hasOwn(node, last)) {
      return style;
    }
    node[last] = value;
  }
  return copy as unknown as AimLineStyle;
}

function formatPx(value: number): string {
  return `${String(Math.round(value * 10) / 10)}px`;
}

// Короткая подпись для контактного листа: что в стиле есть, в цифрах.
export function summarizeStyle(style: AimLineStyle): string {
  const parts = [`ядро ${formatPx(style.core.widthPx)}`];
  if (style.layers.length > 0) {
    parts.push(`ореол ${style.layers.map((layer) => formatPx(layer.widthPx)).join('/')}`);
  } else {
    parts.push('без ореола');
  }
  if (style.dash !== null) {
    parts.push(`штрихи ${String(style.dash.speedPxPerS)}px/с`);
  }
  if (style.end !== null) {
    parts.push(`точка ${formatPx(style.end.radiusPx)}`);
  }
  if (style.pulse.onTarget.depth > 0) {
    parts.push(`пульс ${String(style.pulse.onTarget.hz)}Гц`);
  }
  return parts.join(' · ');
}
