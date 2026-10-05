// Кнопка «В общий бой» ведёт сюда: игра на 30 мест.
const FFA_ENTRY_PATH = '/ffa';

const HINT_OPEN_CLASS = 'is-open';

export interface FfaEntryElements {
  start: HTMLButtonElement;
  info: HTMLButtonElement;
  hint: HTMLElement;
  // Строка под кнопкой, пока она недоступна: что сделать, чтобы попасть в бой.
  locked: HTMLElement;
}

export interface FfaEntryActions {
  // Ник и танк запоминаются на устройстве до перехода: страница боя берёт их оттуда.
  save: () => void;
  navigate: (path: string) => void;
}

// Вход в общий бой с главной: кнопка доступна, когда очки танка розданы; подсказка открывается иконкой «i».
export function mountFfaEntry(
  elements: FfaEntryElements,
  actions: FfaEntryActions,
): { setReady(isReady: boolean): void } {
  const { start, info, hint, locked } = elements;
  start.addEventListener('click', () => {
    actions.save();
    actions.navigate(FFA_ENTRY_PATH);
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
