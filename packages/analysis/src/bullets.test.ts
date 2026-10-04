import { BULLET_RADIUS } from '@tanks/shared/engine';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeLogs, type GameSummary } from './index.js';
import {
  BOT,
  bulletTravel,
  countdownFrames,
  DEFAULT_DAMAGE,
  fightFrame,
  HUMAN,
  LANE_Y,
  makeLogDir,
  muzzleOf,
  pose,
  removeLogDirs,
  startDuel,
  type EventSpec,
  type LogBuilder,
  type Pose,
} from './logFixture.js';

const ZONE_TICK_DAMAGE = 0.7;
const LIFETIME_TICKS = 140;

function analyzeSingle(builder: LogBuilder): GameSummary {
  const dir = makeLogDir({ 'BULL.log': builder.text() });
  const [game] = analyzeLogs(dir, { outDir: join(dir, 'out') }).games;
  if (game === undefined) {
    throw new Error('игра не разобрана');
  }
  return game.summary;
}

function shotEvent(side: 0 | 1, tank: Pose): EventSpec {
  const muzzle = muzzleOf(tank);
  return { kind: 'shot', side, x: muzzle.x, y: muzzle.y, v: tank.turret };
}

// Выстрел на кадре 5 боя, дальнейшие события — по номеру тика относительно выстрела.
function duelWithEvents(poses: [Pose, Pose], eventsAt: Map<number, EventSpec[]>, length: number): LogBuilder {
  const builder = startDuel().roundStart(0, 0).frames(countdownFrames(poses));
  for (let i = 0; i < length; i++) {
    builder.frame(fightFrame(poses, { events: eventsAt.get(i) ?? [] }));
  }
  return builder;
}

afterEach(() => {
  removeLogDirs();
});

