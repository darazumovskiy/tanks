import type { FfaInviteNotice } from '../session.js';
import { element, layer, setShown, setText } from './dom.js';

const TEXTS: Readonly<Record<FfaInviteNotice, { title: string; note: string }>> = {
  full: { title: 'ИГРА ДРУГА ПОЛНА', note: 'Ты в соседней — зови сюда' },
  gone: { title: 'ТОЙ ИГРЫ УЖЕ НЕТ', note: 'Все разошлись — вот новая' },
};

// Плашка под таймером: пришёл по приглашению, а попал не к другу.
export class InviteBannerView {
  readonly element: HTMLDivElement;
  private readonly title: HTMLSpanElement;
  private readonly note: HTMLSpanElement;

  constructor() {
    this.element = layer('ffa-pill ffa-invite');
    this.title = element('span', 'ffa-pill-title');
    this.note = element('span', 'ffa-pill-note');
    this.element.append(this.title, this.note);
  }

  update(notice: FfaInviteNotice | null): void {
    setShown(this.element, notice !== null);
    if (notice === null) {
      return;
    }
    setText(this.title, TEXTS[notice].title);
    setText(this.note, TEXTS[notice].note);
  }
}
