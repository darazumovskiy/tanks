import { createHistogram, type RecordableHistogram } from 'node:perf_hooks';
import type { BotTurnReport } from './crowd/botTurns.js';

export type Direction = 'in' | 'out';
export type DropReason = 'stale' | 'limit' | 'overflow' | 'backlog';

export interface InputDropCounter {
  countDroppedInput(reason: DropReason): void;
}

export const NO_DROP_COUNTER: InputDropCounter = {
  countDroppedInput(): void {
    return;
  },
};

const PLAYER_MODES = ['duel', 'ffa10', 'ffa30', 'ffa50'] as const;
// bot — серверный бот (в дуэли — бот лестницы), swarm — бот роя.
const PLAYER_KINDS = ['human', 'bot', 'swarm'] as const;

export type PlayerMode = (typeof PLAYER_MODES)[number];
type PlayerKind = (typeof PLAYER_KINDS)[number];
export type PlayerCounts = Record<PlayerMode, Record<PlayerKind, number>>;

export function emptyPlayerCounts(): PlayerCounts {
  const counts = PLAYER_MODES.map((mode) => [mode, { human: 0, bot: 0, swarm: 0 }]);
  return Object.fromEntries(counts) as PlayerCounts;
}

export interface MetricsGauges {
  rooms: number;
  connections: number;
  players: PlayerCounts;
}

// Счётчики процесса для ручки /metrics. В тике — только инкременты и запись в гистограмму; текст собирается по запросу.
export interface Metrics extends InputDropCounter {
  recordTick(durationMs: number, isLate: boolean): void;
  recordBotThink(durationMs: number, turns: BotTurnReport): void;
  countMessage(direction: Direction, bytes: number): void;
  render(gauges: MetricsGauges): string;
  close(): void;
}

const QUANTILES: readonly { label: string; percentile: number | 'max' }[] = [
  { label: '0.5', percentile: 50 },
  { label: '0.99', percentile: 99 },
  { label: 'max', percentile: 'max' },
];
const MICROS_PER_MS = 1000;
const MICROS_PER_SECOND = 1_000_000;
const MS_PER_SECOND = 1000;
// Шаг таймера, по опозданию которого меряется задержка цикла событий.
const EVENT_LOOP_PROBE_MS = 10;

function recordMs(histogram: RecordableHistogram, ms: number): void {
  histogram.record(Math.max(1, Math.round(ms * MICROS_PER_MS)));
}

function quantilesOf(histogram: RecordableHistogram, unit = MICROS_PER_MS): [string, number][] {
  return QUANTILES.map((quantile) => {
    const value = quantile.percentile === 'max' ? histogram.max : histogram.percentile(quantile.percentile);
    return [quantile.label, value / unit];
  });
}

class MetricsLines {
  private readonly lines: string[] = [];

  header(name: string, type: 'gauge' | 'counter', help: string): void {
    this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  }

  value(name: string, value: number, labels: Record<string, string> = {}): void {
    const pairs = Object.entries(labels).map(([key, text]) => `${key}="${text}"`);
    const suffix = pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
    this.lines.push(`${name}${suffix} ${String(value)}`);
  }

