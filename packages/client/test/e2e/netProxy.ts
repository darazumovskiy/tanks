import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { decode, type Message } from '@tanks/shared/protocol';

export interface NetProxyOptions {
  // Задержка каждого куска данных в каждую сторону, мс.
  delayMs?: number;
  // Куски после задержки копятся и уходят разом на границах сетки с этим шагом, мс, — как сеть телефона,
  // склеивающая пакеты в пачки.
  burstMs?: number;
  // Неровные пачки: шаг до каждой следующей границы сетки — случайный от `burstMs` до `burstMaxMs`, мс.
  burstMaxMs?: number;
  // Порт и адрес прослушивания; по умолчанию — случайный свободный порт только на этой машине.
  port?: number;
  host?: string;
}

type NetShapeOptions = Pick<NetProxyOptions, 'delayMs' | 'burstMs' | 'burstMaxMs'>;

interface NetShape {
  delayMs: number;
  burstMs: number;
  burstMaxMs: number;
}

interface HeldChunk {
  dueAt: number;
  chunk: Buffer;
}

// Очередь одного направления: срок следующего куска не раньше предыдущего (`lastDueAt`), поэтому порядок кусков
// сохраняется и при смене сети на ходу. `edge` — граница сетки пачек, только растёт; null — сетка начнётся заново
// с шагом новой сети.
interface Lane {
  held: HeldChunk[];
  timer: NodeJS.Timeout | null;
  edge: number | null;
  lastDueAt: number;
}

// Сообщение сервера из соединения игры и момент, когда посредник его получил.
export interface TappedMessage {
  message: Message;
  at: number;
}

const LOOPBACK = '127.0.0.1';
const ANY_FREE_PORT = 0;
const HEADER_END = '\r\n\r\n';
const SWITCHING_PROTOCOLS = 'HTTP/1.1 101';
const OPCODE_BINARY = 0x2;
const LENGTH_16 = 126;
const LENGTH_64 = 127;

// Разбирает поток сервера → браузер соединения игры: заголовок ответа HTTP, затем кадры WebSocket без маски.
// Каждый двоичный кадр — сообщение протокола.
class FrameTap {
  private buffer = Buffer.alloc(0);
  private isUpgraded = false;
  private isGame = true;

  constructor(private readonly onMessage: (message: Message) => void) {}

  push(chunk: Buffer): void {
    if (!this.isGame) {
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.isUpgraded) {
      const end = this.buffer.indexOf(HEADER_END);
      if (end < 0) {
        return;
      }
      this.isGame = this.buffer.subarray(0, SWITCHING_PROTOCOLS.length).toString() === SWITCHING_PROTOCOLS;
      this.isUpgraded = true;
      this.buffer = this.buffer.subarray(end + HEADER_END.length);
      if (!this.isGame) {
        this.buffer = Buffer.alloc(0);
        return;
      }
    }
    this.readFrames();
  }

  private readFrames(): void {
    for (;;) {
      if (this.buffer.length < 2) {
        return;
      }
      const opcode = (this.buffer[0] ?? 0) & 0x0f;
      const shortLength = (this.buffer[1] ?? 0) & 0x7f;
      let offset = 2;
      let length = shortLength;
      if (shortLength === LENGTH_16) {
        if (this.buffer.length < 4) {
          return;
        }
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (shortLength === LENGTH_64) {
        if (this.buffer.length < 10) {
          return;
        }
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + length) {
        return;
      }
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === OPCODE_BINARY) {
        this.onMessage(decode(new Uint8Array(payload)));
      }
    }
  }
}

// TCP-посредник между браузером и сервером: пересылает и страницу, и соединение игры. Страница открывается через
// его порт — иначе соединение игры пойдёт мимо. Разрыв закрывает обе стороны, как пропавшая сеть; молчание —
// открытые соединения перестают пересылать, не закрываясь, и уже ждущие задержки куски не доходят. Пока `isRefusing` — новые соединения сразу закрываются,
// как недоступная сеть. Задержка держит каждый кусок данных заданное время, порядок сохраняется; пачки — куски
// после задержки уходят разом на границе сетки `burstMs`, у неровных пачек шаг сетки случайный до `burstMaxMs`.
// `setShape` меняет сеть на ходу: следующие куски идут по новым правилам, уже ждущие — по старым.
// Сообщения сервера в соединении игры копятся в `serverMessages`.
export class NetProxy {
  isRefusing = false;
  readonly serverMessages: TappedMessage[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly muted = new Set<Socket>();
  private readonly lanes = new Map<Socket, Lane>();
  private readonly accepted = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    readonly port: number,
    private shape: NetShape,
  ) {}

