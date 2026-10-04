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
      'Катается по карте сам по себе и стреляет редко, чаще мимо. Нередко попадает в себя же — пулей, отскочившей от стены.',
  },
  2: {
    name: 'Прогульщик',
    tagline: 'Гуляет по карте. Стреляет, если сам подвернёшься',
    summary:
      'Бродит по карте и к тебе специально не едет, но стреляет, когда ты попадёшься на глаза. Свой отскок от стены ловит через раз.',
  },
  3: {
    name: 'Новобранец',
    tagline: 'Идёт на тебя и палит в упор. Про упреждение не слышал',
    summary:
      'Едет прямо к тебе и стреляет туда, где ты сейчас: пока ты едешь, он мажет. Пуля у него медленная — успеешь отъехать.',
  },
  4: {
    name: 'Сержант',
    tagline: 'Держит дистанцию, лечится. Стреляет туда, где ты был',
    summary:
      'Держится на расстоянии, ходит боком и подбирает аптечки, когда ранен. Всё ещё стреляет туда, где ты был, а не куда едешь.',
  },
  5: {
    name: 'Ветеран',
    tagline: 'Иногда догадывается, куда ты едешь. Иногда',
    summary:
      'Кружит вокруг тебя. Примерно в трети выстрелов целится с опережением — туда, куда ты едешь, остальные — по старинке.',
  },
  6: {
    name: 'Снайпер',
    tagline: 'Чаще попадает туда, куда ты собирался',
    summary: 'Опережение уже в половине выстрелов, прицел точнее, думает быстрее. Промахов заметно меньше.',
  },
  7: {
    name: 'Призрак',
    tagline: 'Уходит от пуль через раз. От твоих пуль',
    summary: 'Видит твою пулю и в половине случаев успевает отъехать. Почти каждый выстрел — на опережение.',
  },
  8: {
    name: 'Охотник',
    tagline: 'Уворачивается от пули, которую ты ещё не выпустил',
    summary:
      'Реагирует мгновенно, всегда стреляет на опережение и уходит от каждой пули, которую видит. Лечится аптечками, из зоны не выходит.',
  },
  9: {
    name: 'Охотник-ас',
    tagline: 'Знает момент твоего выстрела. Пушка на максимум',
    summary:
      'Тот же Охотник, только с самой быстрой пушкой и тяжёлыми снарядами. Делает шаг в сторону за миг до твоего выстрела.',
  },
  10: {
    name: 'ПАРАЛЛАКС-ASTRA',
    tagline: 'Босс. Попал один раз — рассказывай внукам',
    summary:
      'Бот, которого написала нейросеть для турнира ботов. Просчитывает твои ходы на секунду вперёд; человек его не побеждает — задача попасть хотя бы раз.',
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
