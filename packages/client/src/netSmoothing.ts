import { DT, normalizeAngle, type Point } from '@tanks/shared/engine';
import { drawnNearOwn, type PictureBullet, type PictureClock } from './pictureTime.js';

// Отставание чужих: на ровной сети — как без сглаживания; предел — пауза между пачками ночной сети до 250 мс
// (7,5 тика) плюс тик до следующего снимка. Запас — на дрожание таймеров.
export const INTERPOLATION_MIN_TICKS = 2;
export const INTERPOLATION_MAX_TICKS = 9;
export const INTERPOLATION_MARGIN_TICKS = 0.25;
// Неровность меряется по снимкам за это время.
export const JITTER_WINDOW_MS = 2000;
// Время чужих идёт со скоростью настоящего ± эта доля, пока догоняет нужное; расхождение в RESPONSE тиков — скорость
// уже на пределе. Расхождение больше SNAP — время переставляется сразу. Отстало от последнего снимка больше чем
// на MAX_BEHIND (пауза снимков дольше замеренной) — тоже сразу: события о чужих ждут картинку не дольше
// EVENT_MAX_WAIT_MS, и медленный догон их бы выбросил.
export const PLAYOUT_RATE_SHIFT = 0.2;
const PLAYOUT_RESPONSE_TICKS = 3;
export const PLAYOUT_SNAP_TICKS = 30;
export const PLAYOUT_MAX_BEHIND_TICKS = INTERPOLATION_MAX_TICKS + 2;
// Нарисованный свой танк догоняет предсказание за это время; поправка дальше SNAP — перестановка (возрождение),
// рисуется сразу. Поправка меньше EPSILON — совпадение предсказания с сервером, отсчёт догона не начинается заново.
export const OWN_SMOOTHING_MS = 120;
export const OWN_SNAP_DISTANCE = 120;
const OWN_SHIFT_EPSILON = 0.01;
const TICK_MS = DT * 1000;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

interface Arrival {
  receivedAt: number;
  offsetMs: number;
}

// Неровность прихода снимков. Смещение снимка — время прихода минус тик игры в мс: у снимков ровной сети оно одно,
// у пачки — тем больше, чем дольше снимок ждал. Самое раннее смещение окна — снимок, который не ждал; опоздание
// остальных считается от него. Отставание чужих — столько тиков, чтобы самый опоздавший снимок приходил раньше,
// чем картинка до него дойдёт.
export class SnapshotJitter {
  private arrivals: Arrival[] = [];
  private earliestMs: number | null = null;
  private latenessMs = 0;

  note(gameTick: number, receivedAt: number): void {
    this.arrivals.push({ receivedAt, offsetMs: receivedAt - gameTick * TICK_MS });
    this.arrivals = this.arrivals.filter((arrival) => receivedAt - arrival.receivedAt <= JITTER_WINDOW_MS);
    const offsets = this.arrivals.map((arrival) => arrival.offsetMs);
    const earliest = Math.min(...offsets);
    this.earliestMs = earliest;
    this.latenessMs = Math.max(...offsets) - earliest;
  }

  // Когда пришёл бы снимок тика игры 0 без ожидания; null — снимков не было.
  get earliestOffsetMs(): number | null {
    return this.earliestMs;
  }

  get delayTicks(): number {
    const needed = 1 + this.latenessMs / TICK_MS + INTERPOLATION_MARGIN_TICKS;
    return clamp(needed, INTERPOLATION_MIN_TICKS, INTERPOLATION_MAX_TICKS);
  }

  reset(): void {
    this.arrivals = [];
    this.earliestMs = null;
    this.latenessMs = 0;
  }
}

// Время картинки чужих — дробный тик игры. Идёт со скоростью настоящего, поправленной к нужному не больше чем на
// PLAYOUT_RATE_SHIFT: смена отставания не даёт рывков. Дальше последнего пришедшего снимка не уходит — опоздавший
// снимок картинка ждёт, а потом догоняет: в пределах PLAYOUT_MAX_BEHIND_TICKS плавно, дальше — сразу до нужного.
export class PlayoutClock {
  private tick: number | null = null;
  private at = 0;

  advance(now: number, target: number, latestTick: number): number {
    const previous = this.tick;
    let tick: number;
    if (previous === null || Math.abs(target - previous) > PLAYOUT_SNAP_TICKS) {
      tick = Math.min(target, latestTick);
    } else {
      const elapsed = Math.max(0, now - this.at) / TICK_MS;
      const error = target - (previous + elapsed);
      const shift = clamp(error / PLAYOUT_RESPONSE_TICKS, -PLAYOUT_RATE_SHIFT, PLAYOUT_RATE_SHIFT);
      tick = Math.max(previous, Math.min(latestTick, previous + elapsed * (1 + shift)));
    }
    if (latestTick - tick > PLAYOUT_MAX_BEHIND_TICKS) {
      tick = Math.max(tick, Math.min(target, latestTick));
    }
    this.tick = tick;
    this.at = now;
    return tick;
  }

