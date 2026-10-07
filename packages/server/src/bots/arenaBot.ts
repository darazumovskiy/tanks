import { ReactionDelay, type BotBrain } from '@tanks/bots';
import { botView, createRound, DT, type Round, type Side } from '@tanks/shared/engine';
import {
  decode,
  MessageType,
  type RoundStartMessage,
  type SnapshotMessage,
  type TankSnapshot,
} from '@tanks/shared/protocol';
import type { Connection, Seat } from '../room.js';

// Бот живёт внутри процесса как обычное подключение: получает те же сообщения, что игрок (сторону узнаёт из
// Welcome), и отвечает тем же вводом через проверки комнаты. Поля боя не видит — восстанавливает его из протокола
// в собственном раунде движка. Место занимает сам при создании: снимки приходят только после второго игрока.
export class ArenaBot implements Connection {
  readonly seat: Seat;
  private side: Side = 0;
  private seq = 0;
  private round: Round | null = null;
  private delay: ReactionDelay;

  constructor(
    private readonly brain: BotBrain,
    takeSeat: (connection: Connection) => Seat,
  ) {
    this.delay = new ReactionDelay(brain.reactionTicks);
    this.seat = takeSeat(this);
  }

  send(bytes: Uint8Array): void {
    const message = decode(bytes);
    if (message.type === MessageType.Welcome) {
      this.side = message.side;
      return;
    }
    if (message.type === MessageType.RoundStart) {
      this.startRound(message);
      return;
    }
    if (message.type === MessageType.Snapshot && this.round !== null && !message.isOver) {
      this.react(this.round, message);
    }
  }

  private startRound(message: RoundStartMessage): void {
    this.round = createRound(
      message.mapIndex,
      [
        { name: message.tanks[0].nickname, stats: message.tanks[0].stats },
        { name: message.tanks[1].nickname, stats: message.tanks[1].stats },
      ],
      message.rules,
    );
    this.delay = new ReactionDelay(this.brain.reactionTicks);
    this.brain.init?.(botView(this.round, this.side), message);
  }

  private react(round: Round, message: SnapshotMessage): void {
    mirrorSnapshot(round, message);
    const view = this.delay.perceive(botView(round, this.side));
    this.seq++;
    this.seat.input(this.seq, this.brain.tick(view));
  }
}

function mirrorTank(tank: Round['tanks'][number], snapshot: TankSnapshot): void {
  tank.x = snapshot.x;
  tank.y = snapshot.y;
  tank.heading = snapshot.heading;
  tank.turret = snapshot.turret;
  tank.speed = snapshot.speed;
  tank.hp = snapshot.hp;
  tank.reloadLeft = snapshot.reloadLeft;
  tank.isAlive = snapshot.isAlive;
}

// Снимок не несёт урон снаряда и координаты аптечек: урон — по характеристикам владельца, аптечки — по карте.
function mirrorSnapshot(round: Round, snapshot: SnapshotMessage): void {
  round.tick = snapshot.tick;
  round.time = snapshot.tick * DT;
  mirrorTank(round.tanks[0], snapshot.tanks[0]);
  mirrorTank(round.tanks[1], snapshot.tanks[1]);
  round.bullets = snapshot.bullets.map((bullet) => ({
    id: bullet.id,
    owner: bullet.owner,
    x: bullet.x,
    y: bullet.y,
    vx: bullet.vx,
    vy: bullet.vy,
    damage: round.tanks[bullet.owner].stats.damage,
    bouncesLeft: bullet.bouncesLeft,
    hasBounced: bullet.hasBounced,
    age: bullet.age,
    isDead: false,
  }));
  round.kits = round.kits.map((kit, index) => ({ ...kit, ...snapshot.kits[index] }));
  round.zone.radius = snapshot.zoneRadius;
}
