import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TWIN_INFO, twinRoomCode } from '@tanks/shared/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeLogs, type GameSummary } from './index.js';
import {
  ANDROID_USER_AGENT,
  BOT,
  countdownFrames,
  deviceLine,
  fightFrame,
  HUMAN,
  LANE_Y,
  LogBuilder,
  MAC_USER_AGENT,
  makeLogDir,
  pose,
  removeLogDirs,
  roomLog,
  standingFrames,
  START_SEC,
  startDuel,
  type Frame,
  type Pose,
} from './logFixture.js';

const POSES: [Pose, Pose] = [pose(300, LANE_Y), pose(1300, LANE_Y, Math.PI, Math.PI)];
const SECONDS_PER_DAY = 86_400;
const TWO_MINUTES = 120;
const TEN_MINUTES = 600;

function run(dir: string): GameSummary[] {
  return analyzeLogs(dir, { outDir: join(dir, 'out') }).games.map((game) => game.summary);
}

// Короткая игра с клиентскими строками стороны человека: одна строка команды, чтобы сторона определилась.
function shortGame(room: string, names: [string, string], clientSides: readonly (0 | 1)[] = [HUMAN]): string {
  const builder = new LogBuilder(START_SEC).gameStart(room, names[0], names[1]);
  for (const side of clientSides) {
    builder.client(side, 'in seq=1 a=0.00,0.00,0.00,0');
  }
  return builder.roundStart(0, 0).frames(countdownFrames(POSES)).frames(standingFrames(POSES, 5)).text();
}

afterEach(() => {
  removeLogDirs();
});

