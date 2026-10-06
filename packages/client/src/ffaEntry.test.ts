import { beforeEach, describe, expect, it } from 'vitest';
import { mountFfaEntry, type FfaEntryElements } from './ffaEntry.js';

const SIZE_KEY = 'tanks.ffaSize';

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
  let stored: Map<string, string>;
  let entry: ReturnType<typeof mountFfaEntry>;

  function mount(): void {
    document.body.innerHTML = `
      <div class="ffa-size">
        <button id="size-toggle" aria-expanded="false"></button>
        <div id="sizes" hidden></div>
      </div>
      <button id="start" class="action">В общий бой</button>
      <button id="info" class="level-info" aria-expanded="false">i</button>
      <p id="hint" hidden>Выбери, сколько танков на карте.</p>
      <p id="locked" hidden>Раздай танку все очки — и в бой</p>`;
    elements = {
      start: element('start', HTMLButtonElement),
      info: element('info', HTMLButtonElement),
      hint: element('hint', HTMLElement),
      locked: element('locked', HTMLElement),
      sizeToggle: element('size-toggle', HTMLButtonElement),
      sizeList: element('sizes', HTMLElement),
    };
    calls = [];
    entry = mountFfaEntry(
      elements,
      {
        save: () => calls.push('save'),
        navigate: (path) => calls.push(`navigate ${path}`),
      },
      {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
      },
    );
  }

  function pick(size: number): void {
    elements.sizeToggle.click();
    elements.sizeList.querySelector<HTMLButtonElement>(`[data-size="${String(size)}"]`)?.click();
  }

  beforeEach(() => {
    stored = new Map();
    mount();
  });

  it('пока очки не розданы — кнопка недоступна, никуда не ведёт, под ней подсказка', () => {
    entry.setReady(false);
    expect(elements.start.disabled).toBe(true);
    expect(elements.locked.hidden).toBe(false);
    elements.start.click();
    expect(calls).toEqual([]);
  });

  it('P8 танк собран — кнопка сохраняет ник и характеристики и ведёт в игру на 30 мест', () => {
    entry.setReady(false);
    entry.setReady(true);
    expect(elements.locked.hidden).toBe(true);
    expect(elements.sizeToggle.textContent).toBe('30танков▾');
    elements.start.click();
    expect(calls).toEqual(['save', 'navigate /ffa/30']);
  });

  it('P8 список размеров: 10, 30, 50 с названием и описанием; выбор закрывает список и ведёт в игру этого размера', () => {
    elements.sizeToggle.click();
    expect(elements.sizeList.hidden).toBe(false);
    expect(elements.sizeToggle.getAttribute('aria-expanded')).toBe('true');
    const rows = [...elements.sizeList.querySelectorAll<HTMLButtonElement>('.level')];
    expect(rows.map((row) => row.textContent)).toEqual([
      '10СтычкаМаленькая карта — враг всегда рядом',
      '30ТолпаЗолотая середина',
      '50МясорубкаОгромная карта, полный хаос',
    ]);
    expect(rows.map((row) => row.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    rows[0]?.click();
    expect(elements.sizeList.hidden).toBe(true);
    expect(elements.sizeToggle.textContent).toBe('10танков▾');
    elements.start.click();
    pick(50);
    elements.start.click();
    expect(calls).toEqual(['save', 'navigate /ffa/10', 'save', 'navigate /ffa/50']);
  });

  it('P8 выбор запоминается на устройстве; мусор в хранилище — 30', () => {
    pick(50);
    expect(stored.get(SIZE_KEY)).toBe('50');
    mount();
    expect(elements.sizeToggle.textContent).toBe('50танков▾');
    stored.set(SIZE_KEY, '11');
    mount();
    elements.start.click();
    expect(calls).toEqual(['save', 'navigate /ffa/30']);
  });

  it('список закрывается касанием мимо и Escape', () => {
    elements.sizeToggle.click();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(elements.sizeList.hidden).toBe(true);
    elements.sizeToggle.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(elements.sizeList.hidden).toBe(true);
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
