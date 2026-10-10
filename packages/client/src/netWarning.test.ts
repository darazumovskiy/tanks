import { describe, expect, it } from 'vitest';
import {
  DegreeHold,
  isSameWarning,
  medianMs,
  NET_PAUSE_WINDOW_MS,
  NET_WARNING_FALL_MS,
  NET_WARNING_RISE_MS,
  NET_WARNING_TEXT,
  netWarningLogLine,
  NetWarning,
  NO_NET_WARNING,
  pauseDegree,
  pingDegree,
  SnapshotPauses,
  warningLevel,
  warningText,
  type NetDegree,
  type NetWarningLevel,
  type NetWarningState,
} from './netWarning.js';

const SNAPSHOT_MS = 1000 / 30;
const FRAME_MS = 1000 / 60;
const DEGREES: readonly NetDegree[] = [0, 1, 2, 3];

// Снимки ровно раз в тик с from до to; каждые everyMs одна пауза длиной pauseMs. Без пауз — everyMs 0.
function arrivals(fromMs: number, toMs: number, pauseMs = 0, everyMs = 0): number[] {
  const times: number[] = [];
  let at = fromMs;
  let nextPauseAt = everyMs > 0 ? fromMs + everyMs : Infinity;
  while (at <= toMs) {
    times.push(at);
    if (at >= nextPauseAt) {
      at += pauseMs;
      nextPauseAt += everyMs;
    } else {
      at += SNAPSHOT_MS;
    }
  }
  return times;
}

function measureAfter(times: readonly number[]): NetDegree {
  const pauses = new SnapshotPauses();
  for (const at of times) {
    pauses.note(at);
  }
  return pauseDegree(pauses.measure(times.at(-1) ?? 0));
}

interface Frame {
  at: number;
  state: NetWarningState;
}

// Кадры по 60 в секунду с from до to, снимки — в свои моменты между кадрами; пинг — все замеры одинаковы.
function play(warning: NetWarning, fromMs: number, toMs: number, snapshots: readonly number[], rttMs: number): Frame[] {
  const recent = rttMs === 0 ? [] : [rttMs, rttMs, rttMs, rttMs, rttMs];
  const frames: Frame[] = [];
  let next = 0;
  for (let at = fromMs; at <= toMs; at += FRAME_MS) {
    while (next < snapshots.length && (snapshots[next] ?? Infinity) <= at) {
      warning.noteSnapshot(snapshots[next] ?? at);
      next++;
    }
    frames.push({ at, state: warning.update(at, recent) });
  }
  return frames;
}

function firstAt(frames: readonly Frame[], isWanted: (state: NetWarningState) => boolean): number | null {
  return frames.find((frame) => isWanted(frame.state))?.at ?? null;
}

describe('степень пинга', () => {
  it('пороги 80, 150 и 250 — по округлённому числу, как в строке отладки', () => {
    const cases: [number, NetDegree][] = [
      [0, 0],
      [79, 0],
      [79.4, 0],
      [79.6, 1],
      [80, 1],
      [150, 1],
      [150.4, 1],
      [151, 2],
      [250, 2],
      [251, 3],
    ];
    for (const [rttMs, degree] of cases) {
      expect(pingDegree(rttMs), `пинг ${String(rttMs)}`).toBe(degree);
    }
  });

  it('медиана замеров: пусто — 0, нечётное и чётное число замеров', () => {
    expect(medianMs([])).toBe(0);
    expect(medianMs([55, 330, 52, 54, 56])).toBe(55);
    expect(medianMs([100, 60])).toBe(80);
  });
});

