import type { FfaResultRow, FfaResultsModel, FfaResultsTitle } from '../session.js';
import { botMark, button, element, layer, placeText, setShown, setText } from './dom.js';
import { Hint } from './hint.js';

const TITLES: Readonly<Record<FfaResultsTitle, string>> = {
  champion: 'ЧЕМПИОН!',
  podium: 'НА ПЬЕДЕСТАЛЕ',
  solid: 'КРЕПКО',
  nextTime: 'В СЛЕДУЮЩИЙ РАЗ',
  notPlayed: 'СЛЕДУЮЩИЙ МАТЧ — ТВОЙ',
};
const TITLE_KINDS = Object.keys(TITLES);
const COLUMNS = ['#', 'Танкист', 'Подбил', 'Погиб', 'Польза'];
const EFFICIENCY_HINT = 'Сколько урона раздал на каждый полученный. Больше единицы — ты в плюсе.';
const GAP_TEXT = '···';
const DECIMAL_COMMA = ',';

// Польза: «×1,4» с одним знаком после запятой; без полученного урона и смертей — «—».
function efficiencyText(efficiency: number | null): string {
  if (efficiency === null) {
    return '—';
  }
  return `×${efficiency.toFixed(1).replace('.', DECIMAL_COMMA)}`;
}

function cell(text: string, className: string): HTMLTableCellElement {
  return element('td', className, text);
}

function resultRow(row: FfaResultRow): HTMLTableRowElement {
  const node = element('tr', row.isMe ? 'ffa-results-row is-me' : 'ffa-results-row');
  const name = element('td', 'ffa-results-name');
  if (row.isBot) {
    name.append(botMark());
  }
  name.append(document.createTextNode(row.name));
  node.append(
    cell(String(row.place), 'ffa-results-place-cell'),
    name,
    cell(String(row.kills), 'ffa-results-number'),
    cell(String(row.deaths), 'ffa-results-number'),
    cell(efficiencyText(row.efficiency), 'ffa-results-number'),
  );
  return node;
}

function isSameRow(a: FfaResultRow, b: FfaResultRow): boolean {
  return (
    a.place === b.place &&
    a.name === b.name &&
    a.isBot === b.isBot &&
    a.isMe === b.isMe &&
    a.kills === b.kills &&
    a.deaths === b.deaths &&
    a.efficiency === b.efficiency &&
    a.isAfterGap === b.isAfterGap
  );
}

function isSameRows(a: readonly FfaResultRow[], b: readonly FfaResultRow[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, index) => {
      const other = b[index];
      return other !== undefined && isSameRow(row, other);
    })
  );
}

function gapRow(): HTMLTableRowElement {
  const node = element('tr', 'ffa-results-gap');
  const gap = cell(GAP_TEXT, '');
  gap.colSpan = COLUMNS.length;
  node.append(gap);
  return node;
}

// Итоги матча: заголовок по месту, своё место, отсчёт до следующего матча, таблица лучших и своя строка с соседями.
export class ResultsView {
  readonly element: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly title: HTMLHeadingElement;
  private readonly place: HTMLParagraphElement;
  private readonly next: HTMLParagraphElement;
  private readonly body: HTMLTableSectionElement;
  private readonly hint = new Hint(EFFICIENCY_HINT);
  private rows: readonly FfaResultRow[] = [];

  constructor(leave: () => void) {
    this.element = layer('ffa-screen ffa-results');
    this.card = element('div', 'ffa-card ffa-results-card');
    const side = element('div', 'ffa-results-side');
    this.title = element('h2', 'ffa-results-title');
    this.place = element('p', 'ffa-results-place');
    this.next = element('p', 'ffa-results-next');
    const buttons = element('div', 'ffa-buttons');
    buttons.append(button('Выйти', false, leave));
    side.append(this.title, this.place, this.next, buttons);
    const table = element('table', 'ffa-results-table');
    const head = element('thead', '');
    const headRow = element('tr', '');
    for (const column of COLUMNS) {
      const th = element('th', '', column);
      if (column === COLUMNS[COLUMNS.length - 1]) {
        th.append(this.hint.element);
      }
      headRow.append(th);
    }
    head.append(headRow);
    this.body = element('tbody', '');
    table.append(head, this.body);
    this.card.append(side, table);
    this.element.append(this.card);
  }

  update(model: FfaResultsModel | null): void {
    setShown(this.element, model !== null);
    if (model === null) {
      this.hint.close();
      return;
    }
    for (const kind of TITLE_KINDS) {
      this.card.classList.toggle(`is-${kind}`, kind === model.title);
    }
    setText(this.title, TITLES[model.title]);
    this.place.hidden = model.place === null;
    if (model.place !== null) {
      setText(this.place, placeText(model.place, model.total));
    }
    setText(
      this.next,
      model.nextMatchInS === null ? 'Ждём, пока соберёмся' : `Следующий матч через ${String(model.nextMatchInS)}`,
    );
    if (isSameRows(model.rows, this.rows)) {
      return;
    }
    this.rows = model.rows;
    this.body.replaceChildren(
      ...model.rows.flatMap((row) => (row.isAfterGap ? [gapRow(), resultRow(row)] : [resultRow(row)])),
    );
  }
}
