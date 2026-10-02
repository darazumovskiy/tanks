import { DEFAULT_ROOM_OPTIONS, Room, type Connection, type RoomOptions } from './room.js';

const CODE_PATTERN = /^[a-z0-9]{3,16}$/;

export function isValidRoomCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

// Держит все комнаты процесса и крутит общий тик: одна комната — один объект, пустая удаляется.
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly byConnection = new Map<Connection, Room>();

  constructor(private readonly options: RoomOptions = DEFAULT_ROOM_OPTIONS) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  getOrCreate(code: string): Room {
    let room = this.rooms.get(code);
    if (room === undefined) {
      room = new Room(code, this.options);
      this.rooms.set(code, room);
    }
    return room;
  }

  roomOf(connection: Connection): Room | undefined {
    return this.byConnection.get(connection);
  }

  attach(connection: Connection, room: Room): void {
    this.byConnection.set(connection, room);
  }

  detach(connection: Connection): void {
    const room = this.byConnection.get(connection);
    if (room === undefined) {
      return;
    }
    this.byConnection.delete(connection);
    room.leave(connection);
    if (room.isEmpty) {
      this.rooms.delete(room.code);
    }
  }

  step(): void {
    for (const room of this.rooms.values()) {
      room.step();
    }
  }
}
