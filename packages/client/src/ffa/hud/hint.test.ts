import { beforeEach, describe, expect, it } from 'vitest';
import { Hint } from './hint.js';

let hint: Hint;
let outside: HTMLDivElement;

function toggle(): HTMLButtonElement {
  const found = hint.element.querySelector<HTMLButtonElement>('.ffa-hint-toggle');
  if (found === null) {
    throw new Error('нет иконки «i»');
  }
  return found;
}

function text(): HTMLElement {
  const found = hint.element.querySelector<HTMLElement>('.ffa-hint-text');
  if (found === null) {
    throw new Error('нет текста подсказки');
  }
  return found;
}

function isOpen(): boolean {
  return hint.element.classList.contains('is-open');
}

function press(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
}

beforeEach(() => {
  hint = new Hint('Стреляет туда, где ты был.');
  outside = document.createElement('div');
  document.body.replaceChildren(hint.element, outside);
});

describe('подсказка «i»', () => {
  it('закрыта; касание открывает, второе закрывает; состояние — в aria-expanded, aria-hidden и классе', () => {
    expect(toggle().textContent).toBe('i');
    expect(isOpen()).toBe(false);
    expect(text().getAttribute('aria-hidden')).toBe('true');
    press(toggle());
    toggle().click();
    expect(isOpen()).toBe(true);
    expect(text().textContent).toBe('Стреляет туда, где ты был.');
    expect(text().getAttribute('aria-hidden')).toBe('false');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    press(toggle());
    toggle().click();
    expect(isOpen()).toBe(false);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('Esc закрывает; другая клавиша — нет', () => {
    toggle().click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(isOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isOpen()).toBe(false);
  });

  it('касание мимо закрывает; касание по тексту подсказки — нет', () => {
    toggle().click();
    press(text());
    expect(isOpen()).toBe(true);
    press(outside);
    expect(isOpen()).toBe(false);
  });

  it('close закрывает открытую и не трогает закрытую', () => {
    toggle().click();
    hint.close();
    expect(isOpen()).toBe(false);
    hint.close();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('текст меняется без пересоздания', () => {
    const node = text();
    hint.setText('Новый текст.');
    expect(text()).toBe(node);
    expect(node.textContent).toBe('Новый текст.');
  });
});
