import type { FfaCountdownModel } from '../session.js';
import { element, layer, setShown, setText } from './dom.js';

const GO_TEXT = 'В БОЙ!';
const GO_CLASS = 'is-go';

// Отсчёт перед матчем: крупно 3, 2, 1, «В БОЙ!»; не в матче — подпись о высадке с началом боя.
export class CountdownView {
  readonly element: HTMLDivElement;
  private readonly value: HTMLDivElement;
  private readonly note: HTMLParagraphElement;
  private tickParity = 0;

  constructor() {
    this.element = layer('ffa-countdown');
    this.value = element('div', 'ffa-countdown-value');
    this.note = element('p', 'ffa-countdown-note', 'Высаживаемся с началом боя');
    this.element.append(this.value, this.note);
  }

  update(model: FfaCountdownModel | null): void {
    setShown(this.element, model !== null);
    if (model === null) {
      return;
    }
    const text = model.value === null ? GO_TEXT : String(model.value);
    // Новая цифра — новое имя анимации: CSS проигрывает появление заново.
    if (this.value.textContent !== text) {
      this.tickParity = 1 - this.tickParity;
      this.value.dataset.tick = String(this.tickParity);
    }
    setText(this.value, text);
    this.value.classList.toggle(GO_CLASS, model.value === null);
    this.note.hidden = !model.isLanding;
  }
}
