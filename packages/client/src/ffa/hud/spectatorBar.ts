import type { FfaSpectatorModel } from '../session.js';
import { botMark, element, layer, setShown } from './dom.js';

// Плашка зрителя внизу по центру: за кем смотришь и как переключить.
export class SpectatorBarView {
  readonly element: HTMLDivElement;
  private readonly name: HTMLElement;
  private nameKey = '';

  constructor(isTouch: boolean) {
    this.element = layer('ffa-spectator');
    const label = element('p', 'ffa-spectator-label', 'Смотришь за: ');
    this.name = element('b', 'ffa-spectator-name');
    label.append(this.name);
    const hint = element('p', 'ffa-spectator-hint', isTouch ? 'коснись — следующий' : 'клик — следующий');
    this.element.append(label, hint);
  }

  update(model: FfaSpectatorModel | null): void {
    setShown(this.element, model !== null);
    if (model === null) {
      return;
    }
    const key = `${model.name}|${model.isBot ? 'b' : ''}`;
    if (key === this.nameKey) {
      return;
    }
    this.nameKey = key;
    this.name.replaceChildren(...(model.isBot ? [botMark()] : []), document.createTextNode(model.name));
  }
}
