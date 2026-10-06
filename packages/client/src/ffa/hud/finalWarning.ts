import type { FfaFinalModel } from '../session.js';
import { element, layer, setShown, setText } from './dom.js';

const STARTED_CLASS = 'is-started';

// Пока на поле есть боты, подбитый человек в финале возвращается — тексты говорят об этом.
const NOTES = {
  soon: { withBots: 'Потом первыми выбывают боты', withoutBots: 'Потом без возрождений' },
  started: { withBots: 'Подбили — вернёшься, пока живы боты', withoutBots: 'Подбили — смотришь до конца' },
} as const;

// Предупреждение о финале под таймером: «ФИНАЛ ЧЕРЕЗ 5…1», затем «ФИНАЛ!» на 2 с.
export class FinalWarningView {
  readonly element: HTMLDivElement;
  private readonly title: HTMLSpanElement;
  private readonly note: HTMLSpanElement;

  constructor() {
    this.element = layer('ffa-pill ffa-final');
    this.title = element('span', 'ffa-pill-title');
    this.note = element('span', 'ffa-pill-note');
    this.element.append(this.title, this.note);
  }

  update(model: FfaFinalModel | null): void {
    setShown(this.element, model !== null);
    if (model === null) {
      return;
    }
    const isStarted = model.kind === 'started';
    this.element.classList.toggle(STARTED_CLASS, isStarted);
    const notes = NOTES[model.kind];
    setText(this.note, model.hasBots ? notes.withBots : notes.withoutBots);
    if (isStarted) {
      setText(this.title, 'ФИНАЛ!');
      return;
    }
    setText(this.title, `ФИНАЛ ЧЕРЕЗ ${String(model.secondsLeft)}`);
  }
}
