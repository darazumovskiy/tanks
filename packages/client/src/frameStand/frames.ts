import { BULLET_RADIUS, DT, KIT, mapByIndex, MAPS, TANK_RADIUS, ZONE, type Side } from '@tanks/shared/engine';
import { EventFlag, type SnapshotEvent } from '@tanks/shared/protocol';
import {
  bulletFrom,
  deathEvent,
  DEFAULT_TANK_STATS,
  hitEvent,
  muzzleOf,
  pickupEvent,
  pointEvent,
  ricochetEvent,
  shotEvent,
  zoneStartEvent,
  type DuelFrame,
  type FrameCrop,
  type FrameScreenId,
  type TankPose,
  type TimedEvent,
} from './model.js';

// Кадры эталонов дуэли. Положения подобраны по стенам карт: танки и пути снарядов не заходят в стены, точки
// событий лежат на гранях. Возраст события — середина жизни его эффекта.

interface Point {
  x: number;
  y: number;
}

const PHONE: readonly FrameScreenId[] = ['phone'];
const DESKTOP: readonly FrameScreenId[] = ['desktop'];
const DAMAGE = DEFAULT_TANK_STATS.damage;
const FULL_HP = DEFAULT_TANK_STATS.maxHp;
// Снаряд попадает, когда его центр ближе этого к центру танка.
const HIT_DISTANCE = TANK_RADIUS + BULLET_RADIUS - 1;
// Первая кровь пролита раньше всего в кадре, гибели тоже: её объявление и следы попадания к снимку уже погасли.
const FIRST_BLOOD_AGE_S = 4;
const ROUND_END_AGE_S = 0.9;
const ZONE_HIT_SPAN_S = 0.6;
// Дым взрыва осел, подбитый танк виден и дымит сам.
const WRECK_AGE_S = 3.5;
// Тряска от выстрела и перехвата гаснет за доли секунды: снимок — на её пике.
const SHOT_SHAKE_AGE_S = 0.016;
const CLASH_SHAKE_AGE_S = 0.05;
const START_SCORES: readonly [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [2, 1],
];

const STICK_BAND: FrameCrop = { kind: 'screen', left: 0, top: 0.45, right: 1, bottom: 1 };
const ANNOUNCE_BAND: FrameCrop = { kind: 'screen', left: 0, top: 0, right: 1, bottom: 0.6 };
const COUNTDOWN_NUMBER_BAND: FrameCrop = { kind: 'screen', left: 0.25, top: 0.5, right: 0.75, bottom: 1 };
const DEBUG_CORNER: FrameCrop = { kind: 'screen', left: 0, top: 0.7, right: 0.5, bottom: 1 };
// Середина экрана: в отличие от кадра вокруг точки поля, сдвиг камеры меняет картинку.
const SCREEN_CENTER: FrameCrop = { kind: 'screen', left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 };
const FIELD_CENTER: Point = { x: 800, y: 450 };

const FIGHT: Omit<DuelFrame, 'id' | 'title' | 'tanks'> = {
  kind: 'canvas',
  screens: PHONE,
  mapIndex: 0,
  mySide: 0,
  phase: 'fight',
  roundTimeS: 41.3,
  roundIndex: 1,
  score: [1, 0],
  bullets: [],
  kits: null,
  events: [],
  drives: [],
  sticks: [],
  isShotGuarded: false,
  isReversing: false,
  countdownLeftS: null,
  settings: {},
  crop: null,
  roundEnd: null,
};

function timed(ageS: number, event: SnapshotEvent): TimedEvent {
  return { ageS, event };
}

function aimAt(from: Point, to: Point): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function spawnPose(mapIndex: number, side: Side): TankPose {
  const spawn = mapByIndex(mapIndex).spawns[side];
  return { x: spawn.x, y: spawn.y, heading: spawn.heading, turret: spawn.heading };
}

function focus(x: number, y: number): FrameCrop {
  return { kind: 'focus', x, y };
}

