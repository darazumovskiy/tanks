import {
  action,
  BOT,
  countdownFrames,
  fightFrame,
  HUMAN,
  IDLE,
  LogBuilder,
  makeLogDir,
  pose,
  removeLogDirs,
  roundOver,
  shotEvent,
  type Pose,
} from '@tanks/analysis/logFixture';
import { TICK_RATE } from '@tanks/shared/engine';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, USAGE } from './cli.js';
import { PROFILE_WINDOWS, twinProfile, type TwinCalibration, type TwinReference } from './profile.js';

const OPEN_Y = 100;
const BOT_POSE = pose(800, OPEN_Y, Math.PI, Math.PI);
const FIGHT_TICKS = 400;
const RTT_MS = 66;
const STAND_FROM = 200;
const STAND_TO = 260;
const SHOT_EVERY = 25;
// Игры из списков выборки телефона: C2 — главное окно, A — до перенастройки, DF9T — против старой лестницы.
const C2_GAME = 'JUBW';
const C2_WEAK_GAME = 'MFAK';
const OLD_LADDER_GAME = 'DF9T';
const PHONE_GAMES = PROFILE_WINDOWS.phone.periods.flatMap((period) => period.games);

// Бой человека с телефона против уровня 8: стартовая пауза огня, езда с поворотами, позиция с огнём,
// короткая и длинная паузы, выстрелы по стоящему боту, строки настроек и задержки сети.
function phoneGameLog(nick: string, room: string): string {
  const builder = new LogBuilder(3600).server(`game start room=${room} p0=Охотник p1=${nick} rules=30`);
  builder.client(HUMAN, 'net roundstart game=TWIN idx=0 map=0 score=0:0');
  builder.client(HUMAN, 'flags autoaim=0 guard=1 aimline=1');
  builder.client(HUMAN, 'settings {"hasRicochetGuard":true,"pivotThrottle":0.6}');
  builder.roundStart(0, 0).frames(countdownFrames([BOT_POSE, pose(200, OPEN_Y)]));
  let x = 200;
  const isFiring = (tick: number): boolean =>
    tick >= 30 && !(tick >= 100 && tick < 110) && !(tick >= 300 && tick < 370);
  for (let tick = 0; tick < FIGHT_TICKS; tick++) {
    const isStanding = tick >= STAND_FROM && tick < STAND_TO;
    const isTurning = Math.floor(tick / 10) % 2 === 1;
    if (!isStanding) {
      x += Math.cos(tick / 40) * 3;
    }
    const human: Pose = pose(x, OPEN_Y, 0, 0.05);
    const humanAction = isStanding
      ? action(0, 0, 0.2, isFiring(tick))
      : action(0.8, isTurning ? 0.6 : 0, 0, isFiring(tick));
    const events = isFiring(tick) && tick % SHOT_EVERY === 0 ? [shotEvent(HUMAN, human)] : [];
    builder.frame(
      fightFrame([BOT_POSE, human], {
        actions: [IDLE, humanAction],
        events: tick === FIGHT_TICKS - 1 ? [...events, roundOver(BOT)] : events,
      }),
    );
    if (tick % TICK_RATE === 0) {
      builder.client(HUMAN, `sec fps=60 worst=20 rtt=${String(RTT_MS)} pend=1`);
    }
  }
  return builder.text();
}

function runReference(
  files: Record<string, string>,
  profile = 'phone',
): { code: number; lines: string[]; dir: string } {
  const logDir = makeLogDir(files);
  const dir = makeLogDir({});
  const lines: string[] = [];
  const code = runCli(['reference', logDir, '--profile', profile], (line) => lines.push(line), dir);
  return { code, lines, dir };
}

afterEach(() => {
  removeLogDirs();
});

