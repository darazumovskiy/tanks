// Комната против бота: код `bot` + две цифры уровня + произвольный код. Сервер сажает бота первым игроком.
export const BOT_ROOM_PREFIX = 'bot';
const LEVEL_DIGITS = 2;
const LEVEL_PATTERN = new RegExp(`^${BOT_ROOM_PREFIX}(\\d{${String(LEVEL_DIGITS)}})`);

export const BOT_LEVELS = [1, 2, 3, 10] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];

export interface BotLevelInfo {
  name: string;
  summary: string;
}

export const BOT_LEVEL_INFO: Readonly<Record<BotLevel, BotLevelInfo>> = {
  1: { name: 'Манекен', summary: 'ездит куда попало, стреляет редко и мимо' },
  2: { name: 'Карусель', summary: 'кружит и стреляет по тебе каждую перезарядку, без упреждения' },
  3: { name: 'Охотник', summary: 'упреждение, уход от пуль, аптечки — спарринг-бот арены' },
  10: { name: 'ПАРАЛЛАКС-ASTRA', summary: 'бот GPT-6 Astra из турнира; победить нельзя, попасть — уже успех' },
};

function isBotLevel(value: number): value is BotLevel {
  return (BOT_LEVELS as readonly number[]).includes(value);
}

export function isBotRoomCode(code: string): boolean {
  return code.startsWith(BOT_ROOM_PREFIX);
}

export function botRoomCode(level: BotLevel, suffix: string): string {
  return `${BOT_ROOM_PREFIX}${String(level).padStart(LEVEL_DIGITS, '0')}${suffix}`;
}

// null — код не про бота, без цифр уровня или уровень не заполнен.
export function botLevelOf(code: string): BotLevel | null {
  const match = LEVEL_PATTERN.exec(code);
  if (match?.[1] === undefined) {
    return null;
  }
  const level = Number(match[1]);
  return isBotLevel(level) ? level : null;
}
