import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, DEFAULT_STATS, FFA_RESPAWN_WAIT_TICKS } from '@tanks/shared/engine';
import {
  ErrorCode,
  EventFlag,
  FfaInviteMiss,
  FfaPhase,
  MessageType,
  type FfaMatchStartMessage,
  type FfaScoreRow,
  type FfaSelf,
  type FfaSnapshotEvent,
  type FfaSnapshotMessage,
  type FfaStateMessage,
  type FfaTankSnapshot,
  type FfaWelcomeMessage,
} from '@tanks/shared/protocol';
import { feedText, FfaSession, type FfaHudModel } from './session.js';

const ME = 4;
const PHONE = { feedRows: 3, resultsTop: 5 };
const DESKTOP = { feedRows: 4, resultsTop: 10 };
const SUDDEN_DEATH_AT = 85;
// Зритель с момента 0: вводная карточка гаснет к 4 с, дальше видна плашка «Смотришь за».
const SPECTATOR_INTRO_END = 4000;
// Минута спустя: доигрывание конца матча давно кончилось.
const LATER = 60_000;

function welcome(playerId = ME, gameId = 'K7QX', inviteMiss: FfaInviteMiss = FfaInviteMiss.None): FfaWelcomeMessage {
  return {
    type: MessageType.FfaWelcome,
    playerId,
    token: 'пропуск',
    gameId,
    size: 10,
    rules: DEFAULT_RULES,
    inviteMiss,
    hasNetSmoothing: false,
  };
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
    suddenDeathAt: SUDDEN_DEATH_AT,
  };
}

function self(
  stateName: FfaSelf['state'],
  killerId: number | null = null,
  ticksLeft = 30,
  idleTicksLeft: number | null = null,
  isOut = false,
): FfaSelf {
  return { state: stateName, ticksLeft, killerId, idleTicksLeft, isOut };
}

function death(tank: number, by: number | null, flags = 0): FfaSnapshotEvent {
  return { kind: 'death', tank, by, x: 0, y: 0, value: 0, dx: 0, dy: 0, flags };
}

function suddenDeath(): FfaSnapshotEvent {
  return { kind: 'suddenDeath', tank: null, by: null, x: 0, y: 0, value: 0, dx: 0, dy: 0, flags: 0 };
}

function snapshot(tick: number, own: FfaSelf = self('alive'), events: FfaSnapshotEvent[] = []): FfaSnapshotMessage {
  return {
    type: MessageType.FfaSnapshot,
    tick,
    gameTick: tick,
    ackSeq: 0,
    hasSpareInput: false,
    self: own,
    tanks: [],
    kits: [],
    events,
    births: [],
    bounces: [],
    deaths: [],
  };
}

function tank(id: number, isAlive = true): FfaTankSnapshot {
  return { id, x: 100, y: 100, heading: 0, turret: 0, speed: 0, hp: 100, reloadLeft: 0, isAlive, shieldLeft: 0 };
}

function withTanks(message: FfaSnapshotMessage, tanks: FfaTankSnapshot[]): FfaSnapshotMessage {
  return { ...message, tanks };
}

function roster(...players: [number, string, boolean][]): Parameters<FfaSession['onRoster']>[0] {
  return {
    type: MessageType.FfaRoster,
    players: players.map(([id, nickname, isBot]) => ({ id, nickname, stats: DEFAULT_STATS, isBot })),
  };
}

function row(id: number, kills: number, deaths = 0, damageDealt = 0, damageTaken = 0): FfaScoreRow {
  return { id, kills, deaths, damageDealt, damageTaken };
}

function score(session: FfaSession, ...rows: FfaScoreRow[]): void {
  session.onScore({ type: MessageType.FfaScore, rows });
}

const WITH_BOT: [number, string, boolean][] = [
  [ME, 'Дима', false],
  [5, 'Вася', false],
  [6, 'Робот', true],
];

function inFight(players: [number, string, boolean][] = WITH_BOT): FfaSession {
  const session = new FfaSession(10);
  session.onWelcome(welcome(), 0);
  session.onRoster(roster(...players));
  session.onState(state(FfaPhase.Fight, 3600), 0);
  session.onMatchStart(matchStart());
  return session;
}

function hud(session: FfaSession, now = 0, layout = PHONE): FfaHudModel {
  return session.hud(now, layout);
}

