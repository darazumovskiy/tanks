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
import type { Distribution } from '@tanks/analysis';
import { COURSE_BAND_LABELS, DISTANCE_BUCKET_LABELS } from '@tanks/analysis/ruler';
import { parseTwinRival, type TwinCalibration } from '@tanks/bots/twin';
import { calibrationWith } from '@tanks/bots/twinFixture';
import { TICK_RATE } from '@tanks/shared/engine';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, USAGE } from './cli.js';
import { PROFILE_WINDOWS, twinProfile, twinRival, type TwinReference } from './profile.js';
import { loadCalibration, loadReference } from './reference.js';

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
const NO_SHARE = { part: 0, total: 0, pct: null };
const RIVAL_FILE = 'rival.json';
const RIVAL_NOT_REFRESHED = 'Профиль соперника не обновлён: нет справки, условий раундов или полной калибровки phone';
const REFERENCE_DIR = fileURLToPath(new URL('../reference/', import.meta.url));
const RIVAL_PATH = fileURLToPath(import.meta.resolve('@tanks/bots/twin-rival.json'));

function summary(n: number, value: number): Distribution {
  return { n, q1: value, median: value, q3: value, deciles: new Array<number>(11).fill(value) };
}

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

async function cli(argv: readonly string[], referenceDir: string): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runCli(argv, {
    print: (line) => lines.push(line),
    referenceDir,
    rivalPath: join(referenceDir, RIVAL_FILE),
    threads: 1,
    now: () => 0,
  });
  return { code, lines };
}

async function runReference(
  files: Record<string, string>,
  profile = 'phone',
): Promise<{ code: number; lines: string[]; dir: string }> {
  const logDir = makeLogDir(files);
  const dir = makeLogDir({});
  const { code, lines } = await cli(['reference', logDir, '--profile', profile], dir);
  return { code, lines, dir };
}

afterEach(() => {
  removeLogDirs();
});

