import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const SWARM_ENTRY = `${ROOT}/packages/server/dist/swarm/main.js`;
const KEPT_LINES = 20;

// Сетевой рой ботов толпы отдельным процессом — та же программа, что `npm run swarm`. Боты входят по одному раз
// в 200 мс; остановка — Ctrl+C: рой закрывает соединения, сервер держит места ботов ещё 15 с.
export class SwarmProcess {
  private readonly lines: string[] = [];

  private constructor(private readonly child: ChildProcess) {
    child.stdout?.on('data', (chunk: Buffer) => {
      this.lines.push(
        ...chunk
          .toString()
          .split('\n')
          .filter((line) => line !== ''),
      );
      this.lines.splice(0, Math.max(0, this.lines.length - KEPT_LINES));
    });
  }

  static start(wsUrl: string, size: number, count: number): SwarmProcess {
    const child = spawn(
      process.execPath,
      [SWARM_ENTRY, '--url', wsUrl, '--size', String(size), '--count', String(count)],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    return new SwarmProcess(child);
  }

  // Последние строки отчёта роя — в сообщение упавшего теста.
  get output(): string {
    return this.lines.join('\n');
  }

  async stop(): Promise<void> {
    const hasExited = this.child.exitCode !== null || this.child.signalCode !== null;
    if (hasExited) {
      return;
    }
    this.child.kill('SIGINT');
    await once(this.child, 'exit');
  }
}