describe('неровность — паузы между снимками', () => {
  it('нет снимков и один снимок — степень 0', () => {
    expect(measureAfter([])).toBe(0);
    expect(measureAfter([1000])).toBe(0);
  });

  it('ровные снимки 5 с — 0', () => {
    expect(measureAfter(arrivals(0, 5000))).toBe(0);
  });

  it('одна пауза 400 мс среди ровных — 0: пауза не повторилась', () => {
    expect(measureAfter(arrivals(0, 5000, 400, 2500))).toBe(0);
  });

  it('четыре паузы по 235 мс за секунду — 0: это один сбой', () => {
    const times = [...arrivals(0, 2000), ...arrivals(2235, 2235), ...arrivals(2470, 2470), ...arrivals(2705, 2705)];
    times.push(...arrivals(2940, 5000));
    expect(measureAfter(times)).toBe(0);
  });

  it('паузы 120 мс раз в секунду — 1', () => {
    expect(measureAfter(arrivals(0, 5000, 120, 1000))).toBe(1);
  });

  it('паузы 210–240 мс раз в 2 с, как у сети жены — 2', () => {
    expect(measureAfter(arrivals(0, 6000, 225, 2070))).toBe(2);
    expect(measureAfter(arrivals(0, 6000, 240, 2070))).toBe(2);
  });

  it('паузы 270 мс раз в 2 с — 3', () => {
    expect(measureAfter(arrivals(0, 6000, 270, 2070))).toBe(3);
  });

  it('паузы 200 мс раз в 1,2 с — 3: связь замирает слишком часто', () => {
    expect(measureAfter(arrivals(0, 6000, 200, 1200))).toBe(3);
  });

  it('паузы 250 мс раз в 2 с, затем ровно 6 с — 0: паузы вышли из окна', () => {
    const pauses = new SnapshotPauses();
    for (const at of [...arrivals(0, 6000, 250, 2000), ...arrivals(6020, 12_000)]) {
      pauses.note(at);
    }
    expect(pauseDegree(pauses.measure(12_000))).toBe(0);
  });

  it('паузы выходят из окна и без новых снимков', () => {
    const pauses = new SnapshotPauses();
    for (const at of arrivals(0, 6000, 250, 2000)) {
      pauses.note(at);
    }
    expect(pauseDegree(pauses.measure(6000))).toBe(3);
    expect(pauseDegree(pauses.measure(6000 + NET_PAUSE_WINDOW_MS + 1))).toBe(0);
  });

  it('сброс: паузы забыты, первый снимок после сброса паузы не даёт', () => {
    const pauses = new SnapshotPauses();
    for (const at of arrivals(0, 6000, 250, 2000)) {
      pauses.note(at);
    }
    pauses.reset();
    pauses.note(9000);
    pauses.note(9033);
    expect(pauses.measure(9033)).toEqual({ repeatedMs: 0, longCount: 0 });
  });
});

describe('уровень и текст', () => {
  it('все сочетания степеней', () => {
    const expected: NetWarningLevel[][] = [
      [0, 1, 2, 3],
      [1, 2, 2, 3],
      [2, 2, 3, 3],
      [3, 3, 3, 3],
    ];
    for (const ping of DEGREES) {
      for (const jitter of DEGREES) {
        expect(warningLevel(ping, jitter), `пинг ${String(ping)}, неровность ${String(jitter)}`).toBe(
          expected[ping]?.[jitter],
        );
      }
    }
  });

  it('текст по причинам', () => {
    expect(warningText(2, 0)).toBe('Высокий пинг');
    expect(warningText(0, 1)).toBe('Плохая сеть');
    expect(warningText(1, 3)).toBe('Высокий пинг · плохая сеть');
    expect(warningText(0, 0)).toBe('');
    expect(NET_WARNING_TEXT.both).toBe(`${NET_WARNING_TEXT.ping} · плохая сеть`);
  });
});

describe('удержание степени', () => {
  const STEP_MS = 100;
  // Мгновенная выше удержанной с нуля до отметки подъёма включительно — удержанная поднялась на отметке.
  const RISEN_MS = NET_WARNING_RISE_MS + STEP_MS;

  function holdThrough(steps: readonly [NetDegree, number][]): { at: number; degree: NetDegree }[] {
    const hold = new DegreeHold();
    const trace: { at: number; degree: NetDegree }[] = [];
    let at = 0;
    for (const [raw, durationMs] of steps) {
      const until = at + durationMs;
      for (; at < until; at += STEP_MS) {
        trace.push({ at, degree: hold.update(raw, at) });
      }
    }
    return trace;
  }

  it('мгновенная 2 держится 2,9 с, потом 0 — удержанная всё время 0', () => {
    const trace = holdThrough([
      [2, NET_WARNING_RISE_MS],
      [0, 6000],
    ]);
    expect(trace.every((step) => step.degree === 0)).toBe(true);
  });

  it('мгновенная 2 держится 3 с — удержанная 2 ровно в 3 с', () => {
    const trace = holdThrough([[2, NET_WARNING_RISE_MS + 500]]);
    expect(trace.find((step) => step.degree === 2)?.at).toBe(NET_WARNING_RISE_MS);
  });

  it('мгновенная 1 и 2 вперемешку — подъём до наименьшей', () => {
    const trace = holdThrough([
      [1, 500],
      [2, 500],
      [1, 500],
      [2, 2000],
    ]);
    expect(trace.find((step) => step.at === NET_WARNING_RISE_MS)?.degree).toBe(1);
  });

  it('удержанная 2, мгновенная 0 держится 4,9 с, потом 2 — удержанная не падает', () => {
    const trace = holdThrough([
      [2, RISEN_MS],
      [0, NET_WARNING_FALL_MS - STEP_MS],
      [2, 3000],
    ]);
    expect(trace.filter((step) => step.at >= NET_WARNING_RISE_MS).every((step) => step.degree === 2)).toBe(true);
  });

  it('удержанная 2, мгновенная 0 держится 5 с — 0 ровно через 5 с', () => {
    const trace = holdThrough([
      [2, RISEN_MS],
      [0, NET_WARNING_FALL_MS + 500],
    ]);
    expect(trace.find((step) => step.at >= RISEN_MS && step.degree === 0)?.at).toBe(RISEN_MS + NET_WARNING_FALL_MS);
  });

  it('удержанная 3, мгновенная 1 и 0 вперемешку — спуск до наибольшей', () => {
    const trace = holdThrough([
      [3, RISEN_MS],
      [1, 1000],
      [0, 1000],
      [1, 1000],
      [0, 2500],
    ]);
    expect(trace.find((step) => step.at === RISEN_MS + NET_WARNING_FALL_MS)?.degree).toBe(1);
  });
});

