import { ROUND_SECONDS, ZONE, type Side } from '@tanks/shared/engine';
import { gameTimecode } from '@tanks/shared/protocol';
import type { WorldView } from '../prediction.js';
import { edgeMarker, type Camera } from './camera.js';
import type { Effects } from './effects.js';
import { UI_MARGIN, type Screen } from './screenLayers.js';
import { BODY_FONT, HEAD_FONT, SIDE_COLORS, clamp, easeOut } from './view.js';

const SECONDS_PER_MINUTE = 60;
const TEXT_SHADOW_COLOR = 'rgba(0,0,0,0.8)';
const LABEL_SHADOW_COLOR = 'rgba(0,0,0,0.9)';

const CLOCK_FONT_SIZE = 22;
const CLOCK_Y = 28;
const CLOCK_COLOR = '#f2f2f2';
const CLOCK_ZONE_COLOR = '#ff5a6a';
const CLOCK_SHADOW_BLUR = 6;
const SCORE_FONT_SIZE = 14;
const SCORE_Y = 46;
const SCORE_GAP = 8;
const SCORE_SEPARATOR_COLOR = 'rgba(255,255,255,0.5)';
const ROUND_FONT_SIZE = 9;
const ROUND_Y = 58;
const ROUND_COLOR = 'rgba(255,255,255,0.45)';
// Идентификатор игры и таймкод игрок называет при разборе сбоя — крупнее служебных подписей.
const GAME_ID_FONT_SIZE = 11;
const GAME_ID_Y = 72;
const GAME_ID_COLOR = 'rgba(255,255,255,0.7)';

const PLATE_WIDTH = 120;
const PLATE_NAME_FONT_SIZE = 13;
const PLATE_NAME_Y = 19;
const PLATE_NAME_COLOR = '#fff';
const PLATE_NAME_DEAD_COLOR = 'rgba(255,255,255,0.45)';
const PLATE_NAME_SHADOW_BLUR = 4;
const PLATE_BAR_Y = 26;
const PLATE_BAR_HEIGHT = 7;
const PLATE_BAR_BACK_COLOR = 'rgba(0,0,0,0.55)';
const PLATE_GHOST_COLOR = 'rgba(255,255,255,0.85)';
const PLATE_HP_FONT_SIZE = 10;
const PLATE_HP_GAP = 12;
const PLATE_HP_COLOR = 'rgba(255,255,255,0.75)';

const MARKER_INSET = 36;
const MARKER_SIZE = 10;
// Треугольник остриём к противнику: хвост и полуширина основания — доли размера.
const MARKER_TAIL = 0.8;
const MARKER_HALF_BASE = 0.7;
const MARKER_SHADOW_BLUR = 6;
const MARKER_LABEL_FONT_SIZE = 10;
const MARKER_LABEL_COLOR = 'rgba(255,255,255,0.85)';
const MARKER_LABEL_SHADOW_BLUR = 4;
const MARKER_LABEL_EDGE = 30;
const MARKER_LABEL_ABOVE_GAP = 6;
const MARKER_LABEL_BELOW_GAP = 14;

const COUNTDOWN_DIM_COLOR = 'rgba(5,6,8,0.55)';
const COUNTDOWN_TITLE_Y = 0.3;
const COUNTDOWN_TITLE_FONT_SIZE = 14;
const COUNTDOWN_TITLE_COLOR = 'rgba(255,255,255,0.7)';
const COUNTDOWN_MAP_FONT_SIZE = 36;
const COUNTDOWN_MAP_GAP = 42;
const COUNTDOWN_NAME_FONT_SIZE = 14;
const COUNTDOWN_NAME_INSET = UI_MARGIN * 2;
const COUNTDOWN_TEXT_COLOR = '#fff';
const COUNTDOWN_NUMBER_Y = 0.78;
// Цифра появляется крупнее и ярче и за секунду садится до своего размера, бледнея.
const COUNTDOWN_NUMBER_FONT_SIZE = 100;
const COUNTDOWN_NUMBER_GROW = 1.3;
const COUNTDOWN_NUMBER_SHRINK = 0.3;
const COUNTDOWN_NUMBER_FADE = 0.7;
const COUNTDOWN_GO_FONT_SIZE = 80;

// Что панели дуэли знают о раунде. Пустой gameId — боя на сервере нет: строки «ИГРА · таймкод» нет.
export interface DuelHudInfo {
  names: [string, string];
  score: [number, number];
  roundIndex: number;
  gameId: string;
  gameTick: number;
  mySide: Side;
}

function enemyOf(side: Side): Side {
  return side === 0 ? 1 : 0;
}

