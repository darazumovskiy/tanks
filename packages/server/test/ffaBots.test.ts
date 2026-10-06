import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES,
  DEFAULT_STATS,
  DT,
  FFA,
  ffaStandings,
  ffaViewCenter,
  isInFfaView,
  normalizeAngle,
  TICK_RATE,
  TURRET_RATE,
  type Action,
  type FfaMap,
  type Stats,
} from '@tanks/shared/engine';
import {
  decode,
  ErrorCode,
  EventFlag,
  FFA_JOURNAL,
  FFA_LEAVE_IDLE,
  FFA_LEAVE_YIELD,
  FfaInviteMiss,
  FfaPhase,
  MessageType,
  PROTOCOL_VERSION,
  replayFfaJournal,
  type FfaRosterEntry,
  type FfaScoreMessage,
  type FfaSnapshotMessage,
  type FfaStateMessage,
  type FfaTankSnapshot,
  type FfaWelcomeMessage,
  type ServerMessage,
} from '@tanks/shared/protocol';
import { createApp, type App, type AppOptions } from '../src/app.js';
import { DEFAULT_FFA_OPTIONS, FfaGame, type FfaOptions } from '../src/ffaGame.js';
import { NO_LOG } from '../src/gameLog.js';
import { NO_DROP_COUNTER } from '../src/metrics.js';
import { TestClient } from './client.js';
import { seededRandom, sleep, threadCpuMs } from './support.js';

// Открытое поле без стен: стрелок теста видит цель по прямой, боты ездят без застреваний.
const OPEN_MAP: FfaMap = {
  name: 'Поле',
  size: 10,
  seed: 1,
  width: 1600,
  height: 900,
  walls: [],
  kits: [],
  spawnAreas: [
    { x: 200, y: 450, radius: 60 },
    { x: 1400, y: 450, radius: 60 },
    { x: 800, y: 150, radius: 60 },
    { x: 800, y: 750, radius: 60 },
    { x: 200, y: 150, radius: 60 },
    { x: 1400, y: 750, radius: 60 },
    { x: 200, y: 750, radius: 60 },
    { x: 1400, y: 150, radius: 60 },
  ],
};

// Матч 600 с: финал не вмешивается, пока сценарий его не ждёт. Минимум — как на бою: 7 из 10.
const FAST: FfaOptions = {
  ...DEFAULT_FFA_OPTIONS,
  countdownTicks: 3,
  resultsTicks: 5,
  lobbyQuietTicks: 5,
  reconnectTicks: 2000,
  idleWarnTicks: 1_000_000,
  idleKickTicks: 2_000_000,
  matchSeconds: 600,
  maxInputsPerSecond: 100_000,
  mapFor: () => OPEN_MAP,
};
const SHOOTER: Stats = { armor: 0, engine: 0, gun: 5, reload: 5 };
const TARGET: Stats = { armor: 0, engine: 5, gun: 0, reload: 5 };
const AIM_TOLERANCE = 0.02;
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;
const LONG_QUIET_TICKS = 30_000;
// Финал наступает, когда зона накрыла половину мест появления: на этой карте — угловые места, через 2,96 с
// шестисекундного матча, раньше, чем у появившихся с началом боя кончается неуязвимость. Все появляются на тике
// начала боя в центральных местах, которые зона не накрывает, поэтому к финалу все живы на поле. Медленный тик
// оставляет скрипту время до конца матча.
const FINAL_EARLY_MATCH_SECONDS = 6;
const FINAL_EARLY_TICK_MS = 40;
const FINAL_EARLY_MAP: FfaMap = {
  ...OPEN_MAP,
  spawnAreas: [
    { x: 60, y: 60, radius: 40 },
    { x: 1540, y: 60, radius: 40 },
    { x: 60, y: 840, radius: 40 },
    { x: 1540, y: 840, radius: 40 },
    { x: 650, y: 370, radius: 120 },
    { x: 950, y: 370, radius: 120 },
    { x: 650, y: 530, radius: 120 },
    { x: 950, y: 530, radius: 120 },
  ],
};
const STILL: Action = { throttle: 0, turn: 0, turretTurn: 0, isFiring: false };
const PYRAMID_OF_SIX = ['Манекен [1]', 'Прогульщик [2]', 'Новобранец [3]', 'Сержант [4]', 'Ветеран [5]', 'Призрак [7]'];
const PYRAMID_OF_FIVE = ['Манекен [1]', 'Новобранец [3]', 'Призрак [7]', 'Прогульщик [2]', 'Сержант [4]'];
const PYRAMID_OF_FOUR = ['Манекен [1]', 'Новобранец [3]', 'Призрак [7]', 'Прогульщик [2]'];
const IDLE_ACTION_TEXT = '0,0,0,0';

let app: App | null = null;
let port = 0;
const clients: TestClient[] = [];
const logDirs: string[] = [];

