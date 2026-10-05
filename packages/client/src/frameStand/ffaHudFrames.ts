import { DEFAULT_RULES, DEFAULT_STATS, TICK_RATE, type FfaSize } from '@tanks/shared/engine';
import {
  ErrorCode,
  EventFlag,
  FfaPhase,
  MessageType,
  type FfaRosterEntry,
  type FfaScoreRow,
  type FfaSelf,
  type FfaSnapshotEvent,
} from '@tanks/shared/protocol';
import { FfaSession } from '../ffa/session.js';
import { BASE, CROWD, CROWD_FRAME, STAND_ME, type FfaStandFrame, type StandTank } from './ffaFrames.js';
import type { FrameScreenId } from './model.js';

// Кадры интерфейса матча поверх настоящего кадра поля: сессия доведена до экрана теми же сообщениями, что прислал
// бы сервер, интерфейс рисует настоящий `FfaHud`. Снимок — страница целиком.

export interface FfaHudFrame {
  id: string;
  title: string;
  screens: readonly FrameScreenId[];
  scene: FfaStandFrame;
  // Свой танк на поле: на телефоне видна «АВТО».
  hasFieldControls: boolean;
  build: () => FfaHudScript;
}

export interface FfaHudScript {
  session: FfaSession;
  now: number;
}

const PHONE: readonly FrameScreenId[] = ['phone'];
const BOTH: readonly FrameScreenId[] = ['phone', 'desktop'];
const NOW = 100_000;
const MATCH_SECONDS = 120;
const SUDDEN_DEATH_AT = 85;
const RESULTS_TICKS = 15 * TICK_RATE;
const VASYA = 2;
const SHARIK = 7;
const DEFAULT_SIZE: FfaSize = 30;
// Минимум для старта — как у сервера по умолчанию.
const MINIMUM_BY_SIZE: Readonly<Record<FfaSize, number>> = { 10: 7, 30: 20, 50: 35 };
const FATAL_CODES = {
  idle: ErrorCode.Idle,
  replaced: ErrorCode.Replaced,
  update: ErrorCode.BadProtocolVersion,
  error: ErrorCode.BadMessage,
} as const;
const RESULTS_PLAYERS = 24;
// В игре к итогам набралось на следующий матч: строка — отсчёт, а не ожидание сбора.
const PLAYERS_AFTER_RESULTS = 40;
// Своё место в итогах — в середине таблицы: видны лучшие, пропуск и своя строка с соседями.
const RESULTS_OWN_INDEX = 13;

// Ники облака лобби: люди и боты вперемешку, разной длины.
const LOBBY_NAMES = [
  'Дима',
  'Вася',
  'Петя_Танк',
  'Оля',
  'Гена',
  'МашаРаш',
  'Шарик',
  'Коля',
  'Лёша',
  'Светик',
  'Новенький',
  'Ира',
  'Бухгалтер',
  'Серёга77',
  'Катя',
  'Антоха',
  'Юля',
  'Тимлид',
  'Рома',
  'Женя',
  'Броня_Крепка',
  'Миша',
  'Аня',
  'Стажёр',
  'Паша',
  'Лена',
  'Кузя',
  'Денис',
  'ОфисныйТигр',
  'Наташа',
  'Вова',
  'Ника',
  'Гоша',
  'Таня',
  'Игорёк',
  'Саша',
  'Полина',
  'Артём',
  'Даша',
  'Кирилл',
  'Влад',
  'Соня',
  'Макс',
  'Вика',
  'Егор',
  'Алиса',
  'Федя',
  'Настя',
  'Глеб',
  'Ксюша',
];
const BOT_EVERY = 4;

function lobbyRoster(count: number): FfaRosterEntry[] {
  return LOBBY_NAMES.slice(0, count).map((nickname, index) => ({
    id: index + 1,
    nickname,
    stats: DEFAULT_STATS,
    isBot: index % BOT_EVERY === BOT_EVERY - 1,
  }));
}

function crowdRoster(): FfaRosterEntry[] {
  return CROWD.map((tank) => ({ id: tank.id, nickname: tank.name, stats: DEFAULT_STATS, isBot: tank.isBot === true }));
}

