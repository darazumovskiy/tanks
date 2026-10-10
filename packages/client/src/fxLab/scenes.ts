import {
  createRound,
  DEFAULT_RULES,
  DEFAULT_STATS,
  DT,
  MUZZLE_OFFSET,
  NO_CARRY,
  shotCarry,
  type Point,
  type Round,
  type Side,
} from '@tanks/shared/engine';
import type { SnapshotEvent } from '@tanks/shared/protocol';
import { computeAimLine, enemyLeadPoint, type AimLine } from '../aimLine.js';
import type { InterpolatedBullet, InterpolatedTank, WorldView } from '../prediction.js';
import type { ScreenGeometry } from '../render/cameraScenarios.js';

// Сцены лаборатории: положения танков и снаряда, из которых тем же кодом, что в бою, собираются кадр и линия.

export type TurretAim = { turret: number } | { at: 'enemy' } | { at: 'lead' };

export interface SceneEnemy {
  x: number;
  y: number;
  heading: number;
  speed: number;
}

export interface SceneBullet {
  x: number;
  y: number;
  angle: number;
  owner: Side;
}

// Выстрел своего танка за framesBack служебных кадров до снимка по правилам раунда: догон и доля скорости танка.
export interface SceneShot {
  framesBack: number;
  leadTicks: number;
  inheritPercent: number;
}

// Сцена описывает мгновение снимка; едущий свой танк в служебных кадрах до него — позади на свой ход.
export interface FxScene {
  id: string;
  title: string;
  mapIndex: number;
  me: { x: number; y: number; heading: number; speed: number; aim: TurretAim };
  enemy: SceneEnemy | null;
  bullet: SceneBullet | null;
  shot: SceneShot | null;
  hasLeadHint: boolean;
}

export interface FxScreen extends ScreenGeometry {
  isTouchDevice: boolean;
}

export interface SceneFrame {
  view: WorldView;
  aimLine: AimLine;
  // Событие выстрела — только в служебном кадре, где он случился.
  shot: SnapshotEvent | null;
}

// Служебный кадр лаборатории; снаряд сцены за это время пролетает BULLET_STEP.
export const LAB_FRAME_S = 0.016;
const BULLET_STEP = 8;
const SHOT_BULLET_ID = 2;

const ME_LANE = { x: 260, y: 450 };
// Небольшой скос к краю: отражённый путь всё ещё проходит через корпус, но виден рядом с прямым отрезком.
const RETURN_SKEW = 0.1;
const ENEMY_AHEAD = { x: 700, y: 450 };

export const FX_SCENES: readonly FxScene[] = [
  {
    id: 'wall-tail',
    title: 'В стену под углом, хвост после отскока',
    mapIndex: 0,
    // Удар в нижнюю часть стены (330, 160, 44, 200) под пологим углом: хвост после отскока остаётся в кадре.
    me: { x: 200, y: 420, heading: -0.4, speed: 0, aim: { turret: Math.atan2(355 - 420, 325 - 200) } },
    enemy: null,
    bullet: null,
    shot: null,
    hasLeadHint: false,
  },
  {
    id: 'on-target',
    title: 'На противнике',
    mapIndex: 0,
    me: { ...ME_LANE, heading: 0, speed: 0, aim: { at: 'enemy' } },
    enemy: { ...ENEMY_AHEAD, heading: Math.PI, speed: 0 },
    bullet: null,
    shot: null,
    hasLeadHint: false,
  },
  {
    id: 'lead',
    title: 'Упреждаю: противник едет поперёк',
    mapIndex: 0,
    me: { ...ME_LANE, heading: 0, speed: 0, aim: { at: 'lead' } },
    enemy: { x: 650, y: 330, heading: Math.PI / 2, speed: 120 },
    bullet: null,
    shot: null,
    hasLeadHint: true,
  },
  {
    id: 'returning',
    title: 'В край почти в упор: хвост вернётся в меня',
    mapIndex: 0,
    me: { x: 140, y: 450, heading: 0, speed: 0, aim: { turret: Math.PI - RETURN_SKEW } },
    enemy: null,
    bullet: null,
    shot: null,
    hasLeadHint: false,
  },
  {
    id: 'with-bullet',
    title: 'На противнике, рядом летит мой снаряд',
    mapIndex: 0,
    me: { ...ME_LANE, heading: 0, speed: 0, aim: { at: 'enemy' } },
    enemy: { ...ENEMY_AHEAD, heading: Math.PI, speed: 0 },
    bullet: { x: 480, y: 410, angle: 0, owner: 0 },
    shot: null,
    hasLeadHint: false,
  },
  {
    id: 'shot-moving',
    title: 'Выстрел на ходу вбок',
    mapIndex: 0,
    me: { x: 480, y: 450, heading: 0, speed: 220, aim: { turret: Math.PI / 2 } },
    enemy: null,
    bullet: null,
    shot: { framesBack: 3, leadTicks: 3, inheritPercent: 100 },
    hasLeadHint: false,
  },
];

export const FX_SCREENS: readonly FxScreen[] = [
  { id: 'phone', width: 844, height: 390, pixelRatio: 2, isTouchDevice: true },
  { id: 'desktop', width: 1280, height: 720, pixelRatio: 1, isTouchDevice: false },
];

