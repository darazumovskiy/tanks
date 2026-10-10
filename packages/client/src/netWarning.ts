// Оценка связи для предупреждения игрока: у пинга и неровности — степень 0–3, из удержанных степеней — уровень
// предупреждения и текст. Время и замеры приходят параметрами.

export type NetDegree = 0 | 1 | 2 | 3;
export type NetWarningLevel = 0 | 1 | 2 | 3;

// Пинг, округлённый до целых мс, как в строке отладки: меньше первого порога — 0; до второго включительно — 1;
// до третьего включительно — 2; больше — 3. Для предупреждения пинг — медиана последних замеров: ответ, застрявший
// в паузе связи, её не сдвигает.
const NET_PING_DEGREE_MS = [80, 150, 250] as const;
// Неровность — повторившаяся пауза между снимками: самая длинная, какая за окно случилась хотя бы дважды. Паузы
// ближе SPACING друг к другу — один сбой: одиночный рывок и короткий всплеск пауз её не поднимают.
// От первого порога — 1, от второго — 2, от третьего — 3.
export const NET_PAUSE_WINDOW_MS = 5000;
const NET_PAUSE_SPACING_MS = 1000;
const NET_PAUSE_DEGREE_MS = [100, 180, 245] as const;
// Столько раздельных пауз от второго порога за окно — связь замирает чаще раза в 1,7 с: степень 3.
const NET_PAUSE_FREQUENT_COUNT = 4;
// Степень поднимается, продержавшись выше удержанной столько подряд, опускается — продержавшись ниже.
export const NET_WARNING_RISE_MS = 3000;
export const NET_WARNING_FALL_MS = 5000;

export const NET_WARNING_TEXT = {
  ping: 'Высокий пинг',
  jitter: 'Плохая сеть',
  both: 'Высокий пинг · плохая сеть',
} as const;

// pingMs — медиана последних замеров пинга, pauseMs — повторившаяся пауза.
export interface NetWarningState {
  level: NetWarningLevel;
  pingDegree: NetDegree;
  jitterDegree: NetDegree;
  text: string;
  pingMs: number;
  pauseMs: number;
}

export const NO_NET_WARNING: Readonly<NetWarningState> = {
  level: 0,
  pingDegree: 0,
  jitterDegree: 0,
  text: '',
  pingMs: 0,
  pauseMs: 0,
};

// Замеров нет — 0.
export function medianMs(samples: readonly number[]): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function pingDegree(rttMs: number): NetDegree {
  const shownMs = Math.round(rttMs);
  const [weakMs, strongMs, severeMs] = NET_PING_DEGREE_MS;
  if (shownMs < weakMs) {
    return 0;
  }
  if (shownMs <= strongMs) {
    return 1;
  }
  if (shownMs <= severeMs) {
    return 2;
  }
  return 3;
}

export interface PauseMeasure {
  repeatedMs: number;
  longCount: number;
}

export function pauseDegree(measure: PauseMeasure): NetDegree {
  const [weakMs, strongMs, severeMs] = NET_PAUSE_DEGREE_MS;
  if (measure.longCount >= NET_PAUSE_FREQUENT_COUNT || measure.repeatedMs >= severeMs) {
    return 3;
  }
  if (measure.repeatedMs >= strongMs) {
    return 2;
  }
  if (measure.repeatedMs >= weakMs) {
    return 1;
  }
  return 0;
}

export function warningLevel(ping: NetDegree, jitter: NetDegree): NetWarningLevel {
  const worst = Math.max(ping, jitter);
  const best = Math.min(ping, jitter);
  if (worst === 3 || best >= 2) {
    return 3;
  }
  if (worst === 2 || best === 1) {
    return 2;
  }
  if (worst === 1) {
    return 1;
  }
  return 0;
}

export function warningText(ping: NetDegree, jitter: NetDegree): string {
  const isPingBad = ping > 0;
  const isJitterBad = jitter > 0;
  if (isPingBad && isJitterBad) {
    return NET_WARNING_TEXT.both;
  }
  if (isPingBad) {
    return NET_WARNING_TEXT.ping;
  }
  if (isJitterBad) {
    return NET_WARNING_TEXT.jitter;
  }
  return '';
}

interface Pause {
  endedAt: number;
  ms: number;
}

// Раздельные паузы не короче порога: пауза ближе SPACING к прошлой засчитанной — тот же сбой.
function spacedCount(pauses: readonly Pause[], minMs: number): number {
  let count = 0;
  let countedAt: number | null = null;
  for (const pause of pauses) {
    const isSeparate = countedAt === null || pause.endedAt - countedAt >= NET_PAUSE_SPACING_MS;
    if (pause.ms >= minMs && isSeparate) {
      count++;
      countedAt = pause.endedAt;
    }
  }
  return count;
}

// Паузы между приходами снимков за окно. Первый снимок после сброса паузы не даёт: до него поток стоял по замыслу.
// Пауза, которая ещё идёт, не считается: полное молчание ловит обрыв связи.
export class SnapshotPauses {
  private pauses: Pause[] = [];
  private lastAt: number | null = null;