  reset(): void {
    this.tick = null;
  }
}

// Отставание чужих под неровность снимков: замер и время картинки вместе.
export class OthersTiming {
  private readonly jitter = new SnapshotJitter();
  private readonly clock = new PlayoutClock();

  note(gameTick: number, receivedAt: number): void {
    this.jitter.note(gameTick, receivedAt);
  }

  get delayTicks(): number {
    return this.jitter.delayTicks;
  }

  // Тик игры, в котором рисуются чужие; снимков не было — тик последнего снимка.
  gameTickAt(now: number, latestGameTick: number): number {
    const earliest = this.jitter.earliestOffsetMs;
    if (earliest === null) {
      return latestGameTick;
    }
    const target = (now - earliest) / TICK_MS - this.jitter.delayTicks;
    return this.clock.advance(now, target, latestGameTick);
  }

  reset(): void {
    this.jitter.reset();
    this.clock.reset();
  }
}

export interface Bracket<T> {
  older: T;
  newer: T;
  t: number;
}

// Два соседних по тику снимка вокруг тика и доля между ними; раньше первого — первый, позже последнего — последний.
export function bracketByTick<T>(items: readonly T[], tickOf: (item: T) => number, tick: number): Bracket<T> | null {
  let older: T | null = null;
  for (const item of items) {
    if (tickOf(item) > tick) {
      if (older === null) {
        return { older: item, newer: item, t: 1 };
      }
      const from = tickOf(older);
      return { older, newer: item, t: (tick - from) / (tickOf(item) - from) };
    }
    older = item;
  }
  return older === null ? null : { older, newer: older, t: 1 };
}

export interface Pose extends Point {
  heading: number;
  turret: number;
}

export const NO_SHIFT: Readonly<Pose> = { x: 0, y: 0, heading: 0, turret: 0 };

// Смещение нарисованного своего танка от предсказанного: поправка снимка добавляется к нему, и в миг снимка танк
// нарисован там же, где был; дальше смещение равномерно сходит к нулю за OWN_SMOOTHING_MS от последней поправки.
export class OwnSmoothing {
  private shift: Pose = { ...NO_SHIFT };
  private since = 0;

  // before и after — свой танк предсказания до снимка и после переигрывания; null — танка нет на поле.
  correct(before: Pose | null, after: Pose | null, now: number): void {
    if (before === null || after === null) {
      this.reset();
      return;
    }
    const delta: Pose = {
      x: before.x - after.x,
      y: before.y - after.y,
      heading: normalizeAngle(before.heading - after.heading),
      turret: normalizeAngle(before.turret - after.turret),
    };
    const isCorrected =
      Math.hypot(delta.x, delta.y) > OWN_SHIFT_EPSILON ||
      Math.abs(delta.heading) > OWN_SHIFT_EPSILON ||
      Math.abs(delta.turret) > OWN_SHIFT_EPSILON;
    if (!isCorrected) {
      return;
    }
    const current = this.at(now);
    const shift: Pose = {
      x: current.x + delta.x,
      y: current.y + delta.y,
      heading: normalizeAngle(current.heading + delta.heading),
      turret: normalizeAngle(current.turret + delta.turret),
    };
    if (Math.hypot(shift.x, shift.y) > OWN_SNAP_DISTANCE) {
      this.reset();
      return;
    }
    this.shift = shift;
    this.since = now;
  }

  at(now: number): Pose {
    const left = 1 - clamp((now - this.since) / OWN_SMOOTHING_MS, 0, 1);
    if (left === 0) {
      return { ...NO_SHIFT };
    }
    return {
      x: this.shift.x * left,
      y: this.shift.y * left,
      heading: this.shift.heading * left,
      turret: this.shift.turret * left,
    };
  }

  reset(): void {
    this.shift = { ...NO_SHIFT };
  }
}

// Снаряды у своего танка сдвинуты вместе с нарисованным танком: у своего танка картинка и предсказание расположены
// одинаково, у чужого снаряд не сдвигается.
export function shiftNearOwn(bullets: readonly PictureBullet[], clock: PictureClock): PictureBullet[] {
  return bullets.map((bullet) => drawnNearOwn(clock, bullet));
}
