import { IDLE_ACTION, type Action } from '@tanks/shared/engine';
import type { DropReason } from './metrics.js';

// Клиент замолчал (ушёл в фон, завис) — его танк не должен ехать и стрелять по последней команде вечно.
export const INPUT_TIMEOUT_TICKS = 15;

// Поток команд одного игрока: последняя принятая ждёт тика, применённая подтверждается в снимке (ackSeq).
export interface InputChannel {
  lastSeq: number;
  lastInputTick: number;
  ackSeq: number;
  pending: { seq: number; action: Action } | null;
  lastAction: Action;
  inputsThisSecond: number;
  inputsThisTick: number;
}

export function createInputChannel(): InputChannel {
  return {
    lastSeq: 0,
    lastInputTick: 0,
    ackSeq: 0,
    pending: null,
    lastAction: { ...IDLE_ACTION },
    inputsThisSecond: 0,
    inputsThisTick: 0,
  };
}

// Новое пересиливает старое: за тик применяется последняя пришедшая команда, остальные теряются.
export function offerInput(
  channel: InputChannel,
  seq: number,
  action: Action,
  tick: number,
  maxPerSecond: number,
): DropReason | null {
  channel.inputsThisSecond++;
  if (seq <= channel.lastSeq) {
    return 'stale';
  }
  if (channel.inputsThisSecond > maxPerSecond) {
    return 'limit';
  }
  channel.lastSeq = seq;
  channel.lastInputTick = tick;
  channel.inputsThisTick++;
  channel.pending = { seq, action };
  return null;
}

export function isSilent(channel: InputChannel, tick: number): boolean {
  return tick - channel.lastInputTick > INPUT_TIMEOUT_TICKS;
}

// Команда на этот тик: пришедшая становится текущей и подтверждается; молчащий клиент стоит.
export function takeAction(channel: InputChannel, tick: number): Action {
  if (channel.pending !== null) {
    channel.lastAction = channel.pending.action;
    channel.ackSeq = channel.pending.seq;
    channel.pending = null;
  }
  return isSilent(channel, tick) ? IDLE_ACTION : channel.lastAction;
}

export function clearInput(channel: InputChannel): void {
  channel.pending = null;
  channel.lastAction = { ...IDLE_ACTION };
}
