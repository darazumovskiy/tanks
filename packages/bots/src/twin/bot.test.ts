import { createRandom, DEFAULT_STATS, IDLE_ACTION, nextRandom, type Action, type BotView } from '@tanks/shared/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotRound } from '../brain.js';
import { TwinBot } from './bot.js';
import { TwinBrain, type TwinView } from './brain.js';
import { byBand, craftView, profileWith, type ViewSpec } from './fixture.js';
import { parseTwinRival, type TwinRival } from './profile.js';
import { TwinRoundState } from './roundState.js';

const STATS = { armor: 0, engine: 3, gun: 4, reload: 3 };
const ERROR_DECILES = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
const FIGHT_TICKS = 90;
const ROUND: BotRound = { roundIndex: 2, mapIndex: 3, score: [1, 1] };
const SEED_RANGE = 2 ** 32;
const START: ViewSpec = { mapIndex: 3, side: 0, me: { x: 200, y: 450 }, enemy: { x: 1000, y: 450 } };

function rivalWith(overrides: Partial<TwinRival> = {}): TwinRival {
  return {
    profile: profileWith({
      channel: { uplinkTicks: 1, downlinkTicks: 1, interpolationTicks: 2 },
      hand: { errorDecilesDeg: byBand(ERROR_DECILES), leadShare: 0 },
    }),
    stats: STATS,
    hasRicochetGuard: true,
    opponentLevel: 8,
    ...overrides,
  };
}

function randomOf(seed: number): () => number {
  const random = createRandom(seed);
  return () => nextRandom(random);
}

function viewAt(tick: number, overrides: Partial<ViewSpec> = {}): BotView {
  return craftView({ ...START, tick, ...overrides });
}

function fight(bot: TwinBot): Action[] {
  const actions: Action[] = [];
  for (let tick = 1; tick <= FIGHT_TICKS; tick++) {
    actions.push(bot.tick(viewAt(tick)));
  }
  return actions;
}

function startedBot(rival: TwinRival, seed: number): TwinBot {
  const bot = new TwinBot(rival, randomOf(seed));
  bot.init(viewAt(0), ROUND);
  return bot;
}

describe('двойник как мозг бота', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('характеристики и предохранитель — из профиля соперника; задержка реакции — весь канал игрока', () => {
    const bot = new TwinBot(rivalWith(), randomOf(1));

    expect(bot.stats).toEqual(STATS);
    expect(bot.reactionTicks).toBe(4);
  });

  it('на отсчёте — пустые команды, мозг не вызван: бой тот же, что у двойника, не видевшего отсчёта', () => {
    const watched = startedBot(rivalWith(), 5);
    for (let tick = 0; tick < 30; tick++) {
      expect(watched.tick(viewAt(0))).toEqual(IDLE_ACTION);
    }

    expect(fight(watched)).toEqual(fight(startedBot(rivalWith(), 5)));
  });

  it('команды — те же, что у мозга двойника напрямую с обстановкой раунда и сидом из случайности бота', () => {
    const rival = rivalWith();
    const random = randomOf(7);
    const brain = new TwinBrain(rival.profile);
    brain.init({
      level: 8,
      roundIndex: ROUND.roundIndex,
      lossStreak: 0,
      mapIndex: ROUND.mapIndex,
      hasRicochetGuard: true,
      seed: Math.floor(random() * SEED_RANGE),
    });
    const direct: Action[] = [];
    for (let tick = 1; tick <= FIGHT_TICKS; tick++) {
      direct.push(brain.tick({ ...viewAt(tick), hits: [] }).action);
    }

    expect(fight(startedBot(rival, 7))).toEqual(direct);
  });

  it('одна случайность — одинаковые команды, другая — другие; сид каждого раунда свой', () => {
    const bot = startedBot(rivalWith(), 3);
    const first = fight(bot);
    bot.init(viewAt(0), { ...ROUND, roundIndex: 3 });

    expect(fight(startedBot(rivalWith(), 3))).toEqual(first);
    expect(fight(startedBot(rivalWith(), 4))).not.toEqual(first);
    expect(fight(bot)).not.toEqual(first);
  });

  it('здоровье упало или выросло между видами — урон или аптечка этой стороне в попаданиях вида мозга', () => {
    const seen: TwinView[] = [];
    const tick = vi.spyOn(TwinBrain.prototype, 'tick');
    tick.mockImplementation((view) => {
      seen.push({ ...view, hits: [...view.hits] });
      return { action: { ...IDLE_ACTION }, isGuardHolding: false };
    });
    const bot = startedBot(rivalWith(), 1);
    const withHp = (at: number, mine: number, enemy: number): BotView => {
      const view = viewAt(at);
      return { ...view, me: { ...view.me, hp: mine }, enemy: { ...view.enemy, hp: enemy } };
    };
    bot.tick(withHp(1, 100, 100));
    bot.tick(withHp(2, 77, 100));
    bot.tick(withHp(3, 77, 85));
    bot.tick(withHp(4, 97, 85));

    expect(seen.at(-1)?.hits).toEqual([
      { tick: 2, side: 0, value: 23, isPickup: false },
      { tick: 3, side: 1, value: 15, isPickup: false },
      { tick: 4, side: 0, value: 20, isPickup: true },
    ]);
    bot.init(viewAt(0), ROUND);
    bot.tick(withHp(1, 50, 50));
    expect(seen.at(-1)?.hits).toEqual([]);
  });

  it('двойник на стороне 1 — здоровье своей стороны и противника по своим сторонам', () => {
    const seen: TwinView[] = [];
    vi.spyOn(TwinBrain.prototype, 'tick').mockImplementation((view) => {
      seen.push({ ...view, hits: [...view.hits] });
      return { action: { ...IDLE_ACTION }, isGuardHolding: false };
    });
    const bot = new TwinBot(rivalWith(), randomOf(1));
    const side1 = (at: number, mine: number): BotView => {
      const view = viewAt(at, { side: 1 });
      return { ...view, me: { ...view.me, hp: mine } };
    };
    bot.init(side1(0, 100), ROUND);
    bot.tick(side1(1, 100));
    bot.tick(side1(2, 90));

    expect(seen.at(-1)?.hits).toEqual([{ tick: 2, side: 1, value: 10, isPickup: false }]);
  });
});

describe('обстановка раунда двойника', () => {
  it('номер раунда, карта, уровень соперника, предохранитель и сид — как пришли; проигрыши подряд — по счёту', () => {
    const state = new TwinRoundState(9, false);
    const situations = [
      state.next({ roundIndex: 0, mapIndex: 0, score: [0, 0] }, 0, 11),
      state.next({ roundIndex: 1, mapIndex: 1, score: [0, 1] }, 0, 12),
      state.next({ roundIndex: 2, mapIndex: 2, score: [0, 2] }, 0, 13),
      state.next({ roundIndex: 3, mapIndex: 3, score: [1, 2] }, 0, 14),
    ];

    expect(situations.map((situation) => situation.lossStreak)).toEqual([0, 1, 2, 0]);
    expect(situations[1]).toEqual({
      level: 9,
      roundIndex: 1,
      lossStreak: 1,
      mapIndex: 1,
      hasRicochetGuard: false,
      seed: 12,
    });
    expect(new TwinRoundState(9, false).next({ roundIndex: 1, mapIndex: 1, score: [1, 0] }, 1, 0).lossStreak).toBe(0);
  });
});

describe('профиль соперника', () => {
  it('из текста файла — тот же объект', () => {
    const rival = rivalWith({ stats: { ...DEFAULT_STATS } });

    expect(parseTwinRival(JSON.stringify(rival))).toEqual(rival);
  });
});
