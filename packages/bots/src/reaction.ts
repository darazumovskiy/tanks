import type { BotView } from '@tanks/shared/engine';

// Задержка реакции: противника и снаряды мозг видит видом reactionTicks тиков назад (пока истории меньше — самым
// старым из имеющихся). Свой танк, зону и аптечки — свежими: где ты сам, ты знаешь. История — на один раунд.
export class ReactionDelay {
  private readonly recent: BotView[] = [];

  constructor(private readonly reactionTicks: number) {}

  // Свежий вид тика → вид, по которому мозг действует.
  perceive(fresh: BotView): BotView {
    this.recent.push(fresh);
    if (this.recent.length > this.reactionTicks + 1) {
      this.recent.shift();
    }
    // Свежий вид только что добавлен: история не пуста.
    const [seen] = this.recent as [BotView, ...BotView[]];
    return { ...fresh, enemy: seen.enemy, bullets: seen.bullets };
  }
}