describe('экран сессии', () => {
  it('до приветствия и состояния — подключение; лобби — игроки, места, минимум, старт по местным часам', () => {
    const session = new FfaSession(10);
    expect(session.screen(LATER)).toBe('connecting');
    session.onWelcome(welcome(), 0);
    expect(session.screen(LATER)).toBe('connecting');
    session.onState(state(FfaPhase.Lobby, null, 0), 1000);
    expect(session.screen(LATER)).toBe('lobby');
    expect(hud(session, 1000).lobby).toMatchObject({ players: 3, capacity: 10, minimum: 7, startInS: null });
    session.onState(state(FfaPhase.Lobby, 300, 0, 7), 2000);
    expect(hud(session, 4500).lobby?.startInS).toBeCloseTo(7.5, 9);
    expect(hud(session, 20_000).lobby?.startInS).toBe(0);
  });

  it('отсчёт — только когда известен матч с номером из состояния; до того держатся итоги', () => {
    const session = new FfaSession(10);
    session.onWelcome(welcome(), 0);
    session.onState(state(FfaPhase.Countdown, 90, 1), 0);
    expect(session.screen(LATER)).toBe('connecting');
    session.onMatchStart(matchStart(1));
    expect(session.screen(LATER)).toBe('countdown');
    session.onState(state(FfaPhase.Results, 450, 1), 0);
    expect(session.screen(LATER)).toBe('results');
    session.onState(state(FfaPhase.Countdown, 90, 2), 0);
    expect(session.screen(LATER)).toBe('results');
    expect(session.onMatchStart(matchStart(2))).toBe('new');
    expect(session.screen(LATER)).toBe('countdown');
  });

  it('отсчёт неизвестного матча держит экран прошлой фазы: после лобби — лобби, итоги → лобби → отсчёт — лобби', () => {
    const session = new FfaSession(10);
    session.onWelcome(welcome(), 0);
    session.onState(state(FfaPhase.Lobby, 300, 0, 7), 0);
    session.onState(state(FfaPhase.Countdown, 90, 1, 7), 0);
    expect(session.screen(LATER)).toBe('lobby');
    session.onMatchStart(matchStart(1));
    session.onState(state(FfaPhase.Fight, 3600, 1, 7), 0);
    session.onState(state(FfaPhase.Results, 450, 1, 7), 0);
    session.onState(state(FfaPhase.Lobby, null, 1, 3), 0);
    session.onState(state(FfaPhase.Lobby, 300, 1, 7), 0);
    session.onState(state(FfaPhase.Countdown, 90, 2, 7), 0);
    expect(session.screen(LATER)).toBe('lobby');
    expect(hud(session).results).toBeNull();
    session.onMatchStart(matchStart(2));
    expect(session.screen(LATER)).toBe('countdown');
  });

  it('бой: на поле — бой; подбит и ждёт — «подбит»; зритель — зритель; до снимка — подключение', () => {
    const session = inFight();
    expect(session.screen(LATER)).toBe('connecting');
    for (const [own, screen] of [
      ['alive', 'fight'],
      ['wreck', 'dead'],
      ['waiting', 'dead'],
      ['spectator', 'spectator'],
    ] as const) {
      session.acceptSnapshot(snapshot(10, self(own)), 0);
      expect(session.screen(LATER)).toBe(screen);
    }
  });

  it.each([
    [ErrorCode.Idle, 'idle'],
    [ErrorCode.Replaced, 'replaced'],
    [ErrorCode.BadProtocolVersion, 'update'],
    [ErrorCode.BadMessage, 'error'],
    [ErrorCode.RoomFull, 'error'],
  ] as const)('ошибка %i — окончательный экран %s, баннера связи нет', (code, screen) => {
    const session = inFight();
    session.onError(code);
    session.onDisconnect();
    expect(session.screen(LATER)).toBe(screen);
    expect(hud(session).connection).toBeNull();
  });
});

describe('возврат, повторы и устаревшие сообщения', () => {
  it('тот же игрок и игра — «ВЕРНУЛИСЬ!» на 2 с; другой номер — «НЕ УСПЕЛИ», состояние сброшено', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(10), 0);
    session.onDisconnect();
    expect(hud(session).connection).toBe('lost');
    expect(session.onWelcome(welcome(), 1000)).toBe('returned');
    expect(session.isConnectionLost).toBe(false);
    expect(session.screen(LATER)).toBe('fight');
    expect(hud(session, 2999).connection).toBe('returned');
    expect(hud(session, 3000).connection).toBeNull();
    expect(session.onWelcome(welcome(9), 5000)).toBe('lost');
    expect(session.screen(LATER)).toBe('connecting');
    expect(session.match).toBeNull();
    expect(hud(session, 6000).connection).toBe('late');
    expect(hud(session, 7000).connection).toBeNull();
    expect(session.onWelcome(welcome(9, 'ZZZZ'), 8000)).toBe('lost');
  });

  it('приглашение мимо: причина из приветствия видна 8 с; без промаха — ничего; окончательный экран её гасит', () => {
    const session = new FfaSession(10);
    session.onWelcome(welcome(ME, 'K7QX', FfaInviteMiss.Full), 1000);
    expect(hud(session, 1000).invite).toBe('full');
    expect(hud(session, 8999).invite).toBe('full');
    expect(hud(session, 9000).invite).toBeNull();
    session.onWelcome(welcome(9, 'ZZZZ', FfaInviteMiss.Gone), 10_000);
    expect(hud(session, 10_000).invite).toBe('gone');
    session.onError(ErrorCode.Idle);
    expect(hud(session, 10_000).invite).toBeNull();
    const fresh = new FfaSession(10);
    fresh.onWelcome(welcome(), 0);
    expect(hud(fresh, 0).invite).toBeNull();
  });

  it('повторный старт того же матча ничего не сбрасывает; снимок с меньшим тиком пропускается', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(100, self('alive'), [death(5, ME)]), 0);
    expect(session.onMatchStart(matchStart(1))).toBe('same');
    expect(hud(session).feed).toHaveLength(1);
    expect(session.acceptSnapshot(snapshot(99), 0)).toBe(false);
    expect(session.tick).toBe(100);
    expect(session.acceptSnapshot(snapshot(100), 0)).toBe(true);
    expect(session.onMatchStart(matchStart(2))).toBe('new');
    expect(session.acceptSnapshot(snapshot(1), 0)).toBe(true);
    expect(hud(session)).toMatchObject({ screen: 'fight', feed: [] });
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
    session.onWelcome(welcome(), 0);
    expect(session.acceptSnapshot(snapshot(1), 0)).toBe(false);
  });
});