  static async start(targetPort: number, options: NetProxyOptions = {}): Promise<NetProxy> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? ANY_FREE_PORT, options.host ?? LOOPBACK, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const proxy = new NetProxy(server, (server.address() as AddressInfo).port, netShape(options));
    server.on('connection', (client) => {
      proxy.accepted.add(client);
      client.on('close', () => proxy.accepted.delete(client));
      proxy.pipe(client, targetPort);
    });
    return proxy;
  }

  get baseUrl(): string {
    return `http://${LOOPBACK}:${String(this.port)}`;
  }

  setShape(options: NetShapeOptions): void {
    this.shape = netShape(options);
    for (const lane of this.lanes.values()) {
      lane.edge = null;
    }
  }

  cut(): void {
    this.dropDelayed();
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
  }

  mute(): void {
    this.dropDelayed();
    for (const socket of this.sockets) {
      socket.removeAllListeners('data');
      socket.pause();
      this.muted.add(socket);
    }
    this.sockets.clear();
  }

  close(): Promise<void> {
    this.cut();
    for (const socket of this.muted) {
      socket.destroy();
    }
    this.muted.clear();
    for (const socket of this.accepted) {
      socket.destroy();
    }
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private pipe(client: Socket, targetPort: number): void {
    if (this.isRefusing) {
      client.destroy();
      return;
    }
    const upstream = connect(targetPort, LOOPBACK);
    const tap = new FrameTap((message) => {
      this.serverMessages.push({ message, at: performance.now() });
    });
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      this.sockets.add(from);
      from.on('data', (chunk: Buffer) => {
        if (from === upstream) {
          tap.push(chunk);
        }
        this.forward(to, chunk);
      });
      from.on('error', () => to.destroy());
      from.on('close', () => {
        this.sockets.delete(from);
        this.dropLane(from);
        to.destroy();
      });
    }
  }

  private forward(to: Socket, chunk: Buffer): void {
    const { delayMs, burstMs } = this.shape;
    const isHolding = (this.lanes.get(to)?.held.length ?? 0) > 0;
    if (delayMs === 0 && burstMs === 0 && !isHolding) {
      to.write(chunk);
      return;
    }
    this.hold(to, chunk);
  }

  private hold(to: Socket, chunk: Buffer): void {
    const { delayMs, burstMs, burstMaxMs } = this.shape;
    let lane = this.lanes.get(to);
    if (lane === undefined) {
      lane = { held: [], timer: null, edge: null, lastDueAt: 0 };
      this.lanes.set(to, lane);
    }
    let dueAt = Math.max(performance.now() + delayMs, lane.lastDueAt);
    if (burstMs > 0) {
      let edge = lane.edge ?? Math.ceil(dueAt / burstMs) * burstMs;
      while (edge < dueAt) {
        edge += burstMs + Math.random() * (burstMaxMs - burstMs);
      }
      lane.edge = edge;
      dueAt = edge;
    }
    lane.lastDueAt = dueAt;
    lane.held.push({ dueAt, chunk });
    this.scheduleLane(to, lane);
  }

  private scheduleLane(to: Socket, lane: Lane): void {
    const [next] = lane.held;
    if (lane.timer !== null || next === undefined) {
      return;
    }
    lane.timer = setTimeout(
      () => {
        lane.timer = null;
        this.releaseLane(to, lane);
      },
      Math.max(0, next.dueAt - performance.now()),
    );
  }

  private releaseLane(to: Socket, lane: Lane): void {
    const now = performance.now();
    const dueCount = lane.held.findIndex((held) => held.dueAt > now);
    const due = lane.held.splice(0, dueCount < 0 ? lane.held.length : dueCount);
    if (!to.destroyed && due.length > 0) {
      to.write(Buffer.concat(due.map((held) => held.chunk)));
    }
    this.scheduleLane(to, lane);
  }

  private dropLane(socket: Socket): void {
    const timer = this.lanes.get(socket)?.timer ?? null;
    if (timer !== null) {
      clearTimeout(timer);
    }
    this.lanes.delete(socket);
  }

  private dropDelayed(): void {
    for (const socket of [...this.lanes.keys()]) {
      this.dropLane(socket);
    }
  }
}

function netShape(options: NetShapeOptions): NetShape {
  const burstMs = options.burstMs ?? 0;
  return {
    delayMs: options.delayMs ?? 0,
    burstMs,
    burstMaxMs: Math.max(burstMs, options.burstMaxMs ?? burstMs),
  };
}
