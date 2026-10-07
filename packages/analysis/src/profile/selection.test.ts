import { TWIN_INFO, twinRoomCode } from '@tanks/shared/protocol';
import { describe, expect, it } from 'vitest';
import { analyzeLogLines } from '../index.js';
import {
  action,
  BOT,
  countdownFrames,
  FIXTURE_SELECTION,
  fightFrame,
  HUMAN,
  IDLE,
  LANE_Y,
  logFiles,
  muzzleOf,
  pose,
  repeatFrames,
  roundOver,
  startDuel,
  type Frame,
  type LogAction,
} from '../logFixture.js';
import { profileMetrics, selectProfileRounds, type ExclusionReason, type ProfileSelection } from './index.js';

const BOT_POSE = pose(1400, LANE_Y, Math.PI, Math.PI);
const NICK = FIXTURE_SELECTION.nick;
const HUMAN_POSE = pose(200, LANE_Y);
const LONG_FIGHT = 200;
const SHORT_FIGHT = 100;

interface RoundSpec {
  room?: string;
  botName?: string;
  flags?: string;
  settings?: string;
  fightTicks?: number;
  shots?: number;
  humanAction?: (tick: number) => LogAction;
  silentTick?: number;
  winner?: 0 | 1;
}

// Раунд, нарушающий только правила из spec: по умолчанию — бой 200 тиков, человек едет, один выстрел, бот победил.
function roundLog(spec: RoundSpec): string {
  const room = spec.room ?? 'bot05test';
  const builder = spec.botName === undefined ? startDuel({ room }) : startDuel({ room, names: [spec.botName, NICK] });
  if (spec.flags !== undefined) {
    builder.client(HUMAN, `flags ${spec.flags}`);
  }
  if (spec.settings !== undefined) {
    builder.client(HUMAN, `settings ${spec.settings}`);
  }
  builder.roundStart(0, 0).frames(countdownFrames([BOT_POSE, HUMAN_POSE]));
  const ticks = spec.fightTicks ?? LONG_FIGHT;
  const shots = spec.shots ?? 1;
  const humanAction = spec.humanAction ?? ((): LogAction => action(1));
  const frames: Frame[] = repeatFrames(ticks, (tick) => {
    const events = tick < shots ? [{ kind: 'shot', side: HUMAN, ...muzzleOf(HUMAN_POSE), v: 0 }] : [];
    const isLast = tick === ticks - 1;
    return fightFrame([BOT_POSE, HUMAN_POSE], {
      actions: [IDLE, humanAction(tick)],
      isSilent: [false, tick === spec.silentTick],
      events: isLast ? [...events, roundOver(spec.winner ?? BOT)] : events,
    });
  });
  return builder.frames(frames).text();
}

function filesOf(specs: Record<string, RoundSpec>): ReturnType<typeof logFiles> {
  return logFiles(Object.fromEntries(Object.entries(specs).map(([id, spec]) => [`${id}.log`, roundLog(spec)])));
}

function reasonsOf(
  specs: Record<string, RoundSpec>,
  selection: ProfileSelection = FIXTURE_SELECTION,
): Record<string, ExclusionReason | null> {
  const selected = selectProfileRounds(analyzeLogLines(filesOf(specs)), selection);
  const result: Record<string, ExclusionReason | null> = {};
  for (const round of selected.kept) {
    result[round.game] = null;
  }
  for (const [reason, ids] of Object.entries(selected.excluded)) {
    for (const id of ids) {
      result[id.split('#')[0] ?? id] = reason as ExclusionReason;
    }
  }
  return result;
}

