import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { decode, type Message } from '@tanks/shared/protocol';

export interface NetProxyOptions {
  // Задержка каждого куска данных в каждую сторону, мс.
  delayMs?: number;
}

// Сообщение сервера из соединения игры и момент, когда посредник его получил.
export interface TappedMessage {
  message: Message;
  at: number;
}

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
// как недоступная сеть. Задержка держит каждый кусок данных заданное время, порядок сохраняется; сообщения сервера
// в соединении игры копятся в `serverMessages`.
export class NetProxy {
  isRefusing = false;
  readonly serverMessages: TappedMessage[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly muted = new Set<Socket>();
  private readonly delayed = new Set<NodeJS.Timeout>();
  private readonly accepted = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    readonly port: number,
    private readonly delayMs: number,
  ) {}

  static async start(targetPort: number, options: NetProxyOptions = {}): Promise<NetProxy> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const proxy = new NetProxy(server, (server.address() as AddressInfo).port, options.delayMs ?? 0);
    server.on('connection', (client) => {
      proxy.accepted.add(client);
      client.on('close', () => proxy.accepted.delete(client));
      proxy.pipe(client, targetPort);
    });
    return proxy;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.port)}`;
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
    const upstream = connect(targetPort, '127.0.0.1');
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
        to.destroy();
      });
    }
  }

  private forward(to: Socket, chunk: Buffer): void {
    if (this.delayMs === 0) {
      to.write(chunk);
      return;
    }
    const timer = setTimeout(() => {
      this.delayed.delete(timer);
      if (!to.destroyed) {
        to.write(chunk);
      }
    }, this.delayMs);
    this.delayed.add(timer);
  }

  private dropDelayed(): void {
    for (const timer of this.delayed) {
      clearTimeout(timer);
    }
    this.delayed.clear();
  }
}
