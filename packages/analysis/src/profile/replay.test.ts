import { BULLET_RADIUS, MUZZLE_OFFSET, TANK_RADIUS, TICK_RATE, ARENA } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import {
  action,
  countdownFrames,
  fightFrame,
  IDLE,
  LogBuilder,
  pose,
  profileRoundsOf,
  roundOver,
  shotEvent,
  type EventSpec,
  type Pose,
} from '../logFixture.js';
import { profileMetrics } from './index.js';

const HUMAN_SIDE = 0;
const BOT_SIDE = 1;
const OPEN_Y = 100;
const HUMAN_POSE = pose(600, OPEN_Y);
const BOT_POSE = pose(600, 700, Math.PI / 2, Math.PI / 2);
// Бот стреляет вниз в край поля: рикошет через 8 тиков — по нему скорость бота восстанавливает анализатор.
const BOT_SHOTS = 3;
const BOT_TOUCH_TICKS = 8;
const FITTED_SPEED = 650;
const SHOTS = 10;
const SHOT_SPACING = 100;
const SUBSTEP_LENGTH = 6;
const SELF_DAMAGE = 38;
const WRONG_EVENT_ANGLE = 1;

// Подшаги движка: тик касания края поля и тик возврата снаряда в стрелявшего после рикошета.
function flight(speed: number): { touch: number; back: number } {
  const perTick = speed / TICK_RATE;
  const substeps = Math.ceil(perTick / SUBSTEP_LENGTH);
  const substep = perTick / substeps;
  const muzzle = HUMAN_POSE.x + MUZZLE_OFFSET;
  const edge = ARENA.width - BULLET_RADIUS;
  const toEdge = Math.floor((edge - muzzle) / substep) + 1;
  const back = Math.floor((edge - (HUMAN_POSE.x + TANK_RADIUS + BULLET_RADIUS)) / substep) + 1;
  return { touch: Math.floor((toEdge - 1) / substeps), back: Math.floor((toEdge + back - 1) / substeps) };
}

// Человек на стороне 0 стреляет вправо в край поля; рикошет пишется в тик касания при скорости 650,
// возврат в себя — попадание в журнале в тик возврата. Угол в событии выстрела неверный: по нему анализатор
// скорость не восстановит, и остаётся только подбор по полёту от точки дула.
function ricochetRound(builder: LogBuilder, idx: number, shots: number): void {
  const { touch, back } = flight(FITTED_SPEED);
  const events = new Map<number, EventSpec[]>();
  for (let shot = 0; shot < shots; shot++) {
    const at = shot * SHOT_SPACING;
    events.set(at, [{ ...shotEvent(HUMAN_SIDE, HUMAN_POSE), v: WRONG_EVENT_ANGLE }]);
    events.set(at + touch, [{ kind: 'ricochet', side: HUMAN_SIDE, x: ARENA.width - BULLET_RADIUS, y: OPEN_Y }]);
    events.set(at + back, [{ kind: 'hit', side: HUMAN_SIDE, x: HUMAN_POSE.x, y: OPEN_Y, v: SELF_DAMAGE }]);
  }
  for (let shot = 0; shot < BOT_SHOTS; shot++) {
    const at = shot * SHOT_SPACING + SHOT_SPACING / 2;
    events.set(at, [shotEvent(BOT_SIDE, BOT_POSE)]);
    events.set(at + BOT_TOUCH_TICKS, [
      { kind: 'ricochet', side: BOT_SIDE, x: BOT_POSE.x, y: ARENA.height - BULLET_RADIUS },
    ]);
  }
  builder.roundStart(idx, 0).frames(countdownFrames([HUMAN_POSE, BOT_POSE]));
  const ticks = shots * SHOT_SPACING;
  for (let tick = 0; tick < ticks; tick++) {
    const tickEvents = events.get(tick) ?? [];
    builder.frame(
      fightFrame([HUMAN_POSE, BOT_POSE], {
        actions: [action(0, 0, 1), IDLE],
        events: tick === ticks - 1 ? [...tickEvents, roundOver(BOT_SIDE)] : tickEvents,
      }),
    );
  }
}

