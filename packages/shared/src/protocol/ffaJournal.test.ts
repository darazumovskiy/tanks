import { describe, expect, it } from 'vitest';
import {
  createFfaMatch,
  ffaMap,
  joinFfaMatch,
  leaveFfaMatch,
  stepFfaMatch,
  TICK_RATE,
  worldDigest,
  type Action,
  type FfaMatch,
  type Stats,
} from '../engine/index.js';
import { quantizeAction } from './codec.js';
import {
  FFA_JOURNAL,
  FFA_LEAVE_IDLE,
  FFA_LEAVE_OFFLINE,
  formatJournalActions,
  formatJournalRoster,
  formatJournalStats,
  formatJournalSum,
  isJournalSumTick,
  replayFfaJournal,
  type FfaJournalPlayer,
} from './ffaJournal.js';

const SEED = 77;
const MATCH_SECONDS = 20;
const ROSTER: FfaJournalPlayer[] = [
  { id: 1, stats: { armor: 3, engine: 3, gun: 2, reload: 2 } },
  { id: 2, stats: { armor: 0, engine: 5, gun: 5, reload: 0 } },
  { id: 3, stats: { armor: 5, engine: 0, gun: 0, reload: 5 } },
  { id: 4, stats: { armor: 2, engine: 2, gun: 3, reload: 3 } },
  { id: 5, stats: { armor: 1, engine: 4, gun: 4, reload: 1 } },
  { id: 6, stats: { armor: 3, engine: 3, gun: 2, reload: 2 } },
];
const LATE_STATS: Stats = { armor: 4, engine: 4, gun: 1, reload: 1 };
const FIGHT_START_TICK = 3;
const COUNTDOWN_LEAVE = { tick: 2, id: 6 };
const LATE_JOIN = { tick: 50, id: 7 };
const OFFLINE_LEAVE = { tick: 100, id: 2 };
const SILENT = { from: 120, to: 160, id: 3 };
const IDLE_LEAVE = { tick: 200, id: 4 };