describe('лобби', () => {
  it('состав — текущий, свой ник первым, боты отмечены; ушедший пропадает из облака, но не из кэша имён', () => {
    const session = new FfaSession(10);
    session.onWelcome(welcome(), 0);
    session.onState(state(FfaPhase.Lobby, null, 0), 0);
    session.onRoster(roster([5, 'Вася', false], [ME, 'Дима', false], [6, 'Робот', true]));
    expect(hud(session).lobby?.roster).toEqual([
      { id: ME, name: 'Дима', isBot: false, isMe: true },
      { id: 5, name: 'Вася', isBot: false, isMe: false },
      { id: 6, name: 'Робот', isBot: true, isMe: false },
    ]);
    session.onRoster(roster([ME, 'Дима', false], [6, 'Робот', true]));
    expect(hud(session).lobby?.roster.map((nick) => nick.id)).toEqual([ME, 6]);
    expect(session.nameOf(5)).toBe('Вася');
  });

  it('полная игра — признак полного сбора; назначенный старт полным не считается', () => {
    const session = new FfaSession(10);
    session.onWelcome(welcome(), 0);
    session.onState(state(FfaPhase.Lobby, 0, 0, 10), 0);
    expect(hud(session).lobby).toMatchObject({ isFull: true, startInS: 0 });
    session.onState(state(FfaPhase.Lobby, 150, 0, 8), 0);
    expect(hud(session).lobby).toMatchObject({ isFull: false, startInS: 5 });
  });
});

describe('отсчёт', () => {
  it('3, 2, 1 по местным часам, затем «В БОЙ!» — ещё 0,9 с после начала боя', () => {
    const session = new FfaSession(10);
    session.onWelcome(welcome(), 0);
    session.onState(state(FfaPhase.Countdown, 90), 1000);
    session.onMatchStart(matchStart());
    session.acceptSnapshot(snapshot(0), 1000);
    expect(hud(session, 1000).countdown).toEqual({ value: 3, isLanding: false });
    expect(hud(session, 2100).countdown?.value).toBe(2);
    expect(hud(session, 3100).countdown?.value).toBe(1);
    expect(hud(session, 4000).countdown?.value).toBeNull();
    session.onState(state(FfaPhase.Fight, 3600), 4050);
    expect(hud(session, 4900)).toMatchObject({ countdown: { value: null, isLanding: false }, scoreboard: null });
    expect(hud(session, 4950)).toMatchObject({ countdown: null, scoreboard: { timeLeftS: 120 } });
  });

  it('вошедший на отсчёте — «высаживаемся»; вошедший в бой «В БОЙ!» не видит', () => {
    const session = new FfaSession(10);
    session.onWelcome(welcome(), 0);
    session.onState(state(FfaPhase.Countdown, 60), 0);
    session.onMatchStart(matchStart());
    expect(hud(session).countdown).toEqual({ value: 2, isLanding: false });
    session.acceptSnapshot(snapshot(0, self('waiting', null, 0)), 0);
    expect(hud(session).countdown).toEqual({ value: 2, isLanding: true });
    const late = inFight();
    late.acceptSnapshot(snapshot(10), 0);
    expect(hud(late).countdown).toBeNull();
  });
});

describe('табло и лента', () => {
  it('место по общей таблице среди строк матча, счёт, таймер из тика, лидер; на первом месте — «ты лидер»', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(30 * 18), 0);
    score(session, row(5, 3, 1), row(ME, 1, 2), row(6, 1, 0));
    expect(hud(session).scoreboard).toEqual({
      timeLeftS: 102,
      isFinal: false,
      score: { place: 3, total: 3, kills: 1, deaths: 2 },
      leader: { name: 'Вася', kills: 3, isMe: false },
    });
    score(session, row(5, 3, 1), row(ME, 3, 0));
    expect(hud(session).scoreboard).toMatchObject({
      score: { place: 1, total: 2 },
      leader: { name: 'Дима', isMe: true },
    });
    expect(hud(session).scoreboard?.leader?.isMe).toBe(true);
    score(session, row(5, 0, 1), row(ME, 0, 0));
    expect(hud(session).scoreboard).toMatchObject({ score: { place: 1 }, leader: null });
  });

  it('лента: убийство, рикошетом, свой рикошет, зона, свои строки, убийца ушёл, номер не виден', () => {
    const session = inFight();
    session.acceptSnapshot(
      snapshot(5, self('alive'), [
        death(5, ME),
        death(6, ME, EventFlag.Ricochet),
        death(5, 5, EventFlag.Self | EventFlag.Ricochet),
        death(6, null, EventFlag.Zone),
        death(ME, 77),
      ]),
      1000,
    );
    session.onRoster(roster([ME, 'Дима', false]));
    const rows = hud(session, 1000, { feedRows: 10, resultsTop: 5 }).feed;
    expect(rows.map(feedText)).toEqual([
      'Неизвестный танкист ✕ Дима',
      'Робот ◎ сгорел в зоне',
      'Вася ↺ сам себя',
      'Дима ↺ Робот',
      'Дима ✕ Вася',
    ]);
    expect(rows.map((entry) => [entry.cause, entry.isMyKill, entry.isMyDeath])).toEqual([
      ['bullet', false, true],
      ['zone', false, false],
      ['self', false, false],
      ['ricochet', true, false],
      ['bullet', true, false],
    ]);
  });

  it('пять смертей подряд: на телефоне 3 строки, на компьютере 4, новые сверху; строка гаснет через 5 с', () => {
    const session = inFight();
    for (let index = 0; index < 5; index++) {
      session.acceptSnapshot(
        snapshot(index + 1, self('alive'), [death(index % 2 === 0 ? 5 : 6, ME)]),
        1000 + index * 100,
      );
    }
    expect(hud(session, 1500, PHONE).feed.map((entry) => entry.key)).toEqual([5, 4, 3]);
    expect(hud(session, 1500, DESKTOP).feed.map((entry) => entry.key)).toEqual([5, 4, 3, 2]);
    expect(hud(session, 1500, DESKTOP).feed[0]?.ageMs).toBe(100);
    expect(hud(session, 6250, DESKTOP).feed.map((entry) => entry.key)).toEqual([5, 4]);
    expect(hud(session, 6400, DESKTOP).feed).toEqual([]);
  });
});

