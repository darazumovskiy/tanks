import { switchProbability } from '@tanks/analysis/ruler';
import {
  createRandom,
  isShotReturning,
  mapByIndex,
  TICK_RATE,
  type Action,
  type BotView,
  type MapDef,
  type Point,
  type Random,
} from '@tanks/shared/engine';
import type { TwinCalibration, TwinProfile } from './profile.js';
import { Ambush, hasLineOfSight } from './cover.js';
import { FireIntent, fireContextOf } from './fire.js';
import { Hand } from './hand.js';
import { HiddenAim } from './hiddenAim.js';
import { isNearZoneEdge, Manoeuvre, type Drive } from './manoeuvre.js';
import { modeFeatures, type HitRecord, type MatchState } from './modeSwitch.js';
import { gridOf, type Grid } from './path.js';
import { chance } from './sampling.js';
import { aimTurret } from './steering.js';

// Обстановка раунда: матч, карта, предохранитель из раскладки и сид случайности мозга.
export interface TwinSituation extends MatchState {
  mapIndex: number;
  hasRicochetGuard: boolean;
  seed: number;
}

export interface TwinView extends BotView {
  hits: readonly HitRecord[];
}

export interface TwinDecision {
  action: Action;
  isGuardHolding: boolean;
}

export type TwinMode = 'manoeuvre' | 'cover';

interface RoundParts {
  random: Random;
  hand: Hand;
  fire: FireIntent;
  manoeuvre: Manoeuvre;
  hiddenAim: HiddenAim;
  ambush: Ambush | null;
}

const STANDING: Point = { x: 0, y: 0 };

function requireCalibration(profile: TwinProfile): TwinCalibration {
  if (profile.calibration === null) {
    throw new Error(`у профиля ${profile.name} нет калибровки`);
  }
  return profile.calibration;
}

// Мозг двойника: функция от того, что он видит, к команде. Снаряды противника он не смотрит: уклонение —
// побочный эффект фонового манёвра.
export class TwinBrain {
  private readonly calibration: TwinCalibration;
  private parts: RoundParts;
  private situation: TwinSituation = {
    level: 3,
    roundIndex: 0,
    lossStreak: 0,
    mapIndex: 0,
    hasRicochetGuard: false,
    seed: 0,
  };
  private map: MapDef = mapByIndex(0);
  private fightTick = 0;
  private modeState: TwinMode = 'manoeuvre';
  private coverSinceTick = 0;
  private isEnemyInSight = true;
  private wasInCover = false;
  private wasReturning = false;
  private isReturnAvoided = false;

  constructor(private readonly profile: TwinProfile) {
    this.calibration = requireCalibration(profile);
    this.parts = this.partsFor(createRandom(0));
  }

  get mode(): TwinMode {
    return this.modeState;
  }

  init(situation: TwinSituation): void {
    this.situation = situation;
    this.map = mapByIndex(situation.mapIndex);
    this.parts = this.partsFor(createRandom(situation.seed));
    this.parts.hand.reset();
    this.parts.fire.reset();
    this.parts.manoeuvre.reset();
    this.parts.hiddenAim.reset();
    this.fightTick = 0;
    this.modeState = 'manoeuvre';
    this.coverSinceTick = 0;
    this.isEnemyInSight = true;
    this.wasInCover = false;
    this.wasReturning = false;
    this.isReturnAvoided = false;
  }

  tick(view: TwinView): TwinDecision {
    const { me, enemy } = view;
    const grid = gridOf(this.map);
    const hasSight = hasLineOfSight(this.map.walls, me, enemy);
    const distance = Math.hypot(enemy.x - me.x, enemy.y - me.y);
    if (this.fightTick % TICK_RATE === 0) {
      this.switchMode(view, grid, hasSight, distance);
    }
    this.fightTick++;
    const decisions = this.parts.manoeuvre.decisions;
    const drive = this.drive(view, grid, hasSight, distance);
    const target = this.aimPoint(view, grid, hasSight, this.parts.manoeuvre.decisions !== decisions);
    const wanted = this.parts.hand.wanted(
      me,
      target ?? enemy,
      target === null ? { x: enemy.vx, y: enemy.vy } : STANDING,
    );
    const isHeld = this.parts.fire.tick(this.modeState === 'cover' ? 'cover' : fireContextOf(hasSight, distance));
    const isAimHolding = !hasSight && this.modeState === 'manoeuvre' && this.parts.hiddenAim.current === 'hold';
    const isTurretIdle = (this.profile.control === 'sticks' && !isHeld) || isAimHolding;
    const isReturning = isHeld && isShotReturning(this.map, me, me.turret, me.stats.bulletSpeed, enemy);
    const isGuardHolding = this.situation.hasRicochetGuard && isReturning;
    const isAvoiding = !this.situation.hasRicochetGuard && this.avoidsReturn(isReturning);
    return {
      action: {
        ...drive,
        turretTurn: isTurretIdle ? 0 : aimTurret(wanted, me.turret),
        isFiring: isHeld && !isGuardHolding && !isAvoiding,
      },
      isGuardHolding,
    };
  }