function firstBloodTaken(victim: Side, pose: TankPose): TimedEvent {
  return timed(FIRST_BLOOD_AGE_S, hitEvent(victim, pose, null, DAMAGE));
}

// Попадание снаряда стрелка в цель: точка — где снаряд вошёл в корпус.
function hitBetween(victim: Side, shooter: Point, target: Point, flags = 0): SnapshotEvent {
  const angle = aimAt(shooter, target);
  const at = { x: target.x - Math.cos(angle) * HIT_DISTANCE, y: target.y - Math.sin(angle) * HIT_DISTANCE };
  return hitEvent(victim, at, angle, DAMAGE, flags);
}

function kill(victim: Side, shooter: Point, pose: TankPose, ageS: number): TimedEvent[] {
  return [timed(ageS, hitBetween(victim, shooter, pose)), timed(ageS, deathEvent(victim, pose))];
}

function zoneHits(side: Side, pose: TankPose): TimedEvent[] {
  const count = Math.floor(ZONE_HIT_SPAN_S / DT);
  return Array.from({ length: count + 1 }, (_, index) =>
    timed(index * DT, hitEvent(side, pose, null, ZONE.damagePerSecond * DT, EventFlag.Zone)),
  );
}

// Интерфейс компьютера целиком держит первая карта; у остальных — середина поля.
const MAP_FRAMES: DuelFrame[] = MAPS.map((map, mapIndex) => ({
  ...FIGHT,
  id: `map-${String(mapIndex)}`,
  title: mapIndex === 0 ? `${map.name}: старт раунда, поле целиком` : `${map.name}: старт раунда, середина поля`,
  screens: DESKTOP,
  mapIndex,
  roundTimeS: 0,
  roundIndex: mapIndex,
  score: START_SCORES[mapIndex] ?? [0, 0],
  tanks: [spawnPose(mapIndex, 0), spawnPose(mapIndex, 1)],
  crop: mapIndex === 0 ? null : focus(FIELD_CENTER.x, FIELD_CENTER.y),
}));

// Крепости: каждый танк у своего края, противник за кадром выше или ниже — стрелка у края.
const SIDE_SCENE: Omit<DuelFrame, 'id' | 'title' | 'mySide'> = {
  ...FIGHT,
  mapIndex: 2,
  roundTimeS: 47.3,
  roundIndex: 3,
  score: [2, 1],
  tanks: [
    { x: 420, y: 760, heading: -0.6, turret: -0.9, hp: 101 },
    { x: 1250, y: 110, heading: 2.5, turret: 2.9, hp: 64 },
  ],
};

// Оба танка проехали больше трёх секунд: следы лежат через два выцветания (тики раунда, кратные 45), подпалина —
// через оба. Противник ранен и дымит.
const DRIVE_ROUND_S = 52;
const DRIVER: TankPose = { x: 600, y: 800, heading: -0.15, turret: -0.35, hp: 120 };
const ENEMY_DRIVER: TankPose = { x: 960, y: 700, heading: Math.PI + 0.3, turret: 2.6, hp: 50 };
// Левая грань стены (840, 556, 160, 44): тень стены падает в другую сторону.
const OLD_IMPACT: Point = { x: 835, y: 578 };

// Подбитый лежит вплотную к живому: спрайты перекрываются, живой сверху.
const WRECK: TankPose = { x: 720, y: 700, heading: 2.6, turret: 2.2, hp: 0, isAlive: false };
const SURVIVOR: TankPose = { x: 676, y: 724, heading: -0.5, turret: 0.4, hp: 90 };
const PUSHER: TankPose = { x: 1080, y: 800, heading: 0.4, turret: -0.3 };
const PUSHED: TankPose = { x: 1125, y: 818, heading: 2.6, turret: 3.4 };

const LANE_SHOOTER: TankPose = { x: 240, y: 110, heading: 0, turret: -0.04 };
const LANE_ENEMY: TankPose = { x: 1180, y: 96, heading: Math.PI, turret: Math.PI + 0.03 };

