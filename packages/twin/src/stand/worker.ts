import { parentPort, workerData } from 'node:worker_threads';
import { playGames, type StandTask } from './run.js';

parentPort?.postMessage(playGames(workerData as StandTask));
