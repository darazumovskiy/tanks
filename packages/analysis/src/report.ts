import { TICK_RATE } from '@tanks/shared/engine';
import type { GameAnalysis, GameSummary, RoundSummary } from './game.js';
import type { InferredStats } from './inferStats.js';
import { SECONDS_PER_DAY } from './logParser.js';
import { AXIS_BUCKETS, type Axis } from './movement.js';
import { median, pct, roundTo, sum } from './numbers.js';
import { MOVING_SPEED, SHOT_KIND } from './shots.js';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const HALF_DAY_SEC = SECONDS_PER_DAY / 2;
// Сравнение выигранных и проигранных раундов имеет смысл с уровня, где бот начинает побеждать.
const CONTESTED_LEVEL_MIN = 4;
const PER_THOUSAND = 1000;
const EMPTY = '—';
const DEVICE_SEPARATOR = ',';

type Cell = string | number;

export const REPORT_SECTIONS = {
  passports: '## 1. Паспорта игр',
  byLevelDevice: '## 2. Сводка «уровень × устройство»',
  selfHits: '## 3. Самопопадания',
  dynamics: '## 4. Динамика движения и команды',
  wonLost: '## 5. Выигранные и проигранные раунды по устройствам (уровни ≥ 4)',
  quality: '## 6. Контроль качества разбора',
} as const;

function fmt(value: number | null | undefined, suffix = ''): string {
  if (value === null || value === undefined) {
    return EMPTY;
  }
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text}${suffix}`;
}

function mdTable(headers: readonly string[], rows: readonly Cell[][]): string {
  const lines = [`| ${headers.join(' | ')} |`, `|${'---|'.repeat(headers.length)}`];
  for (const row of rows) {
    lines.push(`| ${row.map((cell) => String(cell)).join(' | ')} |`);
  }
  return lines.join('\n');
}

function statsShort(stats: InferredStats): string {
  return [stats.armor, stats.engine, stats.gun, stats.reload].map((v) => (v === null ? '?' : String(v))).join('/');
}

function statsText(stats: InferredStats): string {
  return `броня ${fmt(stats.armor)}, мотор ${fmt(stats.engine)}, пушка ${fmt(stats.gun)}, перезарядка ${fmt(stats.reload)}`;
}

// Игры ночной серии после полуночи идут после вечерних: сутки «начинаются» в полдень.
export function localSortKey(startSecUtc: number, tzHours: number): number {
  const local = (startSecUtc + tzHours * SECONDS_PER_HOUR) % SECONDS_PER_DAY;
  return local < HALF_DAY_SEC ? local + SECONDS_PER_DAY : local;
}

function deviceGroup(game: GameSummary): string {
  return game.device.split(DEVICE_SEPARATOR)[0] ?? game.device;
}

function roundMark(round: RoundSummary, humanSide: number): string {
  let winner = '=';
  if (round.winner !== null) {
    winner = round.winner === humanSide ? 'Д' : 'Б';
  }
  let reason = '…';
  if (round.reason === 'kill') {
    reason = '†';
  } else if (round.reason === 'time') {
    reason = '⏱';
  }
  return `${winner}${reason}${round.duration_s.toFixed(0)}с`;
}

function medianOf(values: readonly (number | null)[]): number | null {
  return median(values.filter((value): value is number => value !== null));
}

function passports(results: readonly GameAnalysis[]): string {
  const rows = results.map(({ summary: r }) => [
    r.id,
    r.start_local,
    r.room,
    `${fmt(r.level)} (${r.bot_name})`,
    r.device,
    r.human_name,
    r.rounds.length,
    `${String(r.wins_human)}:${String(r.wins_bot)}`,
    r.rounds.map((round) => roundMark(round, r.human_side)).join(', '),
    statsText(r.human_stats),
    `rtt ${fmt(r.client.rtt_median)} мс, fps ${fmt(r.client.fps_median)}`,
  ]);
  return mdTable(
    [
      'Игра',
      'Время',
      'Комната',
      'Уровень (бот)',
      'Устройство',
      'Ник',
      'Раундов',
      'Счёт Д:Б',
      'Раунды (Д — человек, Б — бот; † убийство, ⏱ время, … прерван)',
      'Характеристики человека (по журналу)',
      'Сеть/кадры',
    ],
    rows,
  );
}

interface Group {
  level: number;
  device: string;
  games: GameAnalysis[];
}

function groupByLevelDevice(results: readonly GameAnalysis[]): Group[] {
  const groups = new Map<string, Group>();
  for (const game of results) {
    const level = game.summary.level;
    if (level === null || game.summary.shooting_human.shots === 0) {
      continue;
    }
    const device = deviceGroup(game.summary);
    const key = `${String(level)}|${device}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { level, device, games: [game] });
      continue;
    }
    group.games.push(game);
  }
  return [...groups.values()].sort((a, b) => a.level - b.level || a.device.localeCompare(b.device));
}

