import { DEFAULT_RULES, type FfaSize, type RoundRules, type Stats } from '@tanks/shared/engine';
import { botLevelOf, isBotRoomCode } from '@tanks/shared/protocol';
import { createBot } from './bots/ladder.js';
import { DEFAULT_FFA_OPTIONS, FfaGame, type FfaConnection, type FfaOptions } from './ffaGame.js';
import { NO_LOG, type GameLog } from './gameLog.js';
import { NO_DROP_COUNTER, type InputDropCounter } from './metrics.js';
import { DEFAULT_ROOM_OPTIONS, Room, type Connection, type RoomOptions, type Seat } from './room.js';

const CODE_PATTERN = /^[a-z0-9]{3,16}$/;

// Код с префиксом бота обязан нести заполненный уровень.
export function isValidRoomCode(code: string): boolean {
  if (!CODE_PATTERN.test(code)) {
    return false;
  }
  return !isBotRoomCode(code) || botLevelOf(code) !== null;
}

export interface FfaJoinRequest {
  nickname: string;
  stats: Stats;
  token: string;
  isBot: boolean;
}

// release — что сделать с местом после ухода соединения.
interface Membership {
  seat: Seat;
  release: () => void;
}

// Держит все комнаты дуэлей и общие игры процесса и крутит общий тик; пустые удаляются.
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private games: FfaGame[] = [];
  private readonly memberships = new Map<Connection, Membership>();
  private readonly botSeats = new Map<Room, Seat>();

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

  attach(connection: Connection, room: Room, seat: Seat): void {
    this.memberships.set(connection, {
      seat,
      release: () => {
        this.releaseRoom(room);
      },
    });
  }

  // Пропуск живого игрока возвращает его место; прежнее соединение отвязывается и закрывается.
  // Иначе — игра этого размера со свободным местом и наибольшим числом игроков или новая.
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
    const game = this.pickGame(size);
    this.attachFfa(connection, game.join(connection, request.nickname, request.stats, request.isBot));
  }

  // Ушло соединение: место освобождается; общая игра держит игрока сама и удаляется в тике, когда опустеет.
  detach(connection: Connection): void {
    const membership = this.memberships.get(connection);
    if (membership === undefined) {
      return;
    }
    this.memberships.delete(connection);
    membership.seat.leave();
    membership.release();
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

  private attachFfa(connection: FfaConnection, seat: Seat): void {
    this.memberships.set(connection, { seat, release: () => undefined });
  }

  private pickGame(size: FfaSize): FfaGame {
    const open = this.games.filter((game) => game.size === size && game.hasFreeSeat);
    const fullest = open.reduce<FfaGame | null>(
      (best, game) => (best === null || game.playerCount > best.playerCount ? game : best),
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
