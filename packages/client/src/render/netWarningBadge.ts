import { pingDegree, type NetWarningLevel, type NetWarningState } from '../netWarning.js';
import type { Screen } from './screenLayers.js';
import { BODY_FONT, clamp, hexToRgb, lerp } from './view.js';

// Предупреждение о связи — полоса статуса: спокойная плашка внизу по центру, без пульса. Цвет уровня — только на
// столбиках сигнала и кромке, текст тёплый белый. Размеры — точки экрана телефона высотой 390, растут с интерфейсом.
// Оранжевый «сильно» — насыщенный янтарный, желтее и ярче акцента: не читается кнопкой или своим танком.
const NET_WARNING_STYLE = {
  colors: {
    good: '#7fe0a0',
    weak: '#ffe14d',
    strong: '#ff9419',
    severe: '#ff4a5a',
  },
  // Над строкой отладки: низ плашки — на столько выше края экрана.
  bottomOffset: 24,
  height: 24,
  paddingLeft: 9,
  paddingRight: 12,
  iconGap: 7,
  background: 'rgba(11,15,13,0.8)',
  edgeWidth: 1,
  edgeAlpha: 0.6,
  fontSize: 12,
  fontWeight: 600,
  textColor: '#f4f1e8',
  // Строчные кириллицы без выносных элементов: по центру по метрике шрифта текст смотрится выше середины.
  textOffsetY: 0.5,
  bars: {
    count: 4,
    width: 2.5,
    gap: 1.5,
    minHeight: 4,
    maxHeight: 11,
    dimColor: 'rgba(244,241,232,0.22)',
  },
  fadeMs: 160,
  colorMs: 120,
} as const;

const LEVEL_COLORS: Readonly<Record<NetWarningLevel, string>> = {
  0: NET_WARNING_STYLE.colors.good,
  1: NET_WARNING_STYLE.colors.weak,
  2: NET_WARNING_STYLE.colors.strong,
  3: NET_WARNING_STYLE.colors.severe,
};
// Число пинга: до 80 — хорошо, до 150 — слабо, выше — сразу красный.
const PING_COLORS = [
  NET_WARNING_STYLE.colors.good,
  NET_WARNING_STYLE.colors.weak,
  NET_WARNING_STYLE.colors.severe,
  NET_WARNING_STYLE.colors.severe,
] as const;

type Rgb = [number, number, number];

export function pingColor(rttMs: number): string {
  return PING_COLORS[pingDegree(rttMs)];
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}

function css([r, g, b]: Rgb, alpha: number): string {
  return `rgba(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)},${String(alpha)})`;
}

// Плашка с появлением, исчезанием и сменой цвета. Пока гаснет — держит последний уровень и текст.
export class NetWarningBadge {
  private visibility = 0;
  private level: NetWarningLevel = 0;
  private text = '';
  private colorFrom: Rgb = hexToRgb(NET_WARNING_STYLE.colors.weak);
  private colorTo: Rgb = hexToRgb(NET_WARNING_STYLE.colors.weak);
  private colorT = 1;

  update(warning: Readonly<NetWarningState>, frameMs: number): void {
    const isShown = warning.level > 0;
    const step = frameMs / NET_WARNING_STYLE.fadeMs;
    this.visibility = clamp(this.visibility + (isShown ? step : -step), 0, 1);
    this.colorT = clamp(this.colorT + frameMs / NET_WARNING_STYLE.colorMs, 0, 1);
    if (!isShown) {
      return;
    }
    this.text = warning.text;
    if (warning.level === this.level) {
      return;
    }
    const target = hexToRgb(LEVEL_COLORS[warning.level]);
    const isAppearing = this.visibility <= step;
    this.colorFrom = isAppearing ? target : this.color();
    this.colorTo = target;
    this.colorT = isAppearing ? 1 : 0;
    this.level = warning.level;
  }

  draw(ctx: CanvasRenderingContext2D, screen: Screen): void {
    if (this.visibility === 0 || this.text === '') {
      return;
    }
    const { u } = screen;
    const alpha = smoothstep(this.visibility);
    const color = this.color();
    const { bars } = NET_WARNING_STYLE;
    ctx.save();
    ctx.font = `${String(NET_WARNING_STYLE.fontWeight)} ${String(NET_WARNING_STYLE.fontSize * u)}px ${BODY_FONT}`;
    const textWidth = ctx.measureText(this.text).width;
    const iconWidth = (bars.count * bars.width + (bars.count - 1) * bars.gap) * u;
    const width =
      (NET_WARNING_STYLE.paddingLeft + NET_WARNING_STYLE.iconGap + NET_WARNING_STYLE.paddingRight) * u +
      iconWidth +
      textWidth;
    const height = NET_WARNING_STYLE.height * u;
    const left = Math.round(screen.width / 2 - width / 2);
    const top = Math.round(screen.height - NET_WARNING_STYLE.bottomOffset * u - height);
    const edge = NET_WARNING_STYLE.edgeWidth;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.roundRect(left + edge / 2, top + edge / 2, width - edge, height - edge, height / 2);
    ctx.fillStyle = NET_WARNING_STYLE.background;
    ctx.fill();
    ctx.lineWidth = edge;
    ctx.strokeStyle = css(color, NET_WARNING_STYLE.edgeAlpha);
    ctx.stroke();
    this.drawBars(ctx, left + NET_WARNING_STYLE.paddingLeft * u, top + height / 2, u, color);
    ctx.fillStyle = NET_WARNING_STYLE.textColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      this.text,
      left + (NET_WARNING_STYLE.paddingLeft + NET_WARNING_STYLE.iconGap) * u + iconWidth,
      top + height / 2 + NET_WARNING_STYLE.textOffsetY * u,
    );
    ctx.restore();
  }

  // Столбики сигнала по возрастанию; горят 4 − уровень: чем хуже связь, тем меньше.
  private drawBars(ctx: CanvasRenderingContext2D, left: number, middleY: number, u: number, color: Rgb): void {
    const { bars } = NET_WARNING_STYLE;
    const lit = bars.count - this.level;
    const bottom = middleY + (bars.maxHeight * u) / 2;
    for (let index = 0; index < bars.count; index++) {
      const share = index / (bars.count - 1);
      const barHeight = lerp(bars.minHeight, bars.maxHeight, share) * u;
      const x = left + index * (bars.width + bars.gap) * u;
      ctx.fillStyle = index < lit ? css(color, 1) : bars.dimColor;
      ctx.beginPath();
      ctx.roundRect(x, bottom - barHeight, bars.width * u, barHeight, (bars.width * u) / 2);
      ctx.fill();
    }
  }

  private color(): Rgb {
    return mix(this.colorFrom, this.colorTo, smoothstep(this.colorT));
  }
}
