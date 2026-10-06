import { switchProbability } from '@tanks/analysis';
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
import type { TwinCalibration, TwinProfile } from '../profile.js';
import { Ambush, hasLineOfSight } from './cover.js';
import { FireIntent, fireContextOf } from './fire.js';
import { Hand } from './hand.js';
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
    this.fightTick = 0;
    this.modeState = 'manoeuvre';
    this.coverSinceTick = 0;
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
    const drive = this.drive(view, grid, hasSight, distance);
    const isAimingAtExit = this.modeState === 'cover' && !hasSight;
    const target = isAimingAtExit ? this.exitPoint(grid, view) : enemy;
    const wanted = this.parts.hand.wanted(me, target, isAimingAtExit ? STANDING : { x: enemy.vx, y: enemy.vy });
    const isHeld = this.parts.fire.tick(this.modeState === 'cover' ? 'cover' : fireContextOf(hasSight, distance));
    const isTurretIdle = this.profile.control === 'sticks' && !isHeld;
    const isGuardHolding =
      this.situation.hasRicochetGuard &&
      isHeld &&
      isShotReturning(this.map, me, me.turret, me.stats.bulletSpeed, enemy);
    return {
      action: {
        ...drive,
        turretTurn: isTurretIdle ? 0 : aimTurret(wanted, me.turret),
        isFiring: isHeld && !isGuardHolding,
      },
      isGuardHolding,
    };
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
          decisionDecilesS: profile.manoeuvre.decisionDecilesS,
          stickDeciles: profile.manoeuvre.stickDeciles,
          courseDecilesDeg: profile.manoeuvre.courseDecilesDeg,
          reverseChance: calibration.reverseChance,
        },
        random,
      ),
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

  private exitPoint(grid: Grid, view: TwinView): Point {
    return this.parts.ambush?.exit(grid, view.enemy, view.tick) ?? view.enemy;
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
