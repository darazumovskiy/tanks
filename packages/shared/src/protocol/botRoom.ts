// Комната против бота: код `bot` + две цифры уровня + произвольный код. Сервер сажает бота первым игроком.
export const BOT_ROOM_PREFIX = 'bot';
const LEVEL_DIGITS = 2;
const LEVEL_PATTERN = new RegExp(`^${BOT_ROOM_PREFIX}(\\d{${String(LEVEL_DIGITS)}})`);

export const BOT_LEVELS = [1, 2, 3, 10] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];

// tagline — короткое описание для игрока; summary — техническая подсказка под иконкой.
export interface BotLevelInfo {
  name: string;
  tagline: string;
  summary: string;
}

export const BOT_LEVEL_INFO: Readonly<Record<BotLevel, BotLevelInfo>> = {
  1: {
    name: 'Манекен',
    tagline: 'Груша для битья. Иногда огрызается',
    summary: 'Ездит случайными курсами, целится медленно и с шумом, стреляет редко.',
  },
  2: {
    name: 'Карусель',
    tagline: 'Кружится и палит. Стены для него — слухи',
    summary:
      'Манекен из tank-arena: едет кругами, стреляет в твоё текущее положение каждую перезарядку, без упреждения.',
  },
  3: {
    name: 'Охотник',
    tagline: 'Уворачивается от пули, которую ты ещё не выпустил',
    summary: 'Спарринг-бот tank-arena: путь по сетке, упреждение по скорости, уход от летящих пуль, аптечки, зона.',
  },
  10: {
    name: 'ПАРАЛЛАКС-ASTRA',
    tagline: 'Босс. Попал один раз — рассказывай внукам',
    summary: 'Бот GPT-6 Astra из турнира tank-arena, без изменений. Не предполагается выигрываемым.',
  },
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
