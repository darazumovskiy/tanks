import { DEFAULT_STATS, type Action, type Stats } from '@tanks/shared/engine';
import {
  decode,
  encode,
  MessageType,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from '@tanks/shared/protocol';
import { WebSocket } from 'ws';

// Тестовый клиент: говорит с сервером по тому же протоколу, что и браузер, и отдаёт сообщения по одному.
export class TestClient {
  private readonly socket: WebSocket;
  private readonly queue: ServerMessage[] = [];
  private readonly waiters: ((message: ServerMessage) => void)[] = [];
  private isClosed = false;
  private seq = 0;

  private constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.on('message', (data: ArrayBuffer) => {
      const message = decode(new Uint8Array(data)) as ServerMessage;
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter(message);
      } else {
        this.queue.push(message);
      }
    });
    this.socket.on('close', () => {
      this.isClosed = true;
    });
  }

  static async connect(port: number, path = '/ws'): Promise<TestClient> {
    const client = new TestClient(`ws://127.0.0.1:${String(port)}${path}`);
    await new Promise<void>((resolve, reject) => {
      client.socket.once('open', resolve);
      client.socket.once('error', reject);
    });
    return client;
  }

  send(message: ClientMessage): void {
    this.socket.send(encode(message));
  }

  sendRaw(bytes: Uint8Array): void {
    this.socket.send(bytes);
  }

  join(roomCode: string, nickname = 'Тест', stats: Stats = DEFAULT_STATS, protocolVersion = PROTOCOL_VERSION): void {
    this.send({ type: MessageType.Join, protocolVersion, roomCode, nickname, stats });
  }

  input(action: Partial<Action>): number {
    this.seq++;
    this.send({
      type: MessageType.Input,
      seq: this.seq,
      action: { throttle: 0, turn: 0, turretTurn: 0, isFiring: false, ...action },
    });
    return this.seq;
  }

  next(timeoutMs = 2000): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('сервер не ответил вовремя'));
      }, timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  async nextOfType<T extends ServerMessage['type']>(
    type: T,
    timeoutMs = 2000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const message = await this.next(deadline - Date.now());
      if (message.type === type) {
        return message as Extract<ServerMessage, { type: T }>;
      }
    }
    throw new Error(`не дождались сообщения типа ${String(type)}`);
  }

  async closed(timeoutMs = 2000): Promise<boolean> {
    if (this.isClosed) {
      return true;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}