async function startApp(overrides: Partial<FfaOptions> = {}, appOptions: AppOptions = {}): Promise<App> {
  const options = { ...FAST, botRandom: seededRandom(5), ...overrides };
  const started = createApp({ ffa: options, tickMs: 1, ...appOptions });
  app = started;
  port = await started.listen(0, '127.0.0.1');
  return started;
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await app?.close();
  app = null;
  for (const dir of logDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Entered {
  client: TestClient;
  welcome: FfaWelcomeMessage;
}

interface EnterOptions {
  nickname?: string;
  stats?: Stats;
  token?: string;
  isBot?: boolean;
  gameId?: string;
}

async function connectAndJoin(options: EnterOptions): Promise<TestClient> {
  const client = await TestClient.connect(port);
  clients.push(client);
  client.join(
    'ffa10',
    options.nickname ?? 'Человек',
    options.stats ?? DEFAULT_STATS,
    PROTOCOL_VERSION,
    options.token ?? '',
    options.isBot ?? false,
    options.gameId ?? '',
  );
  return client;
}

async function enter(options: EnterOptions = {}): Promise<Entered> {
  const client = await connectAndJoin(options);
  return { client, welcome: await client.nextOfType(MessageType.FfaWelcome) };
}

function tankOf(snapshot: FfaSnapshotMessage | null, id: number): FfaTankSnapshot | undefined {
  return snapshot?.tanks.find((tank) => tank.id === id);
}

function botIds(roster: readonly FfaRosterEntry[]): number[] {
  return roster.filter((player) => player.isBot).map((player) => player.id);
}

function humanIds(roster: readonly FfaRosterEntry[]): number[] {
  return roster.filter((player) => !player.isBot).map((player) => player.id);
}

function botNames(roster: readonly FfaRosterEntry[]): string[] {
  return roster
    .filter((player) => player.isBot)
    .map((player) => player.nickname)
    .sort();
}

function gtOf(line: string | undefined): number {
  return Number(/ gt=(\d+) /.exec(line ?? '')?.[1] ?? NaN);
}

// Команды строки журнала `ac`: номер игрока → команда текстом.
function journalActions(line: string): [number, string][] {
  if (!line.includes(` ${FFA_JOURNAL.actions} `)) {
    return [];
  }
  const parts = line.slice(line.indexOf(` ${FFA_JOURNAL.actions} `) + FFA_JOURNAL.actions.length + 2).split(' ');
  return parts.map((part) => {
    const [id = '', action = ''] = part.split('=');
    return [Number(id), action];
  });
}

// Что видит один клиент: последнее состояние, состав, снимок, счёт. until разбирает пришедшее по порядку и на каждое
// сообщение вызывает onMessage — до того, как обновит своё состояние.
class View {
  roster: FfaRosterEntry[] = [];
  state: FfaStateMessage | null = null;
  snapshot: FfaSnapshotMessage | null = null;
  score: FfaScoreMessage | null = null;
  readonly dead = new Set<number>();
  // Боты, выбывшие в финале за человека: смерть с признаком Out.
  readonly knockedOut: number[] = [];
  // Пришедшее, но ещё не разобранное: until останавливается на нужном сообщении, остальное ждёт следующего.
  private readonly pending: ServerMessage[] = [];

  constructor(readonly entered: Entered) {}

  get id(): number {
    return this.entered.welcome.playerId;
  }

  async until(
    isDone: (view: View) => boolean,
    what: string,
    onMessage: (message: ServerMessage, view: View) => void = () => undefined,
    timeoutMs = WAIT_MS,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.pending.push(...this.entered.client.takeQueued());
      for (let message = this.pending.shift(); message !== undefined; message = this.pending.shift()) {
        onMessage(message, this);
        this.absorb(message);
        if (isDone(this)) {
          return;
        }
      }
      await sleep(2);
    }
    throw new Error(`не дождались: ${what}`);
  }

  private absorb(message: ServerMessage): void {
    switch (message.type) {
      case MessageType.FfaRoster:
        this.roster = message.players;
        break;
      case MessageType.FfaState:
        this.state = message;
        break;
      case MessageType.FfaSnapshot:
        this.snapshot = message;
        for (const event of message.events) {
          if (event.kind === 'death' && event.tank !== null) {
            this.dead.add(event.tank);
            if ((event.flags & EventFlag.Out) !== 0) {
              this.knockedOut.push(event.tank);
            }
          }
        }
        break;
      case MessageType.FfaScore:
        this.score = message;
        break;
      default:
        break;
    }
  }
}

function isPhase(phase: FfaPhase): (view: View) => boolean {
  return (view) => view.state?.phase === phase;
}

function isBotAlive(view: View, id: number): boolean {
  return tankOf(view.snapshot, id)?.isAlive === true;
}

// В каком порядке игра отпускает ботов: без танка на поле, затем в обломках, затем не видимых людьми с танком на
// поле, затем — с самым низким местом.
function yieldOrder(view: View, bots: readonly number[]): number[] {
  const tanks = view.snapshot?.tanks ?? [];
  const humans = new Set(humanIds(view.roster));
  const centers = tanks.filter((tank) => humans.has(tank.id)).map((tank) => ffaViewCenter(tank));
  const places = ffaStandings(view.score?.rows ?? []).map((row) => row.id);
  const rank = (id: number): number => {
    const tank = tanks.find((candidate) => candidate.id === id);
    const isOnField = tank?.isAlive === true;
    const isWreck = tank?.isAlive === false;
    const isSeen = tank !== undefined && centers.some((center) => isInFfaView(center, tank.x, tank.y));
    return Number(isOnField) * 4 + Number(isWreck) * 2 + Number(isSeen);
  };
  return [...bots].sort((a, b) => rank(a) - rank(b) || places.indexOf(b) - places.indexOf(a));
}

// Слушатель состава: кто из ботов ушёл и кого по порядку ухода ждали — по состоянию до этого состава.
function yieldWatcher(): {
  victims: number[];
  expected: number[];
  onMessage: (message: ServerMessage, view: View) => void;
} {
  const victims: number[] = [];
  const expected: number[] = [];
  return {
    victims,
    expected,
    onMessage: (message, view) => {
      if (message.type !== MessageType.FfaRoster) {
        return;
      }
      const ids = new Set(message.players.map((player) => player.id));
      const byId = (a: number, b: number): number => a - b;
      const gone = botIds(view.roster).filter((id) => !ids.has(id));
      victims.push(...gone.sort(byId));
      expected.push(...yieldOrder(view, botIds(view.roster)).slice(0, gone.length).sort(byId));
    },
  };
}

// Порядок ухода видно, только когда бот не на поле стоит в таблице выше бота на поле, которого не видят люди.
function isFieldOutranked(view: View): boolean {
  const tanks = view.snapshot?.tanks ?? [];
  const humans = new Set(humanIds(view.roster));
  const centers = tanks.filter((tank) => humans.has(tank.id)).map((tank) => ffaViewCenter(tank));
  const places = ffaStandings(view.score?.rows ?? []).map((row) => row.id);
  const bots = botIds(view.roster);
  const offField = bots.filter((id) => !isBotAlive(view, id));
  const unseen = bots.filter((id) => {
    const tank = tankOf(view.snapshot, id);
    return tank?.isAlive === true && !centers.some((center) => isInFfaView(center, tank.x, tank.y));
  });
  return offField.some((id) => unseen.some((other) => places.indexOf(other) > places.indexOf(id)));
}

let jitter = 1;

function fidget(): Action {
  jitter = -jitter;
  return { ...STILL, throttle: jitter * 0.02 };
}

const unconfirmedTurns = new Map<TestClient, { seq: number; turretTurn: number }[]>();

// Стрелок доворачивает башню от места, куда её приведут его неподтверждённые команды, — как настоящий клиент.
// targetAt — танк цели из её собственного снимка: цель может быть за краем обзора стрелка.
function hunt(
  shooter: TestClient,
  snapshot: FfaSnapshotMessage,
  shooterId: number,
  targetAt: FfaTankSnapshot | undefined,
): void {
  const me = tankOf(snapshot, shooterId);
  const enemy = targetAt;
  if (me === undefined) {
    return;
  }
  const unconfirmed = (unconfirmedTurns.get(shooter) ?? []).filter((entry) => entry.seq > snapshot.ackSeq);
  const turret = unconfirmed.reduce(
    (angle, entry) => normalizeAngle(angle + entry.turretTurn * TURRET_RATE * DT),
    me.turret,
  );
  let action = fidget();
  if (enemy?.isAlive === true) {
    const diff = normalizeAngle(Math.atan2(enemy.y - me.y, enemy.x - me.x) - turret);
    const turretTurn = Math.max(-1, Math.min(1, diff / (TURRET_RATE * DT)));
    action = { ...action, turretTurn, isFiring: Math.abs(diff) < AIM_TOLERANCE };
  }
  const seq = shooter.input(action);
  unconfirmedTurns.set(shooter, [...unconfirmed, { seq, turretTurn: action.turretTurn }]);
}

async function journalOf(logDir: string, gameId: string): Promise<string[]> {
  await app?.close();
  app = null;
  return readFileSync(join(logDir, `${gameId}.log`), 'utf8').split('\n');
}

function freshLogDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tanks-ffa-bots-'));
  logDirs.push(dir);
  return dir;
}

