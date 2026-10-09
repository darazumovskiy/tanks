import { deriveStats, DT, STAT_MAX } from '@tanks/shared/engine';

// Сыгранный выстрел, команду которого сервер подтвердил без выстрела, ждёт столько тиков: раньше перезарядки самого
// быстрого орудия танк второй раз не выстрелит, и выстрел, найденный за это время, — тот же.
const SAME_SHOT_TICKS = Math.round(deriveStats({ armor: 0, engine: 0, gun: 0, reload: STAT_MAX }).reloadTime / DT);

function ascending(a: ShownShot, b: ShownShot): number {
  return a.seq - b.seq;
}

function isCloser(candidate: ShownShot, best: ShownShot, seq: number, tick: number): boolean {
  const bySeq = Math.abs(candidate.seq - seq) - Math.abs(best.seq - seq);
  if (bySeq !== 0) {
    return bySeq < 0;
  }
  return Math.abs(candidate.tick - tick) < Math.abs(best.tick - tick);
}

// Выстрел своего танка в шаге досчёта: событие выстрела и тик после шага.
export interface DueShot<E> {
  event: E;
  tick: number;
}

// played — выстрелы, сыгранные в кадре; confirmed — выстрелы снимков, уже сыгранные по предсказанию; unconfirmed —
// сыгранные, которых сервер так и не сделал.
export interface OwnShotCounts {
  played: number;
  confirmed: number;
  unconfirmed: number;
}

// Номер команды выстрела и тик досчёта, в котором он родился.
interface ShownShot {
  seq: number;
  tick: number;
}

// Свой выстрел по предсказанию: вспышка у дула, отдача и звук играются в кадр, где досчёт родил свой снаряд, а снимок
// их не повторяет. Выстрел играется один раз, как бы часто переигрывание ни переносило его с команды на команду.
// Показанную вспышку не отменить: выстрел, которого сервер не сделал, остаётся неподтверждённым.
export class OwnShots<E> {
  // Сыгранные или ждущие кадра выстрелы, ещё не сверенные со снимком, по возрастанию команд; среди них — сыгранные,
  // команду которых сервер подтвердил без выстрела, пока они ждут.
  private shown: ShownShot[] = [];
  // Команды, выстрел которых есть в досчёте сейчас.
  private firing = new Set<number>();
  // Команды, чей выстрел снимок уже принёс раньше подтверждения команды: сервер стреляет и повтором прошлой команды,
  // пока новая не пришла.
  private readonly matched = new Set<number>();
  private readonly due = new Map<number, DueShot<E>>();
  private readonly tally: OwnShotCounts = { played: 0, confirmed: 0, unconfirmed: 0 };

  get counts(): OwnShotCounts {
    return { ...this.tally };
  }

  // Шаг ввода команды seq; shot — выстрел своего танка в нём.
  fired(seq: number, shot: DueShot<E> | null): void {
    if (shot === null) {
      return;
    }
    this.firing.add(seq);
    this.place(seq, shot);
  }

  // Переигрывание команд в ожидании; shots — выстрелы своего танка в нём по номерам команд.
  replayed(shots: ReadonlyMap<number, DueShot<E>>): void {
    this.firing = new Set(shots.keys());
    for (const [seq, shot] of [...shots.entries()].sort(([a], [b]) => a - b)) {
      this.place(seq, shot);
    }
  }

  // Снимок тика tick с подтверждённой командой ackSeq и выстрелами своего танка serverShots: каждый забирает
  // несверенный выстрел, ближайший к подтверждённой команде, — снимок его не играет. Сыгранный выстрел подтверждённой
  // команды без выстрела сервера ждёт, потом — неподтверждённый; не дошедший до кадра — не играется. Свой танк не на
  // поле — несверенные больше не подтвердятся. Возвращает выстрелы снимка, уже сыгранные.
  settle(ackSeq: number, tick: number, serverShots: readonly E[], isOnField: boolean): Set<E> {
    const confirmed = new Set<E>();
    for (const shot of serverShots) {
      const nearest = this.nearestTo(ackSeq, tick);
      if (nearest === null) {
        break;
      }
      this.shown = this.shown.filter((candidate) => candidate !== nearest);
      confirmed.add(shot);
      this.tally.confirmed++;
      if (nearest.seq > ackSeq) {
        this.matched.add(nearest.seq);
      }
    }
    if (!isOnField) {
      this.forgetShown();
      return confirmed;
    }
    for (const shown of this.shown.filter((candidate) => candidate.seq <= ackSeq)) {
      const isUndrawn = this.due.delete(shown.seq);
      const isExpired = tick - shown.tick >= SAME_SHOT_TICKS;
      if (isUndrawn || isExpired) {
        this.shown = this.shown.filter((candidate) => candidate !== shown);
      }
      if (!isUndrawn && isExpired) {
        this.tally.unconfirmed++;
      }
    }
    this.firing = new Set([...this.firing].filter((seq) => seq > ackSeq));
    for (const seq of this.matched) {
      if (seq <= ackSeq) {
        this.matched.delete(seq);
      }
    }
    return confirmed;
  }

  takeDue(): DueShot<E>[] {
    const due = [...this.due.entries()].sort(([a], [b]) => a - b).map(([, shot]) => shot);
    this.due.clear();
    this.tally.played += due.length;
    return due;
  }

  // Кадры стояли (вкладка скрыта): выстрелы, не дошедшие до кадра, не играются — и их выстрелы в снимках тоже.
  discardDue(): void {
    this.due.clear();
  }

  // Новое соединение: номера команд снова с единицы.
  clear(): void {
    this.shown = [];
    this.firing.clear();
    this.matched.clear();
    this.due.clear();
  }

  private forgetShown(): void {
    for (const shown of this.shown) {
      if (!this.due.delete(shown.seq)) {
        this.tally.unconfirmed++;
      }
    }
    this.clear();
  }

  // Ближайший к команде seq; при равной близости — с тиком выстрела ближе к tick, при равенстве и его — более ранний.
  private nearestTo(seq: number, tick: number): ShownShot | null {
    let best: ShownShot | null = null;
    for (const candidate of this.shown) {
      if (best === null || isCloser(candidate, best, seq, tick)) {
        best = candidate;
      }
    }
    return best;
  }

  // Новый выстрел досчёта: сыгранный выстрел, которого досчёт больше не видит и который родился в пределах
  // перезарядки от нового, отдаёт ему отметку — сервер иначе посчитал перезарядку, вспышка та же; иначе выстрел ждёт
  // кадра.
  private place(seq: number, shot: DueShot<E>): void {
    const known = this.shown.find((candidate) => candidate.seq === seq);
    if (known !== undefined) {
      known.tick = shot.tick;
      return;
    }
    if (this.matched.has(seq)) {
      return;
    }
    const gone = this.shown.find(
      (candidate) => !this.firing.has(candidate.seq) && Math.abs(candidate.tick - shot.tick) < SAME_SHOT_TICKS,
    );
    if (gone === undefined) {
      this.shown = [...this.shown, { seq, tick: shot.tick }].sort(ascending);
      this.due.set(seq, shot);
      return;
    }
    this.shown = this.shown.map((candidate) => (candidate === gone ? { seq, tick: shot.tick } : candidate));
    this.shown.sort(ascending);
    if (this.due.delete(gone.seq)) {
      this.due.set(seq, shot);
    }
  }
}