describe('номер своего фрага', () => {
  it('F1 своё убийство выстрелом и рикошетом, два в одном тике — номера по порядку; чужое, в себя и зона — нет', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(10, self('alive'), [death(5, ME), death(6, 5)]), 0);
    session.acceptSnapshot(snapshot(20, self('alive'), [death(6, ME, EventFlag.Ricochet), death(7, ME)]), 0);
    session.acceptSnapshot(
      snapshot(30, self('alive'), [death(ME, ME, EventFlag.Self | EventFlag.Ricochet), death(5, null, EventFlag.Zone)]),
      0,
    );
    expect(session.ownKillNumber(10, 5)).toBe(1);
    expect(session.ownKillNumber(20, 6)).toBe(2);
    expect(session.ownKillNumber(20, 7)).toBe(3);
    expect(session.ownKillNumber(10, 6)).toBeNull();
    expect(session.ownKillNumber(30, ME)).toBeNull();
    expect(session.ownKillNumber(30, 5)).toBeNull();
  });

  it('F1 номер до прихода счёта с этим убийством и после — один и тот же', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(10, self('alive'), [death(5, ME)]), 0);
    score(session, row(ME, 1), row(5, 0, 1));
    session.acceptSnapshot(snapshot(20, self('alive'), [death(6, ME)]), 0);
    expect(session.ownKillNumber(20, 6)).toBe(2);
    score(session, row(ME, 2), row(5, 0, 1), row(6, 0, 1));
    expect(session.ownKillNumber(20, 6)).toBe(2);
  });

  it('F1 вернулся после обрыва — убийства за обрыв из счёта сервера; новый матч — снова с 1', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(10, self('alive'), [death(5, ME)]), 0);
    session.onDisconnect();
    session.onWelcome(welcome(), 5000);
    score(session, row(ME, 4), row(5, 0, 4));
    session.acceptSnapshot(snapshot(400, self('alive'), [death(5, ME)]), 5000);
    expect(session.ownKillNumber(400, 5)).toBe(5);
    session.onMatchStart(matchStart(2));
    score(session, row(ME, 0), row(5, 0));
    session.acceptSnapshot(snapshot(10, self('alive'), [death(5, ME)]), 9000);
    expect(session.ownKillNumber(10, 5)).toBe(1);
  });
});