describe('разбор журнала игры', () => {
  it('игра с двумя раундами: сторона человека по строкам клиента, карты, счёт, длительность, причина', () => {
    const builder = new LogBuilder(START_SEC).gameStart('abc123', 'Дима', 'Боб');
    builder.client(0, 'in seq=1 a=0.00,0.00,0.00,0');
    const kill: Frame = fightFrame(POSES, {
      events: [
        { kind: 'death', side: 1, x: 1300, y: LANE_Y },
        { kind: 'roundOver', side: 0 },
      ],
    });
    builder
      .roundStart(0, 0)
      .frames(countdownFrames(POSES, 2))
      .frames(standingFrames(POSES, 29))
      .frame(kill)
      .roundStart(1, 1, '1:0')
      .frames(countdownFrames(POSES, 2))
      .frames(standingFrames(POSES, 9))
      .frame(fightFrame(POSES, { events: [{ kind: 'roundOver', side: null }] }))
      .roundStart(2, 2, '1:0')
      .frames(countdownFrames(POSES, 2))
      .leave(1, 'Боб');
    const [game] = run(makeLogDir({ 'K7MF.log': builder.text() }));

    expect(game?.id).toBe('K7MF');
    expect(game?.human_side).toBe(0);
    expect(game?.human_name).toBe('Дима');
    expect(game?.bot_name).toBe('Боб');
    expect(game?.rounds.map((round) => round.map_name)).toEqual(['Полигон', 'Лабиринт', 'Крепости']);
    expect(game?.rounds.map((round) => round.reason)).toEqual(['kill', 'time', 'прервано']);
    expect(game?.rounds.map((round) => round.winner)).toEqual([0, null, null]);
    expect(game?.rounds.map((round) => round.human_won)).toEqual([true, false, null]);
    expect(game?.rounds[0]?.duration_s).toBe(1);
    expect(game?.rounds[1]?.score_before).toBe('1:0');
    expect(game?.score_bot_human).toEqual([1, 0]);
    expect(game?.wins_human).toBe(1);
    expect(game?.wins_bot).toBe(0);
    expect(game?.start_local).toBe('04:00');
    expect(game?.leave).toEqual({ side: 1, nick: 'Боб' });
  });

  it('уровень бота: из кода комнаты, по имени, неизвестен; сторона человека по имени при строках обеих сторон', () => {
    const dir = makeLogDir({
      'AAAA.log': shortGame('bot05xxxx', ['Ветеран', 'Дима']),
      'BBBB.log': shortGame('plain', ['Ветеран', 'Дима']),
      'CCCC.log': shortGame('plain2', ['Кто-то', 'Дима']),
      'DDDD.log': shortGame('plain3', ['Ветеран', 'Дима'], [0, 1]),
      'EEEE.log': shortGame('plain4', ['Петя', 'Дима'], [0, 1]),
      'FFFF.log': shortGame('plain5', ['Ветеран', 'Снайпер'], [0, 1]),
      'GGGG.log': shortGame(twinRoomCode('k7m2px'), [TWIN_INFO.name, 'Игрок'], [0, 1]),
    });
    const byId = new Map(run(dir).map((game) => [game.id, game]));

    expect(byId.get('AAAA')?.level).toBe(5);
    expect(byId.get('AAAA')?.level_source).toBe('код');
    expect(byId.get('BBBB')?.level).toBe(5);
    expect(byId.get('BBBB')?.level_source).toBe('имя');
    expect(byId.get('CCCC')?.level).toBeNull();
    expect(byId.get('CCCC')?.level_source).toBeNull();
    expect(byId.get('DDDD')?.human_side).toBe(1);
    expect(byId.get('EEEE')?.human_side).toBe(0);
    expect(byId.get('FFFF')?.human_side).toBe(1);
    expect(byId.get('GGGG')?.human_side).toBe(1);
    expect(byId.get('GGGG')?.bot_name).toBe(TWIN_INFO.name);
    expect(byId.get('GGGG')?.level).toBeNull();
  });

  it('ник с пробелами — целиком в начале игры и при уходе', () => {
    const text = new LogBuilder(START_SEC)
      .gameStart('bot05space', 'Ветеран', 'Мой ник')
      .client(HUMAN, 'in seq=1 a=0.00,0.00,0.00,0')
      .roundStart(0, 0)
      .frames(countdownFrames(POSES))
      .frames(standingFrames(POSES, 5))
      .leave(HUMAN, 'Мой ник')
      .text();
    const [game] = run(makeLogDir({ 'SPCE.log': text }));

    expect(game?.human_name).toBe('Мой ник');
    expect(game?.bot_name).toBe('Ветеран');
    expect(game?.leave).toEqual({ side: HUMAN, nick: 'Мой ник' });
  });

  it('ник с пробелами перед правилами со скольжением и догоном — целиком', () => {
    const text = new LogBuilder(START_SEC)
      .server('game start room=bot05lead p0=Ветеран p1=Мой ник rules=30 lead=2')
      .client(HUMAN, 'in seq=1 a=0.00,0.00,0.00,0')
      .roundStart(0, 0)
      .frames(countdownFrames(POSES))
      .frames(standingFrames(POSES, 5))
      .text();
    const [game] = run(makeLogDir({ 'LEAD.log': text }));

    expect(game?.human_name).toBe('Мой ник');
    expect(game?.bot_name).toBe('Ветеран');
  });

  it('ник с пробелами перед правилами со скольжением, догоном и снарядом со скоростью танка — целиком', () => {
    const text = new LogBuilder(START_SEC)
      .server('game start room=bot05inhr p0=Ветеран p1=Мой ник rules=30 lead=2 inherit=100')
      .client(HUMAN, 'in seq=1 a=0.00,0.00,0.00,0')
      .roundStart(0, 0)
      .frames(countdownFrames(POSES))
      .frames(standingFrames(POSES, 5))
      .text();
    const [game] = run(makeLogDir({ 'INHR.log': text }));

    expect(game?.human_name).toBe('Мой ник');
    expect(game?.bot_name).toBe('Ветеран');
  });

  it('устройство: из журнала комнаты не дальше пяти минут, иначе по нику, иначе неизвестно; переход через полночь', () => {
    const slots = `net room slots=Новобранец|Дима`;
    const dir = makeLogDir({
      'NEAR.log': shortGame('bot03dev1', ['Новобранец', 'Дима']),
      'room-bot03dev1.log': roomLog(START_SEC - TWO_MINUTES, HUMAN, [deviceLine(ANDROID_USER_AGENT, true)]),
      'NICK.log': shortGame('bot03dev2', ['Новобранец', 'Дима']),
      'room-bot03dev2.log': roomLog(START_SEC - TEN_MINUTES, HUMAN, [deviceLine(MAC_USER_AGENT, false), slots]),
      'NONE.log': shortGame('bot03dev3', ['Новобранец', 'Петя']),
      'room-bot03dev3.log': roomLog(START_SEC - TEN_MINUTES, HUMAN, [deviceLine(MAC_USER_AGENT, false)]),
      'WRAP.log': startDuel({ room: 'bot03dev4', startSec: 60 })
        .roundStart(0, 0)
        .frames(countdownFrames(POSES))
        .frames(standingFrames(POSES, 3))
        .text(),
      'room-bot03dev4.log': roomLog(SECONDS_PER_DAY - TWO_MINUTES, HUMAN, [deviceLine(ANDROID_USER_AGENT, true)]),
      'room-bot03dev5.log': roomLog(START_SEC, BOT, [slots, 'net welcome side=0', deviceLine(MAC_USER_AGENT, false)]),
    });
    const byId = new Map(run(dir).map((game) => [game.id, game]));

    expect(byId.get('NEAR')?.device).toBe('Android (2407FPN8EG), касание');
    expect(byId.get('NEAR')?.device_source).toBe('комната');
    expect(byId.get('NICK')?.device).toBe('Mac, Chrome, мышь');
    expect(byId.get('NICK')?.device_source).toBe('ник');
    expect(byId.get('NONE')?.device).toBe('? (ник Петя)');
    expect(byId.get('NONE')?.device_source).toBeNull();
    expect(byId.get('WRAP')?.device).toBe('Android (2407FPN8EG), касание');
    expect(byId.get('WRAP')?.device_source).toBe('комната');
  });

  it('подписи устройств: Android без касания, Mac с касанием, прочий user agent', () => {
    const files: Record<string, string> = {};
    const cases: [string, string, boolean][] = [
      ['DRA1', ANDROID_USER_AGENT, false],
      ['DRM1', MAC_USER_AGENT, true],
      ['DRX1', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox', false],
    ];
    for (const [id, userAgent, isTouch] of cases) {
      files[`${id}.log`] = shortGame(`room${id}`, ['Бот', 'Дима']);
      files[`room-room${id}.log`] = roomLog(START_SEC, HUMAN, [deviceLine(userAgent, isTouch)]);
    }
    const byId = new Map(run(makeLogDir(files)).map((game) => [game.id, game]));

    expect(byId.get('DRA1')?.device).toBe('Android');
    expect(byId.get('DRM1')?.device).toBe('Mac, Chrome');
    expect(byId.get('DRX1')?.device).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWeb');
  });

  it('пустая папка — ноль игр; файл без game start, server.log и битые строки пропускаются', () => {
    const empty = analyzeLogs(makeLogDir({}), { outDir: join(makeLogDir({}), 'out') });
    expect(empty.games).toEqual([]);
    expect(existsSync(empty.reportPath)).toBe(true);

    const broken = new LogBuilder(START_SEC).roundStart(0, 0).frames(standingFrames(POSES, 3)).text();
    const good = startDuel()
      .roundStart(0, 0)
      .frames(countdownFrames(POSES))
      .server('tick rt=3 ph=f late=0.0 a0=0.00,0.00,0.00,0 ack0=1 in0=1 sil0=0 p0=300.0,100.0,0.00,0.00 a1=broken')
      .server('ev kind=bump')
      .server('это не строка журнала')
      .frames(standingFrames(POSES, 4))
      .server('ev kind=bump side=1')
      .server('input limit side=1 seq=9')
      .server('input overflow side=1 seq=10')
      .server('input backlog side=1 seq=11')
      .server('input owed side=1 seq=12')
      .server('input stale seq=9 last=10')
      .text();
    const dir = makeLogDir({ 'BRKN.log': broken, 'GOOD.log': good, 'server.log': 'loop late=40 dur=6\n' });
    const result = analyzeLogs(dir, { outDir: join(dir, 'out') });

    expect(result.games.map((game) => game.summary.id)).toEqual(['GOOD']);
    expect(result.skipped).toEqual(['BRKN']);
    expect(result.games[0]?.summary.movement.fight_ticks).toBe(4);
    expect(result.games[0]?.summary.shooting_human.bumps).toBe(1);
    expect(result.games[0]?.summary.movement.dropped_inputs).toBe(3);
  });

  it('журнал со строками клиента `in skip` — игра разбирается, пропуски в итогах и в отчёте', () => {
    const game = startDuel()
      .roundStart(0, 0)
      .frames(countdownFrames(POSES))
      .client(HUMAN, 'in seq=1 a=0.00,0.00,0.00,0')
      .client(HUMAN, 'in skip next=2')
      .client(HUMAN, 'in skip next=2')
      .frames(standingFrames(POSES, 4))
      .text();
    const dir = makeLogDir({ 'SKIP.log': game });
    const result = analyzeLogs(dir, { outDir: join(dir, 'out') });

    expect(result.skipped).toEqual([]);
    expect(result.games[0]?.summary.client_inputs).toMatchObject({ inputs: 1, skipped_inputs: 2 });
    expect(readFileSync(result.reportPath, 'utf8')).toContain('Пропущенных шагов ввода');
  });

  it('--only ограничивает разбор названными играми; выход по умолчанию — ../analysis', () => {
    const dir = makeLogDir(
      { 'ONE1.log': shortGame('r1', ['Бот', 'Дима']), 'TWO2.log': shortGame('r2', ['Бот', 'Дима']) },
      'logs',
    );
    const result = analyzeLogs(dir, { only: ['TWO2'] });

    expect(result.games.map((game) => game.summary.id)).toEqual(['TWO2']);
    expect(result.jsonPath).toBe(join(dir, '..', 'analysis', 'games.json'));
    const written = JSON.parse(readFileSync(result.jsonPath, 'utf8')) as GameSummary[];
    expect(written.map((game) => game.id)).toEqual(['TWO2']);
  });
});
