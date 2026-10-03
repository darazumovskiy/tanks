import { TICK_RATE } from '../engine/index.js';

// Таймкод игры «мм:сс» из числа тиков с её начала — одинаков на экране боя, в журнале сервера и клиента.
export function gameTimecode(gameTick: number): string {
  const totalSeconds = Math.floor(gameTick / TICK_RATE);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
