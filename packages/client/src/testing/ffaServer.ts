import { DEFAULT_STATS, makeTank, type FfaMap, type FfaPlayerState, type Tank, type World } from '@tanks/shared/engine';
import {
  decode,
  encode,
  MessageType,
  type BulletChanges,
  type FfaSnapshotEvent,
  type FfaSnapshotMessage,
  type ServerMessage,
} from '@tanks/shared/protocol';

// Помощники тестов клиента толпы: снимок поля так, как его собрал бы сервер, и проход сообщения через кодек.

export const OPEN_MAP: FfaMap = {
  name: 'Проба',
  size: 10,
  seed: 1,
  width: 2000,
  height: 1200,
  walls: [],
  kits: [],
  spawnAreas: [{ x: 1000, y: 600, radius: 60 }],
};

const NO_CHANGES: BulletChanges = { births: [], bounces: [], deaths: [] };

function throughCodec<T extends ServerMessage>(message: T): T {
  return decode(encode(message)) as T;
}

export function placedTank(id: number, x: number, y: number, heading = 0): Tank {
  return makeTank({ name: `Т${String(id)}`, stats: DEFAULT_STATS }, id, { x, y, heading });
}

export interface SnapshotDetails {
  ackSeq?: number;
  hasSpareInput?: boolean;
  events?: FfaSnapshotEvent[];
  changes?: BulletChanges;
  state?: FfaPlayerState;
  killerId?: number | null;
  gameTick?: number;
  isOut?: boolean;
}

export function snapshotOf(world: World, details: SnapshotDetails = {}): FfaSnapshotMessage {
  return throughCodec({
    type: MessageType.FfaSnapshot,
    tick: world.tick,
    gameTick: details.gameTick ?? world.tick,
    ackSeq: details.ackSeq ?? 0,
    hasSpareInput: details.hasSpareInput ?? false,
    self: {
      state: details.state ?? 'alive',
      ticksLeft: 0,
      killerId: details.killerId ?? null,
      idleTicksLeft: null,
      isOut: details.isOut ?? false,
    },
    tanks: world.tanks.map((tank) => ({
      id: tank.id,
      x: tank.x,
      y: tank.y,
      heading: tank.heading,
      turret: tank.turret,
      speed: tank.speed,
      hp: tank.hp,
      reloadLeft: tank.reloadLeft,
      isAlive: tank.isAlive,
      shieldLeft: tank.shieldLeft,
    })),
    kits: world.kits.map((kit) => ({ isActive: kit.isActive, respawnIn: kit.respawnIn })),
    events: details.events ?? [],
    ...(details.changes ?? NO_CHANGES),
  });
}
