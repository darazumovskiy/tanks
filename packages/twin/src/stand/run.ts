import { EXCLUSION_REASONS, type ProfileRound } from '@tanks/analysis';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { TwinProfile } from '../profile.js';
import { emptyExclusionCounts, mixPrint, playGame, type ExclusionCounts, type GameResult } from './match.js';
import type { GamePlan } from './plan.js';

export interface StandTask {
  profile: TwinProfile;
  games: GamePlan[];
  logDir: string | null;
}

// played — все сыгранные раунды, excluded — сколько из них отсекло правило выборки, по причинам.
export interface StandResult {
  rounds: ProfileRound[];
  played: number;
  excluded: ExclusionCounts;
  print: number;
}

// Поток исполняет собранный код: из src и из dist путь ведёт в один и тот же dist пакета.
const WORKER_PATH = fileURLToPath(new URL('../../dist/stand/worker.js', import.meta.url));

export function playGames(task: StandTask): GameResult[] {
  return task.games.map((game) => playGame(game, task.profile, task.logDir));
}

function runWorker(task: StandTask): Promise<GameResult[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: task });
    worker.once('message', (results: unknown) => {
      resolve(results as GameResult[]);
      void worker.terminate();
    });
    worker.once('error', reject);
  });
}

// Игры раздаются потокам по кругу; результат собирается в порядке раскладки, поэтому от числа потоков не зависит.
export async function runStand(task: StandTask, threads: number): Promise<StandResult> {
  const workers = Math.min(threads, task.games.length);
  let results: GameResult[];
  if (workers <= 1) {
    results = playGames(task);
  } else {
    const chunks: GamePlan[][] = Array.from({ length: workers }, () => []);
    task.games.forEach((game, index) => chunks[index % workers]?.push(game));
    const parts = await Promise.all(chunks.map((games) => runWorker({ ...task, games })));
    results = parts.flat();
  }
  results.sort((a, b) => a.index - b.index);
  const excluded = emptyExclusionCounts();
  for (const result of results) {
    for (const reason of EXCLUSION_REASONS) {
      excluded[reason] += result.excluded[reason];
    }
  }
  return {
    rounds: results.flatMap((result) => result.rounds),
    played: task.games.reduce((total, game) => total + game.rounds, 0),
    excluded,
    print: results.reduce((hash, result) => mixPrint(hash, result.print), 0),
  };
}