function tankView(round: Round, side: Side, speed: number): InterpolatedTank {
  const tank = round.tanks[side];
  return {
    x: tank.x,
    y: tank.y,
    heading: tank.heading,
    turret: tank.turret,
    speed,
    hp: tank.hp,
    maxHp: tank.stats.maxHp,
    isAlive: tank.isAlive,
  };
}

function turretFor(scene: FxScene, bulletSpeed: number): number {
  const { aim } = scene.me;
  if ('turret' in aim) {
    return aim.turret;
  }
  if (scene.enemy === null) {
    return scene.me.heading;
  }
  const lead = enemyLeadPoint(scene.me, scene.enemy, bulletSpeed, NO_CARRY) ?? scene.enemy;
  const target = aim.at === 'lead' ? lead : scene.enemy;
  return Math.atan2(target.y - scene.me.y, target.x - scene.me.x);
}

function muzzleOf(tank: { x: number; y: number; turret: number }): Point {
  return { x: tank.x + Math.cos(tank.turret) * MUZZLE_OFFSET, y: tank.y + Math.sin(tank.turret) * MUZZLE_OFFSET };
}

function shotEventAt(muzzle: Point, turret: number): SnapshotEvent {
  return {
    kind: 'shot',
    side: 0,
    x: muzzle.x,
    y: muzzle.y,
    value: turret,
    dx: Math.cos(turret),
    dy: Math.sin(turret),
    flags: 0,
  };
}

// Снаряд выстрела сцены, как у движка: в тике выстрела — шаг полёта и шаги догона, дальше — со скоростью выстрела.
function shotBullet(round: Round, shot: SceneShot, framesBack: number): InterpolatedBullet {
  const me = round.tanks[0];
  const back = (shot.framesBack - framesBack) * LAB_FRAME_S;
  const firedAt = {
    ...me,
    x: me.x - Math.cos(me.heading) * me.speed * back,
    y: me.y - Math.sin(me.heading) * me.speed * back,
  };
  const muzzle = muzzleOf(firedAt);
  const carry = shotCarry(me, shot.inheritPercent);
  const vx = Math.cos(me.turret) * me.stats.bulletSpeed + carry.x;
  const vy = Math.sin(me.turret) * me.stats.bulletSpeed + carry.y;
  const flightS = (1 + shot.leadTicks) * DT + back;
  return { id: SHOT_BULLET_ID, owner: 0, x: muzzle.x + vx * flightS, y: muzzle.y + vy * flightS };
}

// `framesBack` — за сколько служебных кадров до снимка этот кадр: снаряд сцены ещё не долетел до своей точки,
// едущий свой танк ещё позади — так набирается след и проигрывается выстрел.
export function buildSceneFrame(scene: FxScene, framesBack = 0): SceneFrame {
  const { shot } = scene;
  const rules = {
    ...DEFAULT_RULES,
    shotLeadTicks: shot?.leadTicks ?? 0,
    shotInheritPercent: shot?.inheritPercent ?? 0,
  };
  const round = createRound(
    scene.mapIndex,
    [
      { name: 'Я', stats: { ...DEFAULT_STATS } },
      { name: 'Противник', stats: { ...DEFAULT_STATS } },
    ],
    rules,
  );
  const me = round.tanks[0];
  const driven = scene.me.speed * framesBack * LAB_FRAME_S;
  me.x = scene.me.x - Math.cos(scene.me.heading) * driven;
  me.y = scene.me.y - Math.sin(scene.me.heading) * driven;
  me.heading = scene.me.heading;
  me.speed = scene.me.speed;
  me.turret = turretFor(scene, me.stats.bulletSpeed);
  const enemy = round.tanks[1];
  if (scene.enemy === null) {
    enemy.isAlive = false;
    enemy.x = -1000;
    enemy.y = -1000;
  } else {
    enemy.x = scene.enemy.x;
    enemy.y = scene.enemy.y;
    enemy.heading = scene.enemy.heading;
    enemy.turret = scene.enemy.heading;
  }
  const bullets: InterpolatedBullet[] = [];
  if (scene.bullet !== null) {
    const bulletBack = framesBack * BULLET_STEP;
    bullets.push({
      id: 1,
      owner: scene.bullet.owner,
      x: scene.bullet.x - Math.cos(scene.bullet.angle) * bulletBack,
      y: scene.bullet.y - Math.sin(scene.bullet.angle) * bulletBack,
    });
  }
  const hasFired = shot !== null && framesBack <= shot.framesBack;
  if (hasFired) {
    bullets.push(shotBullet(round, shot, framesBack));
  }
  const view: WorldView = {
    round,
    tanks: [tankView(round, 0, scene.me.speed), tankView(round, 1, scene.enemy?.speed ?? 0)],
    bullets,
  };
  const aimLine = computeAimLine({
    field: round.map,
    shooter: { x: me.x, y: me.y, turret: me.turret },
    bulletSpeed: me.stats.bulletSpeed,
    carry: shot === null ? NO_CARRY : shotCarry(me, shot.inheritPercent),
    targets: scene.enemy === null ? [] : [{ ...scene.enemy }],
    hasLeadHint: scene.hasLeadHint,
  });
  const isShotFrame = shot !== null && framesBack === shot.framesBack;
  return { view, aimLine, shot: isShotFrame ? shotEventAt(muzzleOf(me), me.turret) : null };
}
