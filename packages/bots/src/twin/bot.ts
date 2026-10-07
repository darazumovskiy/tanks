import { IDLE_ACTION, type Action, type BotView, type Side, type Stats } from '@tanks/shared/engine';
import type { BotBrain, BotRound } from '../brain.js';
import { TwinBrain } from './brain.js';
import type { HitRecord } from './modeSwitch.js';
import type { TwinRival } from './profile.js';
import { TwinRoundState } from './roundState.js';

const SIDES: readonly Side[] = [0, 1];
const SEED_RANGE = 2 ** 32;
// Тик раунда на отсчёте: бой ещё не шёл.
const COUNTDOWN_TICK = 0;

// Двойник как мозг бота дуэли — для комнаты сервера и боя ботов в браузере. Канал игрока — свойство человека:
// противника он видит по снимку давности «сеть до клиента + интерполяция», а команда доходит до комнаты через
// «сеть до сервера»; бот видит свой танк свежим, и его команда применяется к следующему тику, поэтому вся сумма
// канала — задержка реакции. Попадания и аптечки — по изменению здоровья между видами.
export class TwinBot implements BotBrain {
  readonly stats: Stats;
  readonly reactionTicks: number;
  private readonly brain: TwinBrain;
  private readonly roundState: TwinRoundState;
  private hits: HitRecord[] = [];
  private lastHp: [number, number] | null = null;

  constructor(
    rival: TwinRival,
    private readonly random: () => number,
  ) {
    const { uplinkTicks, downlinkTicks, interpolationTicks } = rival.profile.channel;
    this.stats = { ...rival.stats };
    this.reactionTicks = uplinkTicks + downlinkTicks + interpolationTicks;
    this.brain = new TwinBrain(rival.profile);
    this.roundState = new TwinRoundState(rival.opponentLevel, rival.hasRicochetGuard);
  }

  init(view: BotView, round: BotRound): void {
    this.hits = [];
    this.lastHp = null;
    this.brain.init(this.roundState.next(round, view.side, Math.floor(this.random() * SEED_RANGE)));
  }

  // На отсчёте двойник шлёт пустые команды, как клиент: мозг начинает раунд с первого тика боя.
  tick(view: BotView): Action {
    if (view.tick === COUNTDOWN_TICK) {
      return { ...IDLE_ACTION };
    }
    this.recordHits(view);
    return this.brain.tick({ ...view, hits: this.hits }).action;
  }

  private recordHits(view: BotView): void {
    const hp: [number, number] = view.side === 0 ? [view.me.hp, view.enemy.hp] : [view.enemy.hp, view.me.hp];
    const previous = this.lastHp;
    this.lastHp = hp;
    if (previous === null) {
      return;
    }
    for (const side of SIDES) {
      const change = hp[side] - previous[side];
      if (change !== 0) {
        this.hits.push({ tick: view.tick, side, value: Math.abs(change), isPickup: change > 0 });
      }
    }
  }
}
