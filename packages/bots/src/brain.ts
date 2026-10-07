import type { Action, BotView, Stats } from '@tanks/shared/engine';

// reactionTicks — бот действует по виду такой давности (модель времени реакции); 0 — по свежему.
export interface BotBrain {
  readonly stats: Stats;
  readonly reactionTicks: number;
  init?(view: BotView): void;
  tick(view: BotView): Action;
}