function line(gameTick: number, text: string, source = 'S'): string {
  return `00:00:00.000 ${source} gt=${String(gameTick)} tc=00:00 ${text}`;
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomAction(random: () => number): Action {
  return quantizeAction({
    throttle: random() * 2 - 1,
    turn: random() * 2 - 1,
    turretTurn: random() * 2 - 1,
    isFiring: random() < 0.2,
  });
}

interface Written {
  lines: string[];
  match: FfaMatch;
}

// Пишет журнал так же, как сервер общей игры: выход по обрыву и вход — до шага, команды при смене, сверка после
// шага, выход за бездействие — после сверки. firstTick — тик игры, с которого начинается матч.
function writeMatch(index: number, firstTick: number, endTick: number | null): Written {
  const random = lcg(SEED + index);
  const lines = [
    line(
      firstTick,
      `${FFA_JOURNAL.matchStart} idx=${String(index)} players=${String(ROSTER.length)} seed=${String(SEED)} dur=${String(MATCH_SECONDS)} roster=${formatJournalRoster(ROSTER)}`,
    ),
  ];
  const map = ffaMap(10);
  const match = createFfaMatch(
    map,
    ROSTER.map((entry) => ({ ...entry, name: `#${String(entry.id)}` })),
    SEED,
    { wallSlidePercent: 30 },
    MATCH_SECONDS,
  );
  const present = new Set(ROSTER.map((entry) => entry.id));
  lines.push(
    line(
      firstTick + COUNTDOWN_LEAVE.tick,
      `${FFA_JOURNAL.leave} id=${String(COUNTDOWN_LEAVE.id)} reason=${FFA_LEAVE_OFFLINE}`,
    ),
  );
  leaveFfaMatch(match, COUNTDOWN_LEAVE.id);
  present.delete(COUNTDOWN_LEAVE.id);
  lines.push(line(firstTick + FIGHT_START_TICK, `${FFA_JOURNAL.fightStart} idx=${String(index)}`));
  let previous = new Map<number, Action>();
  const held = new Map<number, Action>();
  for (let tick = FIGHT_START_TICK + 1; !match.isOver; tick++) {
    const gameTick = firstTick + tick;
    if (endTick !== null && gameTick > endTick) {
      break;
    }
    if (tick === OFFLINE_LEAVE.tick) {
      lines.push(line(gameTick, `${FFA_JOURNAL.leave} id=${String(OFFLINE_LEAVE.id)} reason=${FFA_LEAVE_OFFLINE}`));
      leaveFfaMatch(match, OFFLINE_LEAVE.id);
      present.delete(OFFLINE_LEAVE.id);
    }
    if (tick === LATE_JOIN.tick) {
      lines.push(
        line(gameTick, `${FFA_JOURNAL.join} id=${String(LATE_JOIN.id)} stats=${formatJournalStats(LATE_STATS)}`),
      );
      joinFfaMatch(match, { id: LATE_JOIN.id, name: 'поздний', stats: LATE_STATS });
      present.add(LATE_JOIN.id);
    }
    const actions = new Map<number, Action>();
    for (const id of present) {
      const isSilent = id === SILENT.id && tick >= SILENT.from && tick < SILENT.to;
      if (isSilent) {
        continue;
      }
      if (!held.has(id) || random() < 0.3) {
        held.set(id, randomAction(random));
      }
      actions.set(id, held.get(id) ?? randomAction(random));
    }
    const actionsLine = formatJournalActions(previous, actions);
    if (actionsLine !== null) {
      lines.push(line(gameTick, actionsLine));
    }
    previous = actions;
    const events = stepFfaMatch(match, actions);
    if (isJournalSumTick(match)) {
      lines.push(line(gameTick, formatJournalSum(match)));
    }
    if (tick === IDLE_LEAVE.tick) {
      lines.push(line(gameTick, `${FFA_JOURNAL.leave} id=${String(IDLE_LEAVE.id)} reason=${FFA_LEAVE_IDLE}`));
      leaveFfaMatch(match, IDLE_LEAVE.id);
      present.delete(IDLE_LEAVE.id);
    }
    if (events.some((event) => event.type === 'matchOver')) {
      lines.push(line(gameTick, `${FFA_JOURNAL.matchOver} idx=${String(index)}`));
    }
  }
  return { lines, match };
}

const GAME_START = line(0, `${FFA_JOURNAL.gameStart} mode=ffa size=10 rules=30`);

describe('журнал боя толпы', () => {
  it('строка команд: только изменившиеся, оси целыми как в кодеке, «-» — команды нет', () => {
    const still: Action = { throttle: 0, turn: 0, turretTurn: 0, isFiring: false };
    const moving: Action = quantizeAction({ throttle: 1, turn: -0.5, turretTurn: 0.25, isFiring: true });
    const previous = new Map([
      [1, still],
      [2, still],
      [3, still],
    ]);
    const current = new Map([
      [1, still],
      [2, moving],
    ]);
    expect(formatJournalActions(previous, current)).toBe(`${FFA_JOURNAL.actions} 2=127,-63,32,1 3=-`);
    expect(formatJournalActions(current, current)).toBeNull();
  });

  it('матч со входом, выходами и молчанием прогоняется без расхождений', () => {
    const written = writeMatch(1, 10, null);
    const replay = replayFfaJournal([GAME_START, ...written.lines]);
    expect(replay.size).toBe(10);
    expect(replay.matches).toHaveLength(1);
    const [result] = replay.matches;
    expect(result?.isComplete).toBe(true);
    expect(result?.mismatches).toEqual([]);
    expect(result?.sums).toBe(Math.ceil(written.match.world.tick / TICK_RATE));
    expect(result?.ticks).toBe(written.match.world.tick);
    expect(worldDigest(result?.match.world ?? written.match.world)).toBe(worldDigest(written.match.world));
    expect(result?.match.players.map((player) => player.id).sort()).toEqual([1, 3, 5, 7]);
  });

  it('прогон отдаёт каждый шаг: тики игры подряд, события шага', () => {
    const written = writeMatch(1, 10, null);
    const ticks: number[] = [];
    let shots = 0;
    replayFfaJournal([GAME_START, ...written.lines], {
      onTick: (_match, gameTick, events) => {
        ticks.push(gameTick);
        shots += events.filter((event) => event.type === 'shot').length;
      },
    });
    expect(ticks[0]).toBe(10 + FIGHT_START_TICK + 1);
    expect(ticks.every((tick, index) => index === 0 || tick === (ticks[index - 1] ?? 0) + 1)).toBe(true);
    expect(shots).toBeGreaterThan(0);
  });

  it('пропущенная строка команд — расхождение на ближайшей сверке', () => {
    const written = writeMatch(1, 10, null);
    const actionLines = written.lines.filter((text) => text.includes(` ${FFA_JOURNAL.actions} `));
    const dropped = actionLines[5];
    const broken = written.lines.filter((text) => text !== dropped);
    const [result] = replayFfaJournal([GAME_START, ...broken]).matches;
    expect(result?.mismatches.length).toBeGreaterThan(0);
    expect(result?.mismatches[0]?.tick).toBeLessThanOrEqual(60);
  });

  it('два матча подряд и незаконченный: второй — со сверками до обрыва журнала', () => {
    const first = writeMatch(1, 10, null);
    const secondStart = first.match.world.tick + 40;
    const cutTick = secondStart + 95;
    const second = writeMatch(2, secondStart, cutTick);
    const replay = replayFfaJournal([GAME_START, ...first.lines, ...second.lines]);
    expect(replay.matches.map((match) => match.index)).toEqual([1, 2]);
    const [, unfinished] = replay.matches;
    expect(unfinished?.isComplete).toBe(false);
    expect(unfinished?.mismatches).toEqual([]);
    expect(unfinished?.sums).toBe(3);
  });

  it('строки клиентов, дуэли и мусор пропускаются', () => {
    const written = writeMatch(1, 10, null);
    const noisy = [
      'мусор',
      GAME_START,
      ...written.lines.flatMap((text, index) => (index % 7 === 0 ? [text, line(0, 'snap rt=1', 'C1')] : [text])),
    ];
    const [result] = replayFfaJournal(noisy).matches;
    expect(result?.mismatches).toEqual([]);
    const duel = [line(0, 'game start room=bot01 p0=Манекен p1=Игрок rules=30'), line(1, 'round start idx=0 map=0')];
    expect(replayFfaJournal(duel)).toEqual({ size: null, matches: [] });
  });

  it('хэш поля одинаков у двух прогонов и меняется от сдвига танка', () => {
    const a = writeMatch(1, 10, 200).match;
    const b = writeMatch(1, 10, 200).match;
    expect(worldDigest(a.world)).toBe(worldDigest(b.world));
    const [tank] = b.world.tanks;
    if (tank !== undefined) {
      tank.x += 1e-9;
    }
    expect(worldDigest(a.world)).not.toBe(worldDigest(b.world));
  });
});