describe('подбит и возрождение', () => {
  it.each([
    ['игрок', 5, 0, { kind: 'killed', killerName: 'Вася', isKillerBot: false, isRicochet: false }],
    ['бот', 6, 0, { kind: 'killed', killerName: 'Робот', isKillerBot: true, isRicochet: false }],
    ['рикошетом', 5, EventFlag.Ricochet, { kind: 'killed', killerName: 'Вася', isRicochet: true }],
    ['сам', ME, EventFlag.Self | EventFlag.Ricochet, { kind: 'self' }],
    ['зона', null, EventFlag.Zone, { kind: 'zone' }],
  ] as const)('%s — вид карточки по своему событию', (_name, by, flags, expected) => {
    const session = inFight();
    const killerId = (flags & (EventFlag.Self | EventFlag.Zone)) === 0 ? by : null;
    session.acceptSnapshot(snapshot(5, self('wreck', killerId, 60), [death(ME, by, flags)]), 0);
    expect(hud(session).death).toMatchObject(expected);
  });

  it('отсчёт до появления: подбит — обломки плюс ожидание, ждёт — своё, округление вверх, не меньше 1', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(5, self('wreck', 5, 60), [death(ME, 5)]), 0);
    expect(hud(session).death).toMatchObject({ respawnInS: Math.ceil((60 + FFA_RESPAWN_WAIT_TICKS) / 30) });
    session.acceptSnapshot(snapshot(6, self('wreck', 5, 1)), 0);
    expect(hud(session).death).toMatchObject({ respawnInS: Math.ceil((1 + FFA_RESPAWN_WAIT_TICKS) / 30) });
    session.acceptSnapshot(snapshot(7, self('waiting', 5, 31)), 0);
    expect(hud(session).death).toMatchObject({ respawnInS: 2 });
    session.acceptSnapshot(snapshot(8, self('waiting', 5, 0)), 0);
    expect(hud(session).death).toMatchObject({ respawnInS: 1 });
    session.acceptSnapshot(snapshot(9, self('alive')), 0);
    expect(hud(session).death).toBeNull();
  });

  it('вернулся подбитым без своего события — нейтральная карточка по убийце; убийцы нет — «тебя подбили»', () => {
    const session = inFight();
    session.onWelcome(welcome(), 0);
    session.acceptSnapshot(snapshot(6, self('wreck', 5)), 0);
    expect(session.screen(LATER)).toBe('dead');
    expect(hud(session).death).toMatchObject({ kind: 'killed', killerName: 'Вася', isRicochet: false });
    const zoned = inFight();
    score(zoned, row(ME, 0, 1));
    zoned.acceptSnapshot(snapshot(6, self('waiting', null, 20)), 0);
    expect(hud(zoned).death).toMatchObject({ kind: 'killed', killerName: null });
  });

  it('своё событие гибели забывается при возврате: сгорел в зоне, появился, вернулся подбитым — карточка по убийце', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(5, self('wreck', null, 60), [death(ME, null, EventFlag.Zone)]), 0);
    expect(hud(session).death).toMatchObject({ kind: 'zone' });
    session.acceptSnapshot(snapshot(200, self('alive')), 0);
    session.onWelcome(welcome(), 0);
    session.acceptSnapshot(snapshot(400, self('wreck', 5, 30)), 0);
    expect(hud(session).death).toMatchObject({ kind: 'killed', killerName: 'Вася', isRicochet: false });
  });

  it('ещё ни разу не погибал и ждёт высадки — карточки нет', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(6, self('waiting', null, 0)), 0);
    expect(hud(session).death).toBeNull();
  });

  it('финал наступил, пока подбит, сервер прислал «выбыл» — «ты выбыл» без отсчёта, после обломков зритель с той же карточкой; ждал — сразу', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(SUDDEN_DEATH_AT * 30 - 10, self('wreck', 5, 60), [death(ME, 5)]), 0);
    expect(hud(session).death?.kind).toBe('killed');
    session.acceptSnapshot(snapshot(SUDDEN_DEATH_AT * 30, self('wreck', 5, 50, null, true), [suddenDeath()]), 100);
    expect(hud(session, 100).death).toEqual({ kind: 'out' });
    session.acceptSnapshot(snapshot(SUDDEN_DEATH_AT * 30 + 50, self('spectator', 5, 0)), 2000);
    expect(session.screen(LATER)).toBe('spectator');
    expect(hud(session, 5999).death).toEqual({ kind: 'out' });
    expect(hud(session, 6000).death).toBeNull();
    const waiting = inFight();
    waiting.acceptSnapshot(snapshot(SUDDEN_DEATH_AT * 30 - 10, self('waiting', 5, 40), [death(ME, 5)]), 0);
    waiting.acceptSnapshot(snapshot(SUDDEN_DEATH_AT * 30, self('spectator', 5, 0), [suddenDeath()]), 100);
    expect(hud(waiting, 100)).toMatchObject({ screen: 'spectator', death: { kind: 'out' } });
  });
});

