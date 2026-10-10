import { DT, shotCarry, type Side } from '@tanks/shared/engine';
import type { RoundStartMessage, SnapshotEvent, TankSnapshot } from '@tanks/shared/protocol';
import { computeAimLine, type AimLine } from './aimLine.js';
import { EventSchedule, eventPlace } from './pictureTime.js';
import type { NetWarningState } from './netWarning.js';
import type { InterpolatedTank, PictureView, WorldView } from './prediction.js';
import { isInView } from './render/camera.js';
import type { Effects } from './render/effects.js';
import { DuelFxPolicy, duelFxEvent, duelFxTanks } from './render/fxEvent.js';
import type { HudInfo, Overlay, Renderer } from './render/renderer.js';
import type { Settings } from './settings.js';
import type { StickState } from './touch.js';

// После нуля «БОЙ!» держится до первого тика боя, но не дольше этого.
const COUNTDOWN_TAIL_S = 0.6;

export interface DuelReadout {
  rttMs: number;
  correctionPx: number;
  fps: number;
  worstFrameMs: number;
  isMuted: boolean;
  netWarning: Readonly<NetWarningState>;
  frameTimes: readonly number[];
}

interface DuelControls {
  sticks: readonly StickState[];
  isShotGuarded: boolean;
  isZoneFiring: boolean;
  isReversing: boolean;
}

export interface DuelFrameInput {
  view: WorldView;
  roundStart: RoundStartMessage;
  sinceRoundStartS: number;
  gameTick: number;
  mySide: Side;
  isFighting: boolean;
  visibleEnemy: InterpolatedTank | null;
  frameMs: number;
  readout: DuelReadout;
  controls: DuelControls;
}

interface DrawnDuelFrame {
  aimLine: AimLine | null;
  overlay: Overlay;
}

type DuelEffects = Pick<Effects, 'reset' | 'onSnapshot' | 'onEvent' | 'update'>;
type DuelRenderer = Pick<Renderer, 'currentCamera' | 'resetCamera' | 'draw'>;

export function duelNames(roundStart: RoundStartMessage): [string, string] {
  return [roundStart.tanks[0].nickname, roundStart.tanks[1].nickname];
}

export function countdownSeconds(countdownTicks: number): number {
  return countdownTicks * DT;
}

function countdownOverlay(roundStart: RoundStartMessage, sinceRoundStartS: number, isFighting: boolean): Overlay {
  const totalS = countdownSeconds(roundStart.countdownTicks);
  if (isFighting || sinceRoundStartS >= totalS + COUNTDOWN_TAIL_S) {
    return null;
  }
  return { kind: 'countdown', elapsedS: sinceRoundStartS, totalS };
}

function enemyOf(side: Side): Side {
  return side === 0 ? 1 : 0;
}

// Проводка кадра дуэли — одна для игры и стенда кадров: снимок в эффекты, его события — когда до них дошла картинка,
// по правилам дуэли; линия выстрела с её условиями, интерфейс для рисования и отсчёт.
export class DuelPresenter {
  private readonly fxPolicy = new DuelFxPolicy();
  private readonly schedule = new EventSchedule<SnapshotEvent>();

  constructor(
    private readonly renderer: DuelRenderer,
    private readonly effects: DuelEffects,
    private readonly settings: Readonly<Settings>,
  ) {}

  startRound(): void {
    this.effects.reset();
    this.renderer.resetCamera();
    this.fxPolicy.reset();
    this.schedule.clear();
  }

  // События ждут, пока картинка в их месте дойдёт до тика снимка; событие о танке — от его места в снимке, о своём —
  // сразу.
  applySnapshot(
    tick: number,
    tanks: readonly TankSnapshot[],
    events: readonly SnapshotEvent[],
    now = 0,
    mySide: Side | null = null,
  ): void {
    this.effects.onSnapshot(tick, tanks);
    for (const event of events) {
      const tank = event.side === null ? undefined : tanks[event.side];
      const anchor = event.side === null || tank === undefined ? null : { id: event.side, x: tank.x, y: tank.y };
      this.schedule.add(event, tick, eventPlace(event.kind, anchor, mySide), now);
    }
  }

  // Вкладка вернулась из фона: накопленные события не играются.
  clearEvents(): void {
    this.schedule.clear();
  }

  // События, до которых дошла картинка, — в эффекты; их же отдаёт для звука.
  releaseEvents(view: PictureView, now: number): SnapshotEvent[] {
    const due = this.schedule.release(view.clock, (id) => view.tanks[id === 0 ? 0 : 1], now).map(({ event }) => event);
    for (const event of due) {
      this.applyEvent(event);
    }
    return due;
  }

  applyEvent(event: SnapshotEvent): void {
    this.effects.onEvent(duelFxEvent(event), this.fxPolicy.optionsFor(event));
  }

  update(dtS: number, view: WorldView): void {
    this.effects.update(dtS, duelFxTanks(view));
  }

  // Помощники не добывают информацию: линия выстрела, предохранитель и огонь по цели знают только о живом
  // противнике в кадре камеры и только во время боя.
  visibleEnemy(view: WorldView, mySide: Side, isFighting: boolean): InterpolatedTank | null {
    const enemy = view.tanks[enemyOf(mySide)];
    if (!isFighting || !enemy.isAlive) {
      return null;
    }
    if (!isInView(this.renderer.currentCamera, enemy)) {
      return null;
    }
    return enemy;
  }

  draw(frame: DuelFrameInput): DrawnDuelFrame {
    const aimLine = this.aimLineOf(frame);
    const overlay = countdownOverlay(frame.roundStart, frame.sinceRoundStartS, frame.isFighting);
    this.renderer.draw(frame.view, this.hudOf(frame, aimLine), overlay);
    return { aimLine, overlay };
  }

  private aimLineOf(frame: DuelFrameInput): AimLine | null {
    const { view, mySide, isFighting } = frame;
    const me = view.tanks[mySide];
    const isShown = this.settings.hasAimLine && isFighting && me.isAlive;
    if (!isShown) {
      return null;
    }
    return computeAimLine({
      field: view.round.map,
      shooter: { x: me.x, y: me.y, turret: me.turret },
      bulletSpeed: view.round.tanks[mySide].stats.bulletSpeed,
      carry: shotCarry(me, view.round.rules.shotInheritPercent),
      targets: frame.visibleEnemy === null ? [] : [frame.visibleEnemy],
      hasLeadHint: this.settings.hasLeadHint,
    });
  }

  private hudOf(frame: DuelFrameInput, aimLine: AimLine | null): HudInfo {
    const { roundStart, readout, controls } = frame;
    return {
      names: duelNames(roundStart),
      score: roundStart.score,
      roundIndex: roundStart.roundIndex,
      gameId: roundStart.gameId,
      gameTick: frame.gameTick,
      mySide: frame.mySide,
      ...readout,
      ...controls,
      aimLine,
      frameMs: frame.frameMs,
    };
  }
}
