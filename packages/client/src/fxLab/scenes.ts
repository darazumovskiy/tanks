import { createRound, DEFAULT_STATS, type Round, type Side } from '@tanks/shared/engine';
import { computeAimLine, enemyLeadPoint, type AimLine } from '../aimLine.js';
import type { InterpolatedTank, WorldView } from '../prediction.js';
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

export interface FxScene {
  id: string;
  title: string;
  mapIndex: number;
  me: { x: number; y: number; heading: number; aim: TurretAim };
  enemy: SceneEnemy | null;
  bullet: SceneBullet | null;
  hasLeadHint: boolean;
}

export interface FxScreen extends ScreenGeometry {
  isTouchDevice: boolean;
}

export interface SceneFrame {
  view: WorldView;
  aimLine: AimLine;
}

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
    me: { x: 200, y: 420, heading: -0.4, aim: { turret: Math.atan2(355 - 420, 325 - 200) } },
    enemy: null,
    bullet: null,
    hasLeadHint: false,
  },
  {
    id: 'on-target',
    title: 'На противнике',
    mapIndex: 0,
    me: { ...ME_LANE, heading: 0, aim: { at: 'enemy' } },
    enemy: { ...ENEMY_AHEAD, heading: Math.PI, speed: 0 },
    bullet: null,
    hasLeadHint: false,
  },
  {
    id: 'lead',
    title: 'Упреждаю: противник едет поперёк',
    mapIndex: 0,
    me: { ...ME_LANE, heading: 0, aim: { at: 'lead' } },
    enemy: { x: 650, y: 330, heading: Math.PI / 2, speed: 120 },
    bullet: null,
    hasLeadHint: true,
  },
  {
    id: 'returning',
    title: 'В край почти в упор: хвост вернётся в меня',
    mapIndex: 0,
    me: { x: 140, y: 450, heading: 0, aim: { turret: Math.PI - RETURN_SKEW } },
    enemy: null,
    bullet: null,
    hasLeadHint: false,
  },
  {
    id: 'with-bullet',
    title: 'На противнике, рядом летит мой снаряд',
    mapIndex: 0,
    me: { ...ME_LANE, heading: 0, aim: { at: 'enemy' } },
    enemy: { ...ENEMY_AHEAD, heading: Math.PI, speed: 0 },
    bullet: { x: 480, y: 410, angle: 0, owner: 0 },
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
  const target = aim.at === 'lead' ? (enemyLeadPoint(scene.me, scene.enemy, bulletSpeed) ?? scene.enemy) : scene.enemy;
  return Math.atan2(target.y - scene.me.y, target.x - scene.me.x);
}

// `bulletBack` — на сколько единиц снаряд ещё не долетел до своей точки: служебные кадры перед снимком
// ведут его по этому пути, чтобы набрался след.
export function buildSceneFrame(scene: FxScene, bulletBack = 0): SceneFrame {
  const round = createRound(scene.mapIndex, [
    { name: 'Я', stats: { ...DEFAULT_STATS } },
    { name: 'Противник', stats: { ...DEFAULT_STATS } },
  ]);
  const me = round.tanks[0];
  me.x = scene.me.x;
  me.y = scene.me.y;
  me.heading = scene.me.heading;
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
  const view: WorldView = {
    round,
    tanks: [tankView(round, 0, 0), tankView(round, 1, scene.enemy?.speed ?? 0)],
    bullets:
      scene.bullet === null
        ? []
        : [
            {
              id: 1,
              owner: scene.bullet.owner,
              x: scene.bullet.x - Math.cos(scene.bullet.angle) * bulletBack,
              y: scene.bullet.y - Math.sin(scene.bullet.angle) * bulletBack,
            },
          ],
  };
  const aimLine = computeAimLine({
    field: round.map,
    shooter: { x: me.x, y: me.y, turret: me.turret },
    bulletSpeed: me.stats.bulletSpeed,
    targets: scene.enemy === null ? [] : [{ ...scene.enemy }],
    hasLeadHint: scene.hasLeadHint,
  });
  return { view, aimLine };
}
