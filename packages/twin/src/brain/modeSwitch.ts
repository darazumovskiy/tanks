import { botClassOf, hasCoverWithin, type ModeFeatures } from '@tanks/analysis';
import { TICK_RATE, type MapDef, type Side } from '@tanks/shared/engine';
import type { BotLevel } from '@tanks/shared/protocol';

// Попадание или аптечка, как их видит двойник по снимкам: тик раунда, сторона, величина.
export interface HitRecord {
  tick: number;
  side: Side;
  value: number;
  isPickup: boolean;
}

// Что двойник знает о матче, как Дима: уровень соперника, номер раунда, проигрыши подряд в этой игре.
export interface MatchState {
  level: BotLevel;
  roundIndex: number;
  lossStreak: number;
}

export interface Perception {
  map: MapDef;
  me: { x: number; y: number; maxHp: number };
  enemy: { x: number; y: number };
  side: Side;
  tick: number;
  fightTick: number;
  hasSight: boolean;
  distance: number;
  hits: readonly HitRecord[];
}

const RECENT_DAMAGE_TICKS = 5 * TICK_RATE;

function damageTo(hits: readonly HitRecord[], victim: Side, isInWindow: (tick: number) => boolean): number {
  return hits
    .filter((hit) => !hit.isPickup && hit.side === victim && isInWindow(hit.tick))
    .reduce((total, hit) => total + hit.value, 0);
}

// Проигрыши подряд по счёту на старте раунда: счёт противника вырос — серия длиннее; ничья и победа обрывают её.
export function lossStreakAfter(
  streak: number,
  previous: readonly [number, number] | null,
  score: readonly [number, number],
  enemySide: Side,
): number {
  return previous !== null && score[enemySide] > previous[enemySide] ? streak + 1 : 0;
}

// Признаки выбора режима — те же, что модуль метрик снимает с журнала, но по восприятию двойника.
export function modeFeatures(perception: Perception, match: MatchState): ModeFeatures {
  const { hits, tick, side, me } = perception;
  const enemySide: Side = side === 0 ? 1 : 0;
  const isBefore = (hitTick: number): boolean => hitTick < tick;
  const taken = damageTo(hits, side, isBefore);
  const recent = damageTo(hits, side, (hitTick) => tick - RECENT_DAMAGE_TICKS <= hitTick && hitTick < tick);
  const dealt = damageTo(hits, enemySide, isBefore);
  const healed = hits
    .filter((hit) => hit.isPickup && hit.side === side && hit.tick < tick)
    .reduce((total, hit) => total + hit.value, 0);
  return {
    botClass: botClassOf(match.level),
    lossStreak: match.lossStreak,
    roundIndex: match.roundIndex,
    recentDamageShare: recent / me.maxHp,
    healthShare: Math.min(1, Math.max(0, (me.maxHp - taken + healed) / me.maxHp)),
    exchangeShare: (dealt - taken) / me.maxHp,
    hasCover: hasCoverWithin(perception.map, me, perception.enemy),
    fightSeconds: perception.fightTick / TICK_RATE,
    hasSight: perception.hasSight,
    distance: perception.distance,
  };
}
