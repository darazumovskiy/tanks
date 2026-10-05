import { describe, expect, it } from 'vitest';
import { shownText } from '../../testing/hudText.js';
import type { FfaResultRow, FfaResultsModel } from '../session.js';
import { ResultsView } from './results.js';

function resultRow(place: number, overrides: Partial<FfaResultRow> = {}): FfaResultRow {
  return {
    place,
    name: `Т${String(place)}`,
    isBot: false,
    isMe: false,
    kills: 10 - place,
    deaths: place,
    efficiency: 1.44,
    isAfterGap: false,
    ...overrides,
  };
}

function model(overrides: Partial<FfaResultsModel> = {}): FfaResultsModel {
  return {
    title: 'solid',
    place: 7,
    total: 20,
    rows: [
      resultRow(1),
      resultRow(2, { isBot: true, efficiency: null }),
      resultRow(6, { isAfterGap: true, efficiency: 0.96 }),
      resultRow(7, { isMe: true, name: 'Дима', efficiency: 2.06 }),
      resultRow(8),
    ],
    nextMatchInS: 12,
    ...overrides,
  };
}

function mount(): { view: ResultsView; left: string[] } {
  const left: string[] = [];
  const view = new ResultsView(() => left.push('leave'));
  document.body.replaceChildren(view.element);
  return { view, left };
}

describe('итоги', () => {
  it('заголовок, своё место, отсчёт; строки с пропуском, своя выделена, польза «×1,4» или «—»', () => {
    const { view } = mount();
    view.update(model());
    expect(view.element.classList.contains('is-shown')).toBe(true);
    expect(shownText(view.element.querySelector('.ffa-results-side') ?? document.body)).toBe(
      'КРЕПКО 7-й из 20 Следующий матч через 12 Выйти',
    );
    const rows = [...view.element.querySelectorAll('tbody tr')];
    expect(rows.map((row) => shownText(row))).toEqual([
      '1 Т1 9 1 ×1,4',
      '2 БОТ Т2 8 2 —',
      '···',
      '6 Т6 4 6 ×1,0',
      '7 Дима 3 7 ×2,1',
      '8 Т8 2 8 ×1,4',
    ]);
    expect(rows.map((row) => row.classList.contains('is-me'))).toEqual([false, false, false, false, true, false]);
    expect(rows[2]?.classList.contains('ffa-results-gap')).toBe(true);
  });

  it.each([
    ['champion', 'ЧЕМПИОН!'],
    ['podium', 'НА ПЬЕДЕСТАЛЕ'],
    ['solid', 'КРЕПКО'],
    ['nextTime', 'В СЛЕДУЮЩИЙ РАЗ'],
    ['notPlayed', 'СЛЕДУЮЩИЙ МАТЧ — ТВОЙ'],
  ] as const)('заголовок %s — «%s» и класс карточки', (title, text) => {
    const { view } = mount();
    view.update(model({ title }));
    expect(view.element.querySelector('.ffa-results-title')?.textContent).toBe(text);
    expect(view.element.querySelector('.ffa-results-card')?.classList.contains(`is-${title}`)).toBe(true);
  });

  it('ждём сбора; не в матче — места нет; «Выйти»; польза — с подсказкой «i»; скрытые итоги гаснут', () => {
    const { view, left } = mount();
    view.update(model({ nextMatchInS: null, place: null, title: 'notPlayed' }));
    expect(view.element.querySelector('.ffa-results-next')?.textContent).toBe('Ждём, пока соберёмся');
    expect(view.element.querySelector<HTMLElement>('.ffa-results-place')?.hidden).toBe(true);
    expect(view.element.querySelector('th:last-child .ffa-hint-text')?.textContent).toBe(
      'Сколько урона раздал на каждый полученный. Больше единицы — ты в плюсе.',
    );
    view.element.querySelector<HTMLButtonElement>('.ffa-button')?.click();
    expect(left).toEqual(['leave']);
    view.update(null);
    expect(view.element.classList.contains('is-shown')).toBe(false);
  });

  it('те же строки новыми объектами — узлы таблицы прежние; изменилась строка — таблица пересобрана', () => {
    const { view } = mount();
    view.update(model());
    const first = view.element.querySelector('tbody tr');
    view.update(model());
    expect(view.element.querySelector('tbody tr')).toBe(first);
    view.update(model({ rows: [resultRow(1, { kills: 12 })] }));
    expect(view.element.querySelector('tbody tr')).not.toBe(first);
    expect(shownText(view.element.querySelector('tbody') ?? document.body)).toBe('1 Т1 12 1 ×1,4');
  });

  it('открытая подсказка закрывается со скрытием итогов: при следующем показе она закрыта', () => {
    const { view } = mount();
    view.update(model());
    view.element.querySelector<HTMLButtonElement>('.ffa-hint-toggle')?.click();
    expect(view.element.querySelector('.ffa-hint')?.classList.contains('is-open')).toBe(true);
    view.update(null);
    view.update(model());
    expect(view.element.querySelector('.ffa-hint')?.classList.contains('is-open')).toBe(false);
  });
});