describe('финал', () => {
  it('с начала финала минус 5 с — «ФИНАЛ ЧЕРЕЗ 5…1» по времени матча; событие — «ФИНАЛ!» на 2 с', () => {
    const session = inFight([
      [ME, 'Дима', false],
      [5, 'Вася', false],
    ]);
    session.acceptSnapshot(snapshot((SUDDEN_DEATH_AT - 5) * 30 - 1), 0);
    expect(hud(session).final).toBeNull();
    session.acceptSnapshot(snapshot((SUDDEN_DEATH_AT - 5) * 30), 0);
    expect(hud(session).final).toEqual({ kind: 'soon', secondsLeft: 5, hasBots: false });
    session.acceptSnapshot(snapshot((SUDDEN_DEATH_AT - 1) * 30 + 1), 0);
    expect(hud(session).final).toEqual({ kind: 'soon', secondsLeft: 1, hasBots: false });
    session.acceptSnapshot(snapshot(SUDDEN_DEATH_AT * 30, self('alive'), [suddenDeath()]), 1000);
    expect(hud(session, 2999).final).toEqual({ kind: 'started', hasBots: false });
    expect(hud(session, 3000).final).toBeNull();
    expect(session.isFinal).toBe(true);
  });

  it('бот в матче: тексты про ботов не мигают, пока он ждёт возрождения; выбывшие и чужие боты не считаются', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot((SUDDEN_DEATH_AT - 5) * 30), 0);
    expect(hud(session).final).toEqual({ kind: 'soon', secondsLeft: 5, hasBots: true });
    session.acceptSnapshot(withTanks(snapshot(SUDDEN_DEATH_AT * 30, self('alive'), [suddenDeath()]), [tank(6)]), 1000);
    expect(hud(session, 1000).final).toEqual({ kind: 'started', hasBots: true });
    session.acceptSnapshot(withTanks(snapshot(SUDDEN_DEATH_AT * 30 + 1, self('alive'), [death(6, 5)]), []), 1100);
    expect(hud(session, 1100).final).toEqual({ kind: 'started', hasBots: false });

    const outAtStart = inFight();
    outAtStart.acceptSnapshot(
      withTanks(snapshot(SUDDEN_DEATH_AT * 30, self('alive'), [suddenDeath()]), [tank(6, false)]),
      1000,
    );
    expect(hud(outAtStart, 1000).final).toEqual({ kind: 'started', hasBots: false });

    const knockedOut = inFight();
    knockedOut.acceptSnapshot(withTanks(snapshot(SUDDEN_DEATH_AT * 30, self('alive'), [suddenDeath()]), [tank(6)]), 0);
    knockedOut.acceptSnapshot(
      withTanks(snapshot(SUDDEN_DEATH_AT * 30 + 1, self('alive'), [death(6, null, EventFlag.Out)]), [tank(6, false)]),
      100,
    );
    expect(hud(knockedOut, 100).final).toEqual({ kind: 'started', hasBots: false });

    const stranger = inFight([
      [ME, 'Дима', false],
      [5, 'Вася', false],
    ]);
    stranger.acceptSnapshot(withTanks(snapshot(SUDDEN_DEATH_AT * 30, self('alive'), [suddenDeath()]), [tank(9)]), 0);
    expect(hud(stranger).final).toEqual({ kind: 'started', hasBots: false });
  });

  it('подбит в финале: судьбу решает сервер — без «выбыл» карточка с отсчётом, с «выбыл» — «ты выбыл», даже при живом боте', () => {
    const session = inFight();
    session.acceptSnapshot(withTanks(snapshot(SUDDEN_DEATH_AT * 30, self('alive'), [suddenDeath()]), [tank(6)]), 0);
    const killed = withTanks(snapshot(SUDDEN_DEATH_AT * 30 + 10, self('wreck', 6, 50), [death(ME, 6)]), [tank(6)]);
    session.acceptSnapshot(killed, 1500);
    expect(hud(session, 1500).death).toMatchObject({
      kind: 'killed',
      killerName: 'Робот',
      isKillerBot: true,
      respawnInS: 4,
    });
    session.acceptSnapshot(withTanks(snapshot(SUDDEN_DEATH_AT * 30 + 70, self('waiting', 6, 40)), []), 3500);
    expect(hud(session, 3500).death).toMatchObject({ kind: 'killed', respawnInS: 2 });

    const out = inFight();
    out.acceptSnapshot(
      withTanks(snapshot(SUDDEN_DEATH_AT * 30 + 10, self('wreck', 5, 50, null, true), [death(ME, 5)]), [tank(6)]),
      0,
    );
    expect(hud(out).death).toEqual({ kind: 'out' });
  });

  it('бот выбыл за человека — строка ленты «выбыл»', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(SUDDEN_DEATH_AT * 30 + 1, self('alive'), [death(6, null, EventFlag.Out)]), 0);
    const rows = hud(session).feed;
    expect(rows).toMatchObject([{ victim: 'Робот', cause: 'out', isMyDeath: false, isMyKill: false }]);
    expect(rows.map(feedText)).toEqual(['Робот ⊘ выбыл']);
  });

  it('вернулся в финал — финал по тику без надписи «ФИНАЛ!»; вошёл в финал зрителем — «финал уже идёт»', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(SUDDEN_DEATH_AT * 30 + 90), 0);
    expect(session.isFinal).toBe(true);
    expect(hud(session).final).toBeNull();
    const late = inFight();
    late.acceptSnapshot(snapshot(SUDDEN_DEATH_AT * 30 + 90, self('spectator', null, 0)), 500);
    expect(hud(late, 500)).toMatchObject({ screen: 'spectator', death: { kind: 'late' } });
  });
});

