import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, DEFAULT_STATS } from '@tanks/shared/engine';
import {
  ErrorCode,
  EventFlag,
  FfaPhase,
  MessageType,
  type FfaMatchStartMessage,
  type FfaSelf,
  type FfaSnapshotEvent,
  type FfaSnapshotMessage,
  type FfaStateMessage,
  type FfaWelcomeMessage,
} from '@tanks/shared/protocol';
import { FfaSession } from './session.js';

const ME = 4;

function welcome(playerId = ME, gameId = 'K7QX'): FfaWelcomeMessage {
  return { type: MessageType.FfaWelcome, playerId, token: 'пропуск', gameId, size: 10, rules: DEFAULT_RULES };
}

function state(
  phase: FfaStateMessage['phase'],
  ticksLeft: number | null,
  matchIndex = 1,
  players = 3,
): FfaStateMessage {
  return { type: MessageType.FfaState, phase, ticksLeft, players, capacity: 10, minimum: 7, matchIndex };
}

function matchStart(matchIndex = 1): FfaMatchStartMessage {
  return {
    type: MessageType.FfaMatchStart,
    matchIndex,
    durationSeconds: 120,
    zone: { startRadius: 1400, finalRadius: 380, startShrink: 45, endShrink: 105 },
    suddenDeathAt: 85,
  };
}

function self(stateName: FfaSelf['state'], killerId: number | null = null): FfaSelf {
  return { state: stateName, ticksLeft: 30, killerId, idleTicksLeft: null };
}

function death(tank: number, by: number | null, flags = 0): FfaSnapshotEvent {
  return { kind: 'death', tank, by, x: 0, y: 0, value: 0, dx: 0, dy: 0, flags };
}

function snapshot(tick: number, own: FfaSelf = self('alive'), events: FfaSnapshotEvent[] = []): FfaSnapshotMessage {
  return {
    type: MessageType.FfaSnapshot,
    tick,
    gameTick: tick,
    ackSeq: 0,
    self: own,
    tanks: [],
    kits: [],
    events,
    births: [],
    bounces: [],
    deaths: [],
  };
}

function roster(...players: [number, string, boolean][]): Parameters<FfaSession['onRoster']>[0] {
  return {
    type: MessageType.FfaRoster,
    players: players.map(([id, nickname, isBot]) => ({ id, nickname, stats: DEFAULT_STATS, isBot })),
  };
}

function inFight(): FfaSession {
  const session = new FfaSession(10);
  session.onWelcome(welcome());
  session.onRoster(roster([ME, 'Дима', false], [5, 'Вася', false], [6, 'Робот', true]));
  session.onState(state(FfaPhase.Fight, 3600), 0);
  session.onMatchStart(matchStart());
  return session;
}

describe('экран сессии', () => {
  it('до приветствия и состояния — подключение; лобби — игроки, места, минимум, старт по местным часам', () => {
    const session = new FfaSession(10);
    expect(session.screen()).toBe('connecting');
    session.onWelcome(welcome());
    expect(session.screen()).toBe('connecting');
    session.onState(state(FfaPhase.Lobby, null, 0), 1000);
    expect(session.screen()).toBe('lobby');
    expect(session.lobby(1000)).toEqual({ players: 3, capacity: 10, minimum: 7, startInS: null });
    session.onState(state(FfaPhase.Lobby, 300, 0, 7), 2000);
    expect(session.lobby(4500).startInS).toBeCloseTo(7.5, 9);
    expect(session.lobby(20_000).startInS).toBe(0);
  });

  it('отсчёт — только когда известен матч с номером из состояния; до того держатся итоги', () => {
    const session = new FfaSession(10);
    session.onWelcome(welcome());
    session.onState(state(FfaPhase.Countdown, 90, 1), 0);
    expect(session.screen()).toBe('connecting');
    session.onMatchStart(matchStart(1));
    expect(session.screen()).toBe('countdown');
    session.onState(state(FfaPhase.Results, 450, 1), 0);
    expect(session.screen()).toBe('results');
    session.onState(state(FfaPhase.Countdown, 90, 2), 0);
    expect(session.screen()).toBe('results');
    expect(session.onMatchStart(matchStart(2))).toBe('new');
    expect(session.screen()).toBe('countdown');
  });

  it('бой: на поле — бой; подбит и ждёт — «подбит»; зритель — зритель; до снимка — подключение', () => {
    const session = inFight();
    expect(session.screen()).toBe('connecting');
    for (const [own, screen] of [
      ['alive', 'fight'],
      ['wreck', 'dead'],
      ['waiting', 'dead'],
      ['spectator', 'spectator'],
    ] as const) {
      session.acceptSnapshot(snapshot(10, self(own)));
      expect(session.screen()).toBe(screen);
    }
  });

  it.each([
    [ErrorCode.Idle, 'idle'],
    [ErrorCode.Replaced, 'replaced'],
    [ErrorCode.BadProtocolVersion, 'update'],
    [ErrorCode.BadMessage, 'error'],
    [ErrorCode.RoomFull, 'error'],
  ] as const)('ошибка %i — окончательный экран %s', (code, screen) => {
    const session = inFight();
    session.onError(code);
    expect(session.screen()).toBe(screen);
  });
});