// Интерфейс только дуэли в CSS-пикселях: панели сторон, таймер и счёт, стрелка на противника за кадром, отсчёт.
export class DuelHud {
  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly effects: Effects,
  ) {}

  // Свой танк — слева, противник — справа, независимо от стороны в комнате; цвета — по стороне.
  drawPanels(view: WorldView, hud: DuelHudInfo, screen: Screen): void {
    const { ctx } = this;
    const { u } = screen;
    const enemySide = enemyOf(hud.mySide);
    this.drawPlate(view, hud, screen, hud.mySide, false);
    this.drawPlate(view, hud, screen, enemySide, true);

    const left = Math.max(0, ROUND_SECONDS - view.round.time);
    const minutes = Math.floor(left / SECONDS_PER_MINUTE);
    const seconds = Math.floor(left % SECONDS_PER_MINUTE);
    const isZoneOn = view.round.time >= ZONE.startShrink;
    const centerX = screen.width / 2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = `${String(CLOCK_FONT_SIZE * u)}px ${HEAD_FONT}`;
    ctx.fillStyle = isZoneOn ? CLOCK_ZONE_COLOR : CLOCK_COLOR;
    ctx.shadowColor = TEXT_SHADOW_COLOR;
    ctx.shadowBlur = CLOCK_SHADOW_BLUR * u;
    ctx.fillText(`${String(minutes)}:${String(seconds).padStart(2, '0')}`, centerX, CLOCK_Y * u);
    ctx.font = `${String(SCORE_FONT_SIZE * u)}px ${HEAD_FONT}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = SIDE_COLORS[hud.mySide];
    ctx.fillText(String(hud.score[hud.mySide]), centerX - SCORE_GAP * u, SCORE_Y * u);
    ctx.textAlign = 'left';
    ctx.fillStyle = SIDE_COLORS[enemySide];
    ctx.fillText(String(hud.score[enemySide]), centerX + SCORE_GAP * u, SCORE_Y * u);
    ctx.textAlign = 'center';
    ctx.fillStyle = SCORE_SEPARATOR_COLOR;
    ctx.fillText(':', centerX, SCORE_Y * u);
    ctx.font = `600 ${String(ROUND_FONT_SIZE * u)}px ${BODY_FONT}`;
    ctx.fillStyle = ROUND_COLOR;
    ctx.fillText(`РАУНД ${String(hud.roundIndex + 1)} · ${view.round.map.name.toUpperCase()}`, centerX, ROUND_Y * u);
    if (hud.gameId !== '') {
      ctx.font = `600 ${String(GAME_ID_FONT_SIZE * u)}px ui-monospace, monospace`;
      ctx.fillStyle = GAME_ID_COLOR;
      ctx.fillText(`ИГРА ${hud.gameId} · ${gameTimecode(hud.gameTick)}`, centerX, GAME_ID_Y * u);
    }
    ctx.restore();
  }

  private drawPlate(view: WorldView, hud: DuelHudInfo, screen: Screen, side: Side, isRight: boolean): void {
    const { ctx } = this;
    const { u } = screen;
    const color = SIDE_COLORS[side];
    const tank = view.tanks[side];
    const maxHp = view.round.tanks[side].stats.maxHp;
    const fx = this.effects.tankFx(side);
    const width = PLATE_WIDTH * u;
    const x = isRight ? screen.width - UI_MARGIN * u - width : UI_MARGIN * u;
    const barY = PLATE_BAR_Y * u;
    const barHeight = PLATE_BAR_HEIGHT * u;
    const k = clamp(tank.hp / maxHp, 0, 1);
    const ghost = clamp((fx.ghostHp ?? tank.hp) / maxHp, 0, 1);
    ctx.save();
    ctx.textAlign = isRight ? 'right' : 'left';
    ctx.font = `700 ${String(PLATE_NAME_FONT_SIZE * u)}px ${BODY_FONT}`;
    ctx.fillStyle = tank.isAlive ? PLATE_NAME_COLOR : PLATE_NAME_DEAD_COLOR;
    ctx.shadowColor = TEXT_SHADOW_COLOR;
    ctx.shadowBlur = PLATE_NAME_SHADOW_BLUR * u;
    ctx.fillText(hud.names[side], isRight ? x + width : x, PLATE_NAME_Y * u);
    ctx.shadowBlur = 0;
    ctx.fillStyle = PLATE_BAR_BACK_COLOR;
    ctx.fillRect(x, barY, width, barHeight);
    ctx.fillStyle = PLATE_GHOST_COLOR;
    ctx.fillRect(isRight ? x + width * (1 - ghost) : x, barY, width * ghost, barHeight);
    ctx.fillStyle = color;
    ctx.fillRect(isRight ? x + width * (1 - k) : x, barY, width * k, barHeight);
    ctx.font = `600 ${String(PLATE_HP_FONT_SIZE * u)}px ${BODY_FONT}`;
    ctx.fillStyle = PLATE_HP_COLOR;
    ctx.fillText(
      `${String(Math.ceil(tank.hp))} / ${String(maxHp)}`,
      isRight ? x + width : x,
      barY + barHeight + PLATE_HP_GAP * u,
    );
    ctx.restore();
  }

  drawEnemyMarker(view: WorldView, hud: DuelHudInfo, screen: Screen, camera: Camera): void {
    const enemySide = enemyOf(hud.mySide);
    const enemy = view.tanks[enemySide];
    if (!enemy.isAlive) {
      return;
    }
    const marker = edgeMarker(camera, enemy, MARKER_INSET * screen.u * screen.pixelRatio);
    if (marker === null) {
      return;
    }
    const { ctx } = this;
    const { u } = screen;
    const x = marker.x / screen.pixelRatio;
    const y = marker.y / screen.pixelRatio;
    const size = MARKER_SIZE * u;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(marker.angle);
    ctx.fillStyle = SIDE_COLORS[enemySide];
    ctx.shadowColor = TEXT_SHADOW_COLOR;
    ctx.shadowBlur = MARKER_SHADOW_BLUR * u;
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * MARKER_TAIL, -size * MARKER_HALF_BASE);
    ctx.lineTo(-size * MARKER_TAIL, size * MARKER_HALF_BASE);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = `600 ${String(MARKER_LABEL_FONT_SIZE * u)}px ${BODY_FONT}`;
    ctx.fillStyle = MARKER_LABEL_COLOR;
    ctx.shadowColor = LABEL_SHADOW_COLOR;
    ctx.shadowBlur = MARKER_LABEL_SHADOW_BLUR * u;
    const labelX = clamp(x, MARKER_LABEL_EDGE * u, screen.width - MARKER_LABEL_EDGE * u);
    const labelY = y + (y > screen.height / 2 ? -size - MARKER_LABEL_ABOVE_GAP * u : size + MARKER_LABEL_BELOW_GAP * u);
    ctx.fillText(hud.names[enemySide], labelX, labelY);
    ctx.restore();
  }

  drawCountdown(view: WorldView, hud: DuelHudInfo, screen: Screen, elapsedS: number, totalS: number): void {
    const { ctx } = this;
    const { u, width, height } = screen;
    ctx.save();
    ctx.fillStyle = COUNTDOWN_DIM_COLOR;
    ctx.fillRect(0, 0, width, height);
    const titleY = height * COUNTDOWN_TITLE_Y;
    const mapY = titleY + COUNTDOWN_MAP_GAP * u;
    ctx.textAlign = 'center';
    ctx.font = `600 ${String(COUNTDOWN_TITLE_FONT_SIZE * u)}px ${BODY_FONT}`;
    ctx.fillStyle = COUNTDOWN_TITLE_COLOR;
    ctx.fillText(`РАУНД ${String(hud.roundIndex + 1)}`, width / 2, titleY);
    ctx.font = `${String(COUNTDOWN_MAP_FONT_SIZE * u)}px ${HEAD_FONT}`;
    ctx.fillStyle = COUNTDOWN_TEXT_COLOR;
    ctx.fillText(view.round.map.name.toUpperCase(), width / 2, mapY);
    ctx.font = `700 ${String(COUNTDOWN_NAME_FONT_SIZE * u)}px ${BODY_FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = SIDE_COLORS[0];
    ctx.fillText(`◀ ${hud.names[0]}`, COUNTDOWN_NAME_INSET * u, mapY);
    ctx.textAlign = 'right';
    ctx.fillStyle = SIDE_COLORS[1];
    ctx.fillText(`${hud.names[1]} ▶`, width - COUNTDOWN_NAME_INSET * u, mapY);
    const left = totalS - elapsedS;
    const number = Math.ceil(left);
    const numberY = height * COUNTDOWN_NUMBER_Y;
    ctx.textAlign = 'center';
    ctx.fillStyle = COUNTDOWN_TEXT_COLOR;
    if (number >= 1) {
      const fraction = 1 - (left - Math.floor(left));
      const grow = COUNTDOWN_NUMBER_GROW - easeOut(fraction) * COUNTDOWN_NUMBER_SHRINK;
      ctx.globalAlpha = 1 - fraction * COUNTDOWN_NUMBER_FADE;
      ctx.font = `${String(Math.round(COUNTDOWN_NUMBER_FONT_SIZE * u * grow))}px ${HEAD_FONT}`;
      ctx.fillText(String(number), width / 2, numberY);
    } else {
      ctx.font = `${String(COUNTDOWN_GO_FONT_SIZE * u)}px ${HEAD_FONT}`;
      ctx.fillText('БОЙ!', width / 2, numberY);
    }
    ctx.restore();
  }
}