function ricochetLog(shotsByRound: readonly number[]): string {
  const builder = new LogBuilder(3600).gameStart('bot05side', 'Дима', 'Ветеран');
  builder.client(HUMAN_SIDE, 'net roundstart game=TEST idx=0 map=0 score=0:0');
  shotsByRound.forEach((shots, idx) => {
    ricochetRound(builder, idx, shots);
  });
  return builder.text();
}

interface DuelTick {
  human: Pose;
  bot: Pose;
  events: EventSpec[];
}

// Человек на стороне 0 выигрывает раунд: раунд входит в выборку при любом бое.
function duelLog(ticks: number, tickAt: (tick: number) => DuelTick): string {
  const first = tickAt(0);
  const builder = new LogBuilder(3600).gameStart('bot05duel', 'Дима', 'Ветеран');
  builder.client(HUMAN_SIDE, 'net roundstart game=TEST idx=0 map=0 score=0:0');
  builder.roundStart(0, 0).frames(countdownFrames([first.human, first.bot]));
  for (let tick = 0; tick < ticks; tick++) {
    const spec = tickAt(tick);
    builder.frame(
      fightFrame([spec.human, spec.bot], {
        actions: [action(-1), IDLE],
        events: tick === ticks - 1 ? [...spec.events, roundOver(HUMAN_SIDE)] : spec.events,
      }),
    );
  }
  return builder.text();
}

describe('снаряды движком по позам журнала', () => {
  it('скорость снаряда — по совпадению первого касания стены с рикошетом; попадание засчитано по паре в журнале', () => {
    expect(flight(FITTED_SPEED).back).not.toBe(flight(550).back);
    const metrics = profileMetrics(profileRoundsOf({ 'SIDE.log': ricochetLog([SHOTS]) }));

    expect(metrics.fire.selfHits).toMatchObject({ part: SHOTS, total: SHOTS });
    expect(metrics.fire.hits).toMatchObject({ part: 0, total: SHOTS });
    expect(metrics.dodge.botShots).toBe(BOT_SHOTS);
    expect(metrics.dodge.threatsOfBotShots.part).toBe(0);
  });

  it('скорость подбирается по первым 40 выстрелам и через границу раундов', () => {
    const shotsByRound = [45, 5];
    const metrics = profileMetrics(profileRoundsOf({ 'MANY.log': ricochetLog(shotsByRound) }));

    expect(metrics.fire.selfHits).toMatchObject({ part: 50, total: 50 });
  });

  it('дуло в стене: снаряд гибнет, не вылетев, — ни попадания, ни угрозы', () => {
    // Стена Полигона x 330–374, y 160–360: дула обоих танков на полосе y = 260 внутри неё.
    const human = pose(310, 260);
    const bot = pose(400, 260, Math.PI, Math.PI);
    const log = duelLog(200, (tick) => {
      const events: EventSpec[] = [];
      if (tick === 0 || tick === 40) {
        events.push(shotEvent(HUMAN_SIDE, human));
      }
      if (tick === 20) {
        events.push(shotEvent(BOT_SIDE, bot));
      }
      return { human, bot, events };
    });
    const metrics = profileMetrics(profileRoundsOf({ 'WALL.log': log }));

    expect(metrics.fire.hits).toMatchObject({ part: 0, total: 2 });
    expect(metrics.dodge.threatsOfBotShots).toMatchObject({ part: 0, total: 1 });
  });

  it('путь для прямой езды упирается в край поля: танк стоит у края, и снаряд бота его находит', () => {
    const shotTick = 20;
    const bot = pose(700, OPEN_Y, Math.PI, Math.PI);
    const humanAt = (tick: number): Pose => pose(120 - 4 * Math.min(tick, shotTick), OPEN_Y, Math.PI, 0);
    const shotsAt = new Map<number, EventSpec[]>([
      [0, [shotEvent(HUMAN_SIDE, humanAt(0))]],
      [shotTick, [shotEvent(BOT_SIDE, bot)]],
    ]);
    const log = duelLog(200, (tick) => ({ human: humanAt(tick), bot, events: shotsAt.get(tick) ?? [] }));
    const dodge = profileMetrics(profileRoundsOf({ 'EDGE.log': log })).dodge;

    expect(dodge.threatsOfBotShots).toMatchObject({ part: 1, total: 1 });
  });
});
