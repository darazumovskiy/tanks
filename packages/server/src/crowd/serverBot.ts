import type { Action } from '@tanks/shared/engine';
import { decode, quantizeAction, type ServerMessage } from '@tanks/shared/protocol';
import type { FfaConnection } from '../ffaGame.js';
import type { CrowdBot } from './bot.js';
import type { CrowdLevel } from './profile.js';

// Мозг толпы настраивали со снимком, команда по которому доходит до сервера через 2 тика: пинг ~53 мс.
const INPUT_DELAY_TICKS = 2;

interface DueInput {
  seq: number;
  action: Action;
}

interface PendingInput extends DueInput {
  dueTick: number;
}

// Серверный бот: соединение без сети вокруг бота толпы. Игра пишет в него байты, как в сокет; мозг разбирает их
// вне тика, а команды отдаёт игре на тике, когда они дошли бы по сети.
export class ServerBot implements FfaConnection {
  private inbox: Uint8Array[] = [];
  private pending: PendingInput[] = [];

  constructor(
    private readonly bot: CrowdBot,
    readonly level: CrowdLevel,
  ) {}

  send(bytes: Uint8Array): void {
    this.inbox.push(bytes);
  }

  close(): void {
    this.inbox = [];
    this.pending = [];
    this.bot.disconnect();
  }

  // Оси округляются, как в кодеке сокета: журнал боя пишет и прогоняет команды округлёнными.
  think(tick: number): void {
    const inbox = this.inbox;
    this.inbox = [];
    for (const bytes of inbox) {
      const input = this.bot.receive(decode(bytes) as ServerMessage);
      if (input !== null) {
        this.pending.push({
          dueTick: tick + INPUT_DELAY_TICKS,
          seq: input.seq,
          action: quantizeAction(input.action),
        });
      }
    }
  }

  takeDue(tick: number): DueInput[] {
    const due = this.pending.filter((input) => input.dueTick <= tick);
    this.pending = this.pending.filter((input) => input.dueTick > tick);
    return due;
  }
}
