import {
  BOT_LEVEL_INFO,
  BOT_LEVELS,
  botRoomCode,
  TWIN_INFO,
  twinRoomCode,
  type BotLevel,
  type BotLevelInfo,
} from '@tanks/shared/protocol';

// Соперник против бота на главной: уровень лестницы или двойник игрока последним в списке.
export const TWIN_RIVAL = 'twin';
export type Rival = BotLevel | typeof TWIN_RIVAL;
export const RIVALS: readonly Rival[] = [...BOT_LEVELS, TWIN_RIVAL];
// Значок двойника в списках вместо номера уровня: это ты сам.
export const TWIN_BADGE = 'Я';

export function rivalOf(raw: string | null, fallback: Rival): Rival {
  return RIVALS.find((rival) => String(rival) === raw) ?? fallback;
}

export function rivalInfo(rival: Rival): Readonly<BotLevelInfo> {
  return rival === TWIN_RIVAL ? TWIN_INFO : BOT_LEVEL_INFO[rival];
}

export function rivalBadge(rival: Rival): string {
  return rival === TWIN_RIVAL ? TWIN_BADGE : String(rival);
}

export function rivalRoomCode(rival: Rival, suffix: string): string {
  if (rival === TWIN_RIVAL) {
    return twinRoomCode(suffix);
  }
  return botRoomCode(rival, suffix);
}
