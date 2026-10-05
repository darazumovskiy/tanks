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
import { CrowdBrain } from './brain.js';
import { CROWD_PROFILES, type CrowdLevel, type CrowdProfile } from './profile.js';
import { Targeting, type TargetBook } from './targets.js';
import { crowdView, type CrowdTank, type Frame } from './view.js';

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

const UNKNOWN_STATS = deriveStats(undefined);

// Бот общей игры без транспорта: получает сообщения сервера, восстанавливает из них поле и отвечает командой.
// Сокет роя и подключение внутри сервера — разные обёртки вокруг одного бота.
export class CrowdBot {
  private readonly profile: CrowdProfile;
  token = '';
  playerId: number | null = null;
  phase: FfaPhase | null = null;
  matchTick = 0;
  private readonly map: FfaMap;
  private readonly brain: CrowdBrain;
  private readonly targeting: Targeting;
  private readonly mirror: BulletMirror;
  private gameId = '';
  private seq = 0;
  private roster = new Map<number, DerivedStats>();
  private zonePlan: ZonePlan | null = null;
  private history: Frame[] = [];
  private unconfirmed: { seq: number; action: Action }[] = [];
  private lastGameTick: number | null = null;
  private isOnField = false;
  private counters = emptyCounters();

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

  // Новое соединение: вход с пропуском (пусто — новым игроком), номера команд — с единицы.
  joinMessage(): JoinMessage {
    this.seq = 0;
    this.playerId = null;
    this.lastGameTick = null;
    this.history = [];
    this.unconfirmed = [];
    this.isOnField = false;
    return {
      type: MessageType.Join,
      protocolVersion: PROTOCOL_VERSION,
      roomCode: ffaRoomCode(this.options.size),
      nickname: this.options.nickname,
      stats: this.profile.stats,
      token: this.token,
      isBot: true,
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
        this.isOnField = false;
        this.targeting.release();
        return null;
      case MessageType.FfaBullets:
        this.mirror.reset(message.bullets);
        return null;
      case MessageType.FfaSnapshot:
        return this.onSnapshot(message);
      default:
        return null;
    }
  }

  private statsOf(id: number): DerivedStats {
    return this.roster.get(id) ?? UNKNOWN_STATS;
  }

  private frameOf(message: FfaSnapshotMessage): Frame {
    return {
      tick: message.tick,
      tanks: message.tanks.map((tank) => {
        const stats = this.statsOf(tank.id);
        return {
          id: tank.id,
          x: tank.x,
          y: tank.y,
          heading: tank.heading,
          turret: tank.turret,
          speed: tank.speed,
          vx: Math.cos(tank.heading) * tank.speed,
          vy: Math.sin(tank.heading) * tank.speed,
          hp: tank.hp,
          maxHp: stats.maxHp,
          reloadLeft: tank.reloadLeft,
          shieldLeft: tank.shieldLeft,
          isAlive: tank.isAlive,
          stats,
        };
      }),
      bullets: this.mirror.bullets.map((bullet) => ({
        id: bullet.id,
        owner: bullet.owner,
        x: bullet.x,
        y: bullet.y,
        vx: bullet.vx,
        vy: bullet.vy,
        hasBounced: bullet.hasBounced,
      })),
    };
  }

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

  private onSnapshot(message: FfaSnapshotMessage): InputMessage | null {
    this.counters.snapshots++;
    this.unconfirmed = this.unconfirmed.filter((entry) => entry.seq > message.ackSeq);
    if (this.lastGameTick !== null && message.gameTick > this.lastGameTick + 1) {
      this.counters.gaps += message.gameTick - this.lastGameTick - 1;
    }
    this.lastGameTick = message.gameTick;
    this.matchTick = message.tick;
    this.mirror.apply(message.tick, message);
    const frame = this.frameOf(message);
    this.history.push(frame);
    if (this.history.length > this.profile.reactionTicks + 1) {
      this.history.shift();
    }
    const myId = this.playerId;
    const plan = this.zonePlan;
    if (myId === null || plan === null) {
      return null;
    }
    const fresh: Frame = {
      ...frame,
      tanks: frame.tanks.map((tank) => (tank.id === myId ? this.predictedSelf(tank) : tank)),
    };
    const attackers = this.attackersOf(message, fresh, myId);
    const isFighting = this.phase === FfaPhase.Fight && message.self.state === 'alive';
    // Пока истории меньше задержки реакции — самый старый из имеющихся снимков.
    let delayed = frame;
    for (const oldest of this.history.slice(0, 1)) {
      delayed = oldest;
    }
    const view = crowdView({
      myId,
      fresh,
      delayed,
      map: this.map,
      kits: this.kitsOf(message),
      zone: { x: this.map.width / 2, y: this.map.height / 2, radius: zoneRadiusAt(plan, message.tick * DT) },
      attackers,
    });
    if (!isFighting || view === null) {
      this.isOnField = false;
      this.targeting.release();
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
    this.seq++;
    const action = this.brain.tick(view, target);
    this.unconfirmed.push({ seq: this.seq, action });
    return { type: MessageType.Input, seq: this.seq, action };
  }
}
