import { element, setText } from './dom.js';

const OPEN_CLASS = 'is-open';
const ESCAPE_KEY = 'Escape';

// Иконка «i» с подсказкой мелким приглушённым текстом: касание открывает и закрывает, касание мимо и Esc закрывают.
// Текст появляется и гаснет одним переходом прозрачности.
export class Hint {
  readonly element: HTMLSpanElement;
  private readonly toggle: HTMLButtonElement;
  private readonly text: HTMLParagraphElement;
  private isOpen = false;

  constructor(text: string) {
    this.element = element('span', 'ffa-hint');
    this.toggle = element('button', 'ffa-hint-toggle', 'i');
    this.toggle.type = 'button';
    this.toggle.setAttribute('aria-label', 'Подробнее');
    this.text = element('p', 'ffa-hint-text', text);
    this.element.append(this.toggle, this.text);
    this.setOpen(false);
    this.toggle.addEventListener('click', () => {
      this.setOpen(!this.isOpen);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === ESCAPE_KEY) {
        this.close();
      }
    });
    // Захват: касание поля доходит до подсказки, даже если холст остановит его всплытие.
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (event.target instanceof Node && this.element.contains(event.target)) {
          return;
        }
        this.close();
      },
      true,
    );
  }

  setText(text: string): void {
    setText(this.text, text);
  }

  close(): void {
    if (this.isOpen) {
      this.setOpen(false);
    }
  }

  private setOpen(isOpen: boolean): void {
    this.isOpen = isOpen;
    this.element.classList.toggle(OPEN_CLASS, isOpen);
    this.toggle.setAttribute('aria-expanded', String(isOpen));
    this.text.setAttribute('aria-hidden', String(!isOpen));
  }
}
