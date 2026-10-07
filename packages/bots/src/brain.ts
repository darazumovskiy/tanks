import type { Action, BotView, Stats } from '@tanks/shared/engine';

// Старт раунда, как его знает бот: номер раунда в игре, карта и счёт перед раундом.
export interface BotRound {
  roundIndex: number;
  mapIndex: number;
  score: readonly [number, number];
}

// reactionTicks — бот действует по виду такой давности (модель времени реакции); 0 — по свежему.
export interface BotBrain {
  readonly stats: Stats;
  readonly reactionTicks: number;
  init?(view: BotView, round: BotRound): void;
  tick(view: BotView): Action;
}
