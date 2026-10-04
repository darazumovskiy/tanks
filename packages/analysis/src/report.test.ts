import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeLogs } from './index.js';
import {
  action,
  ANDROID_USER_AGENT,
  BOT,
  bulletTravel,
  countdownFrames,
  DEFAULT_DAMAGE,
  deviceLine,
  fightFrame,
  HUMAN,
  IDLE,
  LANE_Y,
  MAC_USER_AGENT,
  makeLogDir,
  muzzleOf,
  pose,
  removeLogDirs,
  repeatFrames,
  roomLog,
  standingFrames,
  START_SEC,
  startDuel,
  type LogAction,
  type Pose,
} from './logFixture.js';
import { REPORT_SECTIONS } from './report.js';

const FLIGHT_TICKS = 29;
const AFTERNOON_SEC = 13 * 3600;

// Игра с одним попаданием человека и победой по убийству; второй раунд — проигран по времени.
// С isTurning башня до выстрела смотрит в сторону и доворачивается — появляются время наведения и ось turretTurn.
function gameWithHit(room: string, startSec: number, isTurning = false): string {
  const human = pose(200, LANE_Y);
  const aside = pose(200, LANE_Y, 0, isTurning ? 0.6 : 0);
  const bot = pose(800, LANE_Y, Math.PI, Math.PI);
  const poses: [Pose, Pose] = [bot, human];
  const turning: [LogAction, LogAction] = [IDLE, action(0, 0, isTurning ? 0.2 : 0)];
  const muzzle = muzzleOf(human);
  const hitX = muzzle.x + bulletTravel(FLIGHT_TICKS + 1);
  return startDuel({ room, startSec })
    .roundStart(0, 0)
    .frames(countdownFrames([bot, aside]))
    .frames(repeatFrames(5, () => fightFrame([bot, aside], { actions: turning })))
    .frame(fightFrame(poses, { events: [{ kind: 'shot', side: HUMAN, x: muzzle.x, y: muzzle.y, v: 0 }] }))
    .frames(standingFrames(poses, FLIGHT_TICKS - 1))
    .frame(
      fightFrame(poses, {
        events: [
          { kind: 'hit', side: BOT, x: hitX, y: LANE_Y, v: DEFAULT_DAMAGE },
          { kind: 'death', side: BOT, x: 800, y: LANE_Y },
          { kind: 'roundOver', side: HUMAN },
        ],
      }),
    )
    .roundStart(1, 1, '0:1')
    .frames(countdownFrames(poses))
    .frames(standingFrames(poses, 5))
    .frame(fightFrame(poses, { events: [{ kind: 'roundOver', side: BOT }] }))
    .text();
}

afterEach(() => {
  removeLogDirs();
});

describe('отчёт', () => {
  it('содержит шесть разделов, строку игры в паспортах и группы «уровень × устройство» со счётом', () => {
    const dir = makeLogDir({
      'RPT1.log': gameWithHit('bot05rpt1', AFTERNOON_SEC),
      'room-bot05rpt1.log': roomLog(AFTERNOON_SEC, HUMAN, [deviceLine(ANDROID_USER_AGENT, true)]),
      'RPT2.log': gameWithHit('bot05rpt2', START_SEC, true),
      'room-bot05rpt2.log': roomLog(START_SEC, HUMAN, [deviceLine(MAC_USER_AGENT, false)]),
    });
    const result = analyzeLogs(dir, { outDir: join(dir, 'out'), tzHours: 0 });
    const report = readFileSync(result.reportPath, 'utf8');

    for (const header of Object.values(REPORT_SECTIONS)) {
      expect(report).toContain(`\n${header}\n`);
    }
    expect(result.games.map((game) => game.summary.id)).toEqual(['RPT1', 'RPT2']);
    expect(report).toContain('Журналов разобрано: 2. Время — местное (UTC+0).');
    expect(report).toContain(
      '| RPT1 | 13:00 | bot05rpt1 | 5 (Ветеран) | Android (2407FPN8EG), касание | Дима | 2 | 1:1 | Д†1с, Б⏱0с |',
    );
    expect(report).toContain(
      '| 5 | Android (2407FPN8EG) | 1 | 1:1 | ?/?/2/? | 100% (1) | —% (0) | 100% (1) | —% (0) | — | 0 | 100 | — |',
    );
    expect(report).toContain(
      '| 5 | Mac | 1 | 1:1 | ?/?/2/? | 100% (1) | —% (0) | 100% (1) | —% (0) | — | 0 | 87.8 | 0.2 с (1) |',
    );
    expect(report).toContain('| 5 | Android (2407FPN8EG) | 0 | — |');
    expect(report).toContain('| Android (2407FPN8EG) | выиграл | 1 |');
    expect(report).toContain('| Mac | проиграл | 1 |');
    expect(report).toContain('| RPT1 | — → 550 | — | — | — | — → 550 | 28 | 0 | 0 | 0 | комната | 0 | 0 | 0 |');
  });

  it('игры без уровня или без выстрелов человека в сводку не входят', () => {
    const poses: [Pose, Pose] = [pose(800, LANE_Y, Math.PI, Math.PI), pose(200, LANE_Y)];
    const quiet = startDuel({ room: 'plain' })
      .roundStart(0, 0)
      .frames(countdownFrames(poses))
      .frames(standingFrames(poses, 3))
      .text();
    const dir = makeLogDir({ 'QUIE.log': quiet });
    const report = readFileSync(analyzeLogs(dir, { outDir: join(dir, 'out') }).reportPath, 'utf8');
    const summary = report.slice(
      report.indexOf(REPORT_SECTIONS.byLevelDevice),
      report.indexOf(REPORT_SECTIONS.selfHits),
    );

    expect(report).toContain('| QUIE |');
    expect(summary).not.toContain('| QUIE |');
    expect(summary.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Ур.'))).toEqual([]);
  });
});
