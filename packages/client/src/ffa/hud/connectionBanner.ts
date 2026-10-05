import type { FfaConnectionNotice } from '../session.js';
import { element, layer, setShown, setText } from './dom.js';

const TEXTS: Readonly<Record<FfaConnectionNotice, { title: string; note: string }>> = {
  lost: { title: 'СВЯЗЬ ПРОПАЛА', note: 'Держим место, возвращаемся…' },
  returned: { title: 'ВЕРНУЛИСЬ!', note: '' },
  late: { title: 'НЕ УСПЕЛИ', note: 'Место ушло — заходим заново' },
};
const NOTICES: readonly FfaConnectionNotice[] = ['lost', 'returned', 'late'];

// Баннер связи под таймером: пропала и возвращаемся, вернулись, не успели.
export class ConnectionBannerView {
  readonly element: HTMLDivElement;
  private readonly title: HTMLSpanElement;
  private readonly note: HTMLSpanElement;

  constructor() {
    this.element = layer('ffa-pill ffa-connection');
    this.title = element('span', 'ffa-pill-title');
    this.note = element('span', 'ffa-pill-note');
    this.element.append(element('span', 'ffa-spinner'), this.title, this.note);
  }

  update(notice: FfaConnectionNotice | null): void {
    setShown(this.element, notice !== null);
    if (notice === null) {
      return;
    }
    for (const candidate of NOTICES) {
      this.element.classList.toggle(`is-${candidate}`, candidate === notice);
    }
    const text = TEXTS[notice];
    setText(this.title, text.title);
    setText(this.note, text.note);
    this.note.hidden = text.note === '';
  }
}
