import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  botRoomCode,
  MessageType,
  PROTOCOL_VERSION,
  ErrorCode,
  type RoundStartMessage,
  type SnapshotMessage,
} from '@tanks/shared/protocol';
import { createApp, type App } from '../src/app.js';
import { TestClient } from './client.js';
import { seededRandom, sleep } from './support.js';

const FAST_ROOM = { countdownTicks: 3, roundEndTicks: 3, maxInputsPerSecond: 90 };
const TICK_MS = 4;
const LOG_BODY_LIMIT_BYTES = 256 * 1024;
const PART_PAUSE_MS = 50;

// Тело двумя записями с паузой: вторая гарантированно приходит отдельным куском уже после отказа — иначе
// дочитывание лишнего тела проверялось бы, только если TCP сам порежет тело на куски после лимита.
async function postInTwoParts(url: string, first: string, second: string): Promise<number | undefined> {
  const request = httpRequest(url, { method: 'POST' });
  const answered = once(request, 'response') as Promise<[IncomingMessage]>;
  request.write(first);
  await sleep(PART_PAUSE_MS);
  request.end(second);
  const [response] = await answered;
  response.resume();
  return response.statusCode;
}

let app: App;
let port: number;
let staticRoot: string;
const clients: TestClient[] = [];

async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(port);
  clients.push(client);
  return client;
}

// Старт раунда последней пары — для проверок идентификатора дуэли.
let lastRoundStart: RoundStartMessage;

async function joinedPair(code = 'duel1'): Promise<[TestClient, TestClient]> {
  const a = await connect();
  const b = await connect();
  a.join(code, 'Алиса');
  await a.nextOfType(MessageType.Welcome);
  b.join(code, 'Боб');
  await b.nextOfType(MessageType.Welcome);
  lastRoundStart = await a.nextOfType(MessageType.RoundStart);
  await b.nextOfType(MessageType.RoundStart);
  return [a, b];
}

async function snapshotAfterCountdown(client: TestClient): Promise<SnapshotMessage> {
  let snapshot = await client.nextOfType(MessageType.Snapshot);
  while (snapshot.tick === 0) {
    snapshot = await client.nextOfType(MessageType.Snapshot);
  }
  return snapshot;
}

async function healthz(): Promise<{ rooms: number; connections: number; tick: number }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
  expect(response.status).toBe(200);
  return (await response.json()) as { rooms: number; connections: number; tick: number };
}

beforeEach(async () => {
  staticRoot = mkdtempSync(join(tmpdir(), 'tanks-static-'));
  writeFileSync(join(staticRoot, 'index.html'), '<html>tanks</html>');
  writeFileSync(join(staticRoot, 'app.js'), 'console.log(1)');
  writeFileSync(join(staticRoot, 'data.bin'), 'raw');
  app = createApp({ staticRoot, room: FAST_ROOM, random: seededRandom(42), tickMs: TICK_MS });
  port = await app.listen(0, '127.0.0.1');
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await app.close();
});