  text(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

export function createMetrics(): Metrics {
  const tickDuration = createHistogram();
  const botThink = createHistogram();
  // Гистограмма не принимает 0: ожидание пишется со сдвигом на тик и при выводе сдвигается обратно.
  const botWait = createHistogram();
  let botSkipped = 0;
  const eventLoopDelay = createHistogram();
  let probeExpectedAt = performance.now() + EVENT_LOOP_PROBE_MS;
  const probe = setInterval(() => {
    const now = performance.now();
    recordMs(eventLoopDelay, Math.max(0, now - probeExpectedAt));
    probeExpectedAt = now + EVENT_LOOP_PROBE_MS;
  }, EVENT_LOOP_PROBE_MS);
  probe.unref();
  const startedAtSeconds = Date.now() / MS_PER_SECOND - process.uptime();
  let ticks = 0;
  let lateTicks = 0;
  const messages: Record<Direction, number> = { in: 0, out: 0 };
  const bytes: Record<Direction, number> = { in: 0, out: 0 };
  const dropped: Record<DropReason, number> = { stale: 0, limit: 0, overflow: 0, backlog: 0 };

  return {
    recordTick(durationMs, isLate): void {
      ticks++;
      if (isLate) {
        lateTicks++;
      }
      recordMs(tickDuration, durationMs);
    },
    recordBotThink(durationMs, turns): void {
      recordMs(botThink, durationMs);
      botSkipped += turns.skipped;
      for (const ticks of turns.waits) {
        botWait.record(ticks + 1);
      }
    },
    countMessage(direction, size): void {
      messages[direction]++;
      bytes[direction] += size;
    },
    countDroppedInput(reason): void {
      dropped[reason]++;
    },
    render(gauges): string {
      const out = new MetricsLines();
      out.header('tanks_tick_duration_ms', 'gauge', 'длительность тика за окно с прошлого запроса');
      for (const [quantile, value] of quantilesOf(tickDuration)) {
        out.value('tanks_tick_duration_ms', value, { quantile });
      }
      out.header('tanks_event_loop_delay_ms', 'gauge', 'опоздание цикла событий за окно с прошлого запроса');
      for (const [quantile, value] of quantilesOf(eventLoopDelay)) {
        out.value('tanks_event_loop_delay_ms', value, { quantile });
      }
      out.header('tanks_bot_think_ms', 'gauge', 'ход мозга серверных ботов после тика за окно с прошлого запроса');
      for (const [quantile, value] of quantilesOf(botThink)) {
        out.value('tanks_bot_think_ms', value, { quantile });
      }
      out.header(
        'tanks_bot_wait_ticks',
        'gauge',
        'сколько тиков серверный бот ждал решения за окно с прошлого запроса',
      );
      for (const [quantile, value] of quantilesOf(botWait, 1)) {
        out.value('tanks_bot_wait_ticks', Math.max(0, value - 1), { quantile });
      }
      out.header('tanks_bot_skipped_total', 'counter', 'решений серверных ботов, пропущенных из-за бюджета хода');
      out.value('tanks_bot_skipped_total', botSkipped);
      tickDuration.reset();
      eventLoopDelay.reset();
      botThink.reset();
      botWait.reset();
      out.header('tanks_ticks_total', 'counter', 'тиков с запуска');
      out.value('tanks_ticks_total', ticks);
      out.header('tanks_ticks_late_total', 'counter', 'тиков, начавшихся позже расписания больше чем на тик');
      out.value('tanks_ticks_late_total', lateTicks);
      out.header('tanks_rooms', 'gauge', 'комнат сейчас');
      out.value('tanks_rooms', gauges.rooms);
      out.header('tanks_connections', 'gauge', 'сокетов сейчас');
      out.value('tanks_connections', gauges.connections);
      out.header('tanks_players', 'gauge', 'игроков в играх сейчас: люди, серверные боты, боты роя');
      for (const mode of PLAYER_MODES) {
        for (const kind of PLAYER_KINDS) {
          out.value('tanks_players', gauges.players[mode][kind], { mode, kind });
        }
      }
      out.header('tanks_messages_total', 'counter', 'сообщений по сокетам');
      for (const direction of ['in', 'out'] as const) {
        out.value('tanks_messages_total', messages[direction], { direction });
      }
      out.header('tanks_bytes_total', 'counter', 'байт по сокетам');
      for (const direction of ['in', 'out'] as const) {
        out.value('tanks_bytes_total', bytes[direction], { direction });
      }
      out.header('tanks_inputs_dropped_total', 'counter', 'команд отброшено');
      for (const reason of ['stale', 'limit', 'overflow', 'backlog'] as const) {
        out.value('tanks_inputs_dropped_total', dropped[reason], { reason });
      }
      const cpu = process.cpuUsage();
      out.header('process_resident_memory_bytes', 'gauge', 'память процесса');
      out.value('process_resident_memory_bytes', process.memoryUsage.rss());
      out.header('process_cpu_seconds_total', 'counter', 'процессорное время процесса');
      out.value('process_cpu_seconds_total', (cpu.user + cpu.system) / MICROS_PER_SECOND);
      out.header('process_start_time_seconds', 'gauge', 'время старта процесса');
      out.value('process_start_time_seconds', startedAtSeconds);
      return out.text();
    },
    close(): void {
      clearInterval(probe);
    },
  };
}
