import type { PathAllowance } from './brain.js';
import type { ServerBot } from './serverBot.js';

// Поиск пути — самая дорогая разовая работа мозга: на весь процесс не больше стольких за проход, сверх первого —
// пока бюджет не вышел. Первый разрешён всегда: иначе на медленной машине пути не обновлялись бы вовсе.
const PATH_SEARCHES_PER_TURN = 2;
// Первый в очереди решает всегда, даже если разбор ящиков съел бюджет: иначе боты стояли бы вечно.
const MIN_DECISIONS_PER_TURN = 1;

export interface BotTurnReport {
  skipped: number;
  // Ожидание каждого решившего бота в тиках.
  waits: number[];
}

class PathQuota implements PathAllowance {
  used = 0;

  constructor(private readonly isOverBudget: () => boolean) {}

  take(): boolean {
    const isSpent = this.used >= PATH_SEARCHES_PER_TURN || (this.used > 0 && this.isOverBudget());
    if (isSpent) {
      return false;
    }
    this.used++;
    return true;
  }
}

// Очередь хода серверных ботов процесса. Решают боты с новым снимком: дольше ждущий — первым, среди равных — по
// кругу; бот, получивший поиск пути, уходит в конец круга. Не успевший в бюджет повторяет прошлую команду.
export class BotTurns {
  private circle: ServerBot[] = [];

  take(bots: readonly ServerBot[], isOverBudget: () => boolean): BotTurnReport {
    const present = new Set(bots);
    const kept = this.circle.filter((bot) => present.has(bot));
    const known = new Set(kept);
    this.circle = [...kept, ...bots.filter((bot) => !known.has(bot))];
    const queue = this.circle.filter((bot) => bot.hasUndecided).sort((a, b) => b.waitTicks - a.waitTicks);
    const paths = new PathQuota(isOverBudget);
    const planned = new Set<ServerBot>();
    const report: BotTurnReport = { skipped: 0, waits: [] };
    for (const bot of queue) {
      const hasDecisions = report.waits.length >= MIN_DECISIONS_PER_TURN;
      if (hasDecisions && isOverBudget()) {
        bot.skip();
        report.skipped++;
        continue;
      }
      const usedBefore = paths.used;
      report.waits.push(bot.waitTicks);
      bot.decide(paths);
      if (paths.used > usedBefore) {
        planned.add(bot);
      }
    }
    this.circle = [...this.circle.filter((bot) => !planned.has(bot)), ...planned];
    return report;
  }
}
