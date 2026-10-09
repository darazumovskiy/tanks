import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFfaMatch, DEFAULT_STATS, ffaMap, stepFfaMatch, type Action } from '@tanks/shared/engine';
import {
  FFA_JOURNAL,
  formatJournalActions,
  formatJournalRoster,
  formatJournalSum,
  isJournalSumTick,
  quantizeAction,
} from '@tanks/shared/protocol';
import { analyzeFfaLog } from './ffaGames.js';
import { runCli } from './cli.js';
import { countdownFrames, LANE_Y, makeLogDir, pose, removeLogDirs, standingFrames, startDuel } from './logFixture.js';

const SEED = 5;
const FIGHT_TICKS = 95;
const ROSTER = [
  { id: 1, stats: DEFAULT_STATS },
  { id: 2, stats: DEFAULT_STATS },
];
const DRIVE: Action = quantizeAction({ throttle: 1, turn: 0.5, turretTurn: -1, isFiring: true });
// Команды пишутся только при смене: незаконченный журнал прогоняется до последней строки — сверки на 90-м тике.
const REPLAYED_TICKS = 90;

afterEach(() => {
  removeLogDirs();
});

function line(gameTick: number, text: string): string {
  return `00:00:00.000 S gt=${String(gameTick)} tc=00:00 ${text}`;
}

// Журнал толпы в формате сервера: двое, человек и бот, 95 тиков боя, человек едет и стреляет.
function ffaJournal(): string {
  const match = createFfaMatch(
    ffaMap(10),
    ROSTER.map((entry) => ({ ...entry, name: 'x' })),
    SEED,
    { wallSlidePercent: 30, shotLeadTicks: 0, shotInheritPercent: 0 },
  );
  const lines = [
    line(0, `${FFA_JOURNAL.gameStart} mode=ffa size=10 rules=30`),
    line(0, 'join id=1 nick=Дима bot=0'),
    line(0, 'join id=2 nick=Рядовой bot=1'),
    line(
      1,
      `${FFA_JOURNAL.matchStart} idx=1 players=2 seed=${String(SEED)} dur=120 roster=${formatJournalRoster(ROSTER)}`,
    ),
    line(4, `${FFA_JOURNAL.fightStart} idx=1`),
  ];
  let previous = new Map<number, Action>();
  for (let gameTick = 5; gameTick < 5 + FIGHT_TICKS; gameTick++) {
    const actions = new Map<number, Action>([[1, DRIVE]]);
    const actionsLine = formatJournalActions(previous, actions);
    if (actionsLine !== null) {
      lines.push(line(gameTick, actionsLine));
    }
    previous = actions;
    stepFfaMatch(match, actions);
    if (isJournalSumTick(match)) {
      lines.push(line(gameTick, formatJournalSum(match)));
    }
  }
  return `${lines.join('\n')}\n`;
}

describe('журналы боя толпы', () => {
  it('прогон: матч, тики, сверки, люди по строкам входа', () => {
    expect(analyzeFfaLog('FFA1', ffaJournal())).toEqual({
      id: 'FFA1',
      size: 10,
      humans: ['Дима'],
      matches: [
        { index: 1, ticks: REPLAYED_TICKS, sums: 3, mismatches: 0, firstMismatchTick: null, isComplete: false },
      ],
    });
  });

  it('журнал без команд — игра без матчей; дуэль — не журнал толпы', () => {
    const old = [line(0, 'game start mode=ffa size=30 rules=30'), line(5, 'match start idx=1 players=2 seed=9')].join(
      '\n',
    );
    expect(analyzeFfaLog('OLD1', old)).toEqual({ id: 'OLD1', size: 30, humans: [], matches: [] });
    expect(analyzeFfaLog('DUEL', startDuel().text())).toBeNull();
  });

  it('папка с дуэлью и боем толпы: дуэль в сводке, бой толпы — в разделе прогона', () => {
    const poses: [ReturnType<typeof pose>, ReturnType<typeof pose>] = [pose(800, LANE_Y), pose(200, LANE_Y)];
    const duel = startDuel().roundStart(0, 0).frames(countdownFrames(poses)).frames(standingFrames(poses, 2)).text();
    const dir = makeLogDir({ 'GAME.log': duel, 'FFA1.log': ffaJournal() }, 'logs');
    const printed: string[] = [];
    runCli([dir, '--out', join(dir, 'out')], (text) => printed.push(text));
    expect(printed).toEqual(['Игр разобрано: 1', 'Боёв толпы прогнано: 1', join(dir, 'out', 'report.md')]);
    const report = readFileSync(join(dir, 'out', 'report.md'), 'utf8');
    expect(report).toContain('| FFA1 | 10 | Дима | 1 | 90 | 3 / 3 | — | нет |');
  });
});