const FAR_ENEMY: TankPose = { x: 1320, y: 760, heading: Math.PI, turret: 3.4 };

// Круг меньше расстояния до верхней аптечки: она лежит снаружи, под красной заливкой.
const ZONE_SHRINK_S = 95;
const ZONE_VICTIM: TankPose = { x: 420, y: 190, heading: 0.4, turret: 0.45, hp: 52 };

const SHOOTER: TankPose = { x: 480, y: 650, heading: 0.1, turret: -0.25 };
const ENEMY_SHOOTER: TankPose = { x: 800, y: 680, heading: Math.PI, turret: Math.PI + 0.2 };

const IMPACT: Point = { x: 379, y: 610 };
const IMPACT_GUNNER: TankPose = { x: 620, y: 700, heading: -2.6, turret: aimAt({ x: 620, y: 700 }, IMPACT) };

// Левая грань стены (1226, 540, 44, 200), нормаль влево: снаряд отражается зеркально по горизонтали.
const RICOCHET: Point = { x: 1221, y: 640 };
const RICOCHET_GUNNER: TankPose = { x: 980, y: 700, heading: -0.3, turret: aimAt({ x: 980, y: 700 }, RICOCHET) };
const RICOCHET_AGE_S = 0.08;

const FIZZLE: Point = { x: 1010, y: 760 };
const FIZZLE_SHOOTER: TankPose = { x: 640, y: 820, heading: 0, turret: aimAt({ x: 640, y: 820 }, FIZZLE) };

const CLASH: Point = { x: 980, y: 210 };
const CLASH_ME: TankPose = { x: 700, y: 220, heading: 0, turret: aimAt({ x: 700, y: 220 }, CLASH) };
const CLASH_ENEMY: TankPose = { x: 1180, y: 200, heading: Math.PI, turret: aimAt({ x: 1180, y: 200 }, CLASH) };

const HIT_TARGET: TankPose = {
  x: 1000,
  y: 700,
  heading: Math.PI - 0.3,
  turret: Math.PI - 0.1,
  hp: FULL_HP - 2 * DAMAGE,
};
const HITTER: TankPose = { x: 600, y: 680, heading: 0, turret: aimAt({ x: 600, y: 680 }, HIT_TARGET) };
const DEATH_TARGET: TankPose = { ...HIT_TARGET, hp: 0, isAlive: false };
const MIRROR_TARGET: TankPose = { x: 600, y: 700, heading: 0.3, turret: 0.1, hp: FULL_HP - 2 * DAMAGE };
const MIRROR_HITTER: TankPose = {
  x: 1000,
  y: 680,
  heading: Math.PI,
  turret: aimAt({ x: 1000, y: 680 }, MIRROR_TARGET),
};

// Левая грань стены (330, 160, 44, 200): танк упёрся в неё корпусом.
const BUMPER: TankPose = { x: 330 - TANK_RADIUS, y: 250, heading: 0, turret: 0.3 };

const KIT_BOTTOM = mapByIndex(0).kits[1] ?? { x: 0, y: 0 };
const PICKER: TankPose = { x: KIT_BOTTOM.x, y: KIT_BOTTOM.y, heading: -1.4, turret: -0.6 };
const PICKUP_AGE_S = 0.3;

const RICOCHET_VICTIM: TankPose = { x: 1080, y: 470, heading: 2.8, turret: 3, hp: FULL_HP - DAMAGE };
const ANNOUNCER: TankPose = { x: 480, y: 600, heading: -0.2, turret: -0.4 };
const SELF_HIT: TankPose = { x: 300, y: 820, heading: 0, turret: Math.PI - 0.15, hp: FULL_HP - DAMAGE };
const RICOCHETED_ME: TankPose = { x: 600, y: 470, heading: 0.3, turret: 0, hp: FULL_HP - DAMAGE };
const ENEMY_SELF_HIT: TankPose = { x: 1300, y: 820, heading: Math.PI, turret: 0.15, hp: FULL_HP - DAMAGE };