describe('команда reference', () => {
  it('справка по журналам телефона: игры из списков выборки, числа раундов по правилам, победы и файл phone.json', async () => {
    const { code, lines, dir } = await runReference({
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
    expect(warnings).toHaveLength(PHONE_GAMES.length - 3 + 1);
    expect(warnings).toContain('Предупреждение: игры 8A29 из выборки нет в папке журналов');
    expect(warnings[0]).toBe('Предупреждение: игры Mob вне периодов выборки, в справку не вошли: TWN4');
    expect(lines).toContain('Раундов Mob: 3, по правилам выборки — 1');
    expect(lines).toContain('  исключено (weakBot): 1');
    expect(lines).toContain('  исключено (oldLadder): 1');
    expect(lines).toContain('Победы в главном окне: 0 из 1, интервал 0–79 %');
    expect(lines.at(-2)).toBe(path);
    expect(lines.at(-1)).toBe(RIVAL_NOT_REFRESHED);
    expect(existsSync(join(dir, RIVAL_FILE))).toBe(false);
    expect(reference).toMatchObject({
      profile: 'phone',
      nick: 'Mob',
      rounds: { total: 3, selected: 1, mainWindow: 1, excluded: { oldLadder: [`${OLD_LADDER_GAME}#0`] } },
    });
    expect(reference.main.rounds).toBe(1);
    expect(reference.movement.ticks).toBe(FIGHT_TICKS);
    expect(reference.main.fire.startPauseS?.median).toBeCloseTo(1, 4);
  });

  it('без раундов после выборки — ошибка с кодом 2 и числами по правилам; файл не пишется', async () => {
    const { code, lines, dir } = await runReference({ [`${C2_WEAK_GAME}.log`]: phoneGameLog('Mob', 'bot01weak') });

    expect(code).toBe(2);
    expect(lines).toContain('Раундов Mob: 1, по правилам выборки — 0');
    expect(lines).toContain('  исключено (weakBot): 1');
    expect(existsSync(join(dir, 'phone.json'))).toBe(false);
  });

  it('ошибки аргументов — код 2 и подсказка', async () => {
    const cases: string[][] = [
      [],
      ['compare', '--profile', 'phone'],
      ['reference'],
      ['reference', 'logs'],
      ['reference', '--profile', 'phone'],
      ['reference', 'logs', '--profile', 'tablet'],
      ['reference', 'logs', 'more', '--profile', 'phone'],
      ['reference', '--verbose', '--profile', 'phone'],
      ['reference', 'logs', '--profile', 'phone', '--rounds', '10'],
      ['check', 'extra', '--profile', 'phone'],
      ['check', '--profile', 'phone', '--rounds', '0'],
      ['check', '--profile', 'phone', '--rounds', '1.5'],
      ['check', '--profile', 'phone', '--levels', '2-5'],
      ['check', '--profile', 'phone', '--levels', '9-3'],
      ['check', '--profile', 'phone', '--levels', '3-5-7'],
      ['check', '--profile', 'phone', '--seed', '-1'],
      ['check', '--profile', 'phone', '--threads', '0'],
      ['calibrate', '--profile', 'pc', '--log-dir', 'x'],
    ];
    for (const argv of cases) {
      const { code, lines } = await cli(argv, makeLogDir({}));
      expect(code, argv.join(' ')).toBe(2);
      expect(lines.at(-1)).toBe(USAGE);
    }
  });

  it('нет папки журналов — код 2, сообщение и подсказка', async () => {
    const missing = join(makeLogDir({}), 'нет');

    const { code, lines } = await cli(['reference', missing, '--profile', 'pc'], makeLogDir({}));

    expect(code).toBe(2);
    expect(lines).toEqual([`нет папки журналов: ${missing}`, USAGE]);
  });

  it('check и calibrate без справки или калибровки — код 2 и подсказка, что запустить', async () => {
    const empty = makeLogDir({});

    expect(await cli(['check', '--profile', 'phone'], empty)).toEqual({
      code: 2,
      lines: ['нет справки или калибровки phone: сначала twin reference и twin calibrate'],
    });
    expect(await cli(['calibrate', '--profile', 'pc'], empty)).toEqual({
      code: 2,
      lines: ['нет справки pc: сначала twin reference'],
    });
  });
});

describe('профиль двойника', () => {
  const reference = async (): Promise<TwinReference> => {
    const { dir } = await runReference({ [`${C2_GAME}.log`]: phoneGameLog('Mob', 'bot08twin') });
    return JSON.parse(readFileSync(join(dir, 'phone.json'), 'utf8')) as TwinReference;
  };

  it('из справки без калибровки: канал по задержке сети, настройки, рука, огонь, манёвр, позиция', async () => {
    const profile = twinProfile(await reference(), null);

    expect(profile).toMatchObject({
      name: 'phone',
      control: 'sticks',
      channel: { uplinkTicks: 1, downlinkTicks: 1, interpolationTicks: 2 },
      settings: { pivotThrottle: 0.6 },
      calibration: null,
    });
    expect(profile.fire.noStartPauseShare).toBe(0);
    for (const band of DISTANCE_BUCKET_LABELS) {
      expect(profile.hand.errorDecilesDeg[band]).toHaveLength(11);
    }
    for (const band of COURSE_BAND_LABELS) {
      expect(profile.manoeuvre.courseDecilesDeg.sight[band]).toHaveLength(11);
    }
    expect(profile.fire.longPausePerMinute).toBeGreaterThan(0);
    expect(profile.fire.releaseMeanS).toBeCloseTo(10 / TICK_RATE, 4);
    expect(profile.manoeuvre.stickDeciles.every((value) => value === 0.8)).toBe(true);
    expect(profile.cover?.distanceBand.near).toBeGreaterThan(0);
  });

  it('калибровка переходит в профиль как есть; без позиции и настроек в справке', async () => {
    const calibration: TwinCalibration = {
      correlationTicks: 9,
      lagTicks: 3,
      holdShare: {
        'visible|<300': 0.8,
        'visible|300–600': 0.9,
        'visible|>600': 0.7,
        'hidden|<300': 0.7,
        'hidden|300–600': 0.8,
        'hidden|>600': 0.3,
      },
      decisionMeanS: 0.7,
      courseReach: 240,
      reverseChance: 0,
      kitShare: { closer: 0.4, farther: 0.2 },
      kitFollowShare: 0.6,
      hiddenAim: { bearing: 0.1, exit: 0.2, ricochet: 0.3, lastSeen: 0.1 },
      coverHoldShare: 0.9,
      returnAvoidShare: 0.5,
    };
    const source = await reference();
    expect(twinProfile(source, calibration).calibration).toEqual(calibration);

    const noPosition = structuredClone(source);
    noPosition.main.position.hold.distance = null;
    expect(twinProfile(noPosition, null).cover).toBeNull();

    const noSettings = structuredClone(source);
    noSettings.main.settings = null;
    expect(() => twinProfile(noSettings, null)).toThrow('настройки клиента');
  });

  it('ошибка руки по корзине — от 25 выстрелов в корзине, иначе по всем', async () => {
    const source = await reference();
    const withBands = (shots: number): TwinReference => {
      const copy = structuredClone(source);
      copy.main.aim.standingErrDeg = summary(100, 20);
      DISTANCE_BUCKET_LABELS.forEach((band, index) => {
        copy.main.aim.byBucket[band] = {
          standingErrDeg: summary(shots, 7 + index),
          movingErrCurDeg: null,
          movingErrLeadDeg: null,
          tankSizeDeg: null,
          hitAll: NO_SHARE,
          hitStanding: NO_SHARE,
          hitMoving: NO_SHARE,
        };
      });
      return copy;
    };

    const enough = twinProfile(withBands(25), null);
    const scarce = twinProfile(withBands(24), null);
    DISTANCE_BUCKET_LABELS.forEach((band, index) => {
      expect(enough.hand.errorDecilesDeg[band][5]).toBe(7 + index);
      expect(scarce.hand.errorDecilesDeg[band][5]).toBe(20);
    });
  });

  it('угол хода — по корзине в 100 от 10 с с газом; иначе по корзине огня, в которую она входит; иначе по всем', async () => {
    const source = await reference();
    const enough = 10 * TICK_RATE;
    const copy = structuredClone(source);
    copy.movement.courseAllDeg = summary(1000, 90);
    COURSE_BAND_LABELS.forEach((band, index) => {
      copy.movement.courseByBandDeg.sight[band] = summary(index % 2 === 0 ? enough : enough - 1, 10 + index);
      copy.movement.courseByBandDeg.hidden[band] = summary(enough - 1, 10 + index);
    });
    DISTANCE_BUCKET_LABELS.forEach((band, index) => {
      copy.movement.courseDeg.sight[band] = summary(enough, 40 + index);
      copy.movement.courseDeg.hidden[band] = summary(index === 1 ? enough : enough - 1, 50 + index);
    });
    const course = twinProfile(copy, null).manoeuvre.courseDecilesDeg;

    expect(course.sight['<200'][5]).toBe(10);
    expect(course.sight['200–300'][5]).toBe(40);
    expect(course.sight['300–400'][5]).toBe(12);
    expect(course.sight['400–500'][5]).toBe(41);
    expect(course.sight['600–700'][5]).toBe(42);
    expect(course.sight['700–800'][5]).toBe(16);
    expect(course.hidden['<200'][5]).toBe(90);
    expect(course.hidden['400–500'][5]).toBe(51);
    expect(course.hidden['>800'][5]).toBe(90);
  });
});

describe('профиль соперника', () => {
  const playerReference = (): TwinReference => {
    const reference = loadReference('phone', REFERENCE_DIR);
    if (reference === null) {
      throw new Error('нет справки телефона');
    }
    return reference;
  };
  const playerCalibration = (): TwinCalibration => {
    const file = loadCalibration('phone', REFERENCE_DIR);
    if (file === null || 'error' in file) {
      throw new Error('нет калибровки телефона');
    }
    return file.calibration;
  };

  it('профиль — twinProfile; билд и уровень соперника — с наибольшим числом раундов; предохранитель — у большинства', () => {
    const reference = playerReference();
    const calibration = playerCalibration();
    const rival = twinRival(reference, calibration);

    expect(rival).toEqual({
      profile: twinProfile(reference, calibration),
      stats: { armor: 0, engine: 3, gun: 4, reload: 3 },
      hasRicochetGuard: true,
      opponentLevel: 8,
    });

    const guardOff = structuredClone(reference);
    for (const level of Object.values(guardOff.main.conditions)) {
      level.conditions = level.conditions.map((condition) => ({ ...condition, hasRicochetGuard: false }));
    }
    expect(twinRival(guardOff, calibration)?.hasRicochetGuard).toBe(false);

    const noConditions = structuredClone(reference);
    noConditions.main.conditions = {};
    expect(twinRival(noConditions, calibration)).toBeNull();
  });

  it('файл профиля соперника совпадает со сборкой из справки и калибровки телефона — после них нужен twin reference или calibrate', () => {
    const file = parseTwinRival(readFileSync(RIVAL_PATH, 'utf8'));

    expect(twinRival(playerReference(), playerCalibration())).toEqual(file);
  });

  it('reference: справка телефона без условий раундов профиль соперника не трогает, справка компьютера — тоже', async () => {
    const calibration = calibrationWith();
    const logDir = makeLogDir({ [`${C2_GAME}.log`]: phoneGameLog('Mob', 'bot08twin') });
    const dir = makeLogDir({ 'phone.calibration.json': JSON.stringify(calibration) });

    const phone = await cli(['reference', logDir, '--profile', 'phone'], dir);
    expect(phone.lines.at(-1)).toBe(RIVAL_NOT_REFRESHED);
    expect(existsSync(join(dir, RIVAL_FILE))).toBe(false);

    const pcDir = makeLogDir({ 'pc.calibration.json': JSON.stringify(calibration) });
    const pcLogs = makeLogDir({ 'K3UX.log': phoneGameLog('dd', 'bot08pc') });
    const pc = await cli(['reference', pcLogs, '--profile', 'pc'], pcDir);
    expect(pc.code).toBe(0);
    expect(pc.lines.at(-1)).toBe(join(pcDir, 'pc.json'));
    expect(existsSync(join(pcDir, RIVAL_FILE))).toBe(false);
  });
});