describe('зритель', () => {
  function spectating(): FfaSession {
    const session = inFight();
    session.acceptSnapshot(snapshot(5, self('spectator', 5)), 0);
    score(session, row(6, 4), row(8, 2), row(5, 1), row(9, 0));
    return session;
  }

  it('пока показана вводная карточка, плашки нет: они делят низ экрана', () => {
    const session = spectating();
    session.followSpectator([5, 6]);
    expect(hud(session, SPECTATOR_INTRO_END - 1)).toMatchObject({ death: { kind: 'out' }, spectator: null });
    expect(hud(session, SPECTATOR_INTRO_END)).toMatchObject({ death: null, spectator: { name: 'Вася' } });
  });

  it('за убийцей на поле; иначе за лидером среди живых; живых без счёта — по номеру; живых нет — никого', () => {
    expect(spectating().followSpectator([5, 6, 8])).toBe(5);
    expect(spectating().followSpectator([8, 6])).toBe(6);
    expect(spectating().followSpectator([12, 11])).toBe(11);
    expect(spectating().followSpectator([])).toBeNull();
  });

  it('цель держится, пока жива, даже когда лидер сменился; касание — следующий по таблице по кругу', () => {
    const session = spectating();
    expect(session.followSpectator([5, 6, 8, 9])).toBe(5);
    score(session, row(8, 9), row(6, 4), row(5, 1), row(9, 0));
    expect(session.followSpectator([5, 6, 8, 9])).toBe(5);
    expect(session.nextSpectator([5, 6, 8, 9])).toBe(9);
    expect(session.nextSpectator([5, 6, 8, 9])).toBe(8);
    expect(session.spectating).toBe(8);
    expect(hud(session, SPECTATOR_INTRO_END).spectator).toEqual({ name: 'Неизвестный танкист', isBot: false });
  });

  it('цель погибла — следующий живой после неё; ушла из счёта — лидер; новый матч цель забывает', () => {
    const session = spectating();
    session.onRoster(roster([ME, 'Дима', false], [6, 'Гена', true], [8, 'Оля', false], [9, 'Коля', false]));
    session.nextSpectator([6, 8, 9]);
    expect(session.spectating).toBe(6);
    expect(session.followSpectator([8, 9])).toBe(8);
    expect(hud(session, SPECTATOR_INTRO_END).spectator).toEqual({ name: 'Оля', isBot: false });
    expect(session.followSpectator([6, 9])).toBe(9);
    session.nextSpectator([6, 8, 9]);
    session.nextSpectator([6, 8, 9]);
    expect(session.spectating).toBe(8);
    score(session, row(6, 4), row(9, 0));
    expect(session.followSpectator([6, 9])).toBe(6);
    expect(hud(session, SPECTATOR_INTRO_END).spectator).toEqual({ name: 'Гена', isBot: true });
    session.onMatchStart(matchStart(2));
    expect(session.spectating).toBeNull();
  });
});

describe('ты тут?', () => {
  it('отсчёт до выхода — пока сервер его присылает, с округлением вверх', () => {
    const session = inFight();
    session.acceptSnapshot(snapshot(5, self('alive', null, 0, 271)), 0);
    expect(hud(session).idleInS).toBe(10);
    session.acceptSnapshot(snapshot(6, self('alive')), 0);
    expect(hud(session).idleInS).toBeNull();
  });
});

