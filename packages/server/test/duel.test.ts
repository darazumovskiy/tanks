import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DT, normalizeAngle, TURRET_RATE, type Action } from '@tanks/shared/engine';
import { MessageType, type SnapshotMessage, type TankSnapshot } from '@tanks/shared/protocol';
import { createApp, type App } from '../src/app.js';
import { TestClient } from './client.js';

const FAST_ROOM = { countdownTicks: 2, roundEndTicks: 2, maxInputsPerSecond: 90 };
const LANE_Y = 100;
const ARRIVE_DISTANCE = 50;
const AIM_TOLERANCE = 0.02;

let app: App;
let port: number;
const clients: TestClient[] = [];

beforeEach(async () => {
  app = createApp({ room: FAST_ROOM });
  port = await app.listen(0, '127.0.0.1');
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await app.close();
});

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

// Едет к точке, потом разворачивает корпус на заданный курс; стреляет по цели, когда башня наведена.
function controller(
  me: TankSnapshot,
  target: { x: number; y: number },
  faceHeading: number,
  aimAt: TankSnapshot | null,
): Action {
  const dx = target.x - me.x;
  const dy = target.y - me.y;
  const distance = Math.hypot(dx, dy);
  const action: Action = { throttle: 0, turn: 0, turretTurn: 0, isFiring: false };
  if (distance > ARRIVE_DISTANCE) {
    const wanted = Math.atan2(dy, dx);
    const diff = normalizeAngle(wanted - me.heading);
    action.turn = clamp(diff * 3, -1, 1);
    action.throttle = Math.abs(diff) < 0.3 ? 1 : 0;
    return action;
  }
  action.turn = clamp(normalizeAngle(faceHeading - me.heading) * 3, -1, 1);
  if (aimAt !== null) {
    const wantedTurret = Math.atan2(aimAt.y - me.y, aimAt.x - me.x);
    const diff = normalizeAngle(wantedTurret - me.turret);
    action.turretTurn = clamp(diff / (TURRET_RATE * DT), -1, 1);
    action.isFiring = Math.abs(diff) < AIM_TOLERANCE;
  }
  return action;
}

describe('полный раунд', () => {
  it('два скриптовых игрока доигрывают раунд до убийства, счёт растёт, начинается следующий раунд', async () => {
    const a = await TestClient.connect(port);
    const b = await TestClient.connect(port);
    clients.push(a, b);
    a.join('duel', 'Стрелок', { armor: 0, engine: 0, gun: 5, reload: 5 });
    await a.nextOfType(MessageType.Welcome);
    b.join('duel', 'Мишень', { armor: 0, engine: 5, gun: 0, reload: 0 });
    await b.nextOfType(MessageType.Welcome);
    const start = await a.nextOfType(MessageType.RoundStart);
    expect(start.mapIndex).toBe(0);

    const seenEvents = new Set<string>();
    let shotsFired = 0;
    const playUntilOver = async (): Promise<SnapshotMessage> => {
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const snapshot = await a.nextOfType(MessageType.Snapshot);
        await b.nextOfType(MessageType.Snapshot);
        for (const event of snapshot.events) {
          seenEvents.add(event.kind);
          if (event.kind === 'shot') {
            shotsFired++;
          }
        }
        if (snapshot.isOver) {
          return snapshot;
        }
        const [tankA, tankB] = snapshot.tanks;
        const isTargetInLane =
          Math.abs(tankB.y - LANE_Y) < ARRIVE_DISTANCE && Math.abs(tankB.x - 1460) < ARRIVE_DISTANCE;
        a.input(controller(tankA, { x: 140, y: LANE_Y }, 0, isTargetInLane ? tankB : null));
        b.input(controller(tankB, { x: 1460, y: LANE_Y }, Math.PI, null));
      }
      throw new Error('раунд не закончился за отведённое время');
    };

    const roundOver = await playUntilOver();
    expect(roundOver.endReason).toBe('kill');
    expect(roundOver.winner).toBe(0);
    expect(roundOver.tanks[1].isAlive).toBe(false);
    expect(shotsFired).toBeGreaterThanOrEqual(3);
    expect([...seenEvents]).toEqual(expect.arrayContaining(['shot', 'hit', 'death', 'roundOver']));

    const next = await a.nextOfType(MessageType.RoundStart, 3000);
    expect(next.roundIndex).toBe(1);
    expect(next.mapIndex).toBe(1);
    expect(next.score).toEqual([1, 0]);
  }, 30000);
});
