import { DEFAULT_STATS } from '@tanks/shared/engine';
import { BOT_NICKNAME, DummyBot } from './bot.js';
import { DEFAULT_ROOM_OPTIONS, Room, type Connection, type RoomOptions } from './room.js';

const CODE_PATTERN = /^[a-z0-9]{3,16}$/;
// Код с этим префиксом — дуэль против манекена: сервер сажает бота первым игроком при создании комнаты.
export const BOT_ROOM_PREFIX = 'bot';

export function isValidRoomCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

export function isBotRoomCode(code: string): boolean {
  return code.startsWith(BOT_ROOM_PREFIX);
}

// Держит все комнаты процесса и крутит общий тик: одна комната — один объект, пустая удаляется.
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly byConnection = new Map<Connection, Room>();
  private readonly bots = new Map<Room, DummyBot>();

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

  roomOf(connection: Connection): Room | undefined {
    return this.byConnection.get(connection);
  }

  attach(connection: Connection, room: Room): void {
    this.byConnection.set(connection, room);
  }

  // Ушёл последний человек — манекен тоже покидает комнату, и она удаляется.
  detach(connection: Connection): void {
    const room = this.byConnection.get(connection);
    if (room === undefined) {
      return;
    }
    this.byConnection.delete(connection);
    room.leave(connection);
    const bot = this.bots.get(room);
    if (bot !== undefined && room.playerCount === 1) {
      room.leave(bot);
      bot.close();
      this.bots.delete(room);
    }
    if (room.isEmpty) {
      this.rooms.delete(room.code);
    }
  }

  step(): void {
    for (const room of this.rooms.values()) {
      room.step();
    }
  }

  private seatBot(room: Room): void {
    const bot = new DummyBot(this.random);
    bot.attach(room);
    room.join(bot, BOT_NICKNAME, { ...DEFAULT_STATS });
    this.bots.set(room, bot);
  }
}
