import { afterEach, describe, expect, it } from 'vitest';
import { shownText } from '../../testing/hudText.js';
import type { FfaLobbyModel } from '../session.js';
import { LobbyView } from './lobby.js';

// Облако ников по ширине строки: happy-dom не раскладывает страницу, поэтому строки задаёт подменённый offsetTop —
// каждые PER_LINE элементов облака — новая строка.
const PER_LINE = 8;
const LINE_HEIGHT = 26;
const originalOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');

function layOutByOrder(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement): number {
      const parent = this.parentElement;
      if (parent === null) {
        return 0;
      }
      const visible = [...parent.children].filter((child) => !(child as HTMLElement).hidden);
      return Math.floor(visible.indexOf(this) / PER_LINE) * LINE_HEIGHT;
    },
  });
}

afterEach(() => {
  if (originalOffsetTop !== undefined) {
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', originalOffsetTop);
  }
});

function model(players: number, overrides: Partial<FfaLobbyModel> = {}): FfaLobbyModel {
  return {
    players,
    capacity: 50,
    minimum: 35,
    startInS: null,
    isFull: false,
    roster: Array.from({ length: players }, (_, index) => ({
      id: index + 1,
      name: `Танкист${String(index + 1)}`,
      isBot: index % 5 === 4,
      isMe: index === 0,
    })),
    ...overrides,
  };
}

function mount(): LobbyView {
  const view = new LobbyView({ invite: () => Promise.resolve(), leave: () => undefined });
  document.body.replaceChildren(view.element);
  return view;
}

function shownNicks(view: LobbyView): string[] {
  return [...view.element.querySelectorAll<HTMLElement>('.ffa-roster .ffa-nick')]
    .filter((chip) => !chip.hidden)
    .map((chip) => shownText(chip));
}

describe('лобби', () => {
  it('50 ников — две строки облака, последний видимый уступает место «+N»; свой ник первым', () => {
    layOutByOrder();
    const view = mount();
    view.update(model(50), 0);
    const nicks = shownNicks(view);
    expect(nicks).toHaveLength(2 * PER_LINE);
    expect(nicks[0]).toBe('Танкист1');
    expect(nicks[4]).toBe('БОТ Танкист5');
    expect(nicks.at(-1)).toBe(`+${String(50 - (2 * PER_LINE - 1))}`);
    expect(view.element.querySelector('.ffa-nick.is-me')?.textContent).toBe('Танкист1');
  });

  it('ники помещаются в две строки — «+N» нет; состав сменился — облако пересобрано', () => {
    layOutByOrder();
    const view = mount();
    view.update(model(50), 0);
    view.update(model(12), 0);
    expect(shownNicks(view)).toHaveLength(12);
    expect(view.element.querySelector<HTMLElement>('.ffa-roster-more')?.hidden).toBe(true);
  });

  it('тексты по состоянию: меньше минимума — склонение, старт — округление вверх, полная — полный сбор', () => {
    const view = mount();
    const status = (): string => view.element.querySelector('.ffa-lobby-status')?.textContent ?? '';
    for (const [players, text] of [
      [34, 'Ещё 1 смельчак — и в бой'],
      [32, 'Ещё 3 смельчака — и в бой'],
      [24, 'Ещё 11 смельчаков — и в бой'],
      [14, 'Ещё 21 смельчак — и в бой'],
    ] as const) {
      view.update(model(players), 0);
      expect(status()).toBe(text);
    }
    view.update(model(36, { startInS: 6.2 }), 0);
    expect(status()).toBe('Старт через 7');
    view.update(model(36, { startInS: 0.01 }), 0);
    expect(status()).toBe('Старт через 1');
    view.update(model(50, { isFull: true, startInS: 0 }), 0);
    expect(status()).toBe('Полный сбор — поехали!');
  });

  it('подсказка «i» называет минимум этой игры со склонением', () => {
    const view = mount();
    const hint = (): string => view.element.querySelector('.ffa-hint-text')?.textContent ?? '';
    view.update(model(3, { minimum: 20, capacity: 30 }), 0);
    expect(hint()).toBe('Набралось 20 танков — через пять секунд в бой. Опоздавшие влетят прямо в драку.');
    view.update(model(1, { minimum: 1, capacity: 10 }), 0);
    expect(hint()).toContain('Набрался 1 танк —');
    view.update(model(1, { minimum: 2, capacity: 10 }), 0);
    expect(hint()).toContain('Набралось 2 танка —');
    view.update(model(1, { minimum: 21, capacity: 30 }), 0);
    expect(hint()).toContain('Набрался 21 танк —');
  });

  it('открытая подсказка закрывается со скрытием лобби: при следующем показе она закрыта', () => {
    const view = mount();
    const isOpen = (): boolean => view.element.querySelector('.ffa-hint')?.classList.contains('is-open') === true;
    view.update(model(3), 0);
    view.element.querySelector<HTMLButtonElement>('.ffa-hint-toggle')?.click();
    expect(isOpen()).toBe(true);
    view.update(null, 0);
    view.update(model(3), 0);
    expect(isOpen()).toBe(false);
  });

  it('ссылку скопировать не вышло — подтверждения нет', async () => {
    const view = new LobbyView({ invite: () => Promise.reject(new Error('нет буфера')), leave: () => undefined });
    document.body.replaceChildren(view.element);
    view.update(model(3), 0);
    view.element.querySelector<HTMLButtonElement>('.ffa-button.is-primary')?.click();
    await Promise.resolve();
    await Promise.resolve();
    view.update(model(3), 16);
    expect(view.element.querySelector('.ffa-lobby-copied')?.classList.contains('is-shown')).toBe(false);
  });
});
