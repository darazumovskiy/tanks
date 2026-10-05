import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';

// TCP-посредник между браузером и сервером: пересылает и страницу, и соединение игры. Страница открывается через
// его порт — иначе соединение игры пойдёт мимо. Разрыв закрывает обе стороны, как пропавшая сеть; молчание —
// открытые соединения перестают пересылать, не закрываясь. Пока `isRefusing` — новые соединения сразу закрываются,
// как недоступная сеть.
export class NetProxy {
  isRefusing = false;
  private readonly sockets = new Set<Socket>();
  private readonly muted = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    readonly port: number,
  ) {}

  static async start(targetPort: number): Promise<NetProxy> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const proxy = new NetProxy(server, (server.address() as AddressInfo).port);
    server.on('connection', (client) => {
      proxy.pipe(client, targetPort);
    });
    return proxy;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  cut(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
  }

  mute(): void {
    for (const socket of this.sockets) {
      socket.unpipe();
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
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      this.sockets.add(from);
      from.pipe(to);
      from.on('error', () => to.destroy());
      from.on('close', () => {
        this.sockets.delete(from);
        to.destroy();
      });
    }
  }
}