const STICK_SCENE: Omit<DuelFrame, 'id' | 'title'> = {
  ...FIGHT,
  tanks: [{ x: 520, y: 470, heading: 0.3, turret: -0.6 }, FAR_ENEMY],
};

const COUNTDOWN_SCENE: Omit<DuelFrame, 'id' | 'title' | 'countdownLeftS'> = {
  ...FIGHT,
  mapIndex: 1,
  phase: 'countdown',
  roundTimeS: 0,
  tanks: [spawnPose(1, 0), spawnPose(1, 1)],
};

const AIM_ME: TankPose = { x: 260, y: 450, heading: 0, turret: 0 };
const AIM_ENEMY: TankPose = { x: 700, y: 450, heading: Math.PI, turret: Math.PI };
// Удар в нижнюю часть стены (330, 160, 44, 200) под пологим углом: хвост после отскока остаётся в кадре.
const WALL_AIMER: TankPose = { x: 200, y: 420, heading: -0.4, turret: aimAt({ x: 200, y: 420 }, { x: 325, y: 355 }) };
// Почти в упор в левый край: отражённый путь возвращается через свой корпус.
const GUARDED: TankPose = { x: 140, y: 450, heading: 0, turret: Math.PI - 0.1 };
const GUARDED_RIGHT: TankPose = { x: 1460, y: 450, heading: Math.PI, turret: 0.1 };

const CAMERA_SCENE: Omit<DuelFrame, 'id' | 'title' | 'tanks' | 'settings'> = {
  ...FIGHT,
  mapIndex: 3,
  roundTimeS: 28.4,
  roundIndex: 3,
  score: [2, 1],
};
// Противник высоко над своим танком: «за своим» его не показывает, с отдалением окно уходит на дальний уровень.
const FAR_PAIR: [TankPose, TankPose] = [
  { x: 300, y: 800, heading: -0.8, turret: -0.6 },
  { x: 1350, y: 90, heading: 2.4, turret: 2.6 },
];
// Пара помещается на ближнем уровне: окно встаёт по центру пары, а не по своему танку.
const NEAR_PAIR: [TankPose, TankPose] = [
  { x: 500, y: 480, heading: -0.3, turret: -0.2 },
  { x: 1100, y: 380, heading: 2.9, turret: 3.3 },
];

const WINNER: TankPose = { x: 640, y: 620, heading: 0.2, turret: 0.1, hp: 92 };
const LOSER: TankPose = { x: 1000, y: 680, heading: 2.8, turret: 3, hp: 0, isAlive: false };
const ROUND_END_SCENE: Omit<DuelFrame, 'id' | 'title' | 'tanks' | 'roundEnd'> = {
  ...FIGHT,
  kind: 'page',
  phase: 'over',
  roundTimeS: 63.7,
  roundIndex: 2,
  score: [1, 1],
};

// Не эталон: стенд рисует его, пока на месте обоих танков не появятся спрайты.
export const SPRITE_PROBE: DuelFrame = {
  ...FIGHT,
  id: 'sprite-probe',
  title: 'Готовность спрайтов',
  tanks: [
    { x: 500, y: 450, heading: 0, turret: 0 },
    { x: 620, y: 450, heading: Math.PI, turret: Math.PI },
  ],
  settings: { hasAimLine: false },
};

