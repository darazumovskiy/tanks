import { makeLogDir, removeLogDirs } from '@tanks/analysis/logFixture';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import { calibrationWith } from '../fixture.js';
import type { TwinCalibration, TwinReference } from '../profile.js';

const PHONE = JSON.parse(readFileSync(new URL('../../reference/phone.json', import.meta.url), 'utf8')) as TwinReference;
const NO_SHARE = { part: 0, total: 0, pct: null };
const CALIBRATE_THREADS = 4;

// Справка с одним раундом игрока на уровне 8 и без метрик-входов: калибровке нечего подбирать, она мерит один раз.
function tinyReference(): TwinReference {
  const reference = structuredClone(PHONE);
  const level8 = reference.main.conditions['8'];
  if (level8 === undefined) {
    throw new Error('в справке нет уровня 8');
  }
  reference.main.conditions = { '8': { ...level8, guard: { part: 1, total: 1, pct: 100 } } };
  reference.main.aim.aimFit = { n: 0, lagTicks: null, residualSameSideTicks: null };
  reference.main.aim.byBucket = {};
  for (const context of Object.keys(
    reference.main.fire.heldAfterStartByContext,
  ) as (keyof typeof reference.main.fire.heldAfterStartByContext)[]) {
    reference.main.fire.heldAfterStartByContext[context] = NO_SHARE;
  }
  const noAim = { sole: NO_SHARE, chancePct: null, excessPct: null };
  reference.main.aim.hiddenAim = { bearing: noAim, exit: noAim, ricochet: noAim, lastSeen: noAim };
  reference.main.kits.toward = { closer: NO_SHARE, farther: NO_SHARE };
  reference.main.kits.followed = NO_SHARE;
  reference.main.kits.startsPerMinute = { closer: null, farther: null };
  reference.main.fire.returningShotsGuardOff = NO_SHARE;
  reference.movement.pathShift = null;
  reference.movement.freeRunAhead = null;
  return reference;
}

// Файл калибровки, записанный до появления поля.
function withoutField(calibration: TwinCalibration, field: keyof TwinCalibration): Record<string, unknown> {
  return Object.fromEntries(Object.entries(calibration).filter(([key]) => key !== field));
}

async function cli(
  argv: readonly string[],
  referenceDir: string,
  threads = 1,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  let clock = 0;
  const code = await runCli(argv, {
    print: (line) => lines.push(line),
    referenceDir,
    threads,
    now: () => (clock += 500),
  });
  return { code, lines };
}

afterEach(() => {
  removeLogDirs();
});

