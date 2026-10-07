import type { Side } from '@tanks/shared/engine';
import type { BotLevel } from '@tanks/shared/protocol';
import type { BotRound } from '../brain.js';
import type { TwinSituation } from './brain.js';
import { lossStreakAfter } from './modeSwitch.js';

// Обстановка раунда для мозга двойника — то, что о матче знает игрок: уровень соперника, номер раунда, карта,
// проигрыши подряд в этой игре по счёту на старте раунда, предохранитель.
export class TwinRoundState {
  private lossStreak = 0;
  private previousScore: [number, number] | null = null;

  constructor(
    private readonly level: BotLevel,
    private readonly hasRicochetGuard: boolean,
  ) {}

  next(round: BotRound, side: Side, seed: number): TwinSituation {
    const enemySide: Side = side === 0 ? 1 : 0;
    this.lossStreak = lossStreakAfter(this.lossStreak, this.previousScore, round.score, enemySide);
    this.previousScore = [round.score[0], round.score[1]];
    return {
      level: this.level,
      roundIndex: round.roundIndex,
      lossStreak: this.lossStreak,
      mapIndex: round.mapIndex,
      hasRicochetGuard: this.hasRicochetGuard,
      seed,
    };
  }
}
