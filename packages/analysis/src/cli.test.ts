import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCliArgs, runCli, USAGE } from './cli.js';
import { countdownFrames, LANE_Y, makeLogDir, pose, removeLogDirs, standingFrames, startDuel } from './logFixture.js';

const EXIT_OK = 0;
const EXIT_USAGE = 2;

afterEach(() => {
  removeLogDirs();
});

describe('разбор аргументов', () => {
  it('папка и все флаги', () => {
    expect(parseCliArgs(['logs', '--out', 'out', '--tz', '5', '--only', 'A1,B2,'])).toEqual({
      invocation: { logDir: 'logs', options: { outDir: 'out', tzHours: 5, only: ['A1', 'B2'] } },
    });
    expect(parseCliArgs(['logs'])).toEqual({ invocation: { logDir: 'logs', options: {} } });
  });

  it('ошибки: нет папки, две папки, неизвестный флаг, флаг без значения, не число в --tz', () => {
    expect(parseCliArgs([])).toEqual({ error: 'не указана папка с журналами' });
    expect(parseCliArgs(['a', 'b'])).toEqual({ error: 'лишний аргумент: b' });
    expect(parseCliArgs(['a', '--foo'])).toEqual({ error: 'лишний аргумент: --foo' });
    expect(parseCliArgs(['a', '--out'])).toEqual({ error: '--out: нет значения' });
    expect(parseCliArgs(['a', '--tz', 'x'])).toEqual({ error: '--tz: ожидается число, получено x' });
  });
});

describe('запуск из командной строки', () => {
  it('печатает пропуски, число игр и путь к отчёту', () => {
    const poses: [ReturnType<typeof pose>, ReturnType<typeof pose>] = [pose(800, LANE_Y), pose(200, LANE_Y)];
    const game = startDuel().roundStart(0, 0).frames(countdownFrames(poses)).frames(standingFrames(poses, 2)).text();
    const dir = makeLogDir({ 'GAME.log': game, 'NOPE.log': 'мусор\n' }, 'logs');
    const printed: string[] = [];
    const code = runCli([dir, '--out', join(dir, 'out')], (line) => printed.push(line));

    expect(code).toBe(EXIT_OK);
    expect(printed).toEqual([
      'NOPE: нет game start или раундов — пропуск',
      'Игр разобрано: 1',
      join(dir, 'out', 'report.md'),
    ]);
    expect(existsSync(join(dir, 'out', 'games.json'))).toBe(true);
  });

  it('без папки печатает ошибку и подсказку, код выхода 2', () => {
    const printed: string[] = [];
    expect(runCli([], (line) => printed.push(line))).toBe(EXIT_USAGE);
    expect(printed).toEqual(['не указана папка с журналами', USAGE]);
  });
});
