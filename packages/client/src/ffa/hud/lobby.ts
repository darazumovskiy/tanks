import type { FfaLobbyModel, FfaRosterNick } from '../session.js';
import { botMark, button, element, layer, plural, setShown, setStyle, setText } from './dom.js';
import { Hint } from './hint.js';

export interface LobbyActions {
  // Копирует ссылку на игру этого размера; отклонение — скопировать не вышло.
  invite(): Promise<void>;
  leave(): void;
}

const COPIED_MS = 2000;
const ROSTER_LINES = 2;
const READY_CLASS = 'is-ready';
const PERCENT = 100;

function missingText(missing: number): string {
  return `Ещё ${String(missing)} ${plural(missing, 'смельчак', 'смельчака', 'смельчаков')} — и в бой`;
}

function statusText(model: FfaLobbyModel): string {
  if (model.players < model.minimum) {
    return missingText(model.minimum - model.players);
  }
  if (model.isFull) {
    return 'Полный сбор — поехали!';
  }
  if (model.startInS === null) {
    return '';
  }
  return `Старт через ${String(Math.max(1, Math.ceil(model.startInS)))}`;
}

function hintText(minimum: number): string {
  const gathered = plural(minimum, 'Набрался', 'Набралось', 'Набралось');
  const tanks = plural(minimum, 'танк', 'танка', 'танков');
  return `${gathered} ${String(minimum)} ${tanks} — через пять секунд в бой. Опоздавшие влетят прямо в драку.`;
}

function nickChip(nick: FfaRosterNick): HTMLSpanElement {
  const chip = element('span', nick.isMe ? 'ffa-nick is-me' : 'ffa-nick');
  if (nick.isBot) {
    chip.append(botMark());
  }
  chip.append(document.createTextNode(nick.name));
  return chip;
}

// Лобби: непрозрачная карточка поверх пола карты — сколько набралось, сколько нужно, скоро ли старт, кто уже тут.
// Облако ников — в две строки; не поместившиеся — «+N».
export class LobbyView {
  readonly element: HTMLDivElement;
  private readonly count: HTMLSpanElement;
  private readonly capacity: HTMLSpanElement;
  private readonly fill: HTMLDivElement;
  private readonly mark: HTMLDivElement;
  private readonly markLabel: HTMLSpanElement;
  private readonly status: HTMLParagraphElement;
  private readonly roster: HTMLDivElement;
  private readonly more: HTMLSpanElement;
  private readonly copied: HTMLDivElement;
  private readonly hint: Hint;
  private rosterKey = '';
  private lastNow = 0;
  private copiedAt: number | null = null;

  constructor(actions: LobbyActions) {
    this.element = layer('ffa-screen ffa-lobby');
    const card = element('div', 'ffa-card ffa-lobby-card');
    const head = element('div', 'ffa-lobby-head');
    const title = element('h2', 'ffa-title', 'СОБИРАЕМ ТОЛПУ');
    this.hint = new Hint('');
    const counter = element('div', 'ffa-lobby-count');
    this.count = element('span', 'ffa-lobby-players');
    this.capacity = element('span', 'ffa-lobby-capacity');
    counter.append(this.count, this.capacity);
    head.append(title, this.hint.element, counter);
    const progress = element('div', 'ffa-progress');
    this.fill = element('div', 'ffa-progress-fill');
    this.mark = element('div', 'ffa-progress-mark');
    this.markLabel = element('span', 'ffa-progress-mark-label');
    this.mark.append(this.markLabel);
    progress.append(this.fill, this.mark);
    this.status = element('p', 'ffa-lobby-status');
    this.roster = element('div', 'ffa-roster');
    this.more = element('span', 'ffa-nick ffa-roster-more');
    const buttons = element('div', 'ffa-buttons');
    const invite = button('Позвать друга', true, () => {
      actions.invite().then(
        () => {
          this.copiedAt = this.lastNow;
        },
        () => undefined,
      );
    });
    this.copied = layer('ffa-lobby-copied');
    this.copied.textContent = 'Ссылка у тебя — кидай другу';
    buttons.append(
      invite,
      button('Выйти', false, () => {
        actions.leave();
      }),
      this.copied,
    );
    card.append(head, progress, this.status, this.roster, buttons);
    this.element.append(card);
    window.addEventListener('resize', () => {
      this.fitRoster();
    });
    if ('fonts' in document) {
      void document.fonts.ready.then(() => {
        this.fitRoster();
      });
    }
  }

  update(model: FfaLobbyModel | null, now: number): void {
    this.lastNow = now;
    setShown(this.element, model !== null);
    if (model === null) {
      this.hint.close();
      return;
    }
    setText(this.count, String(model.players));
    setText(this.capacity, ` / ${String(model.capacity)}`);
    const capacity = Math.max(1, model.capacity);
    setStyle(this.fill, 'width', `${String(Math.min(1, model.players / capacity) * PERCENT)}%`);
    this.fill.classList.toggle(READY_CLASS, model.players >= model.minimum);
    setStyle(this.mark, 'left', `${String(Math.min(1, model.minimum / capacity) * PERCENT)}%`);
    setText(this.markLabel, String(model.minimum));
    setText(this.status, statusText(model));
    this.hint.setText(hintText(model.minimum));
    setShown(this.copied, this.copiedAt !== null && now - this.copiedAt < COPIED_MS);
    this.updateRoster(model.roster);
  }

  private updateRoster(roster: readonly FfaRosterNick[]): void {
    const key = roster.map((nick) => `${String(nick.id)}:${nick.name}:${nick.isBot ? 'b' : ''}`).join('|');
    if (key === this.rosterKey) {
      return;
    }
    this.rosterKey = key;
    this.roster.replaceChildren(...roster.map(nickChip), this.more);
    this.fitRoster();
  }

  // Ники идут по строкам по порядку: в две строки влезают первые k. «+N» встаёт в конец второй строки и вытесняет
  // последние ники, пока не поместится сам.
  private fitRoster(): void {
    const chips = [...this.roster.children].filter(
      (chip): chip is HTMLElement => chip instanceof HTMLElement && chip !== this.more,
    );
    for (const chip of chips) {
      chip.hidden = false;
    }
    this.more.hidden = true;
    const tops = chips.map((chip) => chip.offsetTop);
    const lineTops = [...new Set(tops)].sort((a, b) => a - b);
    const lastTop = lineTops[ROSTER_LINES - 1];
    if (lastTop === undefined || lineTops.length <= ROSTER_LINES) {
      return;
    }
    let shownCount = tops.filter((top) => top <= lastTop).length;
    const apply = (): void => {
      for (const [index, chip] of chips.entries()) {
        chip.hidden = index >= shownCount;
      }
      setText(this.more, `+${String(chips.length - shownCount)}`);
    };
    this.more.hidden = false;
    apply();
    while (shownCount > 1 && this.more.offsetTop > lastTop) {
      shownCount--;
      apply();
    }
  }
}
