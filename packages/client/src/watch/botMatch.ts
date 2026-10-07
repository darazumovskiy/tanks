import { ReactionDelay, type BotBrain, type BotRound } from '@tanks/bots';
import {
  botView,
  createRandom,
  createRound,
  DEFAULT_RULES,
  DUEL_COUNTDOWN_TICKS,
  nextRandom,
  roundPlan,
  stepRound,
  TICK_RATE,
  type Action,
  type Round,
  type RoundRules,
  type Side,
} from '@tanks/shared/engine';
import { toSnapshotEvent, type SnapshotEvent } from '@tanks/shared/protocol';

export type MatchPhase = 'countdown' | 'fight' | 'roundEnd';

// Итог раунда держится две секунды боя.
export const ROUND_END_TICKS = 2 * TICK_RATE;

export interface MatchFighter {
  name: string;
  createBrain: (random: () => number) => BotBrain;
}

export interface RoundOutcome {
  winner: Side | null;
  isByTime: boolean;
}

// hasRoundStepped — движок сделал шаг раунда: танки могли сдвинуться, события — его.
export interface MatchStep {
  events: SnapshotEvent[];
  isNewRound: boolean;
  hasRoundStepped: boolean;
}

const QUIET_STEP: MatchStep = { events: [], isNewRound: false, hasRoundStepped: false };

function brainOf(fighter: MatchFighter, seed: number, side: Side): BotBrain {
  const random = createRandom(seed + side);
  return fighter.createBrain(() => nextRandom(random));
}

// Бой двух мозгов бесконечной серией раундов: отсчёт, бой, итог. Карты по кругу, как в комнате дуэли. Мозги живут
// весь бой; задержка реакции — своя история на раунд. Случайность мозгов — только из зерна, движок детерминирован:
// одно зерно — один исход.
export class BotMatch {
  private readonly brains: [BotBrain, BotBrain];
  private delays: [ReactionDelay, ReactionDelay];
  private currentRound: Round;
  private currentPhase: MatchPhase = 'countdown';
  private ticksInPhase = 0;
  private roundNumber = 0;
  private ticks = 0;
  private readonly wins: [number, number] = [0, 0];
  private lastOutcome: RoundOutcome | null = null;

  constructor(
    private readonly fighters: readonly [MatchFighter, MatchFighter],
    readonly seed: number,
    private readonly rules: Readonly<RoundRules> = DEFAULT_RULES,
  ) {
    this.brains = [brainOf(fighters[0], seed, 0), brainOf(fighters[1], seed, 1)];
    this.delays = this.freshDelays();
    this.currentRound = this.openRound();
  }

  get round(): Round {
    return this.currentRound;
  }

  get phase(): MatchPhase {
    return this.currentPhase;
  }

  get phaseTicks(): number {
    return this.ticksInPhase;
  }

  get roundIndex(): number {
    return this.roundNumber;
  }

  get totalTicks(): number {
    return this.ticks;
  }

  get score(): readonly [number, number] {
    return this.wins;
  }

  // Итог последнего раунда — пока идёт фаза итога.
  get outcome(): RoundOutcome | null {
    return this.lastOutcome;
  }

  get names(): [string, string] {
    return [this.fighters[0].name, this.fighters[1].name];
  }

  step(): MatchStep {
    this.ticks++;
    this.ticksInPhase++;
    if (this.currentPhase === 'roundEnd') {
      if (this.ticksInPhase < ROUND_END_TICKS) {
        return QUIET_STEP;
      }
      this.roundNumber++;
      this.delays = this.freshDelays();
      this.currentRound = this.openRound();
      return { ...QUIET_STEP, isNewRound: true };
    }
    // На отсчёте мозги видят поле и думают, как бот на сервере над снимками отсчёта; их команды выбрасываются.
    const actions: [Action, Action] = [this.actionOf(0), this.actionOf(1)];
    if (this.currentPhase === 'countdown') {
      if (this.ticksInPhase >= DUEL_COUNTDOWN_TICKS) {
        this.enter('fight');
      }
      return QUIET_STEP;
    }
    const events = stepRound(this.currentRound, actions).map(toSnapshotEvent);
    if (this.currentRound.isOver) {
      this.finishRound(this.currentRound);
    }
    return { events, isNewRound: false, hasRoundStepped: true };
  }

  private actionOf(side: Side): Action {
    return this.brains[side].tick(this.delays[side].perceive(botView(this.currentRound, side)));
  }

  private finishRound(round: Round): void {
    if (round.winner !== null) {
      this.wins[round.winner]++;
    }
    this.lastOutcome = { winner: round.winner, isByTime: round.endReason === 'time' };
    this.enter('roundEnd');
  }

  private enter(phase: MatchPhase): void {
    this.currentPhase = phase;
    this.ticksInPhase = 0;
  }

  private freshDelays(): [ReactionDelay, ReactionDelay] {
    return [new ReactionDelay(this.brains[0].reactionTicks), new ReactionDelay(this.brains[1].reactionTicks)];
  }

  private openRound(): Round {
    const round = createRound(
      roundPlan(this.roundNumber).mapIndex,
      [
        { name: this.fighters[0].name, stats: this.brains[0].stats },
        { name: this.fighters[1].name, stats: this.brains[1].stats },
      ],
      this.rules,
    );
    const start: BotRound = { roundIndex: this.roundNumber, mapIndex: round.mapIndex, score: [...this.wins] };
    this.brains[0].init?.(botView(round, 0), start);
    this.brains[1].init?.(botView(round, 1), start);
    this.lastOutcome = null;
    this.enter('countdown');
    return round;
  }
}
