import { IDLE_ACTION, TICK_RATE, type Action } from '@tanks/shared/engine';
import type { DropReason } from './metrics.js';

// Клиент замолчал (ушёл в фон, завис) — его танк не должен ехать и стрелять по последней команде вечно.
export const INPUT_TIMEOUT_TICKS = 15;
// Команда ждёт своего тика не дольше 100 мс: пары и тройки, которыми сеть телефона склеивает команды, умещаются,
// а после паузы в сотни миллисекунд ждать всю пачку дороже, чем потерять её начало.
export const INPUT_QUEUE_LIMIT = 3;
// Сглаживание дёрганой сети: пока команды приходят пачками, очередь держит пачку после паузы 200 мс целиком.
// Пачка — больше команд в одном тике, чем очередь из трёх принимает с пустого места; без пачек столько тиков —
// сеть снова ровная.
export const INPUT_QUEUE_BURST_LIMIT = 6;
export const INPUT_BURST_SIZE = INPUT_QUEUE_LIMIT + 1;
export const INPUT_BURST_CALM_TICKS = 2 * TICK_RATE;
// Одна команда в очереди после применения — обычный запас против дрожания сети: тик задержки на сервере, который
// предсказание скрывает. Очередь, которая столько тиков не опускалась ниже INPUT_BACKLOG_MIN, держит стойкий запас:
// без слива поздняя пачка навсегда добавила бы тики задержки.
export const INPUT_BACKLOG_TICKS = TICK_RATE;
export const INPUT_BACKLOG_MIN = 2;
// Запас, который столько тиков после каждого применения оставался в очереди и ни разу не понадобился (тика без
// команды не было), сети не нужен: снимок просит клиента пропустить шаг ввода — без потери команд.
export const INPUT_SPARE_TICKS = TICK_RATE;
// Повтор прошлой команды при пустой очереди — столько тиков подряд это дрожание сети: опоздавшая команда встанет в
// запас очереди и исполнится в свой шаг со своим выстрелом. Дальше — пауза связи: повторы засчитываются за команды,
// которые придут потом пачкой.
export const INPUT_JITTER_REPEATS = 1;

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
// применения не опускалась ниже INPUT_BACKLOG_MIN; spareSinceTick — с какого тика после каждого применения в очереди
// оставалась команда. lastAction — действие самой команды, без перенесённого выстрела; hasClientAction — lastAction
// пришла от клиента, а не сброшена в покой новым каналом или раундом. repeatTicks — сколько тиков подряд повторялась
// lastAction; owedSteps — повторы, засчитанные за команды, которые ещё не пришли: ackSeq обгоняет lastSeq на столько же.
// isAdaptive — сглаживание дёрганой сети: queueLimit растёт на пачках; arrivalTick и arrivalsAtTick — сколько команд
// пришло в тике arrivalTick, burstTick — тик последней пачки.
export interface InputChannel {
  lastSeq: number;
  lastInputTick: number;
  ackSeq: number;
  queue: QueuedInput[];
  backlogSinceTick: number;
  spareSinceTick: number;
  hasCarriedFire: boolean;
  lastAction: Action;
  hasClientAction: boolean;
  repeatTicks: number;
  owedSteps: number;
  inputsThisSecond: number;
  inputsThisTick: number;
  isAdaptive: boolean;
  queueLimit: number;
  arrivalTick: number;
  arrivalsAtTick: number;
  burstTick: number;
}

export function createInputChannel(tick: number, isAdaptive: boolean): InputChannel {
  return {
    lastSeq: 0,
    lastInputTick: 0,
    ackSeq: 0,
    queue: [],
    backlogSinceTick: tick,
    spareSinceTick: tick,
    hasCarriedFire: false,
    lastAction: { ...IDLE_ACTION },
    hasClientAction: false,
    repeatTicks: 0,
    owedSteps: 0,
    inputsThisSecond: 0,
    inputsThisTick: 0,
    isAdaptive,
    queueLimit: INPUT_QUEUE_LIMIT,
    arrivalTick: tick,
    arrivalsAtTick: 0,
    burstTick: tick,
  };
}