function weightedByFightTicks(
  games: readonly GameAnalysis[],
  valueOf: (game: GameSummary) => number | null,
): number | null {
  const fightTicks = sum(games.map((game) => game.summary.movement.fight_ticks));
  if (fightTicks === 0) {
    return null;
  }
  return roundTo(
    sum(games.map((game) => (valueOf(game.summary) ?? 0) * game.summary.movement.fight_ticks)) / fightTicks,
    1,
  );
}

function meanOf(games: readonly GameAnalysis[], valueOf: (game: GameSummary) => number | null): number {
  return roundTo(sum(games.map((game) => valueOf(game.summary) ?? 0)) / games.length, 1);
}

function histogramShares(games: readonly GameAnalysis[], axis: Axis): string {
  const fightTicks = sum(games.map((game) => game.summary.movement.fight_ticks));
  return AXIS_BUCKETS.map((bucket) =>
    fmt(pct(sum(games.map((game) => game.summary.hist[axis][bucket] ?? 0)), fightTicks)),
  ).join(' / ');
}

function shareText(hits: number, shots: number): string {
  return `${fmt(pct(hits, shots))}% (${String(shots)})`;
}

function byLevelDevice(groups: readonly Group[]): string {
  const rows = groups.map(({ level, device, games }) => {
    const summaries = games.map((game) => game.summary);
    const fightTicks = sum(summaries.map((g) => g.movement.fight_ticks));
    const minutes = fightTicks / TICK_RATE / SECONDS_PER_MINUTE;
    const shotsHuman = sum(summaries.map((g) => g.shooting_human.shots));
    const hitsHuman = sum(summaries.map((g) => g.shooting_human.hits));
    const shotsBot = sum(summaries.map((g) => g.shooting_bot.shots));
    const hitsBot = sum(summaries.map((g) => g.shooting_bot.hits));
    const moving = sum(summaries.map((g) => g.shots_moving.shots));
    const movingHits = sum(summaries.map((g) => g.shots_moving.hits));
    const standing = sum(summaries.map((g) => g.shots_standing.shots));
    const standingHits = sum(summaries.map((g) => g.shots_standing.hits));
    const lead = sum(summaries.map((g) => g.shot_kinds[SHOT_KIND.lead] ?? 0));
    const shotRows = games.flatMap((game) => game.shots);
    const aimTimes = summaries.flatMap((g) => g.aim_time_ticks);
    const aimErr = medianOf(summaries.map((g) => g.aim_err_median_deg));
    const turretZero = sum(summaries.map((g) => g.hist.turretTurn['0'] ?? 0));
    const selfHits = sum(summaries.map((g) => g.self_hits.count));
    const selfDamage = sum(summaries.map((g) => g.self_hits.damage));
    const damageTaken = sum(summaries.map((g) => g.shooting_human.damage_taken));
    const bumps = sum(summaries.map((g) => g.movement.bumps));
    const aimTimeMedian = median(aimTimes);
    const rtt = medianOf(summaries.map((g) => g.client.rtt_median));
    const batched = sum(summaries.map((g) => g.movement.batched_inputs));
    const silent = sum(summaries.map((g) => g.movement.silent_ticks));
    const batchedText = fightTicks === 0 ? EMPTY : String(Math.round((PER_THOUSAND * batched) / fightTicks));
    return [
      level,
      device,
      games.length,
      `${String(sum(summaries.map((g) => g.wins_human)))}:${String(sum(summaries.map((g) => g.wins_bot)))}`,
      [...new Set(summaries.map((g) => statsShort(g.human_stats)))].sort().join(', '),
      shareText(hitsHuman, shotsHuman),
      shareText(hitsBot, shotsBot),
      shareText(standingHits, standing),
      shareText(movingHits, moving),
      fmt(pct(lead, moving)),
      fmt(aimErr),
      fmt(pct(turretZero, fightTicks)),
      aimTimeMedian === null ? EMPTY : `${(aimTimeMedian / TICK_RATE).toFixed(1)} с (${String(aimTimes.length)})`,
      fmt(weightedByFightTicks(games, (g) => g.movement.full_throttle_pct)),
      fmt(weightedByFightTicks(games, (g) => g.movement.mean_speed)),
      fmt(weightedByFightTicks(games, (g) => g.movement.reverse_pct)),
      fmt(minutes === 0 ? null : roundTo(bumps / minutes, 1)),
      fmt(pct(shotRows.filter((row) => row.hasLineOfSight).length, shotRows.length)),
      fmt(median(shotRows.map((row) => row.distance))),
      `${String(selfHits)} (${fmt(pct(selfHits, shotsHuman))}% выстр., ${fmt(pct(selfDamage, damageTaken))}% урона)`,
      `rtt ${fmt(rtt)} мс, пачкой ${batchedText}/1000 тиков, молч. ${String(silent)}`,
    ];
  });
  return mdTable(
    [
      'Ур.',
      'Устройство',
      'Игр',
      'Счёт Д:Б',
      'Билд (бр/мот/пуш/пер)',
      'Попад. человека (выстр.)',
      'Попад. бота (выстр.)',
      'По стоящ.',
      'По движ.',
      'Упрежд. %',
      'Ошибка башни °',
      'turretTurn=0 %',
      'Наведение',
      'Полный газ %',
      'Ср. скорость',
      'Задний ход %',
      'Удары /мин',
      'LOS %',
      'Дист. мед.',
      'Самопопадания',
      'Сеть',
    ],
    rows,
  );
}

