import { MUZZLE_OFFSET, type FfaSize, type Point } from '@tanks/shared/engine';
import type { FfaSnapshotEvent } from '@tanks/shared/protocol';
import type { FrameScreenId } from './model.js';

// Кадры эталонов толпы на карте 50: пол кусками поверх подложки, толпа из 12 танков, зона в начале сжатия с кромкой,
// кольцо неуязвимости при тряске, рисунок танка цвета вне палитры. Положения подобраны мимо стен карты.

export interface StandTank {
  id: number;
  name: string;
  x: number;
  y: number;
  heading: number;
  turret: number;
  hp?: number;
  isAlive?: boolean;
  isBot?: boolean;
  shieldLeft?: number;
  presence?: number;
}

// Снаряд в момент снимка и направление полёта: до снимка он летел к этой точке.
export interface StandBullet {
  owner: number;
  x: number;
  y: number;
  angle: number;
}

export interface StandEvent {
  ageS: number;
  event: FfaSnapshotEvent;
}

// `focus` — половина экрана вокруг точки поля, как у кадров дуэли.
export type StandCrop = { kind: 'focus'; x: number; y: number } | null;

export interface FfaStandFrame {
  id: string;
  title: string;
  screens: readonly FrameScreenId[];
  size: FfaSize;
  myId: number | null;
  // Точка камеры без своего танка: лобби и вход в игру.
  focus: Point;
  tanks: readonly StandTank[];
  bullets: readonly StandBullet[];
  hasKits: boolean;
  // Секунда матча для радиуса зоны; null — матча нет, зоны нет.
  zoneTimeS: number | null;
  events: readonly StandEvent[];
  crop: StandCrop;
  // Палитра рендера — только свой цвет: рисунок чужого танка создаётся при первом танке этого цвета.
  isOwnPaletteOnly: boolean;
  // Пол кусками собирается с нуля за столько последних кадров, как после перестановки камеры; null — пол готов.
  floorFrames: number | null;
}

const PHONE: readonly FrameScreenId[] = ['phone'];
const BOTH: readonly FrameScreenId[] = ['phone', 'desktop'];
export const STAND_ME = 1;
const ME = STAND_ME;
// Тряска от чужой гибели в кадре гаснет за доли секунды: снимок — около её пика.
const DEATH_SHAKE_AGE_S = 0.04;
const SHIELD_LEFT_S = 2.2;
// Зона в начале сжатия: круг уже зашёл на угол поля карты 50.
const ZONE_EARLY_SHRINK_S = 48.8;

const OWN: StandTank = { id: ME, name: 'Дима', x: 1450, y: 1000, heading: 0, turret: 0 };
// Стык четырёх кусков, через который проходит угловая стена с тенью; камера сдвинута на доли единицы.
const SEAM = { x: 1024, y: 512 };
const SEAM_CAMERA_SHIFT = { x: 0.37, y: 0.61 };
// После перестановки камеры прошло два кадра; часы стенда дают по два новых куска за кадр — готов квадрат 2 × 2 у
// центра окна.
const PENDING_FLOOR_FRAMES = 2;

function bulletAhead(tank: StandTank, distance: number): StandBullet {
  const reach = MUZZLE_OFFSET + distance;
  return {
    owner: tank.id,
    x: tank.x + Math.cos(tank.turret) * reach,
    y: tank.y + Math.sin(tank.turret) * reach,
    angle: tank.turret,
  };
}

export const CROWD: readonly StandTank[] = [
  OWN,
  { id: 2, name: 'Вася', x: 1900, y: 850, heading: Math.PI, turret: Math.PI - 0.15 },
  { id: 3, name: 'Петя', x: 2150, y: 1150, heading: -2, turret: 2.8, hp: 60 },
  { id: 4, name: 'Оля', x: 1150, y: 760, heading: 0.5, turret: 0.3 },
  { id: 5, name: 'Гена', x: 2300, y: 900, heading: 2.5, turret: -2.9 },
  { id: 6, name: 'Маша', x: 1760, y: 1290, heading: -1.2, turret: -1.6, hp: 30 },
  { id: 7, name: 'Шарик', x: 1300, y: 1230, heading: -0.4, turret: -0.9, isBot: true },
  { id: 8, name: 'Коля', x: 2010, y: 1060, heading: 3, turret: 2.2 },
  { id: 9, name: 'Лёша', x: 1600, y: 820, heading: 1.1, turret: 0.4, hp: 0, isAlive: false },
  { id: 10, name: 'Света', x: 2400, y: 1300, heading: -2.6, turret: -2.4 },
  { id: 11, name: 'Новенький', x: 1060, y: 1010, heading: 0.2, turret: 0.2, presence: 0.5 },
  { id: 12, name: 'Ира', x: 1800, y: 700, heading: 2, turret: 1.9 },
];