describe('возврат, повторы и устаревшие сообщения', () => {
  it('тот же игрок и игра — возврат; другой номер — место ушло, состояние сброшено', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(10));
    session.onDisconnect();
    expect(session.isConnectionLost).toBe(true);
    expect(session.onWelcome(welcome())).toBe('returned');
    expect(session.isConnectionLost).toBe(false);
    expect(session.screen()).toBe('fight');
    expect(session.onWelcome(welcome(9))).toBe('lost');
    expect(session.screen()).toBe('connecting');
    expect(session.match).toBeNull();
    expect(session.onWelcome(welcome(9, 'ZZZZ'))).toBe('lost');
  });

  it('повторный старт того же матча ничего не сбрасывает; снимок с меньшим тиком пропускается', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(100, self('alive'), [death(5, ME)]));
    expect(session.onMatchStart(matchStart(1))).toBe('same');
    expect(session.feed).toHaveLength(1);
    expect(session.acceptSnapshot(snapshot(99))).toBe(false);
    expect(session.tick).toBe(100);
    expect(session.acceptSnapshot(snapshot(100))).toBe(true);
    expect(session.onMatchStart(matchStart(2))).toBe('new');
    expect(session.feed).toHaveLength(0);
    expect(session.acceptSnapshot(snapshot(1))).toBe(true);
  });

  it('ушедший из состава остаётся в кэше имён; невиданный — «Неизвестный танкист»', () => {
    const session = inFight();
    session.onRoster(roster([ME, 'Дима', false]));
    expect(session.nameOf(5)).toBe('Вася');
    expect(session.isBot(6)).toBe(true);
    expect(session.nameOf(77)).toBe('Неизвестный танкист');
    expect(session.isBot(77)).toBe(false);
    expect(session.statsOf(77)).toEqual(DEFAULT_STATS);
  });

  it('снимок до старта матча не принимается', () => {
    const session = new FfaSession(10);
    session.onWelcome(welcome());
    expect(session.acceptSnapshot(snapshot(1))).toBe(false);
  });
});

describe('матч: время, финал, счёт, лента, подбит', () => {
  it('таймер — из тика снимка с округлением вверх; финал — по тику, без события', () => {
    const session = inFight();
    expect(session.timeLeftS).toBe(120);
    session.acceptSnapshot(snapshot(1));
    expect(session.timeLeftS).toBe(120);
    session.acceptSnapshot(snapshot(30));
    expect(session.timeLeftS).toBe(119);
    expect(session.isFinal).toBe(false);
    session.acceptSnapshot(snapshot(85 * 30));
    expect(session.isFinal).toBe(true);
    expect(new FfaSession(10).timeLeftS).toBeNull();
  });

  it('своё место — по общей таблице строк счёта, из числа строк', () => {
    const session = inFight();
    expect(session.score()).toBeNull();
    session.onScore({
      type: MessageType.FfaScore,
      rows: [
        { id: 5, kills: 3, deaths: 1, damageDealt: 0, damageTaken: 0 },
        { id: ME, kills: 3, deaths: 0, damageDealt: 0, damageTaken: 0 },
        { id: 6, kills: 1, deaths: 0, damageDealt: 0, damageTaken: 0 },
      ],
    });
    expect(session.score()).toEqual({ place: 1, total: 3, kills: 3, deaths: 0 });
  });

  it('лента: убийство, рикошетом, свой рикошет, зона, убийца не виден', () => {
    const session = inFight();
    session.acceptSnapshot(
      snapshot(5, self('alive'), [
        death(5, ME),
        death(6, ME, EventFlag.Ricochet),
        death(5, 5, EventFlag.Self | EventFlag.Ricochet),
        death(6, null, EventFlag.Zone),
        death(5, 77),
      ]),
    );
    expect(session.feed).toEqual([
      'Дима ✕ Вася',
      'Дима ↺ Робот',
      'Вася ↺ сам себя',
      'Робот ◎ сгорел в зоне',
      'Неизвестный танкист ✕ Вася',
    ]);
  });

  it('подбит своим событием — вид смерти; вернулся подбитым без события — убийца из своего состояния', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(5, self('wreck', 5), [death(ME, 5, EventFlag.Ricochet)]));
    expect(session.death()).toEqual({ killerId: 5, cause: 'ricochet' });
    session.onWelcome(welcome());
    session.acceptSnapshot(snapshot(6, self('wreck', 5)));
    expect(session.screen()).toBe('dead');
    expect(session.death()).toEqual({ killerId: 5, cause: null });
  });

  it('цель зрителя: убийца на поле, иначе лидер среди живых, иначе первый живой; живых нет — никто', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(5, self('spectator', 5)));
    session.onScore({
      type: MessageType.FfaScore,
      rows: [
        { id: 6, kills: 4, deaths: 0, damageDealt: 0, damageTaken: 0 },
        { id: 8, kills: 1, deaths: 0, damageDealt: 0, damageTaken: 0 },
      ],
    });
    expect(session.spectatorTarget([5, 6, 8])).toBe(5);
    expect(session.spectatorTarget([6, 8])).toBe(6);
    expect(session.spectatorTarget([9])).toBe(9);
    expect(session.spectatorTarget([])).toBeNull();
  });
});