describe('правило выборки профиля', () => {
  it('раунд, нарушающий одно правило, исключён с этой причиной', () => {
    expect(
      reasonsOf({
        GOOD: {},
        AUTO: { flags: 'autoaim=1 guard=0' },
        WEAK: { room: 'bot02weak' },
        SHRT: { fightTicks: SHORT_FIGHT },
        NOSH: { shots: 0 },
        IDLE: { humanAction: () => IDLE },
        SILN: { silentTick: 50 },
      }),
    ).toEqual({
      GOOD: null,
      AUTO: 'autoaim',
      WEAK: 'weakBot',
      SHRT: 'short',
      NOSH: 'noShot',
      IDLE: 'idle',
      SILN: 'silence',
    });
  });

  it('правила по порядку: побеждает первое; победа над ботом уровня 3+ входит всегда; раунд без боя — короткий', () => {
    expect(
      reasonsOf({
        AUWN: { flags: 'autoaim=1', winner: HUMAN },
        WKWN: { room: 'bot02weak', winner: HUMAN },
        WIN3: { room: 'bot03win', winner: HUMAN, fightTicks: SHORT_FIGHT, shots: 0, humanAction: () => IDLE },
        SHNS: { fightTicks: SHORT_FIGHT, shots: 0 },
        NOFT: { fightTicks: 0, shots: 0 },
        NSID: { shots: 0, humanAction: () => IDLE },
      }),
    ).toEqual({ AUWN: 'autoaim', WKWN: 'weakBot', WIN3: null, SHNS: 'short', NOFT: 'short', NSID: 'noShot' });
  });

  it('раунд с управлением и одним выстрелом, стоящий 90 % боя, входит в выборку', () => {
    const standing = (tick: number): LogAction => (tick % 10 === 0 ? action(1) : action(0, 0, 1));
    expect(reasonsOf({ STND: { humanAction: standing } })).toEqual({ STND: null });
  });

  it('управление ниже 30 % тиков боя — простой; ровно на пороге — входит', () => {
    const share =
      (every: number) =>
      (tick: number): LogAction =>
        tick % every === 0 ? action(1) : IDLE;
    expect(
      reasonsOf({
        LOW: { humanAction: share(4) },
        EDGE: { humanAction: (tick) => (tick % 10 < 3 ? action(1) : IDLE) },
      }),
    ).toEqual({
      LOW: 'idle',
      EDGE: null,
    });
  });

  it('игра против двойника в комнате twin… — без уровня бота, в выборку профиля не входит', () => {
    const files = filesOf({ TWIN: { room: twinRoomCode('k7m2px'), botName: TWIN_INFO.name, winner: HUMAN } });
    const [game] = analyzeLogLines(files);
    const selected = selectProfileRounds(analyzeLogLines(files), FIXTURE_SELECTION);

    expect(game?.analysis.summary.level).toBeNull();
    expect(selected.total).toBe(0);
    expect(selected.kept).toEqual([]);
  });

  it('число раундов и периоды: раунд вне ника не считается', () => {
    const files = logFiles({ 'GOOD.log': roundLog({}) });
    const other = selectProfileRounds(analyzeLogLines(files), { ...FIXTURE_SELECTION, nick: 'кто-то' });
    expect(other.total).toBe(0);
    const mine = selectProfileRounds(analyzeLogLines(files), FIXTURE_SELECTION);
    expect(mine.total).toBe(1);
    expect(mine.kept[0]?.period).toBeNull();
  });

  it('игры старой лестницы — отдельное правило: исключены даже с победой; слабый бот остаётся слабым', () => {
    const selection = { ...FIXTURE_SELECTION, oldLadderGames: ['OLDL', 'OLDW', 'OLDK'] };
    expect(
      reasonsOf(
        {
          GOOD: {},
          OLDL: {},
          OLDW: { winner: HUMAN },
          OLDK: { room: 'bot02weak' },
        },
        selection,
      ),
    ).toEqual({ GOOD: null, OLDL: 'oldLadder', OLDW: 'oldLadder', OLDK: 'weakBot' });
  });

  it('периоды — списками игр: период по списку, игра вне списков не считается, игра из списка без журнала — в пропавших', () => {
    const selection: ProfileSelection = {
      ...FIXTURE_SELECTION,
      periods: [
        { name: 'early', games: ['LATE', 'GONE'] },
        { name: 'late', games: ['EARL'] },
      ],
    };
    const files = filesOf({
      EARL: { settings: '{"pivotThrottle":0.5}' },
      LATE: { settings: '{"pivotThrottle":0.7}' },
      XTRA: {},
    });
    const selected = selectProfileRounds(analyzeLogLines(files), selection);

    expect(selected.total).toBe(2);
    expect(selected.kept.map((round) => [round.game, round.period])).toEqual([
      ['EARL', 'late'],
      ['LATE', 'early'],
    ]);
    expect(selected.missingGames).toEqual(['GONE']);
    expect(profileMetrics(selected.kept).settings).toEqual({ pivotThrottle: 0.5 });
  });
});