describe('прослеживание снарядов', () => {
  it('выстрел и попадание на прямой: снаряд завершён попаданием, урон засчитан стрелку', () => {
    const human = pose(200, LANE_Y);
    const bot = pose(800, LANE_Y, Math.PI, Math.PI);
    const muzzle = muzzleOf(human);
    const flightTicks = 29;
    const hitX = muzzle.x + bulletTravel(flightTicks + 1);
    const events = new Map<number, EventSpec[]>([
      [5, [shotEvent(HUMAN, human)]],
      [5 + flightTicks, [{ kind: 'hit', side: BOT, x: hitX, y: LANE_Y, v: DEFAULT_DAMAGE }]],
    ]);
    const game = analyzeSingle(duelWithEvents([bot, human], events, 60));

    expect(game.shooting_human).toMatchObject({ shots: 1, hits: 1, damage_dealt: DEFAULT_DAMAGE, ricochet_hits: 0 });
    expect(game.shooting_bot.damage_taken).toBe(DEFAULT_DAMAGE);
    expect(game.hit_pct_human).toBe(100);
    expect(game.rounds[0]?.human_hits).toBe(1);
    expect(game.rounds[0]?.human_first_hit_s).toBe(1.1);
    expect(game.unknown_hits).toBe(0);
    expect(game.in_flight_bullets).toBe(0);
  });

  it('выстрел в край поля, рикошет, попадание в стрелявшего — самопопадание', () => {
    const human = pose(100, LANE_Y, 0, Math.PI);
    const bot = pose(1400, LANE_Y, Math.PI, Math.PI);
    const events = new Map<number, EventSpec[]>([
      [5, [shotEvent(HUMAN, human)]],
      [8, [{ kind: 'ricochet', side: HUMAN, x: BULLET_RADIUS, y: LANE_Y }]],
      [12, [{ kind: 'hit', side: HUMAN, x: BULLET_RADIUS + bulletTravel(4), y: LANE_Y, v: DEFAULT_DAMAGE }]],
    ]);
    const game = analyzeSingle(duelWithEvents([bot, human], events, 40));

    expect(game.shooting_human).toMatchObject({ shots: 1, hits: 0, self_hits: 1, self_damage: DEFAULT_DAMAGE });
    expect(game.shooting_human.damage_taken).toBe(DEFAULT_DAMAGE);
    expect(game.self_hits.count).toBe(1);
    expect(game.unknown_hits).toBe(0);
  });

  it('рикошет от верхнего края и попадание в противника: направление отражено по нормали, попадание рикошетное', () => {
    const turret = -0.79;
    const human = pose(200, LANE_Y, 0, turret);
    const muzzle = muzzleOf(human);
    const dx = Math.cos(turret);
    const dy = Math.sin(turret);
    const toWall = (muzzle.y - BULLET_RADIUS) / -dy;
    const wallX = muzzle.x + dx * toWall;
    const afterBounce = bulletTravel(7);
    const hit = { x: wallX + dx * afterBounce, y: BULLET_RADIUS - dy * afterBounce };
    const bot = pose(hit.x + 4, hit.y + 4, Math.PI, Math.PI);
    const events = new Map<number, EventSpec[]>([
      [5, [shotEvent(HUMAN, human)]],
      [10, [{ kind: 'ricochet', side: HUMAN, x: wallX, y: BULLET_RADIUS }]],
      [17, [{ kind: 'hit', side: BOT, x: hit.x, y: hit.y, v: DEFAULT_DAMAGE }]],
    ]);
    const game = analyzeSingle(duelWithEvents([bot, human], events, 40));

    expect(game.shooting_human).toMatchObject({ shots: 1, hits: 1, ricochet_hits: 1, self_hits: 0 });
    expect(game.unknown_hits).toBe(0);
  });

  it('попадание без снаряда после начала зоны с уроном зоны за тик — зона; до зоны — неизвестно', () => {
    const human = pose(800, 450);
    const bot = pose(300, LANE_Y);
    const events = new Map<number, EventSpec[]>([
      [3, [{ kind: 'hit', side: HUMAN, x: 800, y: 450, v: DEFAULT_DAMAGE }]],
      [10, [{ kind: 'zoneStart', side: null }]],
      [11, [{ kind: 'hit', side: HUMAN, x: 800, y: 450, v: ZONE_TICK_DAMAGE }]],
      [12, [{ kind: 'hit', side: HUMAN, x: 800, y: 450, v: ZONE_TICK_DAMAGE }]],
    ]);
    const game = analyzeSingle(duelWithEvents([bot, human], events, 20));

    expect(game.unknown_hits).toBe(1);
    expect(game.shooting_human.zone_damage).toBeCloseTo(2 * ZONE_TICK_DAMAGE, 6);
    expect(game.shooting_human.damage_taken).toBeCloseTo(DEFAULT_DAMAGE + 2 * ZONE_TICK_DAMAGE, 6);
  });

  it('столкновение двух снарядов: оба завершены как сбитые', () => {
    const human = pose(200, LANE_Y);
    const bot = pose(800, LANE_Y, Math.PI, Math.PI);
    const meetTicks = 14;
    const events = new Map<number, EventSpec[]>([
      [5, [shotEvent(HUMAN, human), shotEvent(BOT, bot)]],
      [5 + meetTicks, [{ kind: 'clash', side: null, x: 500, y: LANE_Y }]],
    ]);
    const game = analyzeSingle(duelWithEvents([bot, human], events, 40));

    expect(game.shooting_human.clashed).toBe(1);
    expect(game.shooting_bot.clashed).toBe(1);
    expect(game.in_flight_bullets).toBe(0);
  });

  it('снаряд старше времени жизни без исхода — потерян; без событий после выстрела — в полёте', () => {
    const human = pose(200, LANE_Y);
    const bot = pose(800, LANE_Y, Math.PI, Math.PI);
    const events = new Map<number, EventSpec[]>([
      [5, [shotEvent(HUMAN, human)]],
      [5 + LIFETIME_TICKS, [{ kind: 'bump', side: BOT, x: 800, y: LANE_Y }, shotEvent(HUMAN, human)]],
    ]);
    const game = analyzeSingle(duelWithEvents([bot, human], events, 5 + LIFETIME_TICKS + 2));

    expect(game.lost_bullets).toBe(1);
    expect(game.in_flight_bullets).toBe(1);
    expect(game.shooting_bot.bumps).toBe(1);
  });

  it('удар о стену и затухание закрывают снаряд владельца; смерть и аптечка считаются по сторонам', () => {
    const human = pose(200, LANE_Y);
    const bot = pose(800, LANE_Y, Math.PI, Math.PI);
    const humanMuzzle = muzzleOf(human);
    const botMuzzle = muzzleOf(bot);
    const events = new Map<number, EventSpec[]>([
      [5, [shotEvent(HUMAN, human), shotEvent(BOT, bot)]],
      [
        15,
        [
          { kind: 'impact', side: HUMAN, x: humanMuzzle.x + bulletTravel(11), y: LANE_Y },
          { kind: 'fizzle', side: BOT, x: botMuzzle.x - bulletTravel(11), y: LANE_Y },
        ],
      ],
      [
        16,
        [
          { kind: 'impact', side: HUMAN, x: 1500, y: 800 },
          { kind: 'ricochet', side: BOT, x: 1500, y: 800 },
        ],
      ],
      [20, [{ kind: 'pickup', side: HUMAN, x: 800, y: 130, v: 50 }]],
      [
        25,
        [
          { kind: 'death', side: BOT, x: 800, y: LANE_Y },
          { kind: 'roundOver', side: HUMAN },
        ],
      ],
    ]);
    const game = analyzeSingle(duelWithEvents([bot, human], events, 30));

    expect(game.shooting_human.kits).toBe(1);
    expect(game.shooting_bot.deaths).toBe(1);
    expect(game.in_flight_bullets).toBe(0);
    expect(game.lost_bullets).toBe(0);
    expect(game.rounds[0]?.reason).toBe('kill');
    expect(game.rounds[0]?.winner).toBe(HUMAN);
  });
});
