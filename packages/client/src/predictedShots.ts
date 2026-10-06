// Свой снаряд, рождённый предсказанием, получает номер от команды выстрела в диапазоне, куда номера сервера
// не доходят: номер не меняется от снимка к снимку до подтверждения.
export const PREDICTED_BULLET_ID_BASE = 2 ** 30;

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
// раньше подтверждения, тоже получает пару с номером сервера.
export class PredictedShots {
  private readonly ids = new Set<number>();

  note(bullets: Iterable<{ id: number }>): void {
    for (const bullet of bullets) {
      if (isPredictedBullet(bullet.id)) {
        this.ids.add(bullet.id);
      }
    }
  }

  // Пары по снимку; подтверждённые номера предсказания забываются.
  confirm(predictedNow: ReadonlySet<number>, ackSeq: number, bornOwn: readonly number[]): ConfirmedBullet[] {
    const pairs = pairConfirmedBullets([...this.ids], predictedNow, ackSeq, bornOwn);
    for (const id of this.ids) {
      if (isShotAcked(id, ackSeq)) {
        this.ids.delete(id);
      }
    }
    return pairs;
  }

  clear(): void {
    this.ids.clear();
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