function joined(size: FfaSize, roster: FfaRosterEntry[]): FfaSession {
  const session = new FfaSession(size);
  session.onWelcome(
    { type: MessageType.FfaWelcome, playerId: STAND_ME, token: 'стенд', gameId: 'K7QX', size, rules: DEFAULT_RULES },
    0,
  );
  session.onRoster({ type: MessageType.FfaRoster, players: roster });
  return session;
}

function setState(
  session: FfaSession,
  phase: FfaPhase,
  ticksLeft: number | null,
  players: number,
  at: number,
  matchIndex = 1,
): void {
  session.onState(
    {
      type: MessageType.FfaState,
      phase,
      ticksLeft,
      players,
      capacity: session.size,
      minimum: MINIMUM_BY_SIZE[session.size],
      matchIndex,
    },
    at,
  );
}

function startMatch(session: FfaSession): void {
  session.onMatchStart({
    type: MessageType.FfaMatchStart,
    matchIndex: 1,
    durationSeconds: MATCH_SECONDS,
    zone: { startRadius: 3200, finalRadius: 850, startShrink: 45, endShrink: 105 },
    suddenDeathAt: SUDDEN_DEATH_AT,
  });
}

function self(state: FfaSelf['state'], overrides: Partial<FfaSelf> = {}): FfaSelf {
  return { state, ticksLeft: 0, killerId: null, idleTicksLeft: null, ...overrides };
}

function snapshot(session: FfaSession, tick: number, own: FfaSelf, events: FfaSnapshotEvent[], at: number): void {
  session.acceptSnapshot(
    {
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
    },
    at,
  );
}

function death(tank: number, by: number | null, flags = 0): FfaSnapshotEvent {
  return { kind: 'death', tank, by, x: 0, y: 0, value: 0, dx: 0, dy: 0, flags };
}

function suddenDeath(): FfaSnapshotEvent {
  return { kind: 'suddenDeath', tank: null, by: null, x: 0, y: 0, value: 0, dx: 0, dy: 0, flags: 0 };
}

function score(session: FfaSession, rows: readonly [number, number, number, number, number][]): void {
  const scoreRows: FfaScoreRow[] = rows.map(([id, kills, deaths, damageDealt, damageTaken]) => ({
    id,
    kills,
    deaths,
    damageDealt,
    damageTaken,
  }));
  session.onScore({ type: MessageType.FfaScore, rows: scoreRows });
}

const CROWD_SCORE: readonly [number, number, number, number, number][] = [
  [VASYA, 5, 1, 520, 160],
  [STAND_ME, 3, 1, 340, 180],
  [3, 3, 2, 300, 260],
  [4, 2, 0, 230, 60],
  [5, 2, 3, 210, 330],
  [6, 1, 1, 150, 140],
  [SHARIK, 1, 2, 120, 220],
  [8, 1, 0, 90, 40],
  [9, 0, 2, 40, 280],
  [10, 0, 1, 30, 120],
  [11, 0, 0, 0, 0],
  [12, 0, 1, 20, 150],
];

function lobby(size: FfaSize, players: number, ticksLeft: number | null): FfaHudScript {
  const session = joined(size, lobbyRoster(players));
  setState(session, FfaPhase.Lobby, ticksLeft, players, NOW);
  return { session, now: NOW };
}

// Бой идёт: счёт и лента — пять смертей за последние секунды, одна — своя победа.
function fighting(own: FfaSelf, tick: number): FfaSession {
  const session = joined(50, crowdRoster());
  setState(session, FfaPhase.Fight, MATCH_SECONDS * TICK_RATE - tick, CROWD.length, 0);
  startMatch(session);
  score(session, CROWD_SCORE);
  snapshot(session, tick - 4, self('alive'), [death(9, VASYA)], NOW - 3800);
  snapshot(session, tick - 3, self('alive'), [death(10, null, EventFlag.Zone)], NOW - 2600);
  snapshot(session, tick - 2, self('alive'), [death(12, STAND_ME)], NOW - 1500);
  snapshot(session, tick - 1, self('alive'), [death(6, SHARIK, EventFlag.Ricochet)], NOW - 700);
  snapshot(session, tick, own, [], NOW - 16);
  return session;
}

