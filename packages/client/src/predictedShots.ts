// Свой снаряд, рождённый предсказанием, получает номер от команды выстрела в диапазоне, куда номера сервера
// не доходят: номер не меняется от снимка к снимку до подтверждения.
export const PREDICTED_BULLET_ID_BASE = 2 ** 30;
// Сервер подтверждает команду повтором в паузе связи, пока клиент молчит не дольше полсекунды; снаряд сервера
// рождается в шаге после того, как команда дошла. Дольше снаряд предсказания пару не ждёт.
export const UNPAIRED_SHOT_TICKS = 20;

export interface ConfirmedBullet {
  predictedId: number;
  serverId: number;
}

export function predictedBulletId(seq: number): number {
  return PREDICTED_BULLET_ID_BASE + seq;
}

export function isPredictedBullet(id: number): boolean {
  return id >= PREDICTED_BULLET_ID_BASE;
}

// Команда выстрела подтверждена сервером: снаряд предсказания больше не переигрывается.
export function isShotAcked(id: number, ackSeq: number): boolean {
  return id - PREDICTED_BULLET_ID_BASE <= ackSeq;
}

// Свои снаряды предсказания до подтверждения команды выстрела — и погибшие в досчёте: снаряд, погасший о врага
// раньше подтверждения, тоже получает пару с номером сервера. Подтверждённый без снаряда сервера (повтор в паузе
// связи подтвердил команду раньше, чем она дошла) летит дальше сам из своего места в тике снимка, пока снаряд
// сервера не родится, — иначе он пропал бы и появился заново позади.
export class PredictedShots<B extends { id: number }> {
  private readonly ids = new Set<number>();
  private readonly states = new Map<number, Map<number, B>>();
  private readonly ackedAt = new Map<number, number>();

  note(bullets: Iterable<B>, tick: number): void {
    for (const bullet of bullets) {
      if (!isPredictedBullet(bullet.id)) {
        continue;
      }
      this.ids.add(bullet.id);
      const byTick = this.states.get(bullet.id) ?? new Map<number, B>();
      byTick.set(tick, { ...bullet });
      this.states.set(bullet.id, byTick);
    }
  }

  // Подтверждённые без пары — в тике снимка, до переигрывания. Первые bornCount по порядку номеров получат пару
  // со снарядами сервера, рождёнными в этом снимке; не дождавшиеся или погибшие в досчёте забываются.
  takeUnpaired(ackSeq: number, tick: number, bornCount: number, isOnField: boolean): B[] {
    const waiting = [...this.ids].filter((id) => isShotAcked(id, ackSeq)).sort((a, b) => a - b);
    const carried: B[] = [];
    for (const id of waiting.slice(bornCount)) {
      const ackTick = this.ackedAt.get(id) ?? tick;
      this.ackedAt.set(id, ackTick);
      const state = this.states.get(id)?.get(tick);
      if (isOnField && state !== undefined && tick - ackTick < UNPAIRED_SHOT_TICKS) {
        carried.push({ ...state });
      } else {
        this.forget(id);
      }
    }
    for (const byTick of this.states.values()) {
      for (const stateTick of byTick.keys()) {
        if (stateTick < tick) {
          byTick.delete(stateTick);
        }
      }
    }
    return carried;
  }

  // Пары по снимку; подтверждённые номера, которых нет в предсказании, забываются.
  confirm(predictedNow: ReadonlySet<number>, ackSeq: number, bornOwn: readonly number[]): ConfirmedBullet[] {
    const pairs = pairConfirmedBullets([...this.ids], predictedNow, ackSeq, bornOwn);
    for (const id of this.ids) {
      if (isShotAcked(id, ackSeq) && !predictedNow.has(id)) {
        this.forget(id);
      }
    }
    return pairs;
  }

  clear(): void {
    this.ids.clear();
    this.states.clear();
    this.ackedAt.clear();
  }

  private forget(id: number): void {
    this.ids.delete(id);
    this.states.delete(id);
    this.ackedAt.delete(id);
  }
}

// Подтверждённый выстрел: снаряд предсказания с командой не новее подтверждённой пропал, а у сервера родился свой
// снаряд — пары по порядку номеров.
export function pairConfirmedBullets(
  predictedBefore: readonly number[],
  predictedNow: ReadonlySet<number>,
  ackSeq: number,
  bornOwn: readonly number[],
): ConfirmedBullet[] {
  const gone = predictedBefore.filter((id) => !predictedNow.has(id) && isShotAcked(id, ackSeq)).sort((a, b) => a - b);
  const born = [...bornOwn].sort((a, b) => a - b);
  const pairs: ConfirmedBullet[] = [];
  for (let index = 0; index < Math.min(gone.length, born.length); index++) {
    pairs.push({ predictedId: gone[index] ?? 0, serverId: born[index] ?? 0 });
  }
  return pairs;
}