  // Без предохранителя человек сам замечает, что выстрел вернётся в него: одно испытание на отрезок опасности,
  // заметил — не стреляет до конца отрезка.
  private avoidsReturn(isReturning: boolean): boolean {
    if (isReturning && !this.wasReturning) {
      this.isReturnAvoided = chance(this.parts.random, this.calibration.returnAvoidShare);
    }
    this.wasReturning = isReturning;
    return isReturning && this.isReturnAvoided;
  }

  private partsFor(random: Random): RoundParts {
    const { profile, calibration } = this;
    return {
      random,
      hand: new Hand(
        {
          errorDecilesDeg: profile.hand.errorDecilesDeg,
          correlationTicks: calibration.correlationTicks,
          lagTicks: calibration.lagTicks,
          leadShare: profile.hand.leadShare,
        },
        random,
      ),
      fire: new FireIntent(
        { ...profile.fire, holdShare: calibration.holdShare, coverHoldShare: calibration.coverHoldShare },
        random,
      ),
      manoeuvre: new Manoeuvre(
        {
          control: profile.control,
          pivotThrottle: profile.settings.pivotThrottle,
          decisionMeanS: calibration.decisionMeanS,
          courseReach: calibration.courseReach,
          stickDeciles: profile.manoeuvre.stickDeciles,
          courseDecilesDeg: profile.manoeuvre.courseDecilesDeg,
          reverseChance: calibration.reverseChance,
          kitShare: calibration.kitShare,
          kitFollowShare: calibration.kitFollowShare,
        },
        random,
      ),
      hiddenAim: new HiddenAim(calibration.hiddenAim, random),
      ambush: profile.cover === null ? null : new Ambush(profile.cover),
    };
  }

  // Переходы «манёвр → позиция» и «позиция → манёвр» — по одному испытанию в начале каждой секунды боя.
  private switchMode(view: TwinView, grid: Grid, hasSight: boolean, distance: number): void {
    const { enter, leave } = this.profile.modeSwitch;
    const ambush = this.parts.ambush;
    if (ambush === null || enter === null || leave === null) {
      return;
    }
    const features = modeFeatures(
      {
        map: this.map,
        me: { x: view.me.x, y: view.me.y, maxHp: view.me.maxHp },
        enemy: view.enemy,
        side: view.side,
        tick: view.tick,
        fightTick: this.fightTick,
        hasSight,
        distance,
        hits: view.hits,
      },
      this.situation,
    );
    if (this.modeState === 'manoeuvre') {
      const isEntering = chance(this.parts.random, switchProbability(enter, features, 0));
      if (isEntering && ambush.choose(grid, view.me, view.enemy)) {
        this.modeState = 'cover';
        this.coverSinceTick = this.fightTick;
      }
      return;
    }
    const positionSeconds = (this.fightTick - this.coverSinceTick) / TICK_RATE;
    if (chance(this.parts.random, switchProbability(leave, features, positionSeconds))) {
      this.modeState = 'manoeuvre';
      ambush.reset();
    }
  }

  // Точка, на которую рука ведёт башню, когда противник не виден; null — на самого противника. В позиции — на точку
  // выхода к засаде; в манёвре — на цель, выбранную при потере видимости, на решении манёвра и при выходе из
  // позиции.
  private aimPoint(view: TwinView, grid: Grid, hasSight: boolean, hasDecided: boolean): Point | null {
    const { hiddenAim, ambush } = this.parts;
    const hasLostSight = this.isEnemyInSight && !hasSight;
    const hasLeftCover = this.wasInCover && this.modeState === 'manoeuvre';
    this.isEnemyInSight = hasSight;
    this.wasInCover = this.modeState === 'cover';
    if (hasSight) {
      hiddenAim.see(view.enemy);
      return null;
    }
    if (hasLostSight || hasDecided || hasLeftCover) {
      hiddenAim.pick();
    }
    if (this.modeState === 'cover' && ambush !== null) {
      return ambush.exit(grid, view.enemy, view.tick);
    }
    return hiddenAim.point(this.map, view.me, view.enemy, view.tick);
  }

  private drive(view: TwinView, grid: Grid, hasSight: boolean, distance: number): Drive {
    const { manoeuvre, ambush } = this.parts;
    if (isNearZoneEdge(view)) {
      return manoeuvre.driveToZone(view, grid);
    }
    const spot = ambush?.spot ?? null;
    if (this.modeState === 'manoeuvre' || ambush === null || spot === null) {
      return manoeuvre.drive(view, grid, hasSight, distance);
    }
    return ambush.isAtSpot(view.me) ? manoeuvre.stop(view) : manoeuvre.travel(view, grid, spot);
  }
}
