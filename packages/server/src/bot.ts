import { clamp, DT, normalizeAngle, TICK_RATE, TURRET_RATE, type Action, type Side } from '@tanks/shared/engine';
import { decode, MessageType, type SnapshotMessage, type TankSnapshot } from '@tanks/shared/protocol';
import type { Connection, Seat } from './room.js';

export const BOT_NICKNAME = 'Манекен';
export const BOT_SIDE: Side = 0;
const HUMAN_SIDE: Side = 1;

const WANDER_MIN_TICKS = TICK_RATE;
const WANDER_MAX_TICKS = TICK_RATE * 2;
const WANDER_THROTTLE = 0.6;
const STUCK_SPEED = 5;
const STUCK_TICKS = TICK_RATE / 2;
const AIM_NOISE_RAD = 0.35;
const AIM_SLOWDOWN = 0.4;
const FIRE_WINDOW_RAD = 0.3;
const FIRE_CHANCE_PER_TICK = 0.3 / TICK_RATE;
const HULL_TURN_RATE = 2;

// Манекен — слабый соперник, живущий внутри процесса как обычное подключение: получает те же сообщения,
// что игрок, и отвечает тем же вводом через проверки комнаты. Блуждает случайными курсами, целится медленно
// и с шумом, стреляет редко. Место занимает сам при создании: снимки приходят только после второго игрока.
export class DummyBot implements Connection {
  readonly seat: Seat;
  private seq = 0;
  private wanderHeading = 0;
  private wanderTicksLeft = 0;
  private stuckTicks = 0;
  private aimNoise = 0;

  constructor(
    private readonly random: () => number,
    takeSeat: (connection: Connection) => Seat,
  ) {
    this.seat = takeSeat(this);
  }

  send(bytes: Uint8Array): void {
    const message = decode(bytes);
    if (message.type === MessageType.RoundStart) {
      this.wanderTicksLeft = 0;
      this.stuckTicks = 0;
      return;
    }
    if (message.type === MessageType.Snapshot) {
      this.react(message);
    }
  }

  // Гибель любого танка заканчивает раунд в тот же тик, поэтому в живом раунде живы оба.
  private react(snapshot: SnapshotMessage): void {
    if (snapshot.isOver) {
      return;
    }
    const me = snapshot.tanks[BOT_SIDE];
    const enemy = snapshot.tanks[HUMAN_SIDE];
    this.seq++;
    this.seat.input(this.seq, {
      ...this.wander(me),
      ...this.aim(me, enemy),
    });
  }

  private wander(me: TankSnapshot): Pick<Action, 'throttle' | 'turn'> {
    const isStuck = Math.abs(me.speed) < STUCK_SPEED;
    this.stuckTicks = isStuck ? this.stuckTicks + 1 : 0;
    if (this.wanderTicksLeft <= 0 || this.stuckTicks > STUCK_TICKS) {
      this.wanderHeading = this.random() * Math.PI * 2 - Math.PI;
      this.wanderTicksLeft = Math.round(WANDER_MIN_TICKS + this.random() * (WANDER_MAX_TICKS - WANDER_MIN_TICKS));
      this.stuckTicks = 0;
    }
    this.wanderTicksLeft--;
    const error = normalizeAngle(this.wanderHeading - me.heading);
    return {
      throttle: WANDER_THROTTLE * Math.max(0, Math.cos(error)),
      turn: clamp(error / (HULL_TURN_RATE * DT), -1, 1),
    };
  }

  private aim(me: TankSnapshot, enemy: TankSnapshot): Pick<Action, 'turretTurn' | 'isFiring'> {
    if (this.random() < 1 / TICK_RATE) {
      this.aimNoise = (this.random() * 2 - 1) * AIM_NOISE_RAD;
    }
    const wanted = Math.atan2(enemy.y - me.y, enemy.x - me.x) + this.aimNoise;
    const error = normalizeAngle(wanted - me.turret);
    const turretTurn = clamp((error / (TURRET_RATE * DT)) * AIM_SLOWDOWN, -1, 1);
    const isOnTarget = Math.abs(error) < FIRE_WINDOW_RAD;
    return { turretTurn, isFiring: isOnTarget && this.random() < FIRE_CHANCE_PER_TICK };
  }
}
