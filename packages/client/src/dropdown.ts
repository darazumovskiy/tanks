const OPEN_CLASS = 'is-open';
const SELECTED_CLASS = 'is-selected';
const UP_CLASS = 'is-up';
// Отступ панели от кнопки — как в style.css у `.dropdown-list`.
const LIST_GAP_PX = 6;

export interface DropdownElements {
  toggle: HTMLButtonElement;
  list: HTMLElement;
}

// optionClass и dataKey — класс строки списка и имя её data-атрибута со значением; optionContent — содержимое
// строки, toggleContent — что показывает кнопка при выбранном значении.
export interface DropdownConfig<T> {
  values: readonly T[];
  selected: T;
  optionClass: string;
  dataKey: string;
  optionContent: (value: T) => HTMLElement[];
  toggleContent: (value: T) => HTMLElement[];
  onSelect: (value: T) => void;
}

// Выпадающий список своего оформления: кнопка показывает выбранное, панель — все варианты. Закрывается выбором,
// касанием мимо и Escape.
export function mountDropdown<T>(elements: DropdownElements, config: DropdownConfig<T>): { selected: () => T } {
  const { toggle, list } = elements;
  let selected = config.selected;
  const rows = config.values.map((value) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = config.optionClass;
    row.dataset[config.dataKey] = String(value);
    row.setAttribute('role', 'option');
    row.append(...config.optionContent(value));
    return { value, row };
  });
  // Снизу панель не помещается на экран, а сверху места больше — раскрывается вверх: на низком экране телефона
  // нижние строки иначе уходят за край.
  const setOpen = (isOpen: boolean): void => {
    list.hidden = !isOpen;
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.classList.toggle(OPEN_CLASS, isOpen);
    if (!isOpen) {
      return;
    }
    const box = toggle.getBoundingClientRect();
    const roomBelow = window.innerHeight - box.bottom;
    const isTooLow = list.offsetHeight + LIST_GAP_PX > roomBelow;
    list.classList.toggle(UP_CLASS, isTooLow && box.top > roomBelow);
  };
  const render = (): void => {
    for (const { value, row } of rows) {
      const isSelected = value === selected;
      row.classList.toggle(SELECTED_CLASS, isSelected);
      row.setAttribute('aria-selected', String(isSelected));
    }
    const chevron = document.createElement('span');
    chevron.className = 'dropdown-chevron';
    chevron.textContent = '▾';
    toggle.replaceChildren(...config.toggleContent(selected), chevron);
  };
  for (const { value, row } of rows) {
    row.addEventListener('click', () => {
      selected = value;
      config.onSelect(value);
      render();
      setOpen(false);
      toggle.focus();
    });
    list.append(row);
  }
  toggle.addEventListener('click', () => {
    setOpen(list.hidden);
  });
  document.addEventListener('pointerdown', (event) => {
    const isInside = event.target instanceof Node && list.parentElement?.contains(event.target) === true;
    if (!isInside) {
      setOpen(false);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
    }
  });
  render();
  return { selected: () => selected };
}