  note(receivedAt: number): void {
    if (this.lastAt !== null) {
      this.pauses.push({ endedAt: receivedAt, ms: receivedAt - this.lastAt });
    }
    this.lastAt = receivedAt;
    this.prune(receivedAt);
  }

  // Заметных пауз за окно — единицы, перебор по каждой как порогу дешёвый.
  measure(now: number): PauseMeasure {
    this.prune(now);
    const noticeable = this.pauses.filter((pause) => pause.ms >= NET_PAUSE_DEGREE_MS[0]);
    let repeatedMs = 0;
    for (const { ms } of noticeable) {
      if (ms > repeatedMs && spacedCount(noticeable, ms) >= 2) {
        repeatedMs = ms;
      }
    }
    return { repeatedMs, longCount: spacedCount(noticeable, NET_PAUSE_DEGREE_MS[1]) };
  }

  reset(): void {
    this.pauses = [];
    this.lastAt = null;
  }

  // Паузы лежат по времени окончания: устаревшие — в начале.
  private prune(now: number): void {
    const firstFresh = this.pauses.findIndex((pause) => now - pause.endedAt <= NET_PAUSE_WINDOW_MS);
    if (firstFresh === 0) {
      return;
    }
    this.pauses = firstFresh === -1 ? [] : this.pauses.slice(firstFresh);
  }
}

interface Stretch {
  since: number;
  bound: NetDegree;
}

function lower(a: NetDegree, b: NetDegree): NetDegree {
  return a < b ? a : b;
}

function higher(a: NetDegree, b: NetDegree): NetDegree {
  return a > b ? a : b;
}

function extend(
  stretch: Stretch | null,
  raw: NetDegree,
  now: number,
  pick: (a: NetDegree, b: NetDegree) => NetDegree,
): Stretch {
  if (stretch === null) {
    return { since: now, bound: raw };
  }
  return { since: stretch.since, bound: pick(stretch.bound, raw) };
}

// Удержанная степень: подъём — до наименьшей мгновенной за RISE подряд выше удержанной, спуск — до наибольшей
// мгновенной за FALL подряд ниже неё.
export class DegreeHold {
  private held: NetDegree = 0;
  private rise: Stretch | null = null;
  private fall: Stretch | null = null;

  update(raw: NetDegree, now: number): NetDegree {
    this.rise = raw > this.held ? extend(this.rise, raw, now, lower) : null;
    this.fall = raw < this.held ? extend(this.fall, raw, now, higher) : null;
    if (this.rise !== null && now - this.rise.since >= NET_WARNING_RISE_MS) {
      this.settle(this.rise.bound, raw, now);
    } else if (this.fall !== null && now - this.fall.since >= NET_WARNING_FALL_MS) {
      this.settle(this.fall.bound, raw, now);
    }
    return this.held;
  }

  private settle(degree: NetDegree, raw: NetDegree, now: number): void {
    this.held = degree;
    this.rise = raw > degree ? { since: now, bound: raw } : null;
    this.fall = raw < degree ? { since: now, bound: raw } : null;
  }
}

// Оценка связи целиком: снимки — в замер пауз, каждый кадр — пинг и время.
export class NetWarning {
  private readonly pauses = new SnapshotPauses();
  private readonly pingHold = new DegreeHold();
  private readonly jitterHold = new DegreeHold();

  noteSnapshot(receivedAt: number): void {
    this.pauses.note(receivedAt);
  }

  // Поток снимков прервался по замыслу: новое соединение, раунд, матч, возврат вкладки.
  resetPauses(): void {
    this.pauses.reset();
  }

  update(now: number, recentRttMs: readonly number[]): NetWarningState {
    const pingMs = medianMs(recentRttMs);
    const measure = this.pauses.measure(now);
    const ping = this.pingHold.update(pingDegree(pingMs), now);
    const jitter = this.jitterHold.update(pauseDegree(measure), now);
    return {
      level: warningLevel(ping, jitter),
      pingDegree: ping,
      jitterDegree: jitter,
      text: warningText(ping, jitter),
      pingMs,
      pauseMs: measure.repeatedMs,
    };
  }
}

// Срез для debugState(): удержанное состояние и видна ли плашка в кадре.
export interface NetWarningDebug {
  level: NetWarningLevel;
  pingDegree: NetDegree;
  jitterDegree: NetDegree;
  text: string;
  isShown: boolean;
}

export function netWarningDebug(state: Readonly<NetWarningState>, isVisible: boolean): NetWarningDebug {
  return {
    level: state.level,
    pingDegree: state.pingDegree,
    jitterDegree: state.jitterDegree,
    text: state.text,
    isShown: isVisible && state.level > 0,
  };
}

export function isSameWarning(a: Readonly<NetWarningState>, b: Readonly<NetWarningState>): boolean {
  return a.level === b.level && a.pingDegree === b.pingDegree && a.jitterDegree === b.jitterDegree;
}

export function netWarningLogLine(state: Readonly<NetWarningState>): string {
  return `netwarn level=${String(state.level)} ping=${String(state.pingDegree)} jitter=${String(state.jitterDegree)} rtt=${state.pingMs.toFixed(0)} pause=${state.pauseMs.toFixed(0)}`;
}
