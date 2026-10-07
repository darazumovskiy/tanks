import {
  TwinRoundState,
  type HitRecord,
  type TwinDecision,
  type TwinProfile,
  type TwinSituation,
  type TwinView,
} from '@tanks/bots/twin';
import type { GameLog } from '@tanks/server/gameLog';
import type { Connection, Seat } from '@tanks/server/room';
import {
  botView,
  createRound,
  DT,
  IDLE_ACTION,
  stepRound,
  TICK_RATE,
  type Action,
  type DerivedStats,
  type Round,
  type Side,
  type TankView,
} from '@tanks/shared/engine';
import {
  decode,
  gameTimecode,
  MessageType,
  type BotLevel,
  type RoundStartMessage,
  type Message,
  type SnapshotMessage,
  type TankSnapshot,
} from '@tanks/shared/protocol';

export interface Brain {
  init(situation: TwinSituation): void;
  tick(view: TwinView): TwinDecision;
}

export interface TwinPlayerOptions {
  profile: TwinProfile;
  brain: Brain;
  level: BotLevel;
  hasRicochetGuard: boolean;
  roundSeeds: readonly number[];
  roomCode: string;
  log: GameLog;
}

interface Delayed<T> {
  at: number;
  item: T;
}

interface Input {
  seq: number;
  action: Action;
}

const TICK_MS = DT * 1000;
// До первого тика боя двойник шлёт пустые команды, как клиент на отсчёте.
const COUNTDOWN_DECISION: TwinDecision = { action: IDLE_ACTION, isGuardHolding: false };
const ROOM_LOG_PREFIX = 'room-';
const CLIENT_SOURCE_PREFIX = 'C';
const TWIN_USER_AGENT = 'tanks-twin';
// Экрана у двойника нет; поля строки `device` нужны разборщику журнала.
const TWIN_SCREEN = 'screen=0x0 dpr=1';

function formatAction(action: Action): string {
  const fire = action.isFiring ? '1' : '0';
  return `${action.throttle.toFixed(2)},${action.turn.toFixed(2)},${action.turretTurn.toFixed(2)},${fire}`;
}

function flag(isOn: boolean): string {
  return isOn ? '1' : '0';
}

