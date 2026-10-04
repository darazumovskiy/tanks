import { FFA_SIZES, type FfaSize } from '../engine/index.js';

// Код общей игры — префикс и размер: ffa10, ffa30, ffa50. Прочие коды на ffa (ffaxyz) — коды дуэли.
export const FFA_ROOM_PREFIX = 'ffa';
const FFA_CODE_PATTERN = /^ffa\d*$/;

export function ffaRoomCode(size: FfaSize): string {
  return `${FFA_ROOM_PREFIX}${String(size)}`;
}

export function isFfaRoomCode(code: string): boolean {
  return FFA_CODE_PATTERN.test(code);
}

// null — код не общей игры или размер не из списка.
export function ffaSizeOf(code: string): FfaSize | null {
  return FFA_SIZES.find((size) => ffaRoomCode(size) === code) ?? null;
}
