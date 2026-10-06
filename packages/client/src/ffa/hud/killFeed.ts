import { FEED_LIFETIME_MS, type DeathCause, type FfaFeedRow } from '../session.js';
import { element, layer, setShown, setStyle, strokeIcon } from './dom.js';

// Строка гаснет последние 200 мс своей жизни.
const FADE_MS = 200;

// Рикошет — стрелка разворотом назад; зона — кольцо с центром; выбыл — перечёркнутый круг.
const RICOCHET_PATHS = ['M14.5 16 V8.5 A4.5 4.5 0 0 0 5.5 8.5 V13', 'M2.8 10.5 L5.5 13.2 L8.2 10.5'];
const ICON_PATHS: Readonly<Record<DeathCause, readonly string[]>> = {
  bullet: ['M5 5 L15 15', 'M15 5 L5 15'],
  ricochet: RICOCHET_PATHS,
  self: RICOCHET_PATHS,
  zone: ['M10 3 A7 7 0 1 1 9.99 3', 'M10 8 A2 2 0 1 1 9.99 8'],
  out: ['M10 3 A7 7 0 1 1 9.99 3', 'M5 15 L15 5'],
};

const NOTE_BY_CAUSE: Readonly<Partial<Record<DeathCause, string>>> = {
  self: 'сам себя',
  zone: 'сгорел в зоне',
  out: 'выбыл',
};

// Номер записи начинается с единицы в каждой сессии: узел строки узнаётся по номеру вместе с содержимым.
function rowKey(row: FfaFeedRow): string {
  return `${String(row.key)}|${row.killer}|${row.victim}|${row.cause}|${String(row.isMyKill)}|${String(row.isMyDeath)}`;
}

function nameSpan(name: string, isMe: boolean): HTMLSpanElement {
  return element('span', isMe ? 'ffa-feed-name is-me' : 'ffa-feed-name', name);
}

function feedRow(row: FfaFeedRow): HTMLDivElement {
  const node = element('div', 'ffa-feed-row');
  node.classList.toggle('is-my-kill', row.isMyKill);
  node.classList.toggle('is-my-death', row.isMyDeath);
  const icon = strokeIcon('ffa-feed-icon', ICON_PATHS[row.cause]);
  icon.dataset.cause = row.cause;
  const victim = nameSpan(row.victim, row.isMyDeath);
  const note = NOTE_BY_CAUSE[row.cause];
  if (note !== undefined) {
    node.append(victim, icon, element('span', 'ffa-feed-note', note));
    return node;
  }
  node.append(nameSpan(row.killer, row.isMyKill), icon, victim);
  return node;
}

// Лента убийств справа под табло: новые сверху, свои строки выделены, строка гаснет через 5 с.
export class KillFeedView {
  readonly element: HTMLDivElement;
  private readonly rows = new Map<string, HTMLDivElement>();

  constructor() {
    this.element = layer('ffa-feed');
  }

  update(rows: readonly FfaFeedRow[]): void {
    setShown(this.element, rows.length > 0);
    const keys = new Set(rows.map(rowKey));
    for (const [key, node] of this.rows) {
      if (!keys.has(key)) {
        node.remove();
        this.rows.delete(key);
      }
    }
    const nodes = rows.map((row) => {
      const key = rowKey(row);
      const node = this.rows.get(key) ?? feedRow(row);
      this.rows.set(key, node);
      setStyle(node, 'opacity', String(Math.min(1, Math.max(0, (FEED_LIFETIME_MS - row.ageMs) / FADE_MS))));
      return node;
    });
    const isSameOrder = nodes.every((node, index) => this.element.children[index] === node);
    if (!isSameOrder || this.element.children.length !== nodes.length) {
      this.element.replaceChildren(...nodes);
    }
  }
}
