import type { FfaDeathModel } from '../session.js';
import { botMark, element, layer, setShown, setText } from './dom.js';

type Tone = 'enemy' | 'danger' | 'zone' | 'calm';

interface CardText {
  kicker: string;
  title: string;
  isBot: boolean;
  note: string;
  tone: Tone;
}

const TONES: readonly Tone[] = ['enemy', 'danger', 'zone', 'calm'];

function cardText(model: FfaDeathModel): CardText {
  switch (model.kind) {
    case 'killed':
      if (model.killerName === null) {
        return { kicker: '', title: 'ТЕБЯ ПОДБИЛИ', isBot: false, note: '', tone: 'enemy' };
      }
      return {
        kicker: 'ТЕБЯ ПОДБИЛ',
        title: model.killerName,
        isBot: model.isKillerBot,
        note: model.isRicochet ? 'рикошетом' : '',
        tone: 'enemy',
      };
    case 'self':
      return { kicker: '', title: 'САМ СЕБЯ!', isBot: false, note: 'Рикошет — коварная штука', tone: 'danger' };
    case 'zone':
      return { kicker: '', title: 'ЗОНА ДОЖАЛА', isBot: false, note: 'Держись внутри круга', tone: 'zone' };
    case 'out':
      return {
        kicker: '',
        title: 'ТЫ ВЫБЫЛ',
        isBot: false,
        note: 'Финал без возрождений — смотрим, кто кого',
        tone: 'calm',
      };
    case 'late':
      return { kicker: '', title: 'ФИНАЛ УЖЕ ИДЁТ', isBot: false, note: 'Следующий матч — твой', tone: 'calm' };
  }
}

// «Тебя подбил» с отсчётом до появления; в финале — «ты выбыл»; вошедшему в финал — «финал уже идёт».
export class DeathCardView {
  readonly element: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly kicker: HTMLParagraphElement;
  private readonly title: HTMLHeadingElement;
  private readonly note: HTMLParagraphElement;
  private readonly respawn: HTMLParagraphElement;
  private readonly respawnValue: HTMLElement;
  private titleKey = '';

  constructor() {
    this.element = layer('ffa-death');
    this.card = element('div', 'ffa-card ffa-death-card');
    this.kicker = element('p', 'ffa-death-kicker');
    this.title = element('h2', 'ffa-death-title');
    this.note = element('p', 'ffa-death-note');
    this.respawn = element('p', 'ffa-death-respawn', 'Снова в бою через ');
    this.respawnValue = element('b', 'ffa-death-respawn-value');
    this.respawn.append(this.respawnValue);
    this.card.append(this.kicker, this.title, this.note, this.respawn);
    this.element.append(this.card);
  }

  update(model: FfaDeathModel | null): void {
    setShown(this.element, model !== null);
    if (model === null) {
      return;
    }
    const text = cardText(model);
    for (const tone of TONES) {
      this.card.classList.toggle(`is-${tone}`, tone === text.tone);
    }
    setText(this.kicker, text.kicker);
    this.kicker.hidden = text.kicker === '';
    const titleKey = `${text.title}|${text.isBot ? 'b' : ''}`;
    if (titleKey !== this.titleKey) {
      this.titleKey = titleKey;
      this.title.replaceChildren(...(text.isBot ? [botMark()] : []), document.createTextNode(text.title));
    }
    setText(this.note, text.note);
    this.note.hidden = text.note === '';
    const respawnInS = 'respawnInS' in model ? model.respawnInS : null;
    this.respawn.hidden = respawnInS === null;
    if (respawnInS !== null) {
      setText(this.respawnValue, String(respawnInS));
    }
  }
}
