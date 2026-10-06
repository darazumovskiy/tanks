import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SystemCpu {
  machinePressureSeconds: number | null;
  gamePressureSeconds: number | null;
  stealSeconds: number | null;
}

const MACHINE_PRESSURE_PATH = 'proc/pressure/cpu';
const OWN_CGROUP_PATH = 'proc/self/cgroup';
const CGROUP_ROOT = 'sys/fs/cgroup';
const CGROUP_PRESSURE_FILE = 'cpu.pressure';
const STAT_PATH = 'proc/stat';
const UNIFIED_CGROUP_PREFIX = '0::';
const PRESSURE_SOME = /^some .*\btotal=(\d+)/m;
const STAT_CPU_PREFIX = 'cpu ';
// Столбцы строки: cpu user nice system idle iowait irq softirq steal …
const STAT_STEAL_COLUMN = 8;
const MICROS_PER_SECOND = 1_000_000;
// USER_HZ ядра Linux, в котором /proc/stat считает время, — 100 на всех сборках.
const STAT_TICKS_PER_SECOND = 100;

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function pressureSeconds(path: string | null): number | null {
  if (path === null) {
    return null;
  }
  const total = PRESSURE_SOME.exec(readText(path) ?? '')?.[1];
  if (total === undefined) {
    return null;
  }
  return Number(total) / MICROS_PER_SECOND;
}

function stealSeconds(path: string): number | null {
  const text = readText(path);
  const line = text?.split('\n').find((row) => row.startsWith(STAT_CPU_PREFIX));
  const steal = line?.trim().split(/\s+/)[STAT_STEAL_COLUMN];
  if (steal === undefined) {
    return null;
  }
  return Number(steal) / STAT_TICKS_PER_SECOND;
}

function ownCgroupPressurePath(root: string): string | null {
  const text = readText(join(root, OWN_CGROUP_PATH));
  const line = text?.split('\n').find((row) => row.startsWith(UNIFIED_CGROUP_PREFIX));
  if (line === undefined) {
    return null;
  }
  return join(root, CGROUP_ROOT, line.slice(UNIFIED_CGROUP_PREFIX.length), CGROUP_PRESSURE_FILE);
}

export function createSystemCpuReader(root: string): () => SystemCpu {
  const gamePressurePath = ownCgroupPressurePath(root);
  return () => ({
    machinePressureSeconds: pressureSeconds(join(root, MACHINE_PRESSURE_PATH)),
    gamePressureSeconds: pressureSeconds(gamePressurePath),
    stealSeconds: stealSeconds(join(root, STAT_PATH)),
  });
}
