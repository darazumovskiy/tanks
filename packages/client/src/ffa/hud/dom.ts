// Помощники разметки интерфейса толпы: элемент с классом, текст без лишних перерисовок, показ слоя с переходом.

export const SHOWN_CLASS = 'is-shown';
const LAYER_CLASS = 'ffa-layer';
const SVG_NS = 'http://www.w3.org/2000/svg';

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== '') {
    node.textContent = text;
  }
  return node;
}

// Слой появляется и гаснет переходом прозрачности; скрытый не ловит нажатия.
export function layer(className: string): HTMLDivElement {
  return element('div', `${LAYER_CLASS} ${className}`);
}

export function setText(target: HTMLElement, text: string): void {
  if (target.textContent !== text) {
    target.textContent = text;
  }
}

const writtenStyles = new WeakMap<HTMLElement, Map<string, string>>();

// Свойство стиля пишется, только когда значение сменилось: браузер не пересчитывает стиль каждый кадр.
export function setStyle(target: HTMLElement, property: string, value: string): void {
  let written = writtenStyles.get(target);
  if (written === undefined) {
    written = new Map();
    writtenStyles.set(target, written);
  }
  if (written.get(property) === value) {
    return;
  }
  written.set(property, value);
  target.style.setProperty(property, value);
}

export function setShown(target: HTMLElement, isShown: boolean): void {
  target.classList.toggle(SHOWN_CLASS, isShown);
}

export function button(label: string, isPrimary: boolean, onPress: () => void): HTMLButtonElement {
  const node = element('button', isPrimary ? 'ffa-button is-primary' : 'ffa-button', label);
  node.type = 'button';
  node.addEventListener('click', onPress);
  return node;
}

// Отметка бота перед ником — тем же словом, что над танком.
export function botMark(): HTMLSpanElement {
  return element('span', 'ffa-bot', 'БОТ');
}

// Значок из штрихов: viewBox 20 × 20, цвет — currentColor.
export function strokeIcon(className: string, paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// Русское число: 1, 21 — one; 2–4, 22–24 — few; остальное, в том числе 11–14, — many.
export function plural(count: number, one: string, few: string, many: string): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) {
    return many;
  }
  if (last === 1) {
    return one;
  }
  return last >= 2 && last <= 4 ? few : many;
}

// Место в таблице: «3-й из 30».
export function placeText(place: number, total: number): string {
  return `${String(place)}-й из ${String(total)}`;
}
