import {
  deriveStats,
  DT,
  ffaViewCenter,
  isInFfaView,
  normalizeAngle,
  zoneRadiusAt,
  type Action,
  type DerivedStats,
  type FfaMap,
  type FfaSize,
  type Kit,
  type ZonePlan,
} from '@tanks/shared/engine';
import {
  BulletMirror,
  ffaRoomCode,
  FfaPhase,
  MessageType,
  PROTOCOL_VERSION,
  type FfaSnapshotMessage,
  type InputMessage,
  type JoinMessage,
  type ServerMessage,
} from '@tanks/shared/protocol';
import { CrowdBrain, UNLIMITED_PATHS, type PathAllowance } from './brain.js';
import { CROWD_PROFILES, type CrowdLevel, type CrowdProfile } from './profile.js';
import { Targeting, type TargetBook } from './targets.js';
import { crowdBullets, crowdTank, crowdView, UNKNOWN_STATS, type CrowdTank, type Frame } from './view.js';

export interface CrowdBotOptions {
  level: CrowdLevel;
  nickname: string;
  size: FfaSize;
  random: () => number;
  book: TargetBook;
  // Разносит пересчёт пути ботов роя по разным тикам.
  phase: number;
  mapFor: (size: FfaSize) => FfaMap;
}

// Накоплено с прошлого takeCounters: снимки и разрывы в них, снаряды в окне обзора, урон по боту и его доля
// от стрелков, которых бот в этот момент не видел.
export interface CrowdBotCounters {
  snapshots: number;
  gaps: number;
  visibleBullets: number;
  visibleSamples: number;
  visibleMax: number;
  damageTaken: number;
  offscreenDamage: number;
}

function emptyCounters(): CrowdBotCounters {
  return {
    snapshots: 0,
    gaps: 0,
    visibleBullets: 0,
    visibleSamples: 0,
    visibleMax: 0,
    damageTaken: 0,
    offscreenDamage: 0,
  };
}

interface Absorbed {
  message: FfaSnapshotMessage;
  frame: Frame;
}

// Бот общей игры без транспорта: получает сообщения сервера, восстанавливает из них поле и отвечает командой.
// Сокет роя и подключение внутри сервера — разные обёртки вокруг одного бота.
export class CrowdBot {
  private readonly profile: CrowdProfile;
  token = '';
  playerId: number | null = null;
  phase: FfaPhase | null = null;
  matchTick = 0;
  gameId = '';
  private readonly map: FfaMap;
  private readonly brain: CrowdBrain;
  private readonly targeting: Targeting;
  private readonly mirror: BulletMirror;
  private seq = 0;
  private roster = new Map<number, DerivedStats>();
  private zonePlan: ZonePlan | null = null;
  private history: Frame[] = [];
  private unconfirmed: { seq: number; action: Action }[] = [];
  private lastGameTick: number | null = null;
  private isOnField = false;
  private counters = emptyCounters();
  // Последний принятый снимок с танком бота в бою, по которому бот ещё не решал, и обидчики со всех принятых с
  // прошлого решения.
  private latest: Absorbed | null = null;
  private attackers: number[] = [];
  private lastAction: Action | null = null;

  constructor(private readonly options: CrowdBotOptions) {
    this.profile = CROWD_PROFILES[options.level];
    this.map = options.mapFor(options.size);
    this.brain = new CrowdBrain(this.profile, options.random, options.phase);
    this.targeting = new Targeting(options.book, this);
    this.mirror = new BulletMirror(this.map);
  }

  get nickname(): string {
    return this.options.nickname;
  }

  get gameTick(): number | null {
    return this.lastGameTick;
  }

  get hasUndecided(): boolean {
    return this.latest !== null;
  }