function selfHitsSection(groups: readonly Group[]): string {
  const rows = groups.map(({ level, device, games }) => {
    const rowsAll = games.flatMap((game) => game.selfHits);
    if (rowsAll.length === 0) {
      return [level, device, 0, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY];
    }
    const kinds = new Map<string, number>();
    for (const row of rowsAll) {
      kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1);
    }
    const kindsText = [...kinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, total]) => `${kind}: ${String(total)}`)
      .join(' / ');
    const shots = sum(games.map((game) => game.summary.shooting_human.shots));
    const damageTaken = sum(games.map((game) => game.summary.shooting_human.damage_taken));
    const withSight = rowsAll.filter((row) => row.hasLineOfSight).length;
    const flightMedian = median(rowsAll.map((row) => row.flightTicks)) ?? 0;
    return [
      level,
      device,
      rowsAll.length,
      `${fmt(pct(rowsAll.length, shots))}%`,
      `${fmt(pct(sum(rowsAll.map((row) => row.damage)), damageTaken))}%`,
      kindsText,
      fmt(median(rowsAll.map((row) => row.wallDistance))),
      fmt(median(rowsAll.map((row) => row.incidenceDeg))),
      `${(flightMedian / TICK_RATE).toFixed(1)} с`,
      String(rowsAll.filter((row) => row.isAutofireOn).length),
      `стоял ${String(rowsAll.filter((row) => row.speed <= MOVING_SPEED).length)}, ехал в стену ${String(rowsAll.filter((row) => row.isTowardWall).length)}`,
      `${String(withSight)} (${fmt(pct(withSight, rowsAll.length))}%)`,
    ];
  });
  return mdTable(
    [
      'Ур.',
      'Устройство',
      'Самопопаданий',
      '% выстрелов',
      '% получ. урона',
      'Типы',
      'Дист. до стены, мед.',
      'Угол к нормали °, мед.',
      'Полёт до возврата, мед.',
      'Авто-огонь вкл.',
      'Танк',
      'Противник в LOS',
    ],
    rows,
  );
}