function withOwn(change: Partial<StandTank>): readonly StandTank[] {
  return CROWD.map((tank) => (tank.id === STAND_ME ? { ...tank, ...change } : tank));
}

const FLOOR_SCENE: FfaStandFrame = {
  ...BASE,
  id: 'hud-floor',
  title: 'пол карты по центру без танков',
  screens: PHONE,
  myId: null,
  focus: { x: 2600, y: 1450 },
  tanks: [],
  hasKits: false,
  zoneTimeS: null,
};
const WRECK_SCENE: FfaStandFrame = { ...CROWD_FRAME, tanks: withOwn({ hp: 0, isAlive: false }), bullets: [] };
const SPECTATOR_SCENE: FfaStandFrame = {
  ...CROWD_FRAME,
  myId: null,
  focus: CROWD[1] ?? BASE.focus,
  tanks: CROWD.filter((tank) => tank.id !== STAND_ME),
  bullets: [],
};

export const FFA_HUD_FRAMES: readonly FfaHudFrame[] = [
  {
    id: 'hud-connecting',
    title: 'подключение: пол затемнён',
    screens: PHONE,
    scene: FLOOR_SCENE,
    hasFieldControls: false,
    build: () => ({ session: new FfaSession(DEFAULT_SIZE), now: NOW }),
  },
  {
    id: 'hud-lobby-few',
    title: 'лобби: меньше минимума',
    screens: PHONE,
    scene: FLOOR_SCENE,
    hasFieldControls: false,
    build: () => lobby(DEFAULT_SIZE, 4, null),
  },
  {
    id: 'hud-lobby-start',
    title: 'лобби: минимум набран, старт назначен',
    screens: BOTH,
    scene: FLOOR_SCENE,
    hasFieldControls: false,
    build: () => lobby(DEFAULT_SIZE, 22, 7 * TICK_RATE),
  },
  {
    id: 'hud-lobby-full',
    title: 'лобби: полный сбор',
    screens: PHONE,
    scene: FLOOR_SCENE,
    hasFieldControls: false,
    build: () => lobby(DEFAULT_SIZE, 30, 0),
  },
  {
    id: 'hud-lobby-50',
    title: 'лобби на 50: облако в две строки и «+N»',
    screens: PHONE,
    scene: FLOOR_SCENE,
    hasFieldControls: false,
    build: () => lobby(50, 50, 0),
  },
  {
    id: 'hud-countdown',
    title: 'отсчёт: цифра в верхней полосе над своим танком',
    screens: PHONE,
    scene: CROWD_FRAME,
    hasFieldControls: true,
    build: () => {
      const session = joined(50, crowdRoster());
      setState(session, FfaPhase.Countdown, 3 * TICK_RATE, CROWD.length, NOW - 1200);
      startMatch(session);
      snapshot(session, 0, self('alive'), [], NOW - 16);
      return { session, now: NOW };
    },
  },
  {
    id: 'hud-fight',
    title: 'бой: табло, лента из 3 строк рядом с «АВТО»',
    screens: PHONE,
    scene: CROWD_FRAME,
    hasFieldControls: true,
    build: () => ({ session: fighting(self('alive'), 58 * TICK_RATE), now: NOW }),
  },
  {
    id: 'hud-death',
    title: '«тебя подбил» с отсчётом до появления',
    screens: PHONE,
    scene: WRECK_SCENE,
    hasFieldControls: false,
    build: () => {
      const session = fighting(self('alive'), 58 * TICK_RATE);
      snapshot(
        session,
        58 * TICK_RATE + 1,
        self('wreck', { killerId: VASYA, ticksLeft: 50 }),
        [death(STAND_ME, VASYA, EventFlag.Ricochet)],
        NOW - 8,
      );
      return { session, now: NOW };
    },
  },
  {
    id: 'hud-out',
    title: '«ты выбыл» в финале',
    screens: PHONE,
    scene: WRECK_SCENE,
    hasFieldControls: false,
    build: () => {
      const tick = (SUDDEN_DEATH_AT + 6) * TICK_RATE;
      const session = fighting(self('alive'), tick);
      snapshot(
        session,
        tick + 1,
        self('wreck', { killerId: SHARIK, ticksLeft: 40 }),
        [death(STAND_ME, SHARIK)],
        NOW - 8,
      );
      return { session, now: NOW };
    },
  },
  {
    id: 'hud-final',
    title: 'предупреждение о финале под таймером',
    screens: PHONE,
    scene: CROWD_FRAME,
    hasFieldControls: true,
    build: () => ({ session: fighting(self('alive'), (SUDDEN_DEATH_AT - 3) * TICK_RATE + 10), now: NOW }),
  },
  {
    id: 'hud-final-start',
    title: '«ФИНАЛ!» под таймером',
    screens: PHONE,
    scene: CROWD_FRAME,
    hasFieldControls: true,
    build: () => {
      const tick = SUDDEN_DEATH_AT * TICK_RATE;
      const session = fighting(self('alive'), tick - 1);
      snapshot(session, tick, self('alive'), [suddenDeath()], NOW - 400);
      return { session, now: NOW };
    },
  },
  {
    id: 'hud-idle',
    title: '«Ты тут?» под таймером',
    screens: PHONE,
    scene: CROWD_FRAME,
    hasFieldControls: true,
    build: () => ({ session: fighting(self('alive', { idleTicksLeft: 265 }), 58 * TICK_RATE), now: NOW }),
  },
  {
    id: 'hud-spectator',
    title: 'зритель: плашка внизу, за убийцей',
    screens: PHONE,
    scene: SPECTATOR_SCENE,
    hasFieldControls: false,
    build: () => {
      const tick = (SUDDEN_DEATH_AT + 10) * TICK_RATE;
      const session = fighting(self('alive'), tick);
      snapshot(session, tick + 1, self('spectator', { killerId: VASYA }), [], NOW - 6000);
      return { session, now: NOW };
    },
  },
  {
    id: 'hud-results',
    title: 'итоги: лучшие и своя строка с соседями',
    screens: BOTH,
    scene: CROWD_FRAME,
    hasFieldControls: false,
    build: () => {
      const session = joined(50, lobbyRoster(RESULTS_PLAYERS));
      setState(session, FfaPhase.Fight, 600, RESULTS_PLAYERS, 0);
      startMatch(session);
      const others = lobbyRoster(RESULTS_PLAYERS)
        .map((player) => player.id)
        .filter((id) => id !== STAND_ME);
      const order = [...others.slice(0, RESULTS_OWN_INDEX), STAND_ME, ...others.slice(RESULTS_OWN_INDEX)];
      score(
        session,
        order.map((id, index): [number, number, number, number, number] => {
          const kills = Math.max(0, 12 - index);
          return [id, kills, 1 + (index % 4), 120 + kills * 60, 90 + (index % 5) * 70];
        }),
      );
      setState(session, FfaPhase.Results, RESULTS_TICKS, PLAYERS_AFTER_RESULTS, NOW - 3000);
      return { session, now: NOW };
    },
  },
  ...(['idle', 'replaced', 'update', 'error'] as const).map((kind): FfaHudFrame => ({
    id: `hud-fatal-${kind}`,
    title: `окончательный экран: ${kind}`,
    screens: PHONE,
    scene: FLOOR_SCENE,
    hasFieldControls: false,
    build: () => {
      const session = lobby(DEFAULT_SIZE, 12, null).session;
      session.onError(FATAL_CODES[kind]);
      return { session, now: NOW };
    },
  })),
  {
    id: 'hud-connection',
    title: 'баннер «связь пропала» поверх боя',
    screens: PHONE,
    scene: CROWD_FRAME,
    hasFieldControls: true,
    build: () => {
      const session = fighting(self('alive'), 58 * TICK_RATE);
      session.onDisconnect();
      return { session, now: NOW };
    },
  },
];
