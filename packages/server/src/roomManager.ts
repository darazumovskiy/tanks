import { DEFAULT_RULES, type FfaSize, type RoundRules, type Stats } from '@tanks/shared/engine';
import { botLevelOf, FfaInviteMiss, isBotRoomCode } from '@tanks/shared/protocol';
import { createBot } from './bots/ladder.js';
import { BotTurns, type BotTurnReport } from './crowd/botTurns.js';
import { DEFAULT_FFA_OPTIONS, FfaGame, type FfaConnection, type FfaOptions, type FfaSeat } from './ffaGame.js';
import { NO_LOG, type GameLog } from './gameLog.js';
import {
  emptyPlayerCounts,
  NO_DROP_COUNTER,
  type InputDropCounter,
  type PlayerCounts,
  type PlayerMode,
} from './metrics.js';
import { DEFAULT_ROOM_OPTIONS, Room, type Connection, type RoomOptions, type Seat } from './room.js';

const CODE_PATTERN = /^[a-z0-9]{3,16}$/;
const FFA_MODES: Readonly<Record<FfaSize, PlayerMode>> = { 10: 'ffa10', 30: 'ffa30', 50: 'ffa50' };

// Код с префиксом бота обязан нести заполненный уровень.
export function isValidRoomCode(code: string): boolean {
  if (!CODE_PATTERN.test(code)) {
    return false;
  }
  return !isBotRoomCode(code) || botLevelOf(code) !== null;
}

// gameId — номер игры из приглашения друга, пусто — любая игра этого размера.
export interface FfaJoinRequest {
  nickname: string;
  stats: Stats;
  token: string;
  isBot: boolean;
  gameId: string;
}

// quit — уход по кнопке «Выйти»; release — что сделать с комнатой после ухода соединения.
interface Membership {
  seat: Seat;
  quit: () => void;
  release: () => void;
}

function inviteMissOf(gameId: string, isGameFound: boolean): FfaInviteMiss {
  if (gameId === '') {
    return FfaInviteMiss.None;
  }
  return isGameFound ? FfaInviteMiss.Full : FfaInviteMiss.Gone;
}