function dynamicsSection(groups: readonly Group[]): string {
  const rows = groups.map(({ level, device, games }) => {
    const summaries = games.map((game) => game.summary);
    return [
      level,
      device,
      games.length,
      histogramShares(games, 'throttle'),
      histogramShares(games, 'turn'),
      fmt(meanOf(games, (g) => g.dynamics.throttle_flips_per_min)),
      fmt(medianOf(summaries.map((g) => g.dynamics.flip_settle_ticks_median))),
      fmt(meanOf(games, (g) => g.dynamics.sharp_stops_per_min)),
      fmt(meanOf(games, (g) => g.dynamics.turnarounds_per_min)),
      fmt(medianOf(summaries.map((g) => g.dynamics.turnaround_ticks_median))),
      fmt(weightedByFightTicks(games, (g) => g.dynamics.kite_pct)),
      fmt(weightedByFightTicks(games, (g) => g.dynamics.circle_pct)),
      fmt(weightedByFightTicks(games, (g) => g.dynamics.mean_distance)),
      `${fmt(weightedByFightTicks(games, (g) => g.dynamics.near_wall_pct))} / ${fmt(weightedByFightTicks(games, (g) => g.dynamics.touching_wall_pct))}`,
      fmt(weightedByFightTicks(games, (g) => g.dynamics.reverse_speed_pct)),
      fmt(meanOf(games, (g) => g.client_inputs.turn_sign_flips_per_min)),
      fmt(meanOf(games, (g) => g.client_inputs.turn_full_flips_per_min)),
      fmt(meanOf(games, (g) => g.client_inputs.turn_changes_pct)),
      fmt(meanOf(games, (g) => g.client_inputs.throttle_changes_pct)),
    ];
  });
  return mdTable(
    [
      'Ур.',
      'Устройство',
      'Игр',
      `throttle: ${AXIS_BUCKETS.join(' / ')}, %`,
      'turn: то же',
      'Смен хода /мин',
      'Тиков до разгона в новую сторону',
      'Резких остановок /мин',
      'Разворотов >90° /мин',
      'Длина разворота, тиков',
      'Кайтинг %',
      'Кружение %',
      'Ср. дист. до бота',
      'У стены <150 / <60, %',
      'Едет задом %',
      'Смен знака turn /мин (клиент)',
      'Из них ±1→∓1 /мин',
      'turn меняется, % команд',
      'throttle меняется, % команд',
    ],
    rows,
  );
}

