import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeLogs } from './index.js';
import {
  ANDROID_USER_AGENT,
  BOT,
  countdownFrames,
  deviceLine,
  fightFrame,
  HUMAN,
  LANE_Y,
  MAC_USER_AGENT,
  makeLogDir,
  pose,
  removeLogDirs,
  roomLog,
  standingFrames,
  START_SEC,
  startDuel,
  visitLine,
  type Pose,
} from './logFixture.js';
import { REPORT_SECTIONS } from './report.js';
import { DIRECT_SOURCE, type VisitorSummary } from './visitors.js';

const DEV_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const DEV_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const DEV_C = 'cccccccccccccccccccccccc';
const DEV_D = 'dddddddddddddddddddddddd';
const DEV_E = 'eeeeeeeeeeeeeeeeeeeeeeee';
const MOSCOW = { country: 'RU', countryName: 'Russia', city: 'Moscow', org: 'MTS PJSC' };
const WINDOWS_CHROME = { os: 'Windows', osVersion: '10', browser: 'Chrome', browserVersion: '154', shell: 'browser' };
const ANDROID_APP = { os: 'Android', osVersion: '16', browser: 'Chrome', browserVersion: '153', shell: 'app' };

function analyze(files: Record<string, string>): { visitors: VisitorSummary[]; report: string; json: unknown } {
  const dir = makeLogDir(files);
  const result = analyzeLogs(dir, { outDir: join(dir, 'out'), tzHours: 3 });
  return {
    visitors: result.visitors,
    report: readFileSync(result.reportPath, 'utf8'),
    json: JSON.parse(readFileSync(result.visitorsPath, 'utf8')),
  };
}

function shortDuel(room: string): string {
  const poses: [Pose, Pose] = [pose(800, LANE_Y, Math.PI), pose(200, LANE_Y)];
  return startDuel({ room, startSec: START_SEC })
    .roundStart(0, 0)
    .frames(countdownFrames(poses))
    .frames(standingFrames(poses, 5))
    .frame(fightFrame(poses, { events: [{ kind: 'roundOver', side: BOT }] }))
    .text();
}

afterEach(() => {
  removeLogDirs();
});

