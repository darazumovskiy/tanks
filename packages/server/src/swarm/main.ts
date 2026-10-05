import { FFA_SIZES, ffaMap, type FfaSize } from '@tanks/shared/engine';
import { CROWD_PROFILES, crowdPyramid } from '../crowd/profile.js';
import { formatReport, Swarm } from './swarm.js';

const REPORT_INTERVAL_MS = 5000;
const DEFAULT_URL = 'ws://localhost:8080/ws';
const DEFAULT_SIZE: FfaSize = 30;
const FREE_SEATS = 2;

interface Launch {
  url: string;
  size: FfaSize;
  count: number;
}

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function parseLaunch(args: readonly string[]): Launch {
  const url = argument(args, 'url') ?? DEFAULT_URL;
  const sizeText = argument(args, 'size');
  const size = FFA_SIZES.find((candidate) => String(candidate) === sizeText) ?? DEFAULT_SIZE;
  if (sizeText !== undefined && String(size) !== sizeText) {
    throw new Error(`размер игры — ${FFA_SIZES.join(', ')}`);
  }
  const countText = argument(args, 'count');
  const count = countText === undefined ? size - FREE_SEATS : Number(countText);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('число ботов — целое больше нуля');
  }
  return { url, size, count };
}

function describeLevels(count: number): string {
  const levels = crowdPyramid(count);
  return Object.values(CROWD_PROFILES)
    .map((profile, index) => `${profile.name} ${String(levels.filter((level) => level === index + 1).length)}`)
    .join(', ');
}

const launch = parseLaunch(process.argv.slice(2));
const swarm = new Swarm({ ...launch, random: Math.random, mapFor: ffaMap });
console.log(`Рой: ${String(launch.count)} ботов в ffa${String(launch.size)} на ${launch.url}`);
console.log(`Уровни: ${describeLevels(launch.count)}`);
swarm.start();

const timer = setInterval(() => {
  void swarm.report().then((report) => {
    console.log(formatReport(report));
    if (swarm.isDone) {
      console.log('Все боты остановлены');
      process.exit(1);
    }
  });
}, REPORT_INTERVAL_MS);

process.on('SIGINT', () => {
  clearInterval(timer);
  void swarm.stop().then(() => {
    process.exit(0);
  });
});
