import { beforeEach, describe, expect, it } from 'vitest';
import { mountFfaEntry, type FfaEntryElements } from './ffaEntry.js';

function element<T extends HTMLElement>(id: string, kind: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof kind)) {
    throw new Error(`нет элемента #${id}`);
  }
  return found;
}

describe('вход в общий бой с главной', () => {
  let elements: FfaEntryElements;
  let calls: string[];
  let entry: ReturnType<typeof mountFfaEntry>;

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="start" class="action">В общий бой</button>
      <button id="info" class="level-info" aria-expanded="false">i</button>
      <p id="hint" hidden>До 30 танков на одной карте.</p>
      <p id="locked" hidden>Раздай танку все очки — и в бой</p>`;
    elements = {
      start: element('start', HTMLButtonElement),
      info: element('info', HTMLButtonElement),
      hint: element('hint', HTMLElement),
      locked: element('locked', HTMLElement),
    };
    calls = [];
    entry = mountFfaEntry(elements, {
      save: () => calls.push('save'),
      navigate: (path) => calls.push(`navigate ${path}`),
    });
  });

  it('пока очки не розданы — кнопка недоступна, никуда не ведёт, под ней подсказка', () => {
    entry.setReady(false);
    expect(elements.start.disabled).toBe(true);
    expect(elements.locked.hidden).toBe(false);
    elements.start.click();
    expect(calls).toEqual([]);
  });

  it('танк собран — кнопка сохраняет ник и характеристики и ведёт на /ffa', () => {
    entry.setReady(false);
    entry.setReady(true);
    expect(elements.locked.hidden).toBe(true);
    elements.start.click();
    expect(calls).toEqual(['save', 'navigate /ffa']);
  });

  it('иконка «i» открывает и закрывает подсказку', () => {
    elements.info.click();
    expect(elements.hint.hidden).toBe(false);
    expect(elements.info.getAttribute('aria-expanded')).toBe('true');
    expect(elements.info.classList.contains('is-open')).toBe(true);
    elements.info.click();
    expect(elements.hint.hidden).toBe(true);
    expect(elements.info.getAttribute('aria-expanded')).toBe('false');
  });
});
