import { botLevelOf, isBotRoomCode } from '@tanks/shared/protocol';
import { createBot } from './bots/ladder.js';
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

interface Membership {
  room: Room;
  seat: Seat;
}

// Держит все комнаты процесса и крутит общий тик: одна комната — один объект, пустая удаляется.
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly memberships = new Map<Connection, Membership>();
  private readonly botSeats = new Map<Room, Seat>();

  constructor(
    private readonly options: RoomOptions = DEFAULT_ROOM_OPTIONS,
    private readonly random: () => number = Math.random,
    private readonly log: GameLog = NO_LOG,
    private readonly dropCounter: InputDropCounter = NO_DROP_COUNTER,
  ) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  // Комната бота создаётся с ботом на месте 0; код уже проверен isValidRoomCode.
  getOrCreate(code: string): Room {
    const existing = this.rooms.get(code);
    if (existing !== undefined) {
      return existing;
    }
    const room = new Room(code, this.options, this.log, this.dropCounter);
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
    this.memberships.set(connection, { room, seat });
  }

  // В комнате с ботом один человек: ушёл он — бот снимается; пустая комната удаляется.
  detach(connection: Connection): void {
    const membership = this.memberships.get(connection);
    if (membership === undefined) {
      return;
    }
    this.memberships.delete(connection);
    membership.seat.leave();
    const botSeat = this.botSeats.get(membership.room);
    if (botSeat !== undefined) {
      botSeat.leave();
      this.botSeats.delete(membership.room);
    }
    if (membership.room.isEmpty) {
      this.rooms.delete(membership.room.code);
    }
  }

  step(lateMs: number): void {
    for (const room of this.rooms.values()) {
      room.step(lateMs);
    }
  }
}