describe('команда reference', () => {
  it('справка по журналам телефона: игры из списков выборки, числа раундов по правилам, победы и файл phone.json', () => {
    const { code, lines, dir } = runReference({
      [`${C2_GAME}.log`]: phoneGameLog('Mob', 'bot08twin'),
      [`${C2_WEAK_GAME}.log`]: phoneGameLog('Mob', 'bot01weak'),
      [`${OLD_LADDER_GAME}.log`]: phoneGameLog('Mob', 'bot03hunter'),
      'TWN3.log': phoneGameLog('dd', 'bot08pc'),
      'TWN4.log': phoneGameLog('Mob', 'bot08later'),
    });
    const path = join(dir, 'phone.json');
    const reference = JSON.parse(readFileSync(path, 'utf8')) as TwinReference;
    const warnings = lines.filter((line) => line.startsWith('Предупреждение'));

    expect(code).toBe(0);
    expect(warnings).toHaveLength(PHONE_GAMES.length - 3);
    expect(warnings).toContain('Предупреждение: игры 8A29 из выборки нет в папке журналов');
    expect(lines).toContain('Раундов Mob: 3, по правилам выборки — 1');
    expect(lines).toContain('  исключено (weakBot): 1');
    expect(lines).toContain('  исключено (oldLadder): 1');
    expect(lines).toContain('Победы в главном окне: 0 из 1, интервал 0–79 %');
    expect(lines.at(-1)).toBe(path);
    expect(reference).toMatchObject({
      profile: 'phone',
      nick: 'Mob',
      rounds: { total: 3, selected: 1, mainWindow: 1, excluded: { oldLadder: [`${OLD_LADDER_GAME}#0`] } },
    });
    expect(reference.main.rounds).toBe(1);
    expect(reference.movement.ticks).toBe(FIGHT_TICKS);
    expect(reference.main.fire.startPauseS?.median).toBeCloseTo(1, 4);
  });

  it('без раундов после выборки — ошибка с кодом 2 и числами по правилам; файл не пишется', () => {
    const { code, lines, dir } = runReference({ [`${C2_WEAK_GAME}.log`]: phoneGameLog('Mob', 'bot01weak') });

    expect(code).toBe(2);
    expect(lines).toContain('Раундов Mob: 1, по правилам выборки — 0');
    expect(lines).toContain('  исключено (weakBot): 1');
    expect(existsSync(join(dir, 'phone.json'))).toBe(false);
  });

  it('ошибки аргументов — код 2 и подсказка', () => {
    const cases: string[][] = [
      [],
      ['check'],
      ['reference'],
      ['reference', 'logs'],
      ['reference', 'logs', '--profile', 'tablet'],
      ['reference', 'logs', 'more', '--profile', 'phone'],
      ['reference', '--verbose', '--profile', 'phone'],
    ];
    for (const argv of cases) {
      const lines: string[] = [];
      expect(runCli(argv, (line) => lines.push(line), makeLogDir({}))).toBe(2);
      expect(lines.at(-1)).toBe(USAGE);
    }
  });

  it('нет папки журналов — код 2, сообщение и подсказка', () => {
    const missing = join(makeLogDir({}), 'нет');
    const lines: string[] = [];

    expect(runCli(['reference', missing, '--profile', 'pc'], (line) => lines.push(line), makeLogDir({}))).toBe(2);
    expect(lines).toEqual([`нет папки журналов: ${missing}`, USAGE]);
  });
});

describe('профиль двойника', () => {
  const reference = (): TwinReference => {
    const { dir } = runReference({ [`${C2_GAME}.log`]: phoneGameLog('Mob', 'bot08twin') });
    return JSON.parse(readFileSync(join(dir, 'phone.json'), 'utf8')) as TwinReference;
  };

  it('из справки без калибровки: канал по задержке сети, настройки, рука, огонь, манёвр, позиция', () => {
    const profile = twinProfile(reference(), null);

    expect(profile).toMatchObject({
      name: 'phone',
      control: 'sticks',
      channel: { uplinkTicks: 1, downlinkTicks: 1, interpolationTicks: 2 },
      settings: { pivotThrottle: 0.6 },
      calibration: null,
    });
    expect(profile.fire.noStartPauseShare).toBe(0);
    expect(profile.hand.errorDecilesDeg).toHaveLength(11);
    expect(profile.fire.longPausePerMinute).toBeGreaterThan(0);
    expect(profile.fire.releaseMeanS).toBeCloseTo(10 / TICK_RATE, 4);
    expect(profile.manoeuvre.stickDeciles.every((value) => value === 0.8)).toBe(true);
    expect(profile.manoeuvre.decisionDecilesS[0]).toBeGreaterThan(0);
    expect(profile.cover?.distanceBand.near).toBeGreaterThan(0);
  });

  it('калибровка переходит в профиль как есть; без позиции и настроек в справке', () => {
    const calibration: TwinCalibration = {
      correlationTicks: 9,
      lagTicks: 3,
      leadShare: 0.1,
      holdShare: {
        'visible|<300': 0.8,
        'visible|300–600': 0.9,
        'visible|>600': 0.7,
        'hidden|<300': 0.7,
        'hidden|300–600': 0.8,
        'hidden|>600': 0.3,
      },
      decisionScale: 1.2,
      kiteChance: 0.5,
      circleChance: 0.2,
      reverseChance: 0,
      coverHoldShare: 0.9,
    };
    const source = reference();
    expect(twinProfile(source, calibration).calibration).toEqual(calibration);

    const noPosition = structuredClone(source);
    noPosition.main.position.hold.distance = null;
    expect(twinProfile(noPosition, null).cover).toBeNull();

    const noSettings = structuredClone(source);
    noSettings.main.settings = null;
    expect(() => twinProfile(noSettings, null)).toThrow('настройки клиента');
  });
});
