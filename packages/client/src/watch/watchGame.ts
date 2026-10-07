import { DT, DUEL_COUNTDOWN_TICKS, TICK_RATE, type Side } from '@tanks/shared/engine';
import type { SnapshotEvent, TankSnapshot } from '@tanks/shared/protocol';
import { CountdownBeeper } from '../countdownBeeper.js';
import type { WorldView } from '../prediction.js';
import type { Effects } from '../render/effects.js';
import { DuelFxPolicy, duelFxEvent } from '../render/fxEvent.js';
import type { Overlay } from '../render/renderer.js';
import type { WatchHudInfo } from '../render/watchRenderer.js';
import type { Sfx } from '../sfx.js';
import { BotMatch, type MatchPhase, type RoundOutcome } from './botMatch.js';
import type { Fighter } from './fighters.js';
import { StepClock, type WatchSpeed } from './stepClock.js';
import { posesOf, worldViewAt, type Poses } from './watchView.js';

export interface WatchRendererLike {
  draw(view: WorldView, hud: WatchHudInfo, overlay: Overlay): void;
}

// Зависимости от браузера: тесты подставляют отрисовщик, эффекты, звук, часы, кадры, видимость вкладки и зёрна.
export interface WatchGameDeps {
  createRenderer: (effects: Effects) => WatchRendererLike;
  createEffects: (names: () => readonly [string, string]) => Effects;
  createSfx: () => Sfx;
  now: () => number;
  requestFrame: (callback: (now: number) => void) => void;
  isHidden: () => boolean;
  nextSeed: () => number;
}

// onOutcome — итог раунда появился (с именами бойцов) или ушёл со стартом следующего (null).
export interface WatchGameOptions {
  fighters: readonly [Fighter, Fighter];
  speed: WatchSpeed;
  onOutcome: (outcome: RoundOutcome | null, names: readonly [string, string]) => void;
}

export interface WatchDebugState {
  fighters: [string, string];
  fighterIds: [string, string];
  seed: number;
  score: [number, number];
  roundIndex: number;
  phase: MatchPhase;
  roundTick: number;
  totalTicks: number;
  mapIndex: number;
  hp: [number, number];
  speed: WatchSpeed;
  isPaused: boolean;
  isHidden: boolean;
  isMuted: boolean;
  fps: number;
  worstFrameStepsMs: number;
}

const MS_PER_S = 1000;
const STATS_WINDOW_MS = 1000;
// Бой ботов на сервере не живёт: номера игры нет, строки «ИГРА · таймкод» на холсте тоже.
const NO_GAME_ID = '';
// Левый боец рисуется своим, как сторона 0 дуэли: оранжевый слева, бирюзовый справа.
const LEFT_SIDE: Side = 0;
const COUNTDOWN_S = DUEL_COUNTDOWN_TICKS * DT;
// «БОЙ!» держится первые полсекунды боя: картинка не отстаёт от движка, как в дуэли по сети, иначе надписи не было бы.
const GO_SHOWN_TICKS = TICK_RATE / 2;

function tankSnapshot(tank: WorldView['round']['tanks'][number]): TankSnapshot {
  return {
    x: tank.x,
    y: tank.y,
    heading: tank.heading,
    turret: tank.turret,
    speed: tank.speed,
    hp: tank.hp,
    reloadLeft: tank.reloadLeft,
    isAlive: tank.isAlive,
  };
}

// Цикл кадров боя ботов: шаги матча по часам кадра, эффекты и звук по событиям раунда, отрисовка, итог раунда.
// Пауза и скрытая вкладка останавливают шаги, эффекты и звук; кадр остаётся на экране.
export class WatchGame {
  private readonly deps: WatchGameDeps;
  private readonly renderer: WatchRendererLike;
  private readonly effects: Effects;
  private readonly sfx: Sfx;
  private readonly fxPolicy = new DuelFxPolicy();
  private readonly clock = new StepClock();
  private fighters: readonly [Fighter, Fighter];
  private match: BotMatch;
  private poses: Poses | null = null;
  private speed: WatchSpeed;
  private isPausedNow = false;
  private isHiddenNow = false;
  private lastFrame: number;
  private framesInWindow = 0;
  private windowStart: number;
  private fps = 0;
  private worstFrameStepsMs = 0;
  private worstFrameStepsMsInWindow = 0;
  private readonly countdownBeeper: CountdownBeeper;

  constructor(
    private readonly options: WatchGameOptions,
    deps: WatchGameDeps,
  ) {
    this.deps = deps;
    this.fighters = options.fighters;
    this.speed = options.speed;
    this.match = new BotMatch(this.fighters, deps.nextSeed());
    this.effects = deps.createEffects(() => this.match.names);
    this.renderer = deps.createRenderer(this.effects);
    this.sfx = deps.createSfx();
    this.countdownBeeper = new CountdownBeeper(this.sfx);
    const startedAt = deps.now();
    this.lastFrame = startedAt;
    this.windowStart = startedAt;
    this.startMatch(this.match);
    deps.requestFrame((now) => {
      this.frame(now);
    });
  }

  get isPaused(): boolean {
    return this.isPausedNow;
  }

