import type { Action } from '@tanks/shared/engine';
import {
  decode,
  quantizeAction,
  type FfaSnapshotMessage,
  type InputMessage,
  type ServerMessage,
} from '@tanks/shared/protocol';
import type { FfaConnection } from '../ffaGame.js';
import type { CrowdBot } from './bot.js';
import type { PathAllowance } from './brain.js';
import type { CrowdLevel } from './profile.js';
import type { Frame } from './view.js';

// Мозг толпы настраивали со снимком, команда по которому доходит до сервера через 2 тика: пинг ~53 мс.
const INPUT_DELAY_TICKS = 2;

interface DueInput {
  seq: number;
  action: Action;
}

interface PendingInput extends DueInput {
  dueTick: number;
}

interface Delivery {
  message: FfaSnapshotMessage;
  frame: Frame;
}

function threadCpuMicros(): number {
  const usage = process.threadCpuUsage();
  return usage.user + usage.system;
}

// Растягивает работу, начатую в startedAt, в factor раз: замедление для замера имитирует медленный процессор.
// Считает процессорное время своего потока: по стенным часам растягивалось бы и вытеснение процесса системой.
function stretch(startedAt: number, factor: number): void {
  if (factor === 1) {
    return;
  }
  const until = startedAt + (threadCpuMicros() - startedAt) * factor;
  while (threadCpuMicros() < until) {
    // ожидание занятостью: процесс должен быть занят, как на медленной машине, а не спать
  }
}

// Серверный бот: соединение без сети вокруг бота толпы. Редкие сообщения игра пишет байтами, как в сокет, снимки —
// объектом вместе с общим полем игры. Мозг разбирает ящик и решает вне тика, когда дойдёт очередь, а команды отдаёт
// игре на тике, когда они дошли бы по сети.
export class ServerBot implements FfaConnection {
  private inbox: (Uint8Array | Delivery)[] = [];
  private pending: PendingInput[] = [];
  private tick = 0;
  // С какого тика у бота лежит снимок без решения.
  private undecidedSinceTick = 0;

  constructor(
    private readonly bot: CrowdBot,
    readonly level: CrowdLevel,
    private readonly slowdown: number,
  ) {}

  get hasUndecided(): boolean {
    return this.bot.hasUndecided;
  }

  // Сколько тиков бот ждёт решения: 0 — снимок пришёл на этом тике.
  get waitTicks(): number {
    return this.tick - this.undecidedSinceTick;
  }

  send(bytes: Uint8Array): void {
    this.inbox.push(bytes);
  }

  deliver(message: FfaSnapshotMessage, frame: Frame): void {
    this.inbox.push({ message, frame });
  }

  close(): void {
    this.inbox = [];
    this.pending = [];
    this.bot.disconnect();
  }

  absorb(tick: number): void {
    const startedAt = this.startStretch();
    this.tick = tick;
    const inbox = this.inbox;
    this.inbox = [];
    for (const item of inbox) {
      if (item instanceof Uint8Array) {
        this.bot.receive(decode(item) as ServerMessage);
        continue;
      }
      if (!this.bot.hasUndecided) {
        this.undecidedSinceTick = tick;
      }
      this.bot.absorb(item.message, item.frame);
    }
    stretch(startedAt, this.slowdown);
  }

  decide(paths: PathAllowance): void {
    const startedAt = this.startStretch();
    this.queue(this.bot.decide(paths));
    stretch(startedAt, this.slowdown);
  }

  private startStretch(): number {
    return this.slowdown === 1 ? 0 : threadCpuMicros();
  }

  skip(): void {
    this.queue(this.bot.repeat());
  }

  takeDue(tick: number): DueInput[] {
    const due = this.pending.filter((input) => input.dueTick <= tick);
    this.pending = this.pending.filter((input) => input.dueTick > tick);
    return due;
  }

  // Оси округляются, как в кодеке сокета: журнал боя пишет и прогоняет команды округлёнными.
  private queue(input: InputMessage | null): void {
    if (input === null) {
      return;
    }
    this.pending.push({ dueTick: this.tick + INPUT_DELAY_TICKS, seq: input.seq, action: quantizeAction(input.action) });
  }
}
