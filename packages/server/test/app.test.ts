import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageType, PROTOCOL_VERSION, ErrorCode, type SnapshotMessage } from '@tanks/shared/protocol';
import { createApp, type App } from '../src/app.js';
import { TestClient } from './client.js';

const FAST_ROOM = { countdownTicks: 3, roundEndTicks: 3, maxInputsPerSecond: 90 };

// Детерминированная случайность для манекена: тест не должен зависеть от удачи.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
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

async function joinedPair(code = 'duel1'): Promise<[TestClient, TestClient]> {
  const a = await connect();
  const b = await connect();
  a.join(code, 'Алиса');
  await a.nextOfType(MessageType.Welcome);
  b.join(code, 'Боб');
  await b.nextOfType(MessageType.Welcome);
  await a.nextOfType(MessageType.RoundStart);
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

beforeEach(async () => {
  staticRoot = mkdtempSync(join(tmpdir(), 'tanks-static-'));
  writeFileSync(join(staticRoot, 'index.html'), '<html>tanks</html>');
  writeFileSync(join(staticRoot, 'app.js'), 'console.log(1)');
  app = createApp({ staticRoot, room: FAST_ROOM, random: seededRandom(42) });
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
    const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rooms: number; connections: number };
    expect(body.rooms).toBe(0);
    expect(body.connections).toBe(0);
  });

  it('раздаёт файлы клиента и index.html на маршрутах приложения', async () => {
    const base = `http://127.0.0.1:${String(port)}`;
    expect(await (await fetch(`${base}/app.js`)).text()).toBe('console.log(1)');
    expect(await (await fetch(`${base}/`)).text()).toBe('<html>tanks</html>');
    expect(await (await fetch(`${base}/d/abc123`)).text()).toBe('<html>tanks</html>');
    expect((await fetch(`${base}/nope.js`)).status).toBe(404);

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
    expect(app.stats().rooms).toBe(1);
  });

  it('код с префиксом bot — дуэль против манекена: он уже сидит первым, раунд стартует сразу', async () => {
    await app.close();
    app = createApp({ staticRoot, room: FAST_ROOM, random: seededRandom(42), tickMs: 4 });
    port = await app.listen(0, '127.0.0.1');
    const human = await connect();
    human.join('botxyz1', 'Дима');
    const welcome = await human.nextOfType(MessageType.Welcome);
    expect(welcome.side).toBe(1);
    const start = await human.nextOfType(MessageType.RoundStart);
    expect(start.tanks[0].nickname).toBe('Манекен');
    expect(start.tanks[1].nickname).toBe('Дима');

    let hasMoved = false;
    let hasFired = false;
    let lastHeading: number | null = null;
    for (let i = 0; i < 400 && !(hasMoved && hasFired); i++) {
      const snapshot = await human.nextOfType(MessageType.Snapshot);
      const bot = snapshot.tanks[0];
      if (lastHeading !== null && (Math.abs(bot.speed) > 1 || bot.heading !== lastHeading)) {
        hasMoved = true;
      }
      lastHeading = bot.heading;
      if (snapshot.bullets.some((bullet) => bullet.owner === 0)) {
        hasFired = true;
      }
    }
    expect(hasMoved).toBe(true);
    expect(hasFired).toBe(true);

    const stranger = await connect();
    stranger.join('botxyz1', 'Третий');
    expect((await stranger.nextOfType(MessageType.Error)).code).toBe(ErrorCode.RoomFull);

    human.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(app.stats().rooms).toBe(0);
  });

  it('клиент замолчал — его танк останавливается, а не едет по последней команде вечно', async () => {
    await app.close();
    app = createApp({ staticRoot, room: FAST_ROOM, random: seededRandom(1), tickMs: 4 });
    port = await app.listen(0, '127.0.0.1');
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.stats().rooms).toBe(0);
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

  it('устаревший и слишком частый ввод отбрасывается', async () => {
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
