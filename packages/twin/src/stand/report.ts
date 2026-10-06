import { wilson, type WinCount } from '@tanks/analysis';
import { isEdgeViolation, type InputCheck, type Sensitivity } from './calibrate.js';
import type { Honesty, Measure, Verdict } from './honesty.js';

const PERCENT = 100;
const EMPTY = '—';
const PRINT_DIGITS = 8;

// Граница интервала у 0 % — минус в последнем знаке плавающей точки; «-0.0» печатается как «0.0».
const NEGATIVE_ZERO = /^-(0\.?0*)$/;

function number(value: number | null, digits = 1): string {
  return value === null ? EMPTY : value.toFixed(digits).replace(NEGATIVE_ZERO, '$1');
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [row(header), row(header.map(() => '---')), ...rows.map(row)];
}

function interval(part: number, total: number): string {
  const bounds = wilson(part, total);
  return bounds === null ? '' : ` [${number(bounds.low)}–${number(bounds.high)}]`;
}

function pctOf(count: WinCount): number | null {
  return count.rounds === 0 ? null : (PERCENT * count.wins) / count.rounds;
}

function winCell(count: WinCount): string {
  return `${number(pctOf(count))} %${interval(count.wins, count.rounds)}`;
}

function dimaWins(count: WinCount | null): string {
  return count === null
    ? EMPTY
    : `${String(count.wins)} из ${String(count.rounds)}${interval(count.wins, count.rounds)}`;
}

function measureCell(measure: Measure, isReference: boolean): string {
  if (measure.kind === 'rate') {
    return number(measure.value);
  }
  if (measure.kind === 'median') {
    const value = measure.value;
    if (value === null) {
      return EMPTY;
    }
    return isReference ? `${number(value.median)} [${number(value.q1)}–${number(value.q3)}]` : number(value.median);
  }
  const { part, total, pct } = measure.value;
  return isReference ? `${number(pct)} %${interval(part, total)}` : `${number(pct)} %`;
}

function measureCount(measure: Measure): string {
  if (measure.kind === 'rate') {
    return EMPTY;
  }
  if (measure.kind === 'median') {
    return measure.value === null ? '0' : String(measure.value.n);
  }
  return String(measure.value.total);
}

function inputRows(inputs: readonly InputCheck[]): string[][] {
  return inputs.map((input) => [
    input.name,
    number(input.dima, 2),
    number(input.twin, 2),
    `±${number(input.tolerance, 2)}`,
    input.verdict,
  ]);
}

function edgeLines(inputs: readonly InputCheck[]): string[] {
  return inputs
    .filter(isEdgeViolation)
    .map(
      (input) =>
        `Нарушение честности: ${input.param} = ${input.value.toFixed(3)} на краю физического диапазона, вход вне допуска — модели не хватает свойства (вход «${input.name}»)`,
    );
}

function violations(honesty: Honesty): string[] {
  const isViolation = (verdict: Verdict): boolean => verdict === 'нарушение';
  return [
    ...honesty.levels
      .filter((item) => isViolation(item.verdict))
      .map((item) => `винрейт, уровень ${String(item.level)}`),
    ...(isViolation(honesty.overall.verdict) ? ['винрейт сводный'] : []),
    ...honesty.outcomes.filter((item) => isViolation(item.verdict)).map((item) => item.name),
    ...honesty.inputs.filter((item) => isViolation(item.verdict)).map((item) => `вход: ${item.name}`),
    ...honesty.inputs.filter(isEdgeViolation).map((item) => `край: ${item.param}`),
  ];
}

export function checkReport(honesty: Honesty, print: number): string[] {
  const levelRows = honesty.levels.map((item) => [
    String(item.level),
    String(item.twin.rounds),
    winCell(item.twin),
    dimaWins(item.dima),
    item.verdict,
  ]);
  levelRows.push([
    'сводный, веса игрока',
    EMPTY,
    `${number(honesty.overall.twinPct)} %`,
    dimaWins(honesty.overall.dima),
    honesty.overall.verdict,
  ]);
  const outcomeRows = honesty.outcomes.map((item) => [
    item.name,
    measureCell(item.dima, true),
    measureCount(item.dima),
    measureCell(item.twin, false),
    item.verdict,
  ]);
  const found = violations(honesty);
  return [
    'Винрейт',
    ...table(['Уровень', 'Раундов двойника', 'Двойник', 'Игрок', 'Вердикт'], levelRows),
    '',
    'Исходы',
    ...table(['Метрика', 'Игрок', 'n', 'Двойник', 'Вердикт'], outcomeRows),
    '',
    'Входы',
    ...table(['Метрика', 'Игрок', 'Двойник', 'Допуск', 'Вердикт'], inputRows(honesty.inputs)),
    ...edgeLines(honesty.inputs),
    '',
    `Отпечаток команд: ${print.toString(16).padStart(PRINT_DIGITS, '0')}`,
    found.length === 0 ? 'Итог: честен' : `Итог: нарушения — ${found.join('; ')}`,
  ];
}

export interface CalibrationSummary {
  inputs: readonly InputCheck[];
  sensitivity: readonly Sensitivity[];
  evaluations: number;
  isConverged: boolean;
}

export function calibrationReport(summary: CalibrationSummary): string[] {
  const rows = summary.inputs.map((input) => [
    input.name,
    number(input.dima, 2),
    number(input.twin, 2),
    `${input.param} = ${input.value.toFixed(3)}`,
  ]);
  const sensitivityRows = summary.sensitivity.map((item) => [
    item.name,
    item.points.map((point) => `${number(point.value, 2)} → ${number(point.measured, 2)}`).join('; '),
  ]);
  return [
    ...table(['Вход', 'Игрок', 'Двойник', 'Параметр'], rows),
    ...edgeLines(summary.inputs),
    '',
    'Чувствительность: параметр → метрика по грубой сетке первого прохода',
    ...table(['Вход', 'Сетка'], sensitivityRows),
    '',
    `Прогонов стенда: ${String(summary.evaluations)}; ${summary.isConverged ? 'все входы в допуске' : 'не все входы в допуске'}`,
  ];
}