describe('добор серверными ботами', () => {
  it(
    'первый человек в лобби: состав уже добран ботами по пирамиде, ники «Имя [уровень]», 7 из 10, старт назначен',
    async () => {
      await startApp({ lobbyQuietTicks: LONG_QUIET_TICKS });
      const { client } = await enter({ nickname: 'Дима' });
      const roster = await client.nextOfType(MessageType.FfaRoster);
      expect(roster.players.map((player) => [player.nickname, player.isBot])).toEqual([
        ['Дима', false],
        ...PYRAMID_OF_SIX.map((name) => [name, true]),
      ]);
      const state = await client.nextOfType(MessageType.FfaState);
      expect(state).toMatchObject({ phase: FfaPhase.Lobby, players: 7, minimum: 7, ticksLeft: LONG_QUIET_TICKS });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'люди приходят и уходят в лобби: оставшиеся боты — пирамида нужного числа, добор — недостающий уровень, бот уровня 7 один',
    async () => {
      await startApp({ lobbyQuietTicks: LONG_QUIET_TICKS, reconnectTicks: 20 });
      const first = new View(await enter());
      await first.until((view) => view.roster.length === 7, 'добор');
      const second = await enter();
      await first.until(
        (view) => humanIds(view.roster).length === 2 && view.roster.length === 7,
        'второй человек в составе, бот ушёл',
      );
      expect(botNames(first.roster)).toEqual(PYRAMID_OF_FIVE);
      expect(first.state).toMatchObject({ players: 7 });
      const third = await enter();
      await first.until(
        (view) => humanIds(view.roster).length === 3 && view.roster.length === 7,
        'третий человек в составе, бот ушёл',
      );
      expect(botNames(first.roster)).toEqual(PYRAMID_OF_FOUR);

      third.client.close();
      await first.until(
        (view) => humanIds(view.roster).length === 2 && view.roster.length === 7,
        'бот вместо третьего',
      );
      expect(botNames(first.roster)).toEqual(PYRAMID_OF_FIVE);
      second.client.close();
      await first.until((view) => humanIds(view.roster).length === 1 && view.roster.length === 7, 'бот вместо второго');
      expect(botNames(first.roster)).toEqual([...PYRAMID_OF_SIX].sort());
      expect(botNames(first.roster).filter((name) => name.endsWith('[7]'))).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'лобби → бой без людей-добора: боты едут и стреляют; команда бота доходит до игры не раньше второго тика после снимка',
    async () => {
      const logDir = freshLogDir();
      await startApp({}, { logDir });
      const human = new View(await enter());
      const starts = new Map<number, { x: number; y: number }>();
      const moved = new Set<number>();
      let botShots = 0;
      await human.until(
        () => moved.size >= 4 && botShots > 0,
        'боты едут и стреляют',
        (message, view) => {
          if (message.type !== MessageType.FfaSnapshot || view.state?.phase !== FfaPhase.Fight) {
            return;
          }
          const bots = new Set(botIds(view.roster));
          for (const tank of message.tanks.filter((candidate) => bots.has(candidate.id))) {
            const start = starts.get(tank.id) ?? { x: tank.x, y: tank.y };
            starts.set(tank.id, start);
            if (Math.hypot(tank.x - start.x, tank.y - start.y) > 50) {
              moved.add(tank.id);
            }
          }
          botShots += message.births.filter((birth) => bots.has(birth.owner)).length;
        },
      );
      const bots = new Set(botIds(human.roster));
      const journal = await journalOf(logDir, human.entered.welcome.gameId);
      const fightAt = gtOf(journal.find((line) => line.includes(` ${FFA_JOURNAL.fightStart} `)));
      const firstMove = journal.find((line) =>
        journalActions(line).some(([id, action]) => bots.has(id) && action !== IDLE_ACTION_TEXT),
      );
      expect(gtOf(firstMove) - fightAt).toBeGreaterThanOrEqual(3);
      const [replayed] = replayFfaJournal(journal, { mapFor: () => OPEN_MAP }).matches;
      expect(replayed?.mismatches).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'второй матч — с теми же ботами, они снова едут',
    async () => {
      await startApp({ matchSeconds: 10 });
      const human = new View(await enter());
      await human.until(isPhase(FfaPhase.Fight), 'бой');
      const firstBots = botIds(human.roster);
      const starts = new Map<number, { x: number; y: number }>();
      const moved = new Set<number>();
      await human.until(
        () => moved.size >= 3,
        'боты едут во втором матче',
        (message, view) => {
          const isSecondFight = view.state?.phase === FfaPhase.Fight && view.state.matchIndex === 2;
          if (message.type !== MessageType.FfaSnapshot || !isSecondFight) {
            return;
          }
          for (const tank of message.tanks.filter((candidate) => firstBots.includes(candidate.id))) {
            const start = starts.get(tank.id) ?? { x: tank.x, y: tank.y };
            starts.set(tank.id, start);
            if (Math.hypot(tank.x - start.x, tank.y - start.y) > 20) {
              moved.add(tank.id);
            }
          }
        },
      );
      expect(botIds(human.roster)).toEqual(firstBots);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'игра только из ботов роя — серверных ботов нет',
    async () => {
      const started = await startApp();
      const swarmBot = new View(await enter({ isBot: true }));
      await sleep(50);
      await swarmBot.until((view) => view.state !== null, 'состояние');
      expect(swarmBot.roster.map((player) => player.isBot)).toEqual([true]);
      expect(started.stats().rooms).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('человек вытесняет бота', () => {
  it(
    'вход в бой при свободном месте: уходит лишний по пирамиде, когда его танка нет на поле — подбитый лежит обломками 2 с и только потом уходит; ушедший команд не шлёт',
    async () => {
      const logDir = freshLogDir();
      await startApp({}, { logDir });
      const first = new View(await enter());
      await first.until(isPhase(FfaPhase.Fight), 'бой');
      await enter();
      await first.until((view) => humanIds(view.roster).length === 2, 'второй человек в составе');
      expect(first.roster).toHaveLength(8);
      const departures: { id: number; nickname: string; hadTank: boolean; hasDied: boolean }[] = [];
      const deathTicks = new Map<number, number>();
      const ticksAfterDeath: number[] = [];
      await first.until(
        (view) => view.roster.length === 7,
        'лишний бот ушёл',
        (message, view) => {
          if (message.type === MessageType.FfaSnapshot) {
            for (const event of message.events) {
              if (event.kind === 'death' && event.tank !== null) {
                deathTicks.set(event.tank, message.tick);
              }
            }
          }
          if (message.type !== MessageType.FfaRoster) {
            return;
          }
          const ids = new Set(message.players.map((player) => player.id));
          for (const player of view.roster.filter((candidate) => candidate.isBot && !ids.has(candidate.id))) {
            departures.push({
              id: player.id,
              nickname: player.nickname,
              hadTank: tankOf(view.snapshot, player.id) !== undefined,
              hasDied: view.dead.has(player.id),
            });
            const deathTick = deathTicks.get(player.id);
            if (deathTick !== undefined) {
              ticksAfterDeath.push((view.snapshot?.tick ?? 0) - deathTick);
            }
          }
        },
        40_000,
      );
      expect(departures).toEqual([expect.objectContaining({ nickname: 'Ветеран [5]', hadTank: false, hasDied: true })]);
      expect(ticksAfterDeath.every((ticks) => ticks >= FFA.wreckSeconds * TICK_RATE)).toBe(true);
      expect(botNames(first.roster)).toEqual(PYRAMID_OF_FIVE);
      const leftAtTick = first.snapshot?.tick ?? 0;
      await first.until((view) => (view.snapshot?.tick ?? 0) > leftAtTick + 50, 'бой после ухода');

      const [departed] = departures;
      const journal = await journalOf(logDir, first.entered.welcome.gameId);
      const leaveAt = journal.findIndex((line) => line.includes(` ${FFA_JOURNAL.leave} id=${String(departed?.id)} `));
      expect(leaveAt).toBeGreaterThan(0);
      const later = journal.slice(leaveAt + 1).flatMap(journalActions);
      expect(later.filter(([id]) => id === departed?.id).map(([, action]) => action)).toEqual(['-']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'вход на отсчёте: лишний бот на поле остаётся до боя, вошедший высаживается с началом боя',
    async () => {
      await startApp({ countdownTicks: 400 });
      const first = new View(await enter());
      await first.until(isPhase(FfaPhase.Countdown), 'отсчёт');
      const late = new View(await enter());
      await first.until((view) => humanIds(view.roster).length === 2, 'второй человек в составе');
      await first.until(isPhase(FfaPhase.Fight), 'бой', (message, view) => {
        if (message.type === MessageType.FfaRoster && view.state?.phase === FfaPhase.Countdown) {
          expect(message.players).toHaveLength(8);
        }
      });
      await late.until((view) => view.snapshot?.self.state === 'alive', 'вошедший на поле');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'вход на итогах: лишний бот уходит сразу, следующий матч — 7 игроков',
    async () => {
      await startApp({ matchSeconds: 2, resultsTicks: 400 });
      const first = new View(await enter());
      await first.until(isPhase(FfaPhase.Results), 'итоги');
      await enter();
      await first.until(
        (view) => humanIds(view.roster).length === 2 && view.roster.length === 7,
        'лишний бот ушёл на итогах',
      );
      expect(first.state?.phase).toBe(FfaPhase.Results);
      await first.until(isPhase(FfaPhase.Countdown), 'отсчёт второго матча');
      expect(first.state).toMatchObject({ players: 7, matchIndex: 2 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'приглашение в полную игру с ботом: друг входит в игру позвавшего без промаха, бот уходит сразу',
    async () => {
      await startApp({ minimum: { 10: 10, 30: 30, 50: 50 } });
      const host = new View(await enter());
      await host.until((view) => view.roster.length === 10, 'игра добрана ботами');
      const friend = await enter({ gameId: host.entered.welcome.gameId });
      expect(friend.welcome.gameId).toBe(host.entered.welcome.gameId);
      expect(friend.welcome.inviteMiss).toBe(FfaInviteMiss.None);
      await host.until(
        (view) => humanIds(view.roster).length === 2 && view.roster.length === 10,
        'друг в составе, бот ушёл',
      );
      expect(botIds(host.roster)).toHaveLength(8);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'игра полная с ботами: человек входит в ту же игру, бот уходит сразу по порядку ухода; двое в один тик — двое ботов',
    async () => {
      const started = await startApp({ minimum: { 10: 10, 30: 30, 50: 50 } }, { tickMs: 5 });
      const first = new View(await enter());
      await first.until(
        (view) => view.state?.phase === FfaPhase.Fight && view.score !== null && isFieldOutranked(view),
        'бот ждёт возрождения, а ниже него в таблице — бот на поле, которого человек не видит',
        undefined,
        40_000,
      );
      expect(first.roster).toHaveLength(10);
      const second = await connectAndJoin({});
      const single = yieldWatcher();
      await first.until(
        (view) => humanIds(view.roster).length === 2 && view.roster.length === 10,
        'второй человек в составе, бот ушёл',
        single.onMessage,
      );
      expect(single.victims).toHaveLength(1);
      expect(single.victims).toEqual(single.expected);
      expect(single.victims.filter((id) => isBotAlive(first, id))).toEqual([]);
      const secondWelcome = await second.nextOfType(MessageType.FfaWelcome);
      expect(secondWelcome.gameId).toBe(first.entered.welcome.gameId);

      await first.until(
        (view) => botIds(view.roster).every((id) => tankOf(view.snapshot, id)?.isAlive === true),
        'все боты на поле',
      );
      const pair = await Promise.all([connectAndJoin({}), connectAndJoin({})]);
      const double = yieldWatcher();
      await first.until(
        (view) => humanIds(view.roster).length === 4 && view.roster.length === 10,
        'четверо людей, двое ботов ушли',
        double.onMessage,
      );
      expect(double.victims).toHaveLength(2);
      expect(double.victims).toEqual(double.expected);
      const welcomes = await Promise.all(pair.map((client) => client.nextOfType(MessageType.FfaWelcome)));
      expect(welcomes.map((welcome) => welcome.gameId)).toEqual([secondWelcome.gameId, secondWelcome.gameId]);
      expect(botIds(first.roster)).toHaveLength(6);
      expect(started.stats().rooms).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'игра полная, бот в обломках — входит человек: уходит бот без живого танка, а не живой',
    async () => {
      await startApp({ minimum: { 10: 10, 30: 30, 50: 50 } }, { tickMs: 5 });
      const first = new View(await enter());
      await first.until(
        (view) =>
          view.state?.phase === FfaPhase.Fight &&
          botIds(view.roster).every((id) => tankOf(view.snapshot, id) !== undefined) &&
          botIds(view.roster).filter((id) => !isBotAlive(view, id)).length === 1,
        'один бот в обломках, остальные живы на поле',
        undefined,
        40_000,
      );
      await connectAndJoin({});
      const watcher = yieldWatcher();
      const wereAlive: boolean[] = [];
      await first.until(
        (view) => humanIds(view.roster).length === 2 && view.roster.length === 10,
        'второй человек в составе, бот ушёл',
        (message, view) => {
          watcher.onMessage(message, view);
          if (message.type === MessageType.FfaRoster) {
            const ids = new Set(message.players.map((player) => player.id));
            wereAlive.push(
              ...botIds(view.roster)
                .filter((id) => !ids.has(id))
                .map((id) => isBotAlive(view, id)),
            );
          }
        },
      );
      expect(watcher.victims).toHaveLength(1);
      expect(watcher.victims).toEqual(watcher.expected);
      expect(wereAlive).toEqual([false]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'полная игра в финале, все боты на поле, входит человек: сначала входит в матч, за него взрывается бот, и уходит именно он, а не живой; вошедший играет',
    async () => {
      const logDir = freshLogDir();
      await startApp(
        { minimum: { 10: 10, 30: 30, 50: 50 }, matchSeconds: FINAL_EARLY_MATCH_SECONDS, mapFor: () => FINAL_EARLY_MAP },
        { logDir, tickMs: FINAL_EARLY_TICK_MS },
      );
      const first = new View(await enter());
      let aliveAtFinal: number | null = null;
      await first.until(
        (view) => view.roster.length === 10 && aliveAtFinal !== null,
        'финал',
        (message) => {
          if (
            message.type === MessageType.FfaSnapshot &&
            message.events.some((event) => event.kind === 'suddenDeath')
          ) {
            aliveAtFinal = message.tanks.filter((tank) => tank.isAlive).length;
          }
        },
        40_000,
      );
      expect(aliveAtFinal).toBe(10);
      const late = new View(await enter({ nickname: 'Опоздавший' }));
      const departed: { id: number }[] = [];
      const noteDeparted = (message: ServerMessage, view: View): void => {
        if (message.type !== MessageType.FfaRoster) {
          return;
        }
        const ids = new Set(message.players.map((player) => player.id));
        for (const id of botIds(view.roster).filter((botId) => !ids.has(botId))) {
          departed.push({ id });
        }
      };
      await first.until((view) => humanIds(view.roster).length === 2, 'вошедший в составе', noteDeparted);
      await late.until((view) => view.snapshot?.self.state === 'alive', 'вошедший на поле');
      const startX = tankOf(late.snapshot, late.id)?.x ?? 0;
      await late.until(
        (view) => Math.abs((tankOf(view.snapshot, late.id)?.x ?? startX) - startX) > 20,
        'вошедший едет',
        (message) => {
          if (message.type === MessageType.FfaSnapshot) {
            late.entered.client.input({ ...STILL, throttle: 1 });
          }
        },
      );
      expect(late.entered.welcome.gameId).toBe(first.entered.welcome.gameId);
      await first.until(
        (view) => view.roster.length === 10 && view.knockedOut.length > 0,
        'бот выбыл за вошедшего и ушёл',
        noteDeparted,
      );
      expect(departed).toHaveLength(1);
      const [victim] = departed;

      const journal = await journalOf(logDir, first.entered.welcome.gameId);
      const joinAt = journal.findIndex((line) => line.includes(` ${FFA_JOURNAL.join} id=${String(late.id)} `));
      expect(joinAt).toBeGreaterThan(0);
      const tick = gtOf(journal[joinAt]);
      const finalAt = journal.findIndex((line) => line.endsWith(' suddenDeath'));
      expect(journal.slice(0, finalAt).filter((line) => line.includes(' death id='))).toEqual([]);
      const sameTick = journal.filter((line) => gtOf(line) === tick);
      const outs = sameTick.filter((line) => line.includes(' out id='));
      expect(outs).toHaveLength(1);
      const knockedOut = Number(/ out id=(\d+)$/.exec(outs[0] ?? '')?.[1]);
      // Между началом финала и входом мог погибнуть бот — тогда уйти вправе и он.
      const hasDiedBefore = journal.slice(0, joinAt).some((line) => line.includes(` death id=${String(victim?.id)} `));
      expect(victim?.id === knockedOut || hasDiedBefore).toBe(true);
      const leaves = sameTick.filter((line) => line.endsWith(`reason=${FFA_LEAVE_YIELD}`));
      expect(leaves).toEqual([expect.stringContaining(` ${FFA_JOURNAL.leave} id=${String(victim?.id)} `)]);
      const [replayed] = replayFfaJournal(journal, { mapFor: () => FINAL_EARLY_MAP }).matches;
      expect(replayed?.mismatches).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'финал со свободными местами: за вошедшего взрывается бот, вошедший играет; подбитый человек — бот взрывается на тике гибели, человек возрождается',
    async () => {
      const logDir = freshLogDir();
      await startApp({ matchSeconds: 60 }, { logDir });
      const target = new View(await enter({ nickname: 'Мишень', stats: TARGET }));
      await target.until(
        () => target.snapshot?.events.some((event) => event.kind === 'suddenDeath') === true,
        'финал',
        undefined,
        30_000,
      );
      const shooter = new View(await enter({ nickname: 'Стрелок', stats: SHOOTER }));
      await shooter.until((view) => view.snapshot?.self.state === 'alive', 'вошедший в финал на поле');
      await target.until((view) => view.knockedOut.length > 0, 'бот выбыл за вошедшего');

      let outWithOwnDeath: number[] | null = null;
      let stateAfterWreck: string | null = null;
      let previous: FfaSnapshotMessage | null = null;
      await target.until(
        () => stateAfterWreck !== null,
        'мишень подбита в финале',
        (message, view) => {
          if (message.type === MessageType.FfaState && message.phase !== FfaPhase.Fight) {
            throw new Error('матч кончился раньше, чем мишень подбили в финале');
          }
          if (message.type !== MessageType.FfaSnapshot) {
            return;
          }
          const isOwnDeath = message.events.some((event) => event.kind === 'death' && event.tank === view.id);
          if (isOwnDeath) {
            outWithOwnDeath = message.events
              .filter((event) => event.kind === 'death' && (event.flags & EventFlag.Out) !== 0)
              .map((event) => event.tank ?? -1);
            expect(message.self).toMatchObject({ state: 'wreck', isOut: false });
          }
          if (outWithOwnDeath !== null && previous?.self.state === 'wreck' && message.self.state !== 'wreck') {
            stateAfterWreck = message.self.state;
          }
          previous = message;
          const latest = shooter.entered.client
            .takeQueued()
            .filter((candidate) => candidate.type === MessageType.FfaSnapshot);
          const fresh = latest[latest.length - 1];
          if (fresh?.type === MessageType.FfaSnapshot) {
            hunt(shooter.entered.client, fresh, shooter.id, tankOf(message, view.id));
          }
        },
        30_000,
      );
      expect(outWithOwnDeath).toHaveLength(1);
      expect(stateAfterWreck).toBe('waiting');
      await target.until(
        (view) => view.snapshot?.events.some((event) => event.kind === 'spawn' && event.tank === view.id) === true,
        'мишень возродилась',
      );

      const journal = await journalOf(logDir, target.entered.welcome.gameId);
      expect(journal.some((line) => / roster=.*:b(,|$)/.test(line))).toBe(true);
      expect(journal.filter((line) => line.includes(' out id=')).length).toBeGreaterThanOrEqual(2);
      const [replayed] = replayFfaJournal(journal, { mapFor: () => OPEN_MAP }).matches;
      expect(replayed?.sums).toBeGreaterThan(0);
      expect(replayed?.mismatches).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'лишний бот — последний бот рядом с людьми: на поле до гибели или конца матча, уходит на итогах',
    async () => {
      await startApp({ minimum: { 10: 2, 30: 2, 50: 2 }, matchSeconds: 20, resultsTicks: 400 });
      const first = new View(await enter());
      await first.until(isPhase(FfaPhase.Fight), 'бой');
      const [botId = -1] = botIds(first.roster);
      await enter();
      await first.until((view) => humanIds(view.roster).length === 2, 'второй человек в составе');
      const leftFromField: number[] = [];
      let fieldSnapshots = 0;
      await first.until(
        (view) => view.state?.phase === FfaPhase.Results && view.roster.length === 2,
        'бот ушёл на итогах',
        (message, view) => {
          const isOnField = isBotAlive(view, botId);
          fieldSnapshots += Number(message.type === MessageType.FfaSnapshot && tankOf(message, botId) !== undefined);
          const hasLeft =
            message.type === MessageType.FfaRoster && !message.players.some((player) => player.id === botId);
          if (hasLeft && isOnField && view.state?.phase !== FfaPhase.Results) {
            leftFromField.push(view.snapshot?.tick ?? -1);
          }
        },
      );
      expect(fieldSnapshots).toBeGreaterThan(0);
      expect(leftFromField).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('связь людей и уход последнего', () => {
  it(
    'человек оборвался и вернулся по пропуску в окне — боты те же, он на своём месте',
    async () => {
      await startApp();
      const first = new View(await enter());
      const second = await enter();
      await first.until((view) => humanIds(view.roster).length === 2 && view.state?.phase === FfaPhase.Fight, 'бой');
      const bots = botIds(first.roster);
      const rosters: number[][] = [];
      const recordRoster = (message: ServerMessage): void => {
        if (message.type === MessageType.FfaRoster) {
          rosters.push(botIds(message.players));
        }
      };
      second.client.close();
      const closedAt = first.snapshot?.tick ?? 0;
      await first.until(
        (view) => (view.snapshot?.tick ?? 0) > closedAt + 300,
        'триста тиков без второго',
        recordRoster,
      );
      const back = await enter({ token: second.welcome.token });
      expect(back.welcome.playerId).toBe(second.welcome.playerId);
      const backAt = first.snapshot?.tick ?? 0;
      await first.until((view) => (view.snapshot?.tick ?? 0) > backAt + 100, 'сто тиков после возврата', recordRoster);
      expect(rosters.every((ids) => ids.join() === bots.join())).toBe(true);
      expect(botIds(first.roster)).toEqual(bots);
      expect(humanIds(first.roster)).toEqual([first.id, second.welcome.playerId]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'последний человек оборвался в бою и вернулся в окне — боты на месте, игра та же',
    async () => {
      const started = await startApp();
      const human = new View(await enter());
      await human.until((view) => (view.snapshot?.tick ?? 0) > 30, 'бой');
      const bots = botIds(human.roster);
      human.entered.client.close();
      await sleep(300);
      expect(started.stats().rooms).toBe(1);
      const back = new View(await enter({ token: human.entered.welcome.token }));
      expect(back.id).toBe(human.id);
      expect(back.entered.welcome.gameId).toBe(human.entered.welcome.gameId);
      await back.until((view) => view.roster.length > 0 && view.snapshot !== null, 'состав и снимок');
      expect(botIds(back.roster)).toEqual(bots);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'серверных ботов не выкидывают за бездействие',
    async () => {
      const logDir = freshLogDir();
      await startApp({ idleWarnTicks: 20, idleKickTicks: 40 }, { logDir });
      const human = new View(await enter());
      await human.until(isPhase(FfaPhase.Fight), 'бой');
      const bots = botIds(human.roster);
      await human.until(
        (view) => (view.snapshot?.tick ?? 0) > 1500,
        'полторы тысячи тиков боя',
        (message) => {
          if (message.type === MessageType.FfaSnapshot) {
            human.entered.client.input(fidget());
          }
        },
      );
      expect(botIds(human.roster)).toEqual(bots);
      const journal = await journalOf(logDir, human.entered.welcome.gameId);
      expect(journal.filter((line) => line.endsWith(`reason=${FFA_LEAVE_IDLE}`))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it('серверный бот без команд стоит дольше порога бездействия — не выкинут; человек с командами — тоже', () => {
    const options: FfaOptions = { ...FAST, idleWarnTicks: 5, idleKickTicks: 10 };
    const game = new FfaGame(10, options, NO_LOG, NO_DROP_COUNTER, DEFAULT_RULES);
    const seen: { phase: FfaPhase; roster: FfaRosterEntry[]; errors: number } = {
      phase: FfaPhase.Lobby,
      roster: [],
      errors: 0,
    };
    const human = game.join(
      {
        send: (bytes: Uint8Array): void => {
          const message = decode(bytes);
          if (message.type === MessageType.FfaState) {
            seen.phase = message.phase;
          }
          if (message.type === MessageType.FfaRoster) {
            seen.roster = message.players;
          }
          if (message.type === MessageType.Error) {
            seen.errors++;
          }
        },
        close: (): void => undefined,
      },
      'Человек',
      DEFAULT_STATS,
      false,
    );
    let seq = 0;
    const fidgetStep = (): void => {
      seq++;
      human.input(seq, { ...STILL, throttle: seq % 2 === 0 ? 0.02 : -0.02 });
      game.step();
    };
    while (seen.phase !== FfaPhase.Fight) {
      fidgetStep();
    }
    const bots = botIds(seen.roster);
    expect(bots.length).toBeGreaterThan(0);
    for (let tick = 0; tick < 20 * options.idleKickTicks; tick++) {
      fidgetStep();
    }
    expect(botIds(seen.roster)).toEqual(bots);
    expect(seen.errors).toBe(0);
  });

  it(
    'человек оборвался дольше окна при другом человеке — вместо него входит бот; прогон журнала совпадает',
    async () => {
      const logDir = freshLogDir();
      await startApp({ reconnectTicks: 30 }, { logDir });
      const first = new View(await enter());
      const second = await enter();
      await first.until((view) => humanIds(view.roster).length === 2 && view.state?.phase === FfaPhase.Fight, 'бой');
      await sleep(50);
      second.client.close();
      await first.until(
        (view) => humanIds(view.roster).length === 1 && botIds(view.roster).length === 6,
        'бот вместо ушедшего',
      );
      await first.until((view) => (view.snapshot?.tick ?? 0) > 200, 'бой после замены');
      const journal = await journalOf(logDir, first.entered.welcome.gameId);
      expect(journal.some((line) => line.includes(` ${FFA_JOURNAL.join} `) && line.endsWith(' bot=1'))).toBe(true);
      const [replayed] = replayFfaJournal(journal, { mapFor: () => OPEN_MAP }).matches;
      expect(replayed?.sums).toBeGreaterThan(0);
      expect(replayed?.mismatches).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'последний человек оборвался дольше окна в бою — боты ушли в том же тике, игра удалена',
    async () => {
      const logDir = freshLogDir();
      const started = await startApp({ reconnectTicks: 20 }, { logDir });
      const human = new View(await enter());
      await human.until((view) => (view.snapshot?.tick ?? 0) > 30, 'бой');
      human.entered.client.close();
      const deadline = Date.now() + WAIT_MS;
      while (started.stats().rooms > 0 && Date.now() < deadline) {
        await sleep(10);
      }
      expect(started.stats().rooms).toBe(0);
      const journal = await journalOf(logDir, human.entered.welcome.gameId);
      const leaves = journal.filter((line) => line.includes(` ${FFA_JOURNAL.leave} `));
      const ticks = new Set(leaves.map((line) => /gt=(\d+)/.exec(line)?.[1]));
      expect(leaves).toHaveLength(7);
      expect(ticks.size).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'последний человек выкинут за бездействие — боты ушли, игра удалена',
    async () => {
      const started = await startApp({ idleWarnTicks: 20, idleKickTicks: 40 });
      const human = await enter();
      expect((await human.client.nextOfType(MessageType.Error, WAIT_MS)).code).toBe(ErrorCode.Idle);
      const deadline = Date.now() + WAIT_MS;
      while (started.stats().rooms > 0 && Date.now() < deadline) {
        await sleep(10);
      }
      expect(started.stats().rooms).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('бюджет хода ботов', () => {
  const BOTS = 34;
  // Замедление — как у боевой машины против Mac: без бюджета проход 34 ботов в два-три раза длиннее бюджета.
  const SLOWDOWN = 15;
  // Меньше одного решения медленного мозга: за проход решает ровно первый в очереди.
  const ONE_DECISION_BUDGET_MS = 1;
  // Во весь тик: за проход решают почти все боты, и поиски пути упираются в разрешение на проход.
  const WHOLE_TICK_BUDGET_MS = Math.floor(1000 / TICK_RATE);
  const FIGHT_TICKS = 200;
  const SLOW_TIMEOUT_MS = 120_000;
  // Бот без решения дольше INPUT_TIMEOUT_TICKS без повтора команды замолчал бы и встал; с повтором живые боты едут
  // почти всегда.
  const MOVING_SHARE_MIN = 0.85;
  // Проход перерастает бюджет на последнее начатое решение: в медиане — на полбюджета, в 99-м процентиле — на четыре.
  const TYPICAL_PASS_BUDGETS = 1.5;
  const SLOW_PASS_BUDGETS = 5;

  interface SlowFight {
    typicalPassMs: number;
    slowPassMs: number;
    skipped: number;
    longestWait: number;
    // Доля тиков, в которые живой танк бота сдвинулся.
    movingShare: number;
  }

  async function metricsOf(): Promise<Map<string, number>> {
    const text = await (await fetch(`http://127.0.0.1:${String(port)}/metrics`)).text();
    const series = new Map<string, number>();
    for (const line of text.split('\n').filter((entry) => entry !== '' && !entry.startsWith('#'))) {
      const space = line.lastIndexOf(' ');
      series.set(line.slice(0, space), Number(line.slice(space + 1)));
    }
    return series;
  }

  async function slowFight(botBudgetMs: number): Promise<SlowFight> {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await app?.close();
    await startApp(
      {
        mapFor: DEFAULT_FFA_OPTIONS.mapFor,
        minimum: { 10: 7, 30: 7, 50: BOTS + 1 },
        botSlowdown: SLOWDOWN,
        botBudgetMs,
      },
      { tickMs: 1000 / TICK_RATE, silenceTimeoutMs: SLOW_TIMEOUT_MS, botClock: threadCpuMs },
    );
    const client = await TestClient.connect(port);
    clients.push(client);
    client.join('ffa50', 'Человек', DEFAULT_STATS, PROTOCOL_VERSION, '', false, '');
    const human = new View({ client, welcome: await client.nextOfType(MessageType.FfaWelcome) });
    await human.until(isPhase(FfaPhase.Fight), 'бой');
    expect(botIds(human.roster)).toHaveLength(BOTS);
    const before = await metricsOf();
    const previous = new Map<number, { x: number; y: number }>();
    let fightTicks = 0;
    let aliveSamples = 0;
    let movingSamples = 0;
    await human.until(
      () => fightTicks >= FIGHT_TICKS,
      'бой идёт',
      (message, view) => {
        if (message.type !== MessageType.FfaSnapshot || view.state?.phase !== FfaPhase.Fight) {
          return;
        }
        fightTicks++;
        const bots = new Set(botIds(view.roster));
        for (const tank of message.tanks.filter((candidate) => bots.has(candidate.id))) {
          const last = previous.get(tank.id);
          previous.set(tank.id, { x: tank.x, y: tank.y });
          if (!tank.isAlive || last === undefined) {
            continue;
          }
          aliveSamples++;
          movingSamples += Number(tank.x !== last.x || tank.y !== last.y);
        }
      },
      SLOW_TIMEOUT_MS,
    );
    const after = await metricsOf();
    const fight: SlowFight = {
      typicalPassMs: after.get('tanks_bot_think_ms{quantile="0.5"}') ?? Infinity,
      slowPassMs: after.get('tanks_bot_think_ms{quantile="0.99"}') ?? Infinity,
      skipped: (after.get('tanks_bot_skipped_total') ?? 0) - (before.get('tanks_bot_skipped_total') ?? 0),
      longestWait: after.get('tanks_bot_wait_ticks{quantile="max"}') ?? Infinity,
      movingShare: movingSamples / aliveSamples,
    };
    console.log(
      `медленный мозг, бюджет ${String(botBudgetMs)} мс: проход ${fight.typicalPassMs.toFixed(2)} · 99-й ` +
        `${fight.slowPassMs.toFixed(2)} мс, пропусков ${String(fight.skipped)}, дольше всех ждал ` +
        `${String(fight.longestWait)} тиков, живые боты едут в ${fight.movingShare.toFixed(2)} тиков`,
    );
    return fight;
  }

  it(
    'медленный мозг: ffa50, 34 бота, замедление 15 — проход около бюджета, пропусков тем меньше, чем больше бюджет, каждый бот решает не реже раза за число ботов, пропущенные едут по прошлой команде',
    async () => {
      const budgetMs = DEFAULT_FFA_OPTIONS.botBudgetMs;
      // За проход решает только первый в очереди: проход — обязательная часть, разбор ящиков и одно решение.
      const mandatory = await slowFight(ONE_DECISION_BUDGET_MS);
      expect(mandatory.longestWait).toBeLessThan(BOTS);
      expect(mandatory.movingShare).toBeGreaterThanOrEqual(MOVING_SHARE_MIN);
      const fight = await slowFight(budgetMs);
      // Код под замером покрытия медленнее в разы: одно решение само длиннее бюджета, и проход упирается в него, а не в
      // бюджет. Длительность прохода сверяется с бюджетом, только когда обязательная часть его не съедает.
      const isBudgetMeasurable = mandatory.typicalPassMs <= budgetMs;
      const measuredBudgetMs = isBudgetMeasurable ? budgetMs : Infinity;
      expect(fight.typicalPassMs).toBeLessThanOrEqual(TYPICAL_PASS_BUDGETS * measuredBudgetMs);
      expect(fight.slowPassMs).toBeLessThanOrEqual(SLOW_PASS_BUDGETS * measuredBudgetMs);
      expect(fight.skipped).toBeGreaterThan(0);
      expect(fight.longestWait).toBeLessThan(BOTS);
      expect(fight.movingShare).toBeGreaterThanOrEqual(MOVING_SHARE_MIN);
      const roomy = await slowFight(WHOLE_TICK_BUDGET_MS);
      expect(roomy.skipped).toBeLessThan(fight.skipped);
    },
    3 * SLOW_TIMEOUT_MS,
  );
});