export const DUEL_FRAMES: readonly DuelFrame[] = [
  ...MAP_FRAMES,
  { ...SIDE_SCENE, id: 'side-0', title: 'Свой танк за сторону 0: панели, стрелка, кромка', mySide: 0 },
  { ...SIDE_SCENE, id: 'side-1', title: 'Та же сцена за сторону 1', mySide: 1 },
  {
    ...FIGHT,
    id: 'tanks',
    title: 'Оба танка едут: следы гусениц, выцветшая подпалина, раненый противник дымит',
    roundTimeS: DRIVE_ROUND_S,
    score: [0, 1],
    tanks: [DRIVER, ENEMY_DRIVER],
    drives: [
      { side: 0, durationS: 3.2, stopAgeS: 0.25 },
      { side: 1, durationS: 3, stopAgeS: 0 },
    ],
    events: [timed(3, pointEvent('impact', 0, OLD_IMPACT.x, OLD_IMPACT.y))],
    crop: focus(780, 740),
  },
  {
    ...FIGHT,
    id: 'wreck-under',
    title: 'Подбитый противник вплотную под живым своим',
    roundTimeS: DRIVE_ROUND_S,
    score: [0, 1],
    tanks: [SURVIVOR, WRECK],
    events: [firstBloodTaken(1, WRECK), ...kill(1, SURVIVOR, WRECK, WRECK_AGE_S)],
    crop: focus(700, 712),
  },
  {
    ...FIGHT,
    id: 'tanks-overlap',
    title: 'Два живых танка вплотную: спрайты перекрыты',
    tanks: [PUSHER, PUSHED],
    crop: focus(1100, 810),
  },
  {
    ...FIGHT,
    id: 'bullets',
    title: 'Снаряды обеих сторон со следом',
    roundTimeS: 21.5,
    roundIndex: 0,
    score: [0, 0],
    tanks: [LANE_SHOOTER, LANE_ENEMY],
    bullets: [
      bulletFrom(0, muzzleOf(LANE_SHOOTER), LANE_SHOOTER.turret, 0.55),
      bulletFrom(1, muzzleOf(LANE_ENEMY), LANE_ENEMY.turret, 0.4),
    ],
    crop: focus(750, 100),
  },
  {
    ...FIGHT,
    id: 'kits',
    title: 'Аптечка лежит и только что появилась; вторая — дуга до появления',
    mapIndex: 3,
    roundTimeS: 35.3,
    roundIndex: 3,
    score: [2, 1],
    tanks: [
      { x: 800, y: 520, heading: -Math.PI / 2, turret: -2.3 },
      { x: 1400, y: 760, heading: Math.PI, turret: 3.6 },
    ],
    kits: [
      { isActive: true, respawnIn: 0 },
      { isActive: false, respawnIn: 2.5 },
    ],
    events: [timed(0.3, pointEvent('kitSpawn', null, 620, 450))],
    crop: focus(800, 470),
  },
  {
    ...FIGHT,
    id: 'zone-start',
    title: 'Начало сжатия: таймер красный, объявление',
    mapIndex: 1,
    roundTimeS: ZONE.startShrink + 0.9,
    roundIndex: 2,
    score: [1, 1],
    tanks: [
      { x: 360, y: 760, heading: -1.2, turret: -0.5 },
      { x: 1250, y: 140, heading: 2, turret: 2.6 },
    ],
    events: [timed(0.9, zoneStartEvent())],
    crop: ANNOUNCE_BAND,
  },
  {
    ...FIGHT,
    id: 'zone-shrink',
    title: 'Зона сжимается: свой танк и аптечка снаружи',
    roundTimeS: ZONE_SHRINK_S,
    tanks: [ZONE_VICTIM, { x: 700, y: 450, heading: Math.PI, turret: 3.5 }],
    kits: [
      { isActive: true, respawnIn: 0 },
      { isActive: true, respawnIn: 0 },
    ],
    events: zoneHits(0, ZONE_VICTIM),
    crop: focus(610, 200),
  },
  {
    ...FIGHT,
    id: 'fx-shot',
    title: 'Выстрел: отдача, вспышка, искры, дым',
    tanks: [SHOOTER, FAR_ENEMY],
    bullets: [bulletFrom(0, muzzleOf(SHOOTER), SHOOTER.turret, 0.05)],
    events: [timed(0.05, shotEvent(0, SHOOTER))],
    crop: focus(540, 630),
  },
  {
    ...FIGHT,
    id: 'fx-shot-shake',
    title: 'Выстрел на втором шаге: тряска ещё не погасла',
    tanks: [SHOOTER, FAR_ENEMY],
    bullets: [bulletFrom(0, muzzleOf(SHOOTER), SHOOTER.turret, SHOT_SHAKE_AGE_S)],
    events: [timed(SHOT_SHAKE_AGE_S, shotEvent(0, SHOOTER))],
    crop: focus(540, 630),
  },
  {
    ...FIGHT,
    id: 'fx-shot-enemy',
    title: 'Выстрел противника: отдача его танка',
    tanks: [SHOOTER, ENEMY_SHOOTER],
    bullets: [bulletFrom(1, muzzleOf(ENEMY_SHOOTER), ENEMY_SHOOTER.turret, 0.05)],
    events: [timed(0.05, shotEvent(1, ENEMY_SHOOTER))],
    crop: focus(780, 660),
  },
  {
    ...FIGHT,
    id: 'fx-impact',
    title: 'Снаряд в стену: искры, дым, подпалина',
    tanks: [IMPACT_GUNNER, FAR_ENEMY],
    events: [timed(0.15, pointEvent('impact', 0, IMPACT.x, IMPACT.y))],
    crop: focus(440, 640),
  },
  {
    ...FIGHT,
    id: 'fx-ricochet',
    title: 'Рикошет: искры вдоль нормали, вспышка, снаряд после отскока',
    tanks: [RICOCHET_GUNNER, FAR_ENEMY],
    bullets: [bulletFrom(0, RICOCHET, Math.PI - RICOCHET_GUNNER.turret, RICOCHET_AGE_S)],
    events: [timed(RICOCHET_AGE_S, ricochetEvent(0, RICOCHET.x, RICOCHET.y, -1, 0))],
    crop: focus(1150, 660),
  },
  {
    ...FIGHT,
    id: 'fx-fizzle',
    title: 'Снаряд выдохся: дымок',
    tanks: [FIZZLE_SHOOTER, FAR_ENEMY],
    events: [timed(0.25, pointEvent('fizzle', 0, FIZZLE.x, FIZZLE.y))],
    crop: focus(960, 760),
  },
  {
    ...FIGHT,
    id: 'fx-clash',
    title: 'Перехват снарядов: вспышка, кольцо, «ПЕРЕХВАТ!»',
    tanks: [CLASH_ME, CLASH_ENEMY],
    events: [timed(0.12, pointEvent('clash', null, CLASH.x, CLASH.y))],
    crop: focus(980, 220),
  },
  {
    ...FIGHT,
    id: 'fx-clash-shake',
    title: 'Перехват в самом начале: тряска',
    tanks: [CLASH_ME, CLASH_ENEMY],
    events: [timed(CLASH_SHAKE_AGE_S, pointEvent('clash', null, CLASH.x, CLASH.y))],
    crop: focus(980, 220),
  },
  {
    ...FIGHT,
    id: 'fx-hit',
    title: 'Попадание: вспышка танка, искры, дым, урон',
    tanks: [HITTER, HIT_TARGET],
    events: [firstBloodTaken(1, HIT_TARGET), timed(0.12, hitBetween(1, HITTER, HIT_TARGET))],
    crop: focus(960, 680),
  },
  {
    ...FIGHT,
    id: 'fx-hit-side-1',
    title: 'Попадание за сторону 1: свой танк бьёт сторону 0',
    mySide: 1,
    tanks: [MIRROR_TARGET, MIRROR_HITTER],
    events: [firstBloodTaken(0, MIRROR_TARGET), timed(0.12, hitBetween(0, MIRROR_HITTER, MIRROR_TARGET))],
    crop: focus(640, 690),
  },
  {
    ...FIGHT,
    id: 'fx-death',
    title: 'Гибель: вспышка экрана, кольца, огонь, обломки, тряска',
    tanks: [HITTER, DEATH_TARGET],
    events: [firstBloodTaken(1, DEATH_TARGET), ...kill(1, HITTER, DEATH_TARGET, 0.25)],
  },
  {
    ...FIGHT,
    id: 'fx-bump',
    title: 'Удар о стену: дым',
    tanks: [BUMPER, FAR_ENEMY],
    events: [timed(0.25, pointEvent('bump', 0, BUMPER.x, BUMPER.y))],
    crop: focus(330, 260),
  },
  {
    ...FIGHT,
    id: 'fx-pickup',
    title: 'Подбор аптечки: кольцо, искры, «+50»',
    tanks: [PICKER, FAR_ENEMY],
    kits: [
      { isActive: true, respawnIn: 0 },
      { isActive: false, respawnIn: KIT.respawn - PICKUP_AGE_S },
    ],
    events: [timed(PICKUP_AGE_S, pickupEvent(0, KIT_BOTTOM.x, KIT_BOTTOM.y, KIT.heal))],
    crop: focus(KIT_BOTTOM.x, KIT_BOTTOM.y - 30),
  },
  {
    ...FIGHT,
    id: 'announce-first-blood',
    title: 'Попадание рикошетом: «РИКОШЕТ!» и «ПЕРВАЯ КРОВЬ»',
    tanks: [ANNOUNCER, RICOCHET_VICTIM],
    events: [timed(0.6, hitBetween(1, { x: 900, y: 330 }, RICOCHET_VICTIM, EventFlag.Ricochet))],
    crop: ANNOUNCE_BAND,
  },
  {
    ...FIGHT,
    id: 'announce-self',
    title: 'Свой рикошет в себя: «САМ СЕБЯ!»',
    tanks: [SELF_HIT, FAR_ENEMY],
    events: [timed(0.6, hitBetween(0, { x: 200, y: 760 }, SELF_HIT, EventFlag.Self | EventFlag.Ricochet))],
    crop: ANNOUNCE_BAND,
  },
  {
    ...FIGHT,
    id: 'announce-first-blood-enemy',
    title: 'Противник попал в меня рикошетом: «РИКОШЕТ!» и «ПЕРВАЯ КРОВЬ» его цветом',
    tanks: [RICOCHETED_ME, { x: 1080, y: 600, heading: Math.PI, turret: 3.3 }],
    events: [timed(0.6, hitBetween(0, { x: 760, y: 250 }, RICOCHETED_ME, EventFlag.Ricochet))],
    crop: ANNOUNCE_BAND,
  },
  {
    ...FIGHT,
    id: 'announce-self-enemy',
    title: 'Противник рикошетом в себя: «САМ СЕБЯ!» его цветом',
    tanks: [ANNOUNCER, ENEMY_SELF_HIT],
    events: [timed(0.6, hitBetween(1, { x: 1400, y: 760 }, ENEMY_SELF_HIT, EventFlag.Self | EventFlag.Ricochet))],
    crop: ANNOUNCE_BAND,
  },
  { ...COUNTDOWN_SCENE, id: 'countdown-3', title: 'Отсчёт: 3', countdownLeftS: 2.5 },
  { ...COUNTDOWN_SCENE, id: 'countdown-2', title: 'Отсчёт: 2', countdownLeftS: 1.5, crop: COUNTDOWN_NUMBER_BAND },
  { ...COUNTDOWN_SCENE, id: 'countdown-1', title: 'Отсчёт: 1', countdownLeftS: 0.5, crop: COUNTDOWN_NUMBER_BAND },
  {
    ...COUNTDOWN_SCENE,
    id: 'countdown-go',
    title: 'Отсчёт: «БОЙ!»',
    countdownLeftS: -0.3,
    crop: COUNTDOWN_NUMBER_BAND,
  },
  {
    ...FIGHT,
    id: 'aim-on-target',
    title: 'Линия выстрела «на нём»',
    tanks: [AIM_ME, AIM_ENEMY],
    crop: focus(480, 450),
  },
  {
    ...FIGHT,
    id: 'aim-none',
    title: 'Линия выстрела без цели, с отскоком',
    tanks: [WALL_AIMER, { x: 1400, y: 700, heading: Math.PI, turret: 3.3 }],
    crop: focus(265, 385),
  },
  {
    ...FIGHT,
    id: 'guard',
    title: 'Предохранитель: отметка поперёк ствола, опасный хвост',
    tanks: [GUARDED, { x: 1100, y: 250, heading: Math.PI, turret: 3 }],
    isShotGuarded: true,
    crop: focus(130, 450),
  },
  {
    ...FIGHT,
    id: 'guard-side-1',
    title: 'Предохранитель за сторону 1: отметка на своём танке',
    mySide: 1,
    tanks: [{ x: 500, y: 250, heading: 0, turret: 0 }, GUARDED_RIGHT],
    isShotGuarded: true,
    crop: focus(1470, 450),
  },
  {
    ...STICK_SCENE,
    id: 'sticks-ring-reverse',
    title: 'Стики: активное кольцо огня, кромка заднего хода',
    settings: { hasFireRing: true },
    sticks: [
      { role: 'move', dx: -0.35, dy: 0.85, isFiring: false },
      { role: 'aim', dx: 0.8, dy: -0.5, isFiring: true },
    ],
    isReversing: true,
    crop: STICK_BAND,
  },
  {
    ...STICK_SCENE,
    id: 'sticks-edge-fire',
    title: 'Стики без кольца: огонь касанием — кромка основания',
    sticks: [
      { role: 'move', dx: 0.6, dy: -0.55, isFiring: false },
      { role: 'aim', dx: -0.3, dy: 0.4, isFiring: true },
    ],
    crop: STICK_BAND,
  },
  {
    ...STICK_SCENE,
    id: 'debug-graph',
    title: 'Отладка: строка и график кадров',
    settings: { showFrameGraph: true },
    crop: DEBUG_CORNER,
  },
  {
    ...CAMERA_SCENE,
    id: 'camera-follow-zoom',
    title: 'Камера «за своим + отдаление»: противник высоко — дальний уровень',
    tanks: FAR_PAIR,
    settings: { cameraMode: 'followZoom' },
  },
  {
    ...CAMERA_SCENE,
    id: 'camera-pair',
    title: 'Камера «оба в кадре»: окно по центру пары',
    tanks: NEAR_PAIR,
    settings: { cameraMode: 'pair' },
    crop: SCREEN_CENTER,
  },
  {
    ...ROUND_END_SCENE,
    id: 'round-win',
    title: 'Итоги раунда: победа',
    tanks: [WINNER, LOSER],
    events: [firstBloodTaken(1, LOSER), ...kill(1, WINNER, LOSER, ROUND_END_AGE_S)],
    roundEnd: {
      info: { result: 'win', isByTime: false, score: [2, 1], mySide: 0, botLevel: null },
      ageS: ROUND_END_AGE_S,
    },
  },
  {
    ...ROUND_END_SCENE,
    id: 'round-loss',
    title: 'Итоги раунда: поражение',
    tanks: [
      { ...WINNER, hp: 0, isAlive: false },
      { ...LOSER, hp: 64, isAlive: true },
    ],
    events: [firstBloodTaken(0, WINNER), ...kill(0, LOSER, WINNER, ROUND_END_AGE_S)],
    roundEnd: {
      info: { result: 'loss', isByTime: false, score: [1, 2], mySide: 0, botLevel: null },
      ageS: ROUND_END_AGE_S,
    },
  },
  {
    ...ROUND_END_SCENE,
    id: 'round-draw',
    title: 'Итоги раунда: ничья по времени',
    roundTimeS: 120,
    tanks: [
      { x: 720, y: 450, heading: 0, turret: 0.1, hp: 90 },
      { x: 880, y: 460, heading: Math.PI, turret: Math.PI - 0.1, hp: 90 },
    ],
    roundEnd: {
      info: { result: 'draw', isByTime: true, score: [1, 1], mySide: 0, botLevel: null },
      ageS: ROUND_END_AGE_S,
    },
  },
];