function wonLostSection(results: readonly GameAnalysis[]): string {
  const byDevice = new Map<string, { won: RoundSummary[]; lost: RoundSummary[] }>();
  for (const { summary } of results) {
    if (summary.level === null || summary.level < CONTESTED_LEVEL_MIN) {
      continue;
    }
    const device = deviceGroup(summary);
    const entry = byDevice.get(device) ?? { won: [], lost: [] };
    byDevice.set(device, entry);
    for (const round of summary.rounds) {
      if (round.human_won === null) {
        continue;
      }
      (round.human_won ? entry.won : entry.lost).push(round);
    }
  }
  const rows: Cell[][] = [];
  for (const [device, groups] of [...byDevice.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const [label, rounds] of [
      ['выиграл', groups.won],
      ['проиграл', groups.lost],
    ] as const) {
      if (rounds.length === 0) {
        continue;
      }
      const shots = sum(rounds.map((round) => round.human_shots));
      const hits = sum(rounds.map((round) => round.human_hits));
      const botShots = sum(rounds.map((round) => round.bot_shots));
      const botHits = sum(rounds.map((round) => round.bot_hits));
      const minutes = sum(rounds.map((round) => round.duration_s)) / SECONDS_PER_MINUTE;
      const med = (valueOf: (round: RoundSummary) => number | null): string => fmt(medianOf(rounds.map(valueOf)));
      rows.push([
        device,
        label,
        rounds.length,
        med((round) => round.duration_s),
        shareText(hits, shots),
        shareText(botHits, botShots),
        med((round) => round.human_first_hit_s),
        med((round) => round.bot_first_hit_s),
        med((round) => round.human_shot_distance_median),
        med((round) => round.human_los_pct),
        med((round) => round.human_lead_pct),
        fmt(minutes === 0 ? null : roundTo(sum(rounds.map((round) => round.human_bumps)) / minutes, 1)),
        med((round) => round.aim_err_median_deg),
      ]);
    }
  }
  return mdTable(
    [
      'Устройство',
      'Раунд',
      'Раундов',
      'Длительность, с (мед.)',
      'Попадания человека, % (выстр.)',
      'Попадания бота, % (выстр.)',
      'Первое попадание человека, с',
      'Первое попадание бота, с',
      'Дистанция выстрела, мед.',
      'Выстрелов с прямой видимостью, %',
      'Упреждение, % по движ.',
      'Удары о стены /мин',
      'Ошибка башни при LOS, °',
    ],
    rows,
  );
}

function qualitySection(results: readonly GameAnalysis[]): string {
  const rows = results.map(({ summary: r }) => {
    const human = r.human_stats;
    const bot = r.bot_stats;
    return [
      r.id,
      `${fmt(human.bulletSpeedRaw)} → ${String(human.bulletSpeed)}`,
      fmt(human.maxSpeedObserved),
      fmt(human.minShotIntervalTicks),
      fmt(human.maxHpObserved),
      `${fmt(bot.bulletSpeedRaw)} → ${String(bot.bulletSpeed)}`,
      fmt(bot.maxHpObserved),
      r.unknown_hits,
      r.lost_bullets,
      r.in_flight_bullets,
      r.device_source ?? EMPTY,
      r.movement.silent_ticks,
      r.movement.batched_inputs,
      r.movement.dropped_inputs,
    ];
  });
  return mdTable(
    [
      'Игра',
      'Скорость снаряда человека (измер. → принято)',
      'Макс. скорость человека',
      'Мин. интервал выстрелов, тиков',
      'HP человека по урону',
      'Скорость снаряда бота',
      'HP бота по урону',
      'Попаданий без снаряда',
      'Снарядов без исхода',
      'Снарядов в полёте при конце раунда',
      'Устройство найдено по',
      'Тиков молчания',
      'Команд пачкой',
      'Отброшенных команд',
    ],
    rows,
  );
}

export function buildReport(results: readonly GameAnalysis[], tzHours: number): string {
  const groups = groupByLevelDevice(results);
  return [
    '# Анализ журналов дуэлей человек — бот',
    '',
    `Журналов разобрано: ${String(results.length)}. Время — местное (UTC+${String(tzHours)}). Сторона человека определена по строкам клиента.`,
    '',
    REPORT_SECTIONS.passports,
    '',
    passports(results),
    '',
    REPORT_SECTIONS.byLevelDevice,
    '',
    'Игры без уровня бота и без выстрелов человека в сводку не входят.',
    '',
    byLevelDevice(groups),
    '',
    REPORT_SECTIONS.selfHits,
    '',
    selfHitsSection(groups),
    '',
    REPORT_SECTIONS.dynamics,
    '',
    dynamicsSection(groups),
    '',
    REPORT_SECTIONS.wonLost,
    '',
    wonLostSection(results),
    '',
    REPORT_SECTIONS.quality,
    '',
    qualitySection(results),
    '',
  ].join('\n');
}