describe('HTTP', () => {
  it('отдаёт состояние на /healthz', async () => {
    const body = await healthz();
    expect(body.rooms).toBe(0);
    expect(body.connections).toBe(0);
  });

  it('раздаёт файлы клиента и index.html на маршрутах приложения', async () => {
    const base = `http://127.0.0.1:${String(port)}`;
    expect(await (await fetch(`${base}/app.js`)).text()).toBe('console.log(1)');
    expect(await (await fetch(`${base}/`)).text()).toBe('<html>tanks</html>');
    expect(await (await fetch(`${base}/d/abc123`)).text()).toBe('<html>tanks</html>');
    expect((await fetch(`${base}/nope.js`)).status).toBe(404);

    const binary = await fetch(`${base}/data.bin`);
    expect(binary.headers.get('content-type')).toBe('application/octet-stream');
    expect(await binary.text()).toBe('raw');

    const outside = join(staticRoot, '..', 'tanks-outside-secret.txt');
    writeFileSync(outside, 'secret');
    try {
      expect((await fetch(`${base}/%2e%2e/tanks-outside-secret.txt`)).status).toBe(404);
    } finally {
      rmSync(outside);
    }
  });

  it('не принимает WebSocket на чужом пути', async () => {
    await expect(TestClient.connect(port, '/other')).rejects.toThrow();
  });

  it('битый кадр WebSocket закрывает соединение, сервер живёт дальше', async () => {
    const socket = connectTcp(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${String(port)}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
    );
    const [handshake] = (await once(socket, 'data')) as [Buffer];
    expect(handshake.toString()).toContain('101');
    expect((await healthz()).connections).toBe(1);

    // Кадр от клиента обязан быть замаскирован; без маски ws отвечает кадром закрытия.
    socket.write(Buffer.from([0x82, 0x01, 0x00]));
    await once(socket, 'data');
    socket.end();
    await once(socket, 'close');
    await sleep(20);
    expect((await healthz()).connections).toBe(0);
  });

  it('отдаёт APK приложения по /app/tanks.apk, пока файл есть', async () => {
    await app.close();
    const apkPath = join(staticRoot, 'tanks.apk');
    writeFileSync(apkPath, 'PK-apk');
    app = createApp({ staticRoot, apkPath, room: FAST_ROOM });
    port = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${String(port)}`;

    const response = await fetch(`${base}/app/tanks.apk`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/vnd.android.package-archive');
    expect(response.headers.get('content-disposition')).toContain('tanks.apk');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toBe('PK-apk');

    const head = await fetch(`${base}/app/tanks.apk`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('6');

    rmSync(apkPath);
    expect((await fetch(`${base}/app/tanks.apk`)).status).toBe(404);
  });

  it('без настроенного APK маршрут /app/tanks.apk отвечает 404', async () => {
    expect((await fetch(`http://127.0.0.1:${String(port)}/app/tanks.apk`)).status).toBe(404);
  });

  it('без папки журнала POST /log отвечает 404', async () => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/log?key=K7MF&src=C1`, {
      method: 'POST',
      body: 'x',
    });
    expect(response.status).toBe(404);
  });
});

describe('процесс', () => {
  it('createApp() без параметров работает с умолчаниями, close() без listen() не падает', async () => {
    await createApp().close();
    const plain = createApp();
    const plainPort = await plain.listen(0, '127.0.0.1');
    try {
      const response = await fetch(`http://127.0.0.1:${String(plainPort)}/healthz`);
      expect(response.status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${String(plainPort)}/`)).status).toBe(404);
    } finally {
      await plain.close();
    }
  });

  it('после остановки процесса дольше пяти тиков расписание сбрасывается, тики не навёрстываются пачкой', async () => {
    await sleep(50);
    const before = (await healthz()).tick;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * TICK_MS);
    await sleep(10 * TICK_MS);
    const after = (await healthz()).tick;
    expect(after - before).toBeGreaterThanOrEqual(5);
    expect(after - before).toBeLessThan(25);
  });
});

describe('вход в комнату', () => {
  it('два игрока получают стороны 0 и 1, состояние комнаты и старт раунда', async () => {
    const a = await connect();
    a.join('room1', 'Алиса');
    const welcomeA = await a.nextOfType(MessageType.Welcome);
    expect(welcomeA.side).toBe(0);
    expect(welcomeA.roomCode).toBe('room1');
    const stateA = await a.nextOfType(MessageType.RoomState);
    expect(stateA.slots[0]).toEqual({ isTaken: true, nickname: 'Алиса' });
    expect(stateA.slots[1].isTaken).toBe(false);

    const b = await connect();
    b.join('room1', '  Боб  ');
    const welcomeB = await b.nextOfType(MessageType.Welcome);
    expect(welcomeB.side).toBe(1);
    const start = await b.nextOfType(MessageType.RoundStart);
    expect(start.tanks[0].nickname).toBe('Алиса');
    expect(start.tanks[1].nickname).toBe('Боб');
    expect(start.score).toEqual([0, 0]);
    expect(start.countdownTicks).toBe(FAST_ROOM.countdownTicks);
    expect(start.rules).toEqual({ wallSlidePercent: 0 });
    expect(app.stats().rooms).toBe(1);
  });

  it('повторный Join из комнаты игнорируется', async () => {
    const [a] = await joinedPair('again');
    a.join('other', 'Алиса-2');
    await expect(a.nextOfType(MessageType.Welcome, 200)).rejects.toThrow();
    expect(await a.closed(100)).toBe(false);
    expect(app.stats().rooms).toBe(1);
  });

  // Бот на месте 0 за 400 снимков успевает поехать или развернуться.
  async function hasBotMoved(human: TestClient): Promise<boolean> {
    let lastHeading: number | null = null;
    for (let i = 0; i < 400; i++) {
      const snapshot = await human.nextOfType(MessageType.Snapshot);
      const bot = snapshot.tanks[0];
      if (lastHeading !== null && (Math.abs(bot.speed) > 1 || bot.heading !== lastHeading)) {
        return true;
      }
      lastHeading = bot.heading;
    }
    return false;
  }

  it('код bot01… — дуэль против манекена: он уже сидит первым, раунд стартует сразу', async () => {
    const code = botRoomCode(1, 'xyz1');
    const human = await connect();
    human.join(code, 'Дима');
    const welcome = await human.nextOfType(MessageType.Welcome);
    expect(welcome.side).toBe(1);
    const start = await human.nextOfType(MessageType.RoundStart);
    expect(start.tanks[0].nickname).toBe('Манекен');
    expect(start.tanks[1].nickname).toBe('Дима');
    expect(await hasBotMoved(human)).toBe(true);

    const stranger = await connect();
    stranger.join(code, 'Третий');
    expect((await stranger.nextOfType(MessageType.Error)).code).toBe(ErrorCode.RoomFull);

    human.close();
    await sleep(100);
    expect(app.stats().rooms).toBe(0);
  });

  it.each([
    [3, 'Новобранец', { armor: 3, engine: 3, gun: 1, reload: 2 }],
    [8, 'Охотник', { armor: 3, engine: 3, gun: 2, reload: 2 }],
    [9, 'Охотник-ас', { armor: 0, engine: 0, gun: 5, reload: 5 }],
    [10, 'ПАРАЛЛАКС-ASTRA', { armor: 2, engine: 1, gun: 2, reload: 5 }],
  ] as const)('уровень %i — бот «%s» со своими характеристиками, двигается', async (level, name, stats) => {
    const human = await connect();
    human.join(botRoomCode(level, 'xyz1'), 'Дима');
    const start = await human.nextOfType(MessageType.RoundStart);
    expect(start.tanks[0]).toEqual({ nickname: name, stats });
    // Стоящий за стеной человек не цель: в стену боты не стреляют, проверяется только движение.
    expect(await hasBotMoved(human)).toBe(true);
  });

  it('код bot без заполненного уровня — неверный код комнаты, комната не создаётся', async () => {
    for (const code of ['botabc', 'bot1abc', 'bot00abc', 'bot11abc']) {
      const client = await connect();
      client.join(code, 'Дима');
      expect((await client.nextOfType(MessageType.Error)).code).toBe(ErrorCode.BadMessage);
      expect(await client.closed()).toBe(true);
    }
    expect(app.stats().rooms).toBe(0);
  });

  it('клиент замолчал — его танк останавливается, а не едет по последней команде вечно', async () => {
    const [a] = await joinedPair('silent');
    await snapshotAfterCountdown(a);
    a.input({ throttle: 1 });
    let fastest = 0;
    let latest = 0;
    for (let i = 0; i < 90; i++) {
      const snapshot = await a.nextOfType(MessageType.Snapshot);
      latest = snapshot.tanks[0].speed;
      fastest = Math.max(fastest, latest);
    }
    expect(fastest).toBeGreaterThan(50);
    expect(latest).toBeLessThan(1);
  });

  it('третьему отказывает: комната полна', async () => {
    await joinedPair('full');
    const c = await connect();
    c.join('full');
    const error = await c.nextOfType(MessageType.Error);
    expect(error.code).toBe(ErrorCode.RoomFull);
    expect(await c.closed()).toBe(true);
  });

  it('отвергает чужую версию протокола, неверный код и мусор', async () => {
    const a = await connect();
    a.join('room1', 'x', undefined, PROTOCOL_VERSION + 1);
    expect((await a.nextOfType(MessageType.Error)).code).toBe(ErrorCode.BadProtocolVersion);

    const b = await connect();
    b.join('НЕ КОД');
    expect((await b.nextOfType(MessageType.Error)).code).toBe(ErrorCode.BadMessage);

    const c = await connect();
    c.sendRaw(new Uint8Array([250, 1, 2]));
    expect((await c.nextOfType(MessageType.Error)).code).toBe(ErrorCode.BadMessage);

    const d = await connect();
    d.sendRaw(new Uint8Array([MessageType.Welcome, 0, 0]));
    expect((await d.nextOfType(MessageType.Error)).code).toBe(ErrorCode.BadMessage);
  });

  it('пустой ник и неверные характеристики заменяются допустимыми', async () => {
    const a = await connect();
    a.join('room2', '   ', { armor: 9, engine: 9, gun: 9, reload: 9 });
    await a.nextOfType(MessageType.Welcome);
    const state = await a.nextOfType(MessageType.RoomState);
    expect(state.slots[0].nickname).toBe('Игрок');
    const b = await connect();
    b.join('room2', 'Боб');
    const start = await b.nextOfType(MessageType.RoundStart);
    expect(start.tanks[0].stats).toEqual({ armor: 3, engine: 3, gun: 2, reload: 2 });
  });

  it('после ухода игрока комната ждёт, снимки прекращаются, пустая комната удаляется', async () => {
    const [a, b] = await joinedPair('leave');
    await snapshotAfterCountdown(a);
    b.close();
    let state = await a.next();
    while (state.type !== MessageType.RoomState) {
      state = await a.next();
    }
    expect(state.slots[1].isTaken).toBe(false);
    await expect(a.nextOfType(MessageType.Snapshot, 300)).rejects.toThrow();
    a.close();
    await a.closed();
    await sleep(50);
    expect(app.stats().rooms).toBe(0);
  });
});

describe('журнал игры', () => {
  let logDir: string;
  const GAME_ID = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;
  const LINE = /^\d{2}:\d{2}:\d{2}\.\d{3} (S|C\d) /;

  beforeEach(async () => {
    await app.close();
    logDir = mkdtempSync(join(tmpdir(), 'tanks-log-'));
    app = createApp({ staticRoot, logDir, room: FAST_ROOM, random: seededRandom(42), tickMs: TICK_MS });
    port = await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
    rmSync(logDir, { recursive: true, force: true });
  });

  function logLines(gameId: string): string[] {
    return readFileSync(join(logDir, `${gameId}.log`), 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  }

  it('дуэль получает идентификатор, таймкод растёт по тикам, новая дуэль — новый идентификатор', async () => {
    const [a, b] = await joinedPair('ids');
    const start = lastRoundStart;
    expect(start.gameId).toMatch(GAME_ID);
    const first = await a.nextOfType(MessageType.Snapshot);
    const second = await a.nextOfType(MessageType.Snapshot);
    expect(second.gameTick).toBe(first.gameTick + 1);

    b.close();
    await sleep(50);
    const c = await connect();
    c.join('ids', 'Вера');
    await c.nextOfType(MessageType.Welcome);
    const restart = await c.nextOfType(MessageType.RoundStart);
    expect(restart.gameId).toMatch(GAME_ID);
    expect(restart.gameId).not.toBe(start.gameId);
  });

  it('сервер пишет старт, тики, команды, события и уход в файл дуэли', async () => {
    const [a, b] = await joinedPair('srvlog');
    const start = lastRoundStart;
    await snapshotAfterCountdown(a);
    const seq = a.input({ throttle: 1, isFiring: true });
    let snapshot = await a.nextOfType(MessageType.Snapshot);
    while (snapshot.ackSeq < seq) {
      snapshot = await a.nextOfType(MessageType.Snapshot);
    }
    a.send({ type: MessageType.Input, seq, action: { throttle: 0, turn: 0, turretTurn: 0, isFiring: false } });
    for (let i = 0; i < FAST_ROOM.maxInputsPerSecond + 5; i++) {
      a.input({ throttle: 1 });
    }
    while (snapshot.events.every((event) => event.kind !== 'shot')) {
      snapshot = await a.nextOfType(MessageType.Snapshot);
    }
    await sleep(700);
    const flushed = logLines(start.gameId);
    expect(flushed.length).toBeGreaterThan(0);

    b.close();
    await sleep(50);
    await app.close();
    const lines = logLines(start.gameId);
    for (const line of lines) {
      expect(line).toMatch(LINE);
    }
    const text = lines.join('\n');
    expect(text).toContain(`S gt=0 tc=00:00 game start room=srvlog p0=Алиса p1=Боб rules=0`);
    expect(text).toContain('round start idx=0 map=0 score=0:0');
    expect(text).toMatch(/tick rt=\d+ ph=c late=\d+\.\d a0=0\.00,0\.00,0\.00,0 ack0=0 in0=0 sil0=\d p0=140\.0,450\.0/);
    expect(text).toMatch(/tick rt=\d+ ph=f .*a0=1\.00,0\.00,0\.00,1 ack0=1 in0=1 /);
    expect(text).toContain(`input stale side=0 seq=${String(seq)} last=${String(seq)}`);
    expect(text).toMatch(/input limit side=0 seq=\d+/);
    expect(text).toMatch(/ev kind=shot side=0 x=\d+\.\d y=450\.0 v=/);
    expect(text).toContain('leave side=1 nick=Боб');
  });

  it('принимает строки клиента на POST /log и пишет их в файл ключа с источником', async () => {
    const base = `http://127.0.0.1:${String(port)}`;
    const posted = await fetch(`${base}/log?key=K7MF&src=C1`, { method: 'POST', body: 'gt=1 snap a\n\ngt=2 in b\n' });
    expect(posted.status).toBe(204);
    const again = await fetch(`${base}/log?key=K7MF&src=C1`, { method: 'POST', body: 'gt=3 sec c' });
    expect(again.status).toBe(204);
    expect((await fetch(`${base}/log?key=K7MF&src=C1`, { method: 'POST', body: '' })).status).toBe(204);
    await app.close();
    const lines = logLines('K7MF');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} C1 gt=1 snap a$/);
    expect(lines[1]).toMatch(/ C1 gt=2 in b$/);
    expect(lines[2]).toMatch(/ C1 gt=3 sec c$/);
  });

  it('правила процесса уходят в RoundStart и в строку game start', async () => {
    await app.close();
    app = createApp({ logDir, rules: { wallSlidePercent: 50 }, room: FAST_ROOM, tickMs: TICK_MS });
    port = await app.listen(0, '127.0.0.1');
    const [a] = await joinedPair('rules');
    expect(lastRoundStart.rules).toEqual({ wallSlidePercent: 50 });
    await snapshotAfterCountdown(a);
    await app.close();
    expect(logLines(lastRoundStart.gameId).join('\n')).toContain('game start room=rules p0=Алиса p1=Боб rules=50');
  });

  it('отвергает недопустимый ключ или источник, слишком большое тело и не-POST', async () => {
    const base = `http://127.0.0.1:${String(port)}`;
    expect((await fetch(`${base}/log?key=../etc&src=C1`, { method: 'POST', body: 'x' })).status).toBe(400);
    expect((await fetch(`${base}/log?key=K7MF&src=client-0`, { method: 'POST', body: 'x' })).status).toBe(400);
    expect((await fetch(`${base}/log?src=C1`, { method: 'POST', body: 'x' })).status).toBe(400);
    expect((await fetch(`${base}/log?key=K7MF`, { method: 'POST', body: 'x' })).status).toBe(400);
    const overLimit = 'y'.repeat(LOG_BODY_LIMIT_BYTES + 1);
    expect(await postInTwoParts(`${base}/log?key=K7MF&src=C1`, overLimit, 'z'.repeat(1024))).toBe(413);
    expect((await fetch(`${base}/log?key=K7MF&src=C1`)).status).toBe(404);
    await app.close();
    expect(existsSync(join(logDir, 'K7MF.log'))).toBe(false);
  });
});

