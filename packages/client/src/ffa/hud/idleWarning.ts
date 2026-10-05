import { element, layer, setShown, setText } from './dom.js';

// «Ты тут?» под таймером с отсчётом до выхода; сервер перестал присылать отсчёт — гаснет.
export class IdleWarningView {
  readonly element: HTMLDivElement;
  private readonly note: HTMLSpanElement;

  constructor() {
    this.element = layer('ffa-pill ffa-idle');
    this.note = element('span', 'ffa-pill-note');
    this.element.append(element('span', 'ffa-pill-title', 'ТЫ ТУТ?'), this.note);
  }

  update(secondsLeft: number | null): void {
    setShown(this.element, secondsLeft !== null);
    if (secondsLeft === null) {
      return;
    }
    setText(this.note, `Шевельнись — иначе выкинет через ${String(secondsLeft)}`);
  }
}