describe('команды стенда', () => {
  it('calibrate: мерит входы против набора соперников игрока, печатает таблицу и пишет файл калибровки', async () => {
    const dir = makeLogDir({ 'phone.json': JSON.stringify(tinyReference()) });

    // Смесь калибровки — около тысячи раундов уровня 8: потоки исполняют собранный dist, без инструментовки покрытия.
    const { code, lines } = await cli(['calibrate', '--profile', 'phone', '--seed', '3'], dir, CALIBRATE_THREADS);
    const calibration = JSON.parse(readFileSync(join(dir, 'phone.calibration.json'), 'utf8')) as TwinCalibration;

    expect(code).toBe(0);
    expect(lines[0]).toBe('| Вход | Игрок | Двойник | Параметр |');
    expect(lines.some((line) => line.startsWith('| Отставание башни по ходу цели, тиков | — |'))).toBe(true);
    expect(lines).toContain('Прогонов стенда: 1; все входы в допуске');
    expect(lines).toContain(`Время: 0.5 с · потоков ${String(CALIBRATE_THREADS)}`);
    expect(lines.at(-1)).toBe(join(dir, 'phone.calibration.json'));
    expect(calibration).toMatchObject({ reverseChance: 0, coverHoldShare: 0, lagTicks: 15 });
    expect(calibration.correlationTicks).toBeCloseTo(Math.sqrt(120), 3);
  }, 60000);

  it('calibrate --only: остальные параметры — из прежней калибровки; без неё, без её группы и с чужой группой — отказ', async () => {
    const reference = JSON.stringify(tinyReference());
    const empty = makeLogDir({ 'phone.json': reference });
    const old = withoutField(calibrationWith({ lagTicks: 2 }), 'returnAvoidShare');
    const dir = makeLogDir({ 'phone.json': reference, 'phone.calibration.json': JSON.stringify(old) });

    const unknown = await cli(['calibrate', '--profile', 'phone', '--only', 'hold,aim'], dir);
    const missing = await cli(['calibrate', '--profile', 'phone', '--only', 'hold'], empty);
    const oldFile = await cli(['calibrate', '--profile', 'phone', '--only', 'hold'], dir);
    const { code } = await cli(
      ['calibrate', '--profile', 'phone', '--only', 'returnAvoidShare'],
      dir,
      CALIBRATE_THREADS,
    );
    const calibration = JSON.parse(readFileSync(join(dir, 'phone.calibration.json'), 'utf8')) as TwinCalibration;

    expect(unknown.code).toBe(2);
    expect(unknown.lines[0]).toMatch(/^--only: ожидаются группы через запятую из correlationTicks, lagTicks, hold/);
    expect(missing).toMatchObject({
      code: 2,
      lines: ['нет калибровки phone: --only перекалибровывает только поверх прежней'],
    });
    expect(oldFile).toMatchObject({
      code: 2,
      lines: ['в калибровке phone нет параметров или они не числа: returnAvoidShare — пересоберите twin calibrate'],
    });
    expect(code).toBe(0);
    // У игрока входа нет — параметр группы встаёт на середину диапазона, остальные остаются прежними.
    expect(calibration).toMatchObject({ lagTicks: 2, returnAvoidShare: 0.5 });
  }, 60000);

  it('check: калибровка без группы параметров или с не числом — отказ с кодом 2 и списком параметров', async () => {
    const noKits = withoutField(calibrationWith(), 'kitShare');
    const broken = { ...calibrationWith(), holdShare: { ...calibrationWith().holdShare, 'hidden|>600': 'x' } };
    const reference = JSON.stringify(tinyReference());
    const kitsDir = makeLogDir({ 'phone.json': reference, 'phone.calibration.json': JSON.stringify(noKits) });
    const holdDir = makeLogDir({ 'phone.json': reference, 'phone.calibration.json': JSON.stringify(broken) });

    expect(await cli(['check', '--profile', 'phone'], kitsDir)).toEqual({
      code: 2,
      lines: [
        'в калибровке phone нет параметров или они не числа: kit closer, kit farther — пересоберите twin calibrate',
      ],
    });
    expect(await cli(['check', '--profile', 'phone'], holdDir)).toEqual({
      code: 2,
      lines: ['в калибровке phone нет параметров или они не числа: hold hidden|>600 — пересоберите twin calibrate'],
    });
  });

  it('check: три таблицы, отпечаток, итог и замер времени; код выхода по итогу', async () => {
    const dir = makeLogDir({
      'phone.json': JSON.stringify(tinyReference()),
      'phone.calibration.json': JSON.stringify(calibrationWith({ correlationTicks: 6 })),
    });

    const { code, lines } = await cli(
      ['check', '--profile', 'phone', '--rounds', '10', '--levels', '8', '--seed', '2'],
      dir,
    );
    const verdictLine = lines.find((line) => line.startsWith('Итог:')) ?? '';

    expect(lines[0]).toBe('Профиль phone · раундов на уровень от 10 · сид 2');
    expect(lines).toContain('Винрейт');
    expect(lines).toContain('Исходы');
    expect(lines).toContain('Входы');
    expect(lines.some((line) => line.startsWith('| 8 | '))).toBe(true);
    expect(lines.some((line) => line.startsWith('Отпечаток команд: '))).toBe(true);
    expect(lines.at(-1)).toBe('Время: 0.5 с · 17.9 мс на раунд · потоков 1');
    expect(code).toBe(verdictLine === 'Итог: честен' ? 0 : 1);
  }, 30000);
});