describe('бой', () => {
  it('снимки идут каждый тик, в отсчёте танки стоят, после — ввод двигает танк и подтверждается', async () => {
    const [a] = await joinedPair('fight');
    const idle = await a.nextOfType(MessageType.Snapshot);
    expect(idle.tick).toBe(0);
    expect(idle.tanks[0].x).toBe(140);

    const first = await snapshotAfterCountdown(a);
    const seq = a.input({ throttle: 1 });
    let moved = await a.nextOfType(MessageType.Snapshot);
    while (moved.ackSeq < seq) {
      moved = await a.nextOfType(MessageType.Snapshot);
    }
    expect(moved.tick).toBeGreaterThan(first.tick);
    expect(moved.tanks[0].x).toBeGreaterThan(140);
    expect(moved.tanks[0].speed).toBeGreaterThan(0);
    expect(moved.tanks[1].x).toBe(1460);
  });

  it('выстрел порождает снаряд и событие', async () => {
    const [a] = await joinedPair('shoot');
    await snapshotAfterCountdown(a);
    a.input({ isFiring: true });
    let snapshot = await a.nextOfType(MessageType.Snapshot);
    while (snapshot.events.every((event) => event.kind !== 'shot')) {
      snapshot = await a.nextOfType(MessageType.Snapshot);
    }
    expect(snapshot.bullets.length).toBe(1);
    expect(snapshot.bullets[0]?.owner).toBe(0);
    expect(snapshot.tanks[0].reloadLeft).toBeGreaterThan(0);
  });

  it('снаряд о стену даёт рикошет, затем удар', async () => {
    const [a] = await joinedPair('wall');
    await snapshotAfterCountdown(a);
    a.input({ isFiring: true });
    const seen = new Set<string>();
    const deadline = Date.now() + 5000;
    const isDone = (): boolean => seen.has('ricochet') && (seen.has('impact') || seen.has('clash'));
    while (!isDone() && Date.now() < deadline) {
      const snapshot = await a.nextOfType(MessageType.Snapshot);
      a.input({ isFiring: true });
      for (const event of snapshot.events) {
        seen.add(event.kind);
      }
    }
    expect(seen.has('shot')).toBe(true);
    expect(isDone()).toBe(true);
  }, 10000);

  it('устаревший и слишком частый ввод отбрасывается, через секунду лимит сбрасывается', async () => {
    const [a] = await joinedPair('spam');
    await snapshotAfterCountdown(a);
    for (let i = 0; i < 200; i++) {
      a.input({ throttle: 1 });
    }
    a.send({ type: MessageType.Input, seq: 1, action: { throttle: -1, turn: 0, turretTurn: 0, isFiring: false } });
    let snapshot = await a.nextOfType(MessageType.Snapshot);
    while (snapshot.ackSeq === 0) {
      snapshot = await a.nextOfType(MessageType.Snapshot);
    }
    expect(snapshot.ackSeq).toBeLessThanOrEqual(FAST_ROOM.maxInputsPerSecond);
    expect(snapshot.tanks[0].speed).toBeGreaterThan(0);

    await sleep(40 * TICK_MS);
    const lateSeq = a.input({ throttle: 1 });
    const deadline = Date.now() + 2000;
    let acked = await a.nextOfType(MessageType.Snapshot);
    while (acked.ackSeq < lateSeq && Date.now() < deadline) {
      acked = await a.nextOfType(MessageType.Snapshot);
    }
    expect(acked.ackSeq).toBe(lateSeq);
  });

  it('отвечает на ping текущим тиком', async () => {
    const [a] = await joinedPair('ping');
    a.send({ type: MessageType.Ping, clientTime: 42.5 });
    const pong = await a.nextOfType(MessageType.Pong);
    expect(pong.clientTime).toBe(42.5);
    expect(pong.serverTick).toBeGreaterThanOrEqual(0);
  });

  it('ввод до входа в комнату игнорируется', async () => {
    const a = await connect();
    a.input({ throttle: 1 });
    a.send({ type: MessageType.Ping, clientTime: 1 });
    await expect(a.next(200)).rejects.toThrow();
  });
});