describe('кто играл', () => {
  it('два устройства: вернувшееся с дуэлью и новое с боем толпы — визиты, бои, ники, место, источник', () => {
    const { visitors, report, json } = analyze({
      'visits/2026-10-05.log': [
        visitLine({
          at: '2026-10-05T10:07:49.000Z',
          dev: DEV_A,
          ip: '95.24.1.1',
          geo: MOSCOW,
          page: '/',
          from: 'arena',
          firstFrom: 'arena',
          nick: 'МАКСИМ',
          langs: 'ru-RU,ru',
          tz: 'Europe/Moscow',
          client: WINDOWS_CHROME,
        }),
        visitLine({
          at: '2026-10-05T10:15:00.000Z',
          dev: DEV_B,
          ip: '81.2.69.142',
          geo: { country: 'GB', countryName: 'United Kingdom', city: 'London' },
          ref: 'https://t.me/arena_channel',
          nick: 'Рустам',
          model: 'Pixel 8',
          client: ANDROID_APP,
        }),
        '',
      ].join('\n'),
      'visits/2026-10-06.log': visitLine({
        at: '2026-10-06T09:00:00.000Z',
        dev: DEV_A,
        ip: '95.24.1.2',
        geo: MOSCOW,
        page: '/d/bot01x',
        from: 'tg',
        firstFrom: 'arena',
        nick: 'Макс',
        client: WINDOWS_CHROME,
      }),
      'room-bot01x.log': roomLog(START_SEC, HUMAN, [deviceLine(MAC_USER_AGENT, false, DEV_A)]),
      'room-ffa30.log': roomLog(START_SEC, HUMAN, [deviceLine(ANDROID_USER_AGENT, true, DEV_B, ' mode=ffa size=30')]),
      'room-old.log': roomLog(START_SEC, HUMAN, [deviceLine(MAC_USER_AGENT, false)]),
    });
    expect(visitors).toEqual([
      {
        dev: DEV_A,
        first_visit: '2026-10-05 13:07',
        last_visit: '2026-10-06 12:00',
        visits: 2,
        days: 2,
        is_returning: true,
        battles_duel: 1,
        battles_ffa: 0,
        nicks: ['МАКСИМ', 'Макс'],
        country: 'Russia',
        city: 'Moscow',
        org: 'MTS PJSC',
        ips: ['95.24.1.1', '95.24.1.2'],
        device: 'Windows 10, Chrome 154',
        langs: 'ru-RU,ru',
        tz: 'Europe/Moscow',
        source: 'arena',
      },
      {
        dev: DEV_B,
        first_visit: '2026-10-05 13:15',
        last_visit: '2026-10-05 13:15',
        visits: 1,
        days: 1,
        is_returning: false,
        battles_duel: 0,
        battles_ffa: 1,
        nicks: ['Рустам'],
        country: 'United Kingdom',
        city: 'London',
        org: null,
        ips: ['81.2.69.142'],
        device: 'Android 16 (Pixel 8), Chrome 153, приложение',
        langs: null,
        tz: null,
        source: 't.me',
      },
    ]);
    expect(json).toEqual(visitors);
    expect(report).toContain(REPORT_SECTIONS.visitors);
    expect(report).toContain('Устройств: 2, визитов: 3, вернулись в другой день: 1, с боем: 2.');
    expect(report).toContain(
      '| aaaaaa | МАКСИМ, Макс | 2026-10-05 13:07 | 2026-10-06 12:00 | 2 | 2 | 1 | 0 | Russia, Moscow |',
    );
    expect(report).toContain('| arena | 1 |');
  });

  it('источник: метка позднего визита, иначе сайт первого визита, иначе прямой заход', () => {
    const { visitors } = analyze({
      'visits/2026-10-05.log': [
        visitLine({ at: '2026-10-05T10:00:00.000Z', dev: DEV_C }),
        visitLine({ at: '2026-10-05T10:01:00.000Z', dev: DEV_C, from: 'vk' }),
        visitLine({ at: '2026-10-05T10:02:00.000Z', dev: DEV_D, ref: 'не адрес' }),
        visitLine({ at: '2026-10-05T10:03:00.000Z', dev: DEV_E, ref: '' }),
      ].join('\n'),
    });
    const sourceOf = (dev: string): string | undefined => visitors.find((visitor) => visitor.dev === dev)?.source;
    expect(sourceOf(DEV_C)).toBe('vk');
    expect(sourceOf(DEV_D)).toBe('не адрес');
    expect(sourceOf(DEV_E)).toBe(DIRECT_SOURCE);
    expect(visitors.find((visitor) => visitor.dev === DEV_C)?.device).toBeNull();
  });

  it('битые строки пропущены; бой без визита — устройство без визитов; дуэль находит устройство по строке с номером', () => {
    const { visitors, report } = analyze({
      'visits/2026-10-05.log': [
        'мусор',
        '12:00:00.000 V {не json',
        '12:00:00.000 V [1]',
        '12:00:00.000 V {"dev":"без времени"}',
        visitLine({ at: '2026-10-05T10:00:00.000Z', dev: DEV_A, client: { os: 'Linux' } }),
      ].join('\n'),
      'visits/notes.txt': 'не журнал',
      'DUEL.log': shortDuel('bot01duel'),
      'room-bot01duel.log': roomLog(START_SEC, HUMAN, [deviceLine(MAC_USER_AGENT, false, DEV_E)]),
    });
    expect(visitors.map((visitor) => visitor.dev)).toEqual([DEV_A, DEV_E]);
    expect(visitors[0]?.device).toBe('Linux');
    expect(visitors[1]).toMatchObject({
      visits: 0,
      first_visit: null,
      battles_duel: 1,
      device: null,
      source: DIRECT_SOURCE,
    });
    expect(report).toContain('| eeeeee | — | — | — | 0 | 0 | 1 | 0 | — | — | — | — | — | прямой заход |');
    expect(report).toContain('Mac, Chrome');
  });

  it('черта и перевод строки в нике не разваливают таблицу отчёта', () => {
    const { report } = analyze({
      'visits/2026-10-05.log': visitLine({ at: '2026-10-05T10:00:00.000Z', dev: DEV_A, nick: 'Танк|Боец\nДва' }),
    });
    expect(report).toContain('| aaaaaa | Танк\\|Боец Два |');
  });

  it('без папки визитов и строк с номером — раздел «визитов нет», пустой visitors.json', () => {
    const { visitors, report, json } = analyze({
      'room-old.log': roomLog(START_SEC, HUMAN, [deviceLine(MAC_USER_AGENT, false)]),
    });
    expect(visitors).toEqual([]);
    expect(json).toEqual([]);
    expect(report).toContain(`${REPORT_SECTIONS.visitors}\n\nВизитов нет.`);
  });
});
