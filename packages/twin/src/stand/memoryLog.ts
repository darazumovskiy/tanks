import type { LogFile } from '@tanks/analysis';
import type { GameLog } from '@tanks/server/gameLog';
import { TICK_RATE } from '@tanks/shared/engine';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Условное время строк — полдень плюс gt / 30 секунд: журнал стенда не зависит от часов машины.
const STAND_START_SEC = 12 * 3600;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const GAME_TICK_PATTERN = /^gt=(\d+) /;
const ROOM_LOG_PREFIX = 'room-';
const LOG_EXTENSION = '.log';
const CLOCK_DIGITS = 2;
const MS_DIGITS = 3;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function timeOf(text: string): string {
  const gt = Number(GAME_TICK_PATTERN.exec(text)?.[1] ?? 0);
  const totalMs = Math.round((STAND_START_SEC + gt / TICK_RATE) * MS_PER_SECOND);
  const seconds = Math.floor(totalMs / MS_PER_SECOND);
  const hh = Math.floor(seconds / SECONDS_PER_HOUR);
  const mm = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const ss = seconds % SECONDS_PER_MINUTE;
  return `${pad(hh, CLOCK_DIGITS)}:${pad(mm, CLOCK_DIGITS)}:${pad(ss, CLOCK_DIGITS)}.${pad(totalMs % MS_PER_SECOND, MS_DIGITS)}`;
}

// Журнал одной игры стенда в памяти, в формате сервера и клиента. Случайный идентификатор дуэли комнаты
// заменяется идентификатором игры стенда, чтобы журналы не зависели от запуска.
export class MemoryGameLog implements GameLog {
  private readonly gameLines: string[] = [];
  private readonly roomLines: string[] = [];

  constructor(
    private readonly gameId: string,
    private readonly roomCode: string,
  ) {}

  write(key: string, source: string, text: string): void {
    const line = `${timeOf(text)} ${source} ${text}`;
    if (key.startsWith(ROOM_LOG_PREFIX)) {
      this.roomLines.push(line);
      return;
    }
    this.gameLines.push(line);
  }

  files(): LogFile[] {
    return [
      { name: `${this.gameId}${LOG_EXTENSION}`, lines: this.gameLines },
      { name: `${ROOM_LOG_PREFIX}${this.roomCode}${LOG_EXTENSION}`, lines: this.roomLines },
    ];
  }

  // Журнал комнаты общий у всех игр уровня — дописывается.
  save(dir: string): void {
    mkdirSync(dir, { recursive: true });
    for (const file of this.files()) {
      appendFileSync(join(dir, file.name), file.lines.map((line) => `${line}\n`).join(''));
    }
  }
}