const CORNER_OWN: StandTank = { id: ME, name: 'Дима', x: 300, y: 300, heading: -2.4, turret: -2.4 };
const SHIELD_OWN: StandTank = {
  id: ME,
  name: 'Дима',
  x: 2600,
  y: 760,
  heading: 0.3,
  turret: -0.2,
  shieldLeft: SHIELD_LEFT_S,
};
const SHIELD_WRECK: StandTank = {
  id: 5,
  name: 'Гена',
  x: 2450,
  y: 900,
  heading: 2,
  turret: 2.6,
  hp: 0,
  isAlive: false,
};

export const BASE: Omit<FfaStandFrame, 'id' | 'title' | 'screens' | 'tanks'> = {
  size: 50,
  myId: ME,
  focus: { x: 2600, y: 1450 },
  bullets: [],
  hasKits: true,
  zoneTimeS: 10,
  events: [],
  crop: null,
  isOwnPaletteOnly: false,
  floorFrames: null,
};

export const CROWD_FRAME: FfaStandFrame = {
  ...BASE,
  id: 'crowd-50',
  title: '12 танков: свой, чужие, бот с отметкой, подбитый, проявляющийся; снаряды своих и чужих',
  screens: PHONE,
  tanks: CROWD,
  bullets: [
    bulletAhead(OWN, 60),
    bulletAhead(OWN, 220),
    bulletAhead(CROWD[1] ?? OWN, 40),
    bulletAhead(CROWD[2] ?? OWN, 120),
    bulletAhead(CROWD[11] ?? OWN, 90),
  ],
};

export const FFA_FRAMES: readonly FfaStandFrame[] = [
  {
    ...BASE,
    id: 'floor-50',
    title: 'пол карты 50 кусками поверх подложки вокруг точки',
    screens: BOTH,
    myId: null,
    focus: { x: 1300, y: 900 },
    tanks: [],
    hasKits: false,
    zoneTimeS: null,
  },
  {
    ...BASE,
    id: 'floor-seam',
    title: 'стык четырёх кусков при дробном положении камеры: стена с тенью через шов',
    screens: BOTH,
    myId: null,
    focus: { x: SEAM.x + SEAM_CAMERA_SHIFT.x, y: SEAM.y + SEAM_CAMERA_SHIFT.y },
    tanks: [],
    hasKits: false,
    zoneTimeS: null,
    crop: { kind: 'focus', x: SEAM.x, y: SEAM.y },
  },
  {
    ...BASE,
    id: 'floor-pending',
    title: 'перестановка камеры: готовы четыре куска у центра, остальное — подложка',
    screens: PHONE,
    myId: null,
    focus: { x: 1800, y: 760 },
    tanks: [],
    hasKits: false,
    zoneTimeS: null,
    floorFrames: PENDING_FLOOR_FRAMES,
  },
  CROWD_FRAME,
  {
    ...BASE,
    id: 'zone-50',
    title: 'зона толпы в начале сжатия у угла карты, кромка 1200',
    screens: PHONE,
    tanks: [CORNER_OWN, { id: 7, name: 'Шарик', x: 560, y: 470, heading: 2.6, turret: 2.9, isBot: true }],
    zoneTimeS: ZONE_EARLY_SHRINK_S,
  },
  {
    ...BASE,
    id: 'shield-shake',
    title: 'кольцо неуязвимости у своего и чужого при тряске от гибели в кадре',
    screens: PHONE,
    tanks: [
      SHIELD_OWN,
      { id: 3, name: 'Петя', x: 2830, y: 650, heading: 2.8, turret: 3, shieldLeft: 1.5 },
      SHIELD_WRECK,
    ],
    events: [
      {
        ageS: DEATH_SHAKE_AGE_S,
        event: {
          kind: 'death',
          tank: 5,
          by: 3,
          x: SHIELD_WRECK.x,
          y: SHIELD_WRECK.y,
          value: 0,
          dx: 0,
          dy: 0,
          flags: 0,
        },
      },
    ],
    crop: { kind: 'focus', x: SHIELD_OWN.x, y: SHIELD_OWN.y },
  },
  {
    ...BASE,
    id: 'art-color',
    title: 'рисунок чужого танка создан при первом танке этого цвета',
    screens: PHONE,
    tanks: [OWN, { id: 2, name: 'Вася', x: 1580, y: 940, heading: 2.6, turret: 2.9 }],
    crop: { kind: 'focus', x: OWN.x + 60, y: OWN.y },
    isOwnPaletteOnly: true,
  },
];

// Пробный кадр до первого снимка: оба цвета танков на каждом рендере стенда.
export const FFA_SPRITE_PROBE: FfaStandFrame = {
  ...BASE,
  id: 'probe',
  title: 'пробный кадр спрайтов',
  screens: PHONE,
  tanks: [OWN, { id: 2, name: 'Вася', x: 1600, y: 1000, heading: 0, turret: 0 }],
  zoneTimeS: null,
};
