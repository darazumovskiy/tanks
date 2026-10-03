import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPIED_FEEDBACK_MS, renderInvite, type InviteActions } from './invite.js';

const LINK = 'https://tanks.example/d/abc123';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('renderInvite', () => {
  let container: HTMLElement;
  let copied: string[];
  let shared: string[];

  const recordShare = (url: string): Promise<void> => {
    shared.push(url);
    return Promise.resolve();
  };

  const actionsWith = (canShare: boolean, share: InviteActions['share'] = recordShare): InviteActions => ({
    copy: (text) => {
      copied.push(text);
      return Promise.resolve();
    },
    canShare: () => Promise.resolve(canShare),
    share,
  });

  const buttonNamed = (label: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent === label);

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.append(container);
    copied = [];
    shared = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('кнопка «Копировать» кладёт ссылку в буфер и на время показывает «Скопировано»', async () => {
    renderInvite(container, LINK, actionsWith(false));
    const button = buttonNamed('Копировать');
    expect(button).toBeDefined();
    button?.click();
    await flush();
    expect(copied).toEqual([LINK]);
    expect(button?.textContent).toBe('Скопировано');
    vi.advanceTimersByTime(COPIED_FEEDBACK_MS);
    expect(button?.textContent).toBe('Копировать');
  });

  it('без доступа к буферу надпись не меняется и ошибка не всплывает', async () => {
    const rejected = vi.fn();
    process.on('unhandledRejection', rejected);
    const actions = actionsWith(false);
    actions.copy = () => Promise.reject(new Error('NotAllowedError'));
    renderInvite(container, LINK, actions);
    buttonNamed('Копировать')?.click();
    await flush();
    await flush();
    process.off('unhandledRejection', rejected);
    expect(buttonNamed('Копировать')?.textContent).toBe('Копировать');
    expect(rejected).not.toHaveBeenCalled();
  });

  it('клик по полю со ссылкой выделяет её и копирует', async () => {
    renderInvite(container, LINK, actionsWith(false));
    const linkBox = container.querySelector<HTMLInputElement>('input.overlay-link');
    expect(linkBox?.value).toBe(LINK);
    linkBox?.click();
    await flush();
    expect(copied).toEqual([LINK]);
    expect(linkBox?.selectionStart).toBe(0);
    expect(linkBox?.selectionEnd).toBe(LINK.length);
  });

  it('без системного «поделиться» кнопки нет', async () => {
    renderInvite(container, LINK, actionsWith(false));
    await flush();
    expect(buttonNamed('Поделиться')).toBeUndefined();
  });

  it('с системным «поделиться» кнопка открывает меню со ссылкой', async () => {
    renderInvite(container, LINK, actionsWith(true));
    await flush();
    buttonNamed('Поделиться')?.click();
    await flush();
    expect(shared).toEqual([LINK]);
  });

  it('закрытое игроком меню «поделиться» не роняет страницу', async () => {
    const rejected = vi.fn();
    process.on('unhandledRejection', rejected);
    renderInvite(
      container,
      LINK,
      actionsWith(true, () => Promise.reject(new Error('AbortError'))),
    );
    await flush();
    buttonNamed('Поделиться')?.click();
    await flush();
    await flush();
    process.off('unhandledRejection', rejected);
    expect(rejected).not.toHaveBeenCalled();
  });
});