function tankViewOf(snapshot: TankSnapshot, stats: DerivedStats): TankView {
  return {
    x: snapshot.x,
    y: snapshot.y,
    heading: snapshot.heading,
    turret: snapshot.turret,
    speed: snapshot.speed,
    vx: Math.cos(snapshot.heading) * snapshot.speed,
    vy: Math.sin(snapshot.heading) * snapshot.speed,
    hp: snapshot.hp,
    maxHp: stats.maxHp,
    reloadLeft: snapshot.reloadLeft,
    isAlive: snapshot.isAlive,
    stats: { ...stats },
  };
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

// Игрок-двойник за каналом сети: сообщения комнаты доходят через downlinkTicks, команды до комнаты —
// через uplinkTicks. Свой танк — с предсказанием, как у клиента: последний снимок плюс неподтверждённые команды;
// противник — по снимку на interpolationTicks старше последнего. Клиентские строки журнала — как у клиента.
export class TwinPlayer implements Connection {
  private seat: Seat | null = null;
  private side: Side = 0;
  private clock = 0;
  private inbox: Delayed<Message>[] = [];
  private outbox: Delayed<Input>[] = [];
  private seq = 0;
  private round: Round | null = null;
  private pending: Input[] = [];
  private history: SnapshotMessage[] = [];
  private hits: HitRecord[] = [];
  private isRoundOver = true;
  private gameId: string | null = null;
  private lastSnapshotGameTick = 0;
  private lastSnapshotClock: number | null = null;
  private readonly roundState: TwinRoundState;
  private wasGuardHolding = false;
  private finished = 0;
  private isOverCounted = false;

  constructor(private readonly options: TwinPlayerOptions) {
    this.roundState = new TwinRoundState(options.level, options.hasRicochetGuard);
  }

  // Раундов, которые комната уже закончила, — без задержки канала.
  get finishedRounds(): number {
    return this.finished;
  }

  attach(seat: Seat): void {
    this.seat = seat;
  }

  send(bytes: Uint8Array): void {
    const message = decode(bytes);
    if (message.type === MessageType.RoundStart) {
      this.isOverCounted = false;
    }
    if (message.type === MessageType.Snapshot && message.isOver && !this.isOverCounted) {
      this.isOverCounted = true;
      this.finished++;
    }
    this.inbox.push({ at: this.clock + this.options.profile.channel.downlinkTicks, item: message });
  }

  // Шаг клиента после тика комнаты: дошедшие сообщения, одна команда, отправка дошедших до комнаты команд.
  step(): void {
    while (this.inbox.length > 0 && (this.inbox[0]?.at ?? Infinity) <= this.clock) {
      const delivered = this.inbox.shift();
      if (delivered !== undefined) {
        this.receive(delivered.item);
      }
    }
    if (this.round !== null && !this.isRoundOver) {
      this.act(this.round);
    }
    while (this.outbox.length > 0 && (this.outbox[0]?.at ?? Infinity) <= this.clock) {
      const input = this.outbox.shift();
      if (input !== undefined) {
        this.seat?.input(input.item.seq, input.item.action);
      }
    }
    this.clock++;
  }

  private get isFighting(): boolean {
    const latest = this.history.at(-1);
    return latest !== undefined && latest.tick > 0 && !latest.isOver;
  }

  private receive(message: Message): void {
    if (message.type === MessageType.Welcome) {
      this.side = message.side;
      this.write(
        `device ua=${TWIN_USER_AGENT}/${this.options.profile.name} ${TWIN_SCREEN} touch=${flag(this.options.profile.control === 'sticks')}`,
      );
      return;
    }
    if (message.type === MessageType.RoundStart) {
      this.startRound(message);
      return;
    }
    if (message.type === MessageType.Snapshot && this.round !== null) {
      this.applySnapshot(this.round, message);
    }
  }

  private startRound(message: RoundStartMessage): void {
    this.gameId = message.gameId;
    this.round = createRound(
      message.mapIndex,
      [
        { name: message.tanks[0].nickname, stats: message.tanks[0].stats },
        { name: message.tanks[1].nickname, stats: message.tanks[1].stats },
      ],
      message.rules,
    );
    this.pending = [];
    this.history = [];
    this.hits = [];
    this.isRoundOver = false;
    this.wasGuardHolding = false;
    const seed = this.options.roundSeeds[message.roundIndex] ?? message.roundIndex;
    this.options.brain.init(this.roundState.next(message, this.side, seed));
    this.write(`flags guard=${flag(this.options.hasRicochetGuard)} aimline=1`);
    this.write(
      `settings ${JSON.stringify({ pivotThrottle: this.options.profile.settings.pivotThrottle, hasRicochetGuard: this.options.hasRicochetGuard })}`,
    );
  }

  private applySnapshot(round: Round, message: SnapshotMessage): void {
    this.lastSnapshotGameTick = message.gameTick;
    this.lastSnapshotClock = this.clock;
    this.history.push(message);
    if (this.history.length > this.options.profile.channel.interpolationTicks + 1) {
      this.history.shift();
    }
    for (const event of message.events) {
      const isHit = event.kind === 'hit';
      if ((isHit || event.kind === 'pickup') && event.side !== null) {
        this.hits.push({ tick: message.tick, side: event.side, value: event.value, isPickup: !isHit });
      }
    }
    if (message.isOver) {
      this.isRoundOver = true;
      return;
    }
    round.tick = message.tick;
    round.time = message.tick * DT;
    round.zone.radius = message.zoneRadius;
    mirrorTank(round.tanks[0], message.tanks[0]);
    mirrorTank(round.tanks[1], message.tanks[1]);
    round.bullets = message.bullets.map((bullet) => ({ ...bullet, damage: 0, isDead: false }));
    round.kits = round.kits.map((kit, index) => ({ ...kit, ...message.kits[index] }));
    this.pending = this.pending.filter((input) => input.seq > message.ackSeq);
    if (this.isFighting) {
      for (const input of this.pending) {
        stepRound(round, this.actionsFor(input.action));
      }
    }
  }

  private act(round: Round): void {
    const decision = this.isFighting ? this.options.brain.tick(this.view(round)) : COUNTDOWN_DECISION;
    const input: Input = { seq: ++this.seq, action: { ...decision.action } };
    this.pending.push(input);
    if (this.isFighting) {
      stepRound(round, this.actionsFor(input.action));
    }
    this.outbox.push({ at: this.clock + this.options.profile.channel.uplinkTicks, item: input });
    this.write(`in seq=${String(input.seq)} a=${formatAction(input.action)}`);
    if (decision.isGuardHolding && !this.wasGuardHolding) {
      this.write('guard hold');
    }
    this.wasGuardHolding = decision.isGuardHolding;
    if (this.clock % TICK_RATE === 0) {
      const { uplinkTicks, downlinkTicks } = this.options.profile.channel;
      const rtt = Math.round((uplinkTicks + downlinkTicks) * TICK_MS);
      this.write(`sec rtt=${String(rtt)} pend=${String(this.pending.length)}`);
    }
  }

  private view(round: Round): TwinView {
    const enemySide: Side = this.side === 0 ? 1 : 0;
    const own = botView(round, this.side);
    const delayed = this.history[0];
    const enemy =
      delayed === undefined ? own.enemy : tankViewOf(delayed.tanks[enemySide], round.tanks[enemySide].stats);
    return { ...own, enemy, hits: this.hits };
  }

  private actionsFor(mine: Action): [Action, Action] {
    return this.side === 0 ? [mine, IDLE_ACTION] : [IDLE_ACTION, mine];
  }

  private gameTick(): number {
    if (this.lastSnapshotClock === null) {
      return 0;
    }
    return this.lastSnapshotGameTick + this.clock - this.lastSnapshotClock;
  }

  private write(body: string): void {
    const gt = this.gameTick();
    const key = this.gameId ?? `${ROOM_LOG_PREFIX}${this.options.roomCode}`;
    const text = `gt=${String(gt)} tc=${gameTimecode(gt)} now=${(this.clock * TICK_MS).toFixed(0)} ${body}`;
    this.options.log.write(key, `${CLIENT_SOURCE_PREFIX}${String(this.side)}`, text);
  }
}
