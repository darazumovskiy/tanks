import type { FfaScreen } from '../session.js';
import { button, element, layer, setShown, setText } from './dom.js';

export interface FatalActions {
  // Вход заново: с пропуском — на то же место, без — новым игроком.
  rejoin(isWithToken: boolean): void;
  leave(): void;
  reload(): void;
}

type FatalScreen = Extract<FfaScreen, 'idle' | 'replaced' | 'update' | 'error'>;

interface FatalSpec {
  title: string;
  text: string;
  primary: { label: string; press: (actions: FatalActions) => void };
  hasHome: boolean;
}

const SPECS: Readonly<Record<FatalScreen, FatalSpec>> = {
  idle: {
    title: 'ВЫКИНУЛО ЗА БЕЗДЕЙСТВИЕ',
    text: 'Танк стоял слишком долго — место отдали другому.',
    primary: {
      label: 'Вернуться в бой',
      press: (actions) => {
        actions.rejoin(false);
      },
    },
    hasHome: true,
  },
  replaced: {
    title: 'ТЫ ИГРАЕШЬ В ДРУГОМ МЕСТЕ',
    text: 'Бой открыт в другой вкладке или на другом устройстве.',
    primary: {
      label: 'Играть здесь',
      press: (actions) => {
        actions.rejoin(true);
      },
    },
    hasHome: true,
  },
  update: {
    title: 'ВЫШЛО ОБНОВЛЕНИЕ',
    text: 'Перезагрузи — и в бой.',
    primary: {
      label: 'Обновить',
      press: (actions) => {
        actions.reload();
      },
    },
    hasHome: false,
  },
  error: {
    title: 'ЧТО-ТО ПОШЛО НЕ ТАК',
    text: 'Сервер нас не понял. Попробуем ещё раз?',
    primary: {
      label: 'Ещё раз',
      press: (actions) => {
        actions.rejoin(true);
      },
    },
    hasHome: true,
  },
};

function fatalSpec(screen: FfaScreen): FatalSpec | null {
  switch (screen) {
    case 'idle':
    case 'replaced':
    case 'update':
    case 'error':
      return SPECS[screen];
    default:
      return null;
  }
}

// Окончательные экраны: выкинуло, занято, обновление, ошибка — карточка по центру поверх затемнения.
export class FatalScreenView {
  readonly element: HTMLDivElement;
  private readonly title: HTMLHeadingElement;
  private readonly text: HTMLParagraphElement;
  private readonly buttons: HTMLDivElement;
  private shownSpec: FatalSpec | null = null;

  constructor(private readonly actions: FatalActions) {
    this.element = layer('ffa-screen ffa-fatal');
    const card = element('div', 'ffa-card ffa-fatal-card');
    this.title = element('h2', 'ffa-title');
    this.text = element('p', 'ffa-fatal-text');
    this.buttons = element('div', 'ffa-buttons');
    card.append(this.title, this.text, this.buttons);
    this.element.append(card);
  }

  update(screen: FfaScreen): void {
    const spec = fatalSpec(screen);
    setShown(this.element, spec !== null);
    if (spec === null || spec === this.shownSpec) {
      return;
    }
    this.shownSpec = spec;
    setText(this.title, spec.title);
    setText(this.text, spec.text);
    const primary = button(spec.primary.label, true, () => {
      spec.primary.press(this.actions);
    });
    const home = button('На главную', false, () => {
      this.actions.leave();
    });
    this.buttons.replaceChildren(...(spec.hasHome ? [primary, home] : [primary]));
  }
}
