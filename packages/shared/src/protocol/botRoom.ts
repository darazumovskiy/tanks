// Комната против бота: код `bot` + две цифры уровня + произвольный код. Сервер сажает бота первым игроком.
export const BOT_ROOM_PREFIX = 'bot';
const LEVEL_DIGITS = 2;
const LEVEL_PATTERN = new RegExp(`^${BOT_ROOM_PREFIX}(\\d{${String(LEVEL_DIGITS)}})`);

export const BOT_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
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
    summary:
      'Гуляет по карте, к тебе не идёт. Реакция 400 мс, прицел дрожит на ±0,35 рад, стреляет треть готовых выстрелов.',
  },
  2: {
    name: 'Прогульщик',
    tagline: 'Гуляет по карте. Стреляет, если сам подвернёшься',
    summary: 'Патруль по случайным точкам. Реакция 370 мс, шум прицела ±0,25 рад, стреляет чаще. Медленная пуля.',
  },
  3: {
    name: 'Новобранец',
    tagline: 'Идёт на тебя и палит в упор. Про упреждение не слышал',
    summary:
      'Сближается и держит дистанцию ~350. Реакция 300 мс, шум ±0,12 рад, каждый готовый выстрел. Медленная пуля.',
  },
  4: {
    name: 'Сержант',
    tagline: 'Держит дистанцию, лечится. Стреляет туда, где ты был',
    summary: 'Сближение, аптечки при низком здоровье, обычная пушка. Реакция 270 мс, шум ±0,09 рад, без упреждения.',
  },
  5: {
    name: 'Ветеран',
    tagline: 'Иногда догадывается, куда ты едешь. Иногда',
    summary: 'Кружит вокруг тебя на 300 px. Упреждение в 30 % выстрелов и на 60 % от нужного. Реакция 200 мс.',
  },
  6: {
    name: 'Снайпер',
    tagline: 'Чаще попадает туда, куда ты собирался',
    summary: 'Кружит, упреждение в половине выстрелов на 75 % от нужного. Реакция 170 мс, шум ±0,045 рад.',
  },
  7: {
    name: 'Призрак',
    tagline: 'Уходит от пуль через раз. От твоих пуль',
    summary: 'Уклоняется от каждой второй видимой пули, упреждение в 75 % выстрелов на 90 %. Реакция 100 мс.',
  },
  8: {
    name: 'Охотник',
    tagline: 'Уворачивается от пули, которую ты ещё не выпустил',
    summary:
      'Спарринг-бот tank-arena без ограничений: мгновенная реакция, точное упреждение, уход от всех пуль, аптечки.',
  },
  9: {
    name: 'Охотник-ас',
    tagline: 'Знает момент твоего выстрела. Пушка на максимум',
    summary:
      'Охотник с пушкой 5 и перезарядкой 5 (пуля 700 px/с, урон 43), шагает вбок перед твоим выстрелом, окно огня 0,05 рад.',
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