  // Новое соединение: вход с пропуском (пусто — новым игроком), номера команд — с единицы.
  joinMessage(): JoinMessage {
    this.seq = 0;
    this.playerId = null;
    this.lastGameTick = null;
    this.history = [];
    this.unconfirmed = [];
    this.isOnField = false;
    this.lastAction = null;
    return {
      type: MessageType.Join,
      protocolVersion: PROTOCOL_VERSION,
      roomCode: ffaRoomCode(this.options.size),
      nickname: this.options.nickname,
      stats: this.profile.stats,
      token: this.token,
      isBot: true,
      gameId: '',
    };
  }

  // Выкинут за бездействие: следующий вход — новым игроком.
  forgetToken(): void {
    this.token = '';
  }

  // Соединение пропало: цель освобождается для других ботов роя.
  disconnect(): void {
    this.playerId = null;
    this.targeting.release();
  }

  takeCounters(): CrowdBotCounters {
    const taken = this.counters;
    this.counters = emptyCounters();
    return taken;
  }

  receive(message: ServerMessage): InputMessage | null {
    switch (message.type) {
      case MessageType.FfaWelcome:
        this.playerId = message.playerId;
        this.token = message.token;
        this.gameId = message.gameId;
        return null;
      case MessageType.FfaRoster:
        this.roster = new Map(message.players.map((player) => [player.id, deriveStats(player.stats)]));
        return null;
      case MessageType.FfaState:
        this.phase = message.phase;
        return null;
      case MessageType.FfaMatchStart:
        // На итогах снимков нет по замыслу: разрывы считаются только внутри матча.
        this.lastGameTick = null;
        this.zonePlan = message.zone;
        this.mirror.reset([]);
        this.history = [];
        this.latest = null;
        this.attackers = [];
        this.leaveField();
        return null;
      case MessageType.FfaBullets:
        this.mirror.reset(message.bullets);
        return null;
      case MessageType.FfaSnapshot:
        this.mirror.apply(message.tick, message);
        this.absorb(message, {
          tick: message.tick,
          tanks: message.tanks.map((tank) => crowdTank(tank, this.statsOf(tank.id))),
          bullets: crowdBullets(this.mirror.bullets),
        });
        return this.decide();
      default:
        return null;
    }
  }

  private readonly statsOf = (id: number): DerivedStats => this.roster.get(id) ?? UNKNOWN_STATS;

  private kitsOf(message: FfaSnapshotMessage): Kit[] {
    return this.map.kits.map((kit, index) => ({
      x: kit.x,
      y: kit.y,
      isActive: false,
      respawnIn: 0,
      ...message.kits[index],
    }));
  }

  // Кто попал в бота на этом снимке; урон по боту и та его часть, что пришла от стрелков вне окна обзора.
  // Танк стрелка мог уже исчезнуть с поля — снаряд живёт дольше подбитого танка; такой стрелок тоже не виден.
  private attackersOf(message: FfaSnapshotMessage, frame: Frame, myId: number): number[] {
    const me = frame.tanks.find((tank) => tank.id === myId);
    const center = me === undefined ? null : ffaViewCenter(me);
    const attackers: number[] = [];
    for (const event of message.events) {
      const isHitByOther = event.kind === 'hit' && event.tank === myId && event.by !== null && event.by !== myId;
      if (!isHitByOther || center === null) {
        continue;
      }
      this.counters.damageTaken += event.value;
      const shooter = frame.tanks.find((tank) => tank.id === event.by);
      if (shooter === undefined || !isInFfaView(center, shooter.x, shooter.y)) {
        this.counters.offscreenDamage += event.value;
      }
      if (shooter !== undefined) {
        attackers.push(shooter.id);
      }
    }
    return attackers;
  }

  // Свой танк — с поправкой на команды, которые сервер ещё не применил: без неё башня при задержке связи
  // проскакивает цель и качается вокруг неё. Место не поправляется — за пару тиков оно меняется мало.
  private predictedSelf(tank: CrowdTank): CrowdTank {
    let heading = tank.heading;
    let turret = tank.turret;
    for (const { action } of this.unconfirmed) {
      heading = normalizeAngle(heading + action.turn * tank.stats.turnRate * DT);
      turret = normalizeAngle(turret + action.turretTurn * tank.stats.turretRate * DT);
    }
    return { ...tank, heading, turret, vx: Math.cos(heading) * tank.speed, vy: Math.sin(heading) * tank.speed };
  }