// Пачка поднимает предел до того, как её команды проверены на переполнение. Предел опускается, только когда очередь
// вместе с новой командой в него помещается: длинную очередь укорачивают слив и пропуск шага, а не выброс разом.
function adaptQueueLimit(channel: InputChannel, tick: number): void {
  if (!channel.isAdaptive) {
    return;
  }
  channel.arrivalsAtTick = channel.arrivalTick === tick ? channel.arrivalsAtTick + 1 : 1;
  channel.arrivalTick = tick;
  if (channel.arrivalsAtTick >= INPUT_BURST_SIZE) {
    channel.queueLimit = INPUT_QUEUE_BURST_LIMIT;
    channel.burstTick = tick;
    return;
  }
  const isCalm = tick - channel.burstTick > INPUT_BURST_CALM_TICKS;
  if (isCalm && channel.queue.length < INPUT_QUEUE_LIMIT) {
    channel.queueLimit = INPUT_QUEUE_LIMIT;
  }
}

// Выброшенные команды — самые старые; их выстрел достаётся следующей, иначе короткое нажатие огня пропало бы.
function dropOldest(channel: InputChannel, count: number, reason: DropReason): InputDrop[] {
  const dropped = channel.queue.splice(0, Math.max(0, count));
  if (dropped.some((input) => input.action.isFiring)) {
    channel.hasCarriedFire = true;
  }
  return dropped.map((input) => ({ reason, seq: input.seq }));
}

// Пришла команда, за которую сервер уже шагнул повтором и которую подтвердил. Её действие повторяется дальше,
// выстрел достаётся следующему шагу.
function settleOwedStep(channel: InputChannel, action: Action): InputDrop {
  channel.owedSteps--;
  channel.lastAction = action;
  if (action.isFiring) {
    channel.hasCarriedFire = true;
  }
  return { reason: 'owed', seq: channel.lastSeq };
}

// Повторы, за которыми команды так и не пришли, больше не засчитываются: подтверждение возвращается к последней
// пришедшей.
function forgiveOwedSteps(channel: InputChannel): void {
  channel.ackSeq -= channel.owedSteps;
  channel.owedSteps = 0;
  channel.repeatTicks = 0;
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
  adaptQueueLimit(channel, tick);
  if (channel.owedSteps > 0) {
    return [settleOwedStep(channel, action)];
  }
  channel.queue.push({ seq, action });
  const drops = dropOldest(channel, channel.queue.length - channel.queueLimit, 'overflow');
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

// Команда на этот тик: самая старая из очереди становится текущей и подтверждается. Без неё повторяется прошлая;
// повтор дольше INPUT_JITTER_REPEATS засчитывается за следующую команду: снимок подтверждает её номер заранее, иначе
// предсказание клиента переиграло бы её поверх уже сделанного шага и убежало вперёд. Засчитывается только повтор
// команды клиента: покой после сброса — ожидание первой команды, а не догадка о ней. Молчащий клиент стоит, и
// засчитанное прощается: столько не слал команд — в фоне, погиб, завис — значит, и не предсказывал их. Перенесённый
// выстрел стреляет один раз, в следующем шаге: выброшенная из очереди команда передаёт его следующей в очереди,
// засчитанная за повтор — следующему шагу, даже если это снова повтор.
export function takeAction(channel: InputChannel, tick: number): Action {
  const next = channel.queue.shift();
  if (next !== undefined) {
    channel.lastAction = next.action;
    channel.hasClientAction = true;
    channel.ackSeq = next.seq;
    channel.repeatTicks = 0;
  }
  if (channel.queue.length < INPUT_BACKLOG_MIN) {
    channel.backlogSinceTick = tick;
  }
  if (channel.queue.length === 0) {
    channel.spareSinceTick = tick;
  }
  if (isSilent(channel, tick)) {
    forgiveOwedSteps(channel);
    return IDLE_ACTION;
  }
  const hasRepeated = next === undefined && channel.hasClientAction;
  if (hasRepeated) {
    channel.repeatTicks++;
  }
  const isOwed = hasRepeated && channel.repeatTicks > INPUT_JITTER_REPEATS;
  if (isOwed) {
    channel.owedSteps++;
    channel.ackSeq++;
  }
  if (!channel.hasCarriedFire) {
    return channel.lastAction;
  }
  channel.hasCarriedFire = false;
  return { ...channel.lastAction, isFiring: true };
}

export function hasSpareInput(channel: InputChannel, tick: number): boolean {
  return tick - channel.spareSinceTick >= INPUT_SPARE_TICKS;
}

export function clearInput(channel: InputChannel, tick: number): void {
  channel.queue = [];
  channel.backlogSinceTick = tick;
  channel.spareSinceTick = tick;
  channel.hasCarriedFire = false;
  channel.lastAction = { ...IDLE_ACTION };
  channel.hasClientAction = false;
  forgiveOwedSteps(channel);
}
