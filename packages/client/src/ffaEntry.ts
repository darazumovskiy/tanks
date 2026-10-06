import { FFA_SIZES, type FfaSize } from '@tanks/shared/engine';
import { mountDropdown } from './dropdown.js';

const FFA_SIZE_KEY = 'tanks.ffaSize';
const DEFAULT_FFA_SIZE: FfaSize = 30;
const HINT_OPEN_CLASS = 'is-open';
const FFA_SIZE_INFO: Readonly<Record<FfaSize, { name: string; tagline: string }>> = {
  10: { name: 'Стычка', tagline: 'Маленькая карта — враг всегда рядом' },
  30: { name: 'Толпа', tagline: 'Золотая середина' },
  50: { name: 'Мясорубка', tagline: 'Огромная карта, полный хаос' },
};

export interface FfaEntryElements {
  start: HTMLButtonElement;
  info: HTMLButtonElement;
  hint: HTMLElement;
  // Строка под кнопкой, пока она недоступна: что сделать, чтобы попасть в бой.
  locked: HTMLElement;
  sizeToggle: HTMLButtonElement;
  sizeList: HTMLElement;
}

export interface FfaEntryActions {
  // Ник и танк запоминаются на устройстве до перехода: страница боя берёт их оттуда.
  save: () => void;
  navigate: (path: string) => void;
}

function parseFfaSize(raw: string | null): FfaSize {
  return FFA_SIZES.find((size) => String(size) === raw) ?? DEFAULT_FFA_SIZE;
}

function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

// Строка списка — как уровень бота: число танков, название и строка описания.
function sizeOption(size: FfaSize): HTMLElement[] {
  const info = FFA_SIZE_INFO[size];
  const body = span('level-body', '');
  body.append(span('level-name', info.name), span('level-tagline', info.tagline));
  return [span('level-badge', String(size)), body];
}

function sizeToggleContent(size: FfaSize): HTMLElement[] {
  return [span('ffa-size-count', String(size)), span('ffa-size-unit', 'танков')];
}

// Вход в общий бой с главной: размер игры — свой выпадающий список, выбор запоминается на устройстве; кнопка доступна,
// когда очки танка розданы, и ведёт в игру выбранного размера; подсказка открывается иконкой «i».
export function mountFfaEntry(
  elements: FfaEntryElements,
  actions: FfaEntryActions,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
): { setReady(isReady: boolean): void } {
  const { start, info, hint, locked } = elements;
  const size = mountDropdown(
    { toggle: elements.sizeToggle, list: elements.sizeList },
    {
      values: FFA_SIZES,
      selected: parseFfaSize(storage.getItem(FFA_SIZE_KEY)),
      optionClass: 'level',
      dataKey: 'size',
      optionContent: sizeOption,
      toggleContent: sizeToggleContent,
      onSelect: (selected) => {
        storage.setItem(FFA_SIZE_KEY, String(selected));
      },
    },
  );
  start.addEventListener('click', () => {
    actions.save();
    actions.navigate(`/ffa/${String(size.selected())}`);
  });
  info.addEventListener('click', () => {
    const isOpen = hint.hidden;
    hint.hidden = !isOpen;
    info.classList.toggle(HINT_OPEN_CLASS, isOpen);
    info.setAttribute('aria-expanded', String(isOpen));
  });
  return {
    setReady: (isReady) => {
      start.disabled = !isReady;
      locked.hidden = isReady;
    },
  };
}
