import { DEFAULT_STATS } from '@tanks/shared/engine';
import { BOT_NICKNAME, BOT_SIDE, DummyBot } from './bot.js';
import { DEFAULT_ROOM_OPTIONS, Room, type Connection, type RoomOptions, type Seat } from './room.js';

const CODE_PATTERN = /^[a-z0-9]{3,16}$/;
// Код с этим префиксом — дуэль против манекена: сервер сажает бота первым игроком при создании комнаты.
export const BOT_ROOM_PREFIX = 'bot';

export function isValidRoomCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

export function isBotRoomCode(code: string): boolean {
  return code.startsWith(BOT_ROOM_PREFIX);
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
  ) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  getOrCreate(code: string): Room {
    let room = this.rooms.get(code);
    if (room === undefined) {
      room = new Room(code, this.options);
      this.rooms.set(code, room);
      if (isBotRoomCode(code)) {
        this.seatBot(room);
      }
    }
    return room;
  }

  seatOf(connection: Connection): Seat | undefined {
    return this.memberships.get(connection)?.seat;
  }

  attach(connection: Connection, room: Room, seat: Seat): void {
    this.memberships.set(connection, { room, seat });
  }

  // В комнате с манекеном один человек: ушёл он — манекен снимается; пустая комната удаляется.
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

  step(): void {
    for (const room of this.rooms.values()) {
      room.step();
    }
  }

  // Комната только что создана, место манекена свободно.
  private seatBot(room: Room): void {
    const bot = new DummyBot(this.random, (connection) =>
      room.join(BOT_SIDE, connection, BOT_NICKNAME, { ...DEFAULT_STATS }),
    );
    this.botSeats.set(room, bot.seat);
  }
}
