import { IDLE_ACTION, TICK_RATE, type Action } from '@tanks/shared/engine';
import type { DropReason } from './metrics.js';

// Клиент замолчал (ушёл в фон, завис) — его танк не должен ехать и стрелять по последней команде вечно.
export const INPUT_TIMEOUT_TICKS = 15;
// Команда ждёт своего тика не дольше 100 мс: пары и тройки, которыми сеть телефона склеивает команды, умещаются,
// а после паузы в сотни миллисекунд ждать всю пачку дороже, чем потерять её начало.
export const INPUT_QUEUE_LIMIT = 3;
// Одна команда в очереди после применения — обычный запас против дрожания сети: тик задержки на сервере, который
// предсказание скрывает. Очередь, которая столько тиков не опускалась ниже INPUT_BACKLOG_MIN, держит стойкий запас:
// без слива поздняя пачка навсегда добавила бы тики задержки.
export const INPUT_BACKLOG_TICKS = TICK_RATE;
export const INPUT_BACKLOG_MIN = 2;

interface QueuedInput {
  seq: number;
  action: Action;
}

export interface InputDrop {
  reason: DropReason;
  seq: number;
}

// Поток команд одного игрока: принятые ждут в очереди и применяются по одной за тик — столько же шагов, сколько
// предсказал клиент; применённая подтверждается в снимке (ackSeq). backlogSinceTick — с какого тика очередь после
// применения не опускалась ниже INPUT_BACKLOG_MIN. lastAction — действие самой команды, без перенесённого выстрела.
export interface InputChannel {
  lastSeq: number;
  lastInputTick: number;
  ackSeq: number;
  queue: QueuedInput[];
  backlogSinceTick: number;
  hasCarriedFire: boolean;
  lastAction: Action;
  inputsThisSecond: number;
  inputsThisTick: number;
}

export function createInputChannel(tick: number): InputChannel {
  return {
    lastSeq: 0,
    lastInputTick: 0,
    ackSeq: 0,
    queue: [],
    backlogSinceTick: tick,
    hasCarriedFire: false,
    lastAction: { ...IDLE_ACTION },
    inputsThisSecond: 0,
    inputsThisTick: 0,
  };
}

// Выброшенные команды — самые старые; их выстрел достаётся следующей, иначе короткое нажатие огня пропало бы.
function dropOldest(channel: InputChannel, count: number, reason: DropReason): InputDrop[] {
  const dropped = channel.queue.splice(0, Math.max(0, count));
  if (dropped.some((input) => input.action.isFiring)) {
    channel.hasCarriedFire = true;
  }
  return dropped.map((input) => ({ reason, seq: input.seq }));
}

export function offerInput(
  channel: InputChannel,
  seq: number,
  action: Action,
  tick: number,
  maxPerSecond: number,
): InputDrop[] {
  channel.inputsThisSecond++;
  if (seq <= channel.lastSeq) {
    return [{ reason: 'stale', seq }];
  }
  if (channel.inputsThisSecond > maxPerSecond) {
    return [{ reason: 'limit', seq }];
  }
  channel.lastSeq = seq;
  channel.lastInputTick = tick;
  channel.inputsThisTick++;
  channel.queue.push({ seq, action });
  const drops = dropOldest(channel, channel.queue.length - INPUT_QUEUE_LIMIT, 'overflow');
  const hasStandingBacklog =
    channel.queue.length > INPUT_BACKLOG_MIN && tick - channel.backlogSinceTick > INPUT_BACKLOG_TICKS;
  if (!hasStandingBacklog) {
    return drops;
  }
  channel.backlogSinceTick = tick;
  return [...drops, ...dropOldest(channel, 1, 'backlog')];
}

export function isSilent(channel: InputChannel, tick: number): boolean {
  return tick - channel.lastInputTick > INPUT_TIMEOUT_TICKS;
}

// Команда на этот тик: самая старая из очереди становится текущей и подтверждается; молчащий клиент стоит.
// Перенесённый выстрел стреляет только в тике своей команды и не повторяется, если следующая опоздает.
export function takeAction(channel: InputChannel, tick: number): Action {
  const next = channel.queue.shift();
  const isFireCarried = next !== undefined && channel.hasCarriedFire;
  if (next !== undefined) {
    channel.lastAction = next.action;
    channel.hasCarriedFire = false;
    channel.ackSeq = next.seq;
  }
  if (channel.queue.length < INPUT_BACKLOG_MIN) {
    channel.backlogSinceTick = tick;
  }
  if (isSilent(channel, tick)) {
    return IDLE_ACTION;
  }
  return isFireCarried ? { ...channel.lastAction, isFiring: true } : channel.lastAction;
}

export function clearInput(channel: InputChannel, tick: number): void {
  channel.queue = [];
  channel.backlogSinceTick = tick;
  channel.hasCarriedFire = false;
  channel.lastAction = { ...IDLE_ACTION };
}