describe('итоги', () => {
  function results(ownPlace: number, total: number, players = 9): FfaSession {
    const session = inFight();
    const rows = Array.from({ length: total }, (_, index) => row(100 + index, total - index, index));
    const own = rows[ownPlace - 1];
    if (own !== undefined) {
      own.id = ME;
    }
    score(session, ...rows);
    session.onState(state(FfaPhase.Results, 450, 1, players), 1000);
    return session;
  }

  it.each([
    [1, 9, 'champion'],
    [2, 6, 'podium'],
    [3, 6, 'podium'],
    [2, 4, 'solid'],
    [4, 9, 'solid'],
    [5, 9, 'nextTime'],
    [9, 9, 'nextTime'],
    [1, 1, 'champion'],
  ] as const)('место %i из %i — заголовок %s', (place, total, title) => {
    const model = hud(results(place, total)).results;
    expect(model).toMatchObject({ title, place, total });
  });

  it('не в матче — «следующий матч твой», места нет', () => {
    const session = inFight();
    score(session, row(5, 2), row(6, 1));
    session.onState(state(FfaPhase.Results, 450), 0);
    expect(hud(session).results).toMatchObject({ title: 'notPlayed', place: null, total: 2 });
  });

  it('телефон: пятёрка лучших и своя строка с соседями после пропуска; компьютер — десятка', () => {
    const phone = hud(results(12, 20)).results?.rows ?? [];
    expect(phone.map((entry) => [entry.place, entry.isAfterGap, entry.isMe])).toEqual([
      [1, false, false],
      [2, false, false],
      [3, false, false],
      [4, false, false],
      [5, false, false],
      [11, true, false],
      [12, false, true],
      [13, false, false],
    ]);
    const desktop = hud(results(11, 11), 0, DESKTOP).results?.rows ?? [];
    expect(desktop.map((entry) => entry.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(desktop.some((entry) => entry.isAfterGap)).toBe(false);
    expect(hud(results(6, 6)).results?.rows.map((entry) => [entry.place, entry.isAfterGap])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, false],
      [5, false],
      [6, false],
    ]);
  });

  it('польза — тем же кодом, что на сервере; без урона и смертей — нет; имена и боты из кэша', () => {
    const session = inFight();
    score(session, row(ME, 3, 1, 400, 250), row(6, 0, 0, 100, 0));
    session.onState(state(FfaPhase.Results, 450), 0);
    const rows = hud(session).results?.rows ?? [];
    expect(rows[0]).toMatchObject({ name: 'Дима', isMe: true, isBot: false, kills: 3, deaths: 1 });
    expect(rows[0]?.efficiency).toBeCloseTo((400 + 150 * 3) / (250 + 150), 12);
    expect(rows[1]).toMatchObject({ name: 'Робот', isBot: true, efficiency: null });
  });

  it('следующий матч через N по местным часам; игроков меньше минимума — ждём сбора, затем лобби', () => {
    const session = results(2, 6, 7);
    expect(hud(session, 1000).results?.nextMatchInS).toBe(15);
    expect(hud(session, 3500).results?.nextMatchInS).toBe(13);
    session.onState(state(FfaPhase.Results, 300, 1, 6), 4000);
    expect(hud(session, 4000).results?.nextMatchInS).toBeNull();
    session.onState(state(FfaPhase.Lobby, null, 1, 6), 14_000);
    expect(hud(session, 14_000)).toMatchObject({ screen: 'lobby', results: null });
  });

  it.each([
    ['на поле', self('alive'), true],
    ['подбит, за него выбыл бот', self('wreck', 5), true],
    ['ждёт возрождения, за него выбыл бот', self('waiting'), true],
    ['выбыл', self('wreck', 5, 30, null, true), false],
    ['зритель', self('spectator', 5), false],
  ] as const)('F5 последний снимок финала — %s: «выжил в финале» — %s', (_, last, hasSurvived) => {
    const session = inFight();
    session.acceptSnapshot(snapshot(120 * 30, last), 900);
    score(session, row(ME, 2, 1), row(5, 1, 2));
    session.onState(state(FfaPhase.Results, 450), 1000);
    expect(hud(session, LATER).results?.hasSurvived).toBe(hasSurvived);
  });

  it('F8 конец матча вживую: 2 с поля — бой, лента с последним убийством, без «Ты тут?»; затем итоги', () => {
    const session = inFight();
    score(session, row(ME, 1), row(5, 0, 1));
    session.acceptSnapshot(snapshot(120 * 30, self('alive', null, 30, 3), [death(5, ME)]), 900);
    session.onState(state(FfaPhase.Results, 210), 1000);
    expect(hud(session, 1000)).toMatchObject({ screen: 'fight', results: null, idleInS: null });
    expect(hud(session, 1000).feed.map(feedText)).toEqual(['Дима ✕ Вася']);
    expect(hud(session, 2999).screen).toBe('fight');
    expect(hud(session, 3000)).toMatchObject({ screen: 'results', results: { place: 1 } });
  });

  it('F8 подбит последним ботом — 2 с карточка «выбыл», затем итоги; давний снимок или возврат после обрыва — итоги сразу', () => {
    const killed = inFight();
    killed.acceptSnapshot(snapshot(120 * 30, self('wreck', 6, 30, null, true), [death(ME, 6)]), 900);
    killed.onState(state(FfaPhase.Results, 210), 1000);
    expect(hud(killed, 1500)).toMatchObject({ screen: 'dead', death: { kind: 'out' } });
    expect(hud(killed, 3000).screen).toBe('results');
    const stale = inFight();
    stale.acceptSnapshot(snapshot(100 * 30), 0);
    stale.onState(state(FfaPhase.Results, 210), 2000);
    expect(hud(stale, 2000).screen).toBe('results');
    const returned = inFight();
    returned.acceptSnapshot(snapshot(120 * 30), 900);
    returned.onDisconnect();
    returned.onWelcome(welcome(), 1200);
    returned.onState(state(FfaPhase.Results, 210), 1300);
    expect(hud(returned, 1300).screen).toBe('results');
  });

  it('F5 матч кончился до финала, вошёл или вернулся после обрыва на итоги без снимка, не играл — «выжил» нет', () => {
    const early = inFight();
    early.acceptSnapshot(snapshot((SUDDEN_DEATH_AT - 1) * 30), 900);
    score(early, row(ME, 2), row(5, 1));
    early.onState(state(FfaPhase.Results, 450), 1000);
    expect(hud(early, LATER).results?.hasSurvived).toBe(false);
    expect(hud(results(2, 6), 1000).results?.hasSurvived).toBe(false);
    const returned = inFight();
    returned.acceptSnapshot(snapshot((SUDDEN_DEATH_AT + 5) * 30, self('alive')), 900);
    returned.onDisconnect();
    returned.onWelcome(welcome(), 5000);
    score(returned, row(ME, 2, 1), row(5, 1, 2));
    returned.onState(state(FfaPhase.Results, 450), 5000);
    expect(hud(returned, 5000).results).toMatchObject({ place: 1, hasSurvived: false });
    const late = inFight();
    late.acceptSnapshot(snapshot(120 * 30, self('alive')), 900);
    score(late, row(5, 1), row(6, 0));
    late.onState(state(FfaPhase.Results, 450), 1000);
    expect(hud(late, LATER).results).toMatchObject({ place: null, hasSurvived: false });
  });

  it('итоги держатся до старта следующего матча; новый матч — нулевой счёт, лента и табло пусты', () => {
    const session = results(2, 6, 7);
    session.acceptSnapshot(snapshot(200, self('alive'), [death(5, ME)]), 900);
    session.onState(state(FfaPhase.Countdown, 90, 2, 7), 1000);
    expect(hud(session, 1000).screen).toBe('results');
    session.onMatchStart(matchStart(2));
    score(session, row(ME, 0), row(5, 0));
    session.acceptSnapshot(snapshot(0), 1000);
    const next = hud(session, 1000);
    expect(next).toMatchObject({ screen: 'countdown', countdown: { value: 3 }, results: null });
    expect(session.score()).toEqual({ place: 1, total: 2, kills: 0, deaths: 0 });
    session.onState(state(FfaPhase.Fight, 3600, 2, 7), 4000);
    expect(hud(session, 4000)).toMatchObject({ screen: 'fight', feed: [], scoreboard: null });
    expect(hud(session, 5000)).toMatchObject({ feed: [], scoreboard: { score: { kills: 0 } } });
  });
});
