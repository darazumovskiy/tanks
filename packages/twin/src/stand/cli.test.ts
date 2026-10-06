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

// Справка с одним раундом Димы на уровне 8 и без метрик-входов: калибровке нечего подбирать, она мерит один раз.
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
  return reference;
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
  it('calibrate: мерит входы против набора соперников Димы, печатает таблицу и пишет файл калибровки', async () => {
    const dir = makeLogDir({ 'phone.json': JSON.stringify(tinyReference()) });

    // Смесь калибровки — около тысячи раундов уровня 8: потоки исполняют собранный dist, без инструментовки покрытия.
    const { code, lines } = await cli(['calibrate', '--profile', 'phone', '--seed', '3'], dir, CALIBRATE_THREADS);
    const calibration = JSON.parse(readFileSync(join(dir, 'phone.calibration.json'), 'utf8')) as TwinCalibration;

    expect(code).toBe(0);
    expect(lines[0]).toBe('| Вход | Дима | Двойник | Параметр |');
    expect(lines.some((line) => line.startsWith('| Отставание башни по ходу цели, тиков | — |'))).toBe(true);
    expect(lines).toContain('Прогонов стенда: 1; все входы в допуске');
    expect(lines).toContain(`Время: 0.5 с · потоков ${String(CALIBRATE_THREADS)}`);
    expect(lines.at(-1)).toBe(join(dir, 'phone.calibration.json'));
    expect(calibration).toMatchObject({ reverseChance: 0, coverHoldShare: 0, lagTicks: -5 });
    expect(calibration.correlationTicks).toBeCloseTo(Math.sqrt(120), 3);
  }, 60000);

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

    expect(lines[0]).toBe('Профиль phone · раундов на уровень 16 · сид 2');
    expect(lines).toContain('Винрейт');
    expect(lines).toContain('Исходы');
    expect(lines).toContain('Входы');
    expect(lines.some((line) => line.startsWith('| 8 | '))).toBe(true);
    expect(lines.some((line) => line.startsWith('Отпечаток команд: '))).toBe(true);
    expect(lines.at(-1)).toBe('Время: 0.5 с · 31.3 мс на раунд · потоков 1');
    expect(code).toBe(verdictLine === 'Итог: честен' ? 0 : 1);
  }, 30000);
});