// Держит все комнаты дуэлей и общие игры процесса и крутит общий тик; пустые удаляются.
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private games: FfaGame[] = [];
  private readonly memberships = new Map<Connection, Membership>();
  private readonly botSeats = new Map<Room, Seat>();
  private readonly botTurns = new BotTurns();

  constructor(
    private readonly options: RoomOptions = DEFAULT_ROOM_OPTIONS,
    private readonly random: () => number = Math.random,
    private readonly log: GameLog = NO_LOG,
    private readonly dropCounter: InputDropCounter = NO_DROP_COUNTER,
    private readonly rules: Readonly<RoundRules> = DEFAULT_RULES,
    private readonly ffaOptions: FfaOptions = DEFAULT_FFA_OPTIONS,
  ) {}

  get roomCount(): number {
    return this.rooms.size + this.games.length;
  }

  // Комната бота создаётся с ботом на месте 0; код уже проверен isValidRoomCode.
  getOrCreate(code: string): Room {
    const existing = this.rooms.get(code);
    if (existing !== undefined) {
      return existing;
    }
    const room = new Room(code, this.options, this.log, this.dropCounter, this.rules);
    this.rooms.set(code, room);
    const level = botLevelOf(code);
    if (level !== null) {
      const bot = createBot(level, this.random, (connection, nickname, stats) =>
        room.join(0, connection, nickname, stats),
      );
      this.botSeats.set(room, bot.seat);
    }
    return room;
  }

  seatOf(connection: Connection): Seat | undefined {
    return this.memberships.get(connection)?.seat;
  }

  // В дуэли выход кнопкой — то же, что закрытие соединения.
  attach(connection: Connection, room: Room, seat: Seat): void {
    this.memberships.set(connection, {
      seat,
      quit: () => {
        seat.leave();
      },
      release: () => {
        this.releaseRoom(room);
      },
    });
  }

  // Пропуск живого игрока возвращает его место; прежнее соединение отвязывается и закрывается.
  // Иначе — игра из приглашения, если в ней есть место для участника; нет — игра этого размера с местом и наибольшим
  // числом участников или новая, а вошедший узнаёт, почему он не у друга.
  joinFfa(size: FfaSize, connection: FfaConnection, request: FfaJoinRequest): void {
    for (const game of request.token === '' ? [] : this.games) {
      const result = game.rejoin(request.token, connection);
      if (result === null) {
        continue;
      }
      if (result.previous !== null) {
        this.memberships.delete(result.previous);
        result.previous.close();
      }
      this.attachFfa(connection, result.seat);
      return;
    }
    const invited = this.games.find((game) => game.id === request.gameId && game.size === size);
    if (invited?.hasFreeSeat === true) {
      this.attachFfa(connection, invited.join(connection, request.nickname, request.stats, request.isBot));
      return;
    }
    const miss = inviteMissOf(request.gameId, invited !== undefined);
    const game = this.pickGame(size);
    this.attachFfa(connection, game.join(connection, request.nickname, request.stats, request.isBot, miss));
  }

  // Ушло соединение: место освобождается; общая игра держит игрока сама и удаляется в тике, когда опустеет.
  detach(connection: Connection): void {
    this.endMembership(connection, (membership) => {
      membership.seat.leave();
    });
  }

  // Игрок ушёл кнопкой: соединение отвязано от места, его команды и закрытие место больше не трогают.
  quit(connection: Connection): void {
    this.endMembership(connection, (membership) => {
      membership.quit();
    });
  }

  step(lateMs: number): void {
    for (const room of this.rooms.values()) {
      room.step(lateMs);
    }
    for (const game of this.games) {
      game.step();
    }
    this.games = this.games.filter((game) => !game.isEmpty);
  }

  // Проход хода серверных ботов всех игр: все разбирают ящики, решают по очереди в бюджете.
  thinkBots(isOverBudget: () => boolean): BotTurnReport {
    for (const game of this.games) {
      game.absorbBots();
    }
    return this.botTurns.take(
      this.games.flatMap((game) => game.serverBots),
      isOverBudget,
    );
  }

  // Бот лестницы в дуэли — серверный бот, как в общей игре.
  playerCounts(): PlayerCounts {
    const counts = emptyPlayerCounts();
    for (const room of this.rooms.values()) {
      const bots = Number(this.botSeats.has(room));
      counts.duel.human += room.playerCount - bots;
      counts.duel.bot += bots;
    }
    for (const game of this.games) {
      const kinds = game.playerKinds;
      const entry = counts[FFA_MODES[game.size]];
      entry.human += kinds.humans;
      entry.bot += kinds.serverBots;
      entry.swarm += kinds.swarmBots;
    }
    return counts;
  }

  private attachFfa(connection: FfaConnection, seat: FfaSeat): void {
    this.memberships.set(connection, {
      seat,
      quit: () => {
        seat.quit();
      },
      release: () => undefined,
    });
  }

  private endMembership(connection: Connection, leave: (membership: Membership) => void): void {
    const membership = this.memberships.get(connection);
    if (membership === undefined) {
      return;
    }
    this.memberships.delete(connection);
    leave(membership);
    membership.release();
  }

  private pickGame(size: FfaSize): FfaGame {
    const open = this.games.filter((game) => game.size === size && game.hasFreeSeat);
    const fullest = open.reduce<FfaGame | null>(
      (best, game) => (best === null || game.participantCount > best.participantCount ? game : best),
      null,
    );
    if (fullest !== null) {
      return fullest;
    }
    const game = new FfaGame(size, this.ffaOptions, this.log, this.dropCounter, this.rules);
    this.games.push(game);
    return game;
  }

  // В комнате с ботом один человек: ушёл он — бот снимается; пустая комната удаляется.
  private releaseRoom(room: Room): void {
    const botSeat = this.botSeats.get(room);
    if (botSeat !== undefined) {
      botSeat.leave();
      this.botSeats.delete(room);
    }
    if (room.isEmpty) {
      this.rooms.delete(room.code);
    }
  }
}