  get isMuted(): boolean {
    return this.sfx.isMuted;
  }

  setFighters(fighters: readonly [Fighter, Fighter]): void {
    this.fighters = fighters;
    this.restart();
  }

  restart(): void {
    this.startMatch(new BotMatch(this.fighters, this.deps.nextSeed()));
  }

  setSpeed(speed: WatchSpeed): void {
    this.speed = speed;
  }

  togglePause(): boolean {
    this.isPausedNow = !this.isPausedNow;
    return this.isPausedNow;
  }

  toggleSound(): boolean {
    return this.sfx.toggle();
  }

  unlockSound(): void {
    this.sfx.unlock();
  }

  debugState(): WatchDebugState {
    const { match } = this;
    const [left, right] = match.round.tanks;
    return {
      fighters: match.names,
      fighterIds: [this.fighters[0].id, this.fighters[1].id],
      seed: match.seed,
      score: [match.score[0], match.score[1]],
      roundIndex: match.roundIndex,
      phase: match.phase,
      roundTick: match.round.tick,
      totalTicks: match.totalTicks,
      mapIndex: match.round.mapIndex,
      hp: [left.hp, right.hp],
      speed: this.speed,
      isPaused: this.isPausedNow,
      isHidden: this.isHiddenNow,
      isMuted: this.sfx.isMuted,
      fps: this.fps,
      worstFrameStepsMs: this.worstFrameStepsMs,
    };
  }

  private startMatch(match: BotMatch): void {
    this.match = match;
    this.clock.reset();
    this.startRound();
  }

  private startRound(): void {
    this.effects.reset();
    this.fxPolicy.reset();
    this.poses = null;
    this.countdownBeeper.reset();
    this.options.onOutcome(null, this.match.names);
  }

  private frame(now: number): void {
    this.deps.requestFrame((next) => {
      this.frame(next);
    });
    const frameMs = now - this.lastFrame;
    this.lastFrame = now;
    this.countFrame(now);
    this.isHiddenNow = this.deps.isHidden();
    const isStopped = this.isPausedNow || this.isHiddenNow;
    if (!isStopped) {
      this.advance(frameMs);
    }
    this.draw(isStopped ? 0 : frameMs);
  }

  private countFrame(now: number): void {
    this.framesInWindow++;
    if (now - this.windowStart < STATS_WINDOW_MS) {
      return;
    }
    this.fps = (this.framesInWindow * MS_PER_S) / (now - this.windowStart);
    this.worstFrameStepsMs = this.worstFrameStepsMsInWindow;
    this.framesInWindow = 0;
    this.worstFrameStepsMsInWindow = 0;
    this.windowStart = now;
  }

  private advance(frameMs: number): void {
    const steps = this.clock.advance(frameMs, this.speed);
    const startedAt = this.deps.now();
    for (let step = 0; step < steps; step++) {
      this.stepOnce();
    }
    this.worstFrameStepsMsInWindow = Math.max(this.worstFrameStepsMsInWindow, this.deps.now() - startedAt);
    const view = worldViewAt(this.match.round, this.poses, this.clock.fraction);
    this.effects.update(frameMs / MS_PER_S, [
      { ...view.tanks[0], id: 0 },
      { ...view.tanks[1], id: 1 },
    ]);
    this.countdownBeeper.update(this.overlay());
  }

  private stepOnce(): void {
    const { match } = this;
    const poses = posesOf(match.round);
    const step = match.step();
    if (step.isNewRound) {
      this.startRound();
      return;
    }
    if (!step.hasRoundStepped) {
      this.poses = null;
      return;
    }
    this.poses = poses;
    const { round } = match;
    this.effects.onSnapshot(round.tick, [tankSnapshot(round.tanks[0]), tankSnapshot(round.tanks[1])]);
    this.playEvents(step.events);
    if (match.outcome !== null) {
      this.options.onOutcome(match.outcome, match.names);
    }
  }

  private playEvents(events: readonly SnapshotEvent[]): void {
    for (const event of events) {
      this.effects.onEvent(duelFxEvent(event), this.fxPolicy.optionsFor(event));
    }
    this.sfx.events(events);
  }

  private overlay(): Overlay {
    const { phase, phaseTicks } = this.match;
    if (phase === 'countdown') {
      return { kind: 'countdown', elapsedS: phaseTicks * DT, totalS: COUNTDOWN_S };
    }
    if (phase === 'fight' && phaseTicks < GO_SHOWN_TICKS) {
      return { kind: 'countdown', elapsedS: COUNTDOWN_S + phaseTicks * DT, totalS: COUNTDOWN_S };
    }
    return null;
  }

  private draw(frameMs: number): void {
    const { match } = this;
    const view = worldViewAt(match.round, this.poses, this.clock.fraction);
    this.renderer.draw(
      view,
      {
        names: match.names,
        score: [match.score[0], match.score[1]],
        roundIndex: match.roundIndex,
        gameId: NO_GAME_ID,
        gameTick: match.totalTicks,
        mySide: LEFT_SIDE,
        frameMs,
      },
      this.overlay(),
    );
  }
}