describe('оценка связи целиком', () => {
  it('ровные снимки, пинг 50 — предупреждения нет', () => {
    const frames = play(new NetWarning(), 0, 20_000, arrivals(0, 20_000), 50);
    expect(frames.every((frame) => frame.state.level === 0 && frame.state.text === '')).toBe(true);
  });

  it('пинг 100 при ровных снимках — жёлтый «Высокий пинг» через 3 с', () => {
    const frames = play(new NetWarning(), 0, 8000, arrivals(0, 8000), 100);
    expect(firstAt(frames, (state) => state.level > 0)).toBeCloseTo(NET_WARNING_RISE_MS, -2);
    expect(frames.at(-1)?.state).toMatchObject({ level: 1, pingDegree: 1, jitterDegree: 0, text: 'Высокий пинг' });
  });

  it('паузы как у жены, пинг 55 — оранжевый «Плохая сеть» через 3 с после второй паузы', () => {
    const snapshots = arrivals(0, 15_000, 225, 2070);
    const pauseEnds = snapshots.filter((at, index) => index > 0 && at - (snapshots[index - 1] ?? at) > 200);
    const secondPauseEnd = pauseEnds[1] ?? 0;
    const frames = play(new NetWarning(), 0, 15_000, snapshots, 55);
    const shownAt = firstAt(frames, (state) => state.level > 0) ?? 0;
    expect(shownAt).toBeGreaterThanOrEqual(secondPauseEnd + NET_WARNING_RISE_MS - FRAME_MS);
    expect(shownAt).toBeLessThan(secondPauseEnd + NET_WARNING_RISE_MS + 2 * FRAME_MS);
    const shown = frames.filter((frame) => frame.at >= shownAt);
    expect(shown.every((frame) => frame.state.level === 2 && frame.state.text === 'Плохая сеть')).toBe(true);
  });

  it('пинг 200 и паузы как у жены — красный «Высокий пинг · плохая сеть»', () => {
    const frames = play(new NetWarning(), 0, 15_000, arrivals(0, 15_000, 225, 2070), 200);
    expect(frames.at(-1)?.state).toMatchObject({
      level: 3,
      pingDegree: 2,
      jitterDegree: 2,
      text: 'Высокий пинг · плохая сеть',
    });
  });

  it('один застрявший ответ на пинг среди ровных — предупреждения нет', () => {
    const warning = new NetWarning();
    let level = 0;
    for (let at = 0; at < 10_000; at += 100) {
      const recent = at >= 4000 && at < 9000 ? [55, 56, 330, 54, 55] : [55, 56, 54, 55, 56];
      level = Math.max(level, warning.update(at, recent).level);
    }
    expect(level).toBe(0);
  });

  it('паузы прекратились — плашка гаснет не раньше 5 с после выхода пауз из окна', () => {
    const warning = new NetWarning();
    const stalls = arrivals(0, 12_000, 225, 2070);
    const lastStall = stalls.at(-1) ?? 0;
    const frames = play(warning, 0, 30_000, [...stalls, ...arrivals(lastStall + SNAPSHOT_MS, 30_000)], 55);
    const hiddenAt = frames.find((frame) => frame.at > 12_000 && frame.state.level === 0)?.at ?? Infinity;
    expect(hiddenAt).toBeGreaterThanOrEqual(lastStall + NET_WARNING_FALL_MS);
    expect(hiddenAt).toBeLessThan(lastStall + NET_PAUSE_WINDOW_MS + NET_WARNING_FALL_MS + FRAME_MS);
  });

  it('сброс пауз — новая серия начинается без пауз прошлой', () => {
    const warning = new NetWarning();
    play(warning, 0, 3000, arrivals(0, 3000), 55);
    warning.resetPauses();
    const frames = play(warning, 10_000, 20_000, arrivals(10_000, 20_000), 55);
    expect(frames.every((frame) => frame.state.pauseMs === 0 && frame.state.level === 0)).toBe(true);
  });
});

describe('журнал', () => {
  it('строка netwarn и сравнение состояний', () => {
    const state: NetWarningState = {
      level: 2,
      pingDegree: 0,
      jitterDegree: 2,
      text: 'Плохая сеть',
      pingMs: 53.4,
      pauseMs: 231,
    };
    expect(netWarningLogLine(state)).toBe('netwarn level=2 ping=0 jitter=2 rtt=53 pause=231');
    expect(isSameWarning(state, { ...state, pingMs: 80, pauseMs: 200 })).toBe(true);
    expect(isSameWarning(state, NO_NET_WARNING)).toBe(false);
    expect(isSameWarning(state, { ...state, pingDegree: 1 })).toBe(false);
  });
});