  // Снимок в историю, без решения: обидчики копятся до следующего decide. Подбит или бой не идёт — бот сразу уходит
  // с поля: решать нечего, а пропущенный ход после возрождения не повторяет команду прошлой жизни.
  absorb(message: FfaSnapshotMessage, frame: Frame): void {
    this.counters.snapshots++;
    this.unconfirmed = this.unconfirmed.filter((entry) => entry.seq > message.ackSeq);
    if (this.lastGameTick !== null && message.gameTick > this.lastGameTick + 1) {
      this.counters.gaps += message.gameTick - this.lastGameTick - 1;
    }
    this.lastGameTick = message.gameTick;
    this.matchTick = message.tick;
    this.history.push(frame);
    if (this.history.length > this.profile.reactionTicks + 1) {
      this.history.shift();
    }
    const myId = this.playerId;
    let attackers: number[] = [];
    if (myId !== null && this.zonePlan !== null) {
      attackers = this.attackersOf(message, this.withPredictedSelf(frame, myId), myId);
    }
    if (this.phase !== FfaPhase.Fight || message.self.state !== 'alive') {
      this.latest = null;
      this.attackers = [];
      this.leaveField();
      return;
    }
    this.latest = { message, frame };
    this.attackers.push(...attackers);
  }

  // Решение по последнему принятому снимку; paths — разрешение на поиск пути на этом ходу.
  decide(paths: PathAllowance = UNLIMITED_PATHS): InputMessage | null {
    const latest = this.latest;
    const attackers = this.attackers;
    this.latest = null;
    this.attackers = [];
    const myId = this.playerId;
    const plan = this.zonePlan;
    if (latest === null || myId === null || plan === null) {
      return null;
    }
    const { message, frame } = latest;
    // Пока истории меньше задержки реакции — самый старый из имеющихся снимков.
    let delayed = frame;
    for (const oldest of this.history.slice(0, 1)) {
      delayed = oldest;
    }
    const view = crowdView({
      myId,
      fresh: this.withPredictedSelf(frame, myId),
      delayed,
      map: this.map,
      kits: this.kitsOf(message),
      zone: { x: this.map.width / 2, y: this.map.height / 2, radius: zoneRadiusAt(plan, message.tick * DT) },
      attackers,
    });
    if (view === null) {
      this.leaveField();
      return null;
    }
    if (!this.isOnField) {
      this.brain.init();
      this.isOnField = true;
    }
    this.counters.visibleBullets += view.bullets.length;
    this.counters.visibleSamples++;
    this.counters.visibleMax = Math.max(this.counters.visibleMax, view.bullets.length);
    const target: CrowdTank | null = this.targeting.pick(view, this.gameId);
    const action = this.brain.tick(view, target, paths);
    this.lastAction = action;
    return this.send(action);
  }

  // Ход пропущен: прошлая команда ещё раз, но без выстрела — бот не видел, куда смотрит башня.
  repeat(): InputMessage | null {
    if (this.lastAction === null) {
      return null;
    }
    return this.send({ ...this.lastAction, isFiring: false });
  }

  private send(action: Action): InputMessage {
    this.seq++;
    this.unconfirmed.push({ seq: this.seq, action });
    return { type: MessageType.Input, seq: this.seq, action };
  }

  private withPredictedSelf(frame: Frame, myId: number): Frame {
    return { ...frame, tanks: frame.tanks.map((tank) => (tank.id === myId ? this.predictedSelf(tank) : tank)) };
  }

  private leaveField(): void {
    this.isOnField = false;
    this.lastAction = null;
    this.targeting.release();
  }
}
