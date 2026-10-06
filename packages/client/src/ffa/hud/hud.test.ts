import { describe, expect, it } from 'vitest';
import { shownText } from '../../testing/hudText.js';
import type { FfaHudModel } from '../session.js';
import { FfaHud } from './hud.js';

const ACTIONS = {
  invite: (): Promise<void> => Promise.resolve(),
  leave: (): void => undefined,
  rejoin: (): void => undefined,
  reload: (): void => undefined,
};

function model(overrides: Partial<FfaHudModel> = {}): FfaHudModel {
  return {
    screen: 'fight',
    lobby: null,
    countdown: null,
    scoreboard: { timeLeftS: 42, isFinal: true, score: null, leader: null },
    feed: [],
    death: null,
    spectator: null,
    final: { kind: 'soon', secondsLeft: 3, hasBots: false },
    idleInS: 7,
    results: null,
    connection: 'lost',
    invite: null,
    ...overrides,
  };
}

function mount(isTouch: boolean): { hud: FfaHud; root: HTMLElement } {
  const root = document.createElement('div');
  root.hidden = true;
  document.body.replaceChildren(root);
  return { hud: new FfaHud(root, ACTIONS, isTouch), root };
}

function isShown(root: HTMLElement, selector: string): boolean {
  return root.querySelector(selector)?.classList.contains('is-shown') === true;
}

describe('корень интерфейса', () => {
  it('под таймером одно место: связь, «Ты тут?», финал, приглашение мимо — в этом порядке', () => {
    const { hud, root } = mount(false);
    const pills = (): boolean[] =>
      ['.ffa-connection', '.ffa-idle', '.ffa-final', '.ffa-invite'].map((selector) => isShown(root, selector));
    hud.render(model({ invite: 'full' }), 0);
    expect(pills()).toEqual([true, false, false, false]);
    hud.render(model({ connection: null, invite: 'full' }), 0);
    expect(pills()).toEqual([false, true, false, false]);
    hud.render(model({ connection: null, idleInS: null, invite: 'full' }), 0);
    expect(pills()).toEqual([false, false, true, false]);
    expect(root.querySelector('.ffa-timer')?.classList.contains('is-final')).toBe(true);
    hud.render(model({ connection: null, idleInS: null, final: null, invite: 'full' }), 0);
    expect(pills()).toEqual([false, false, false, true]);
    expect(root.querySelector('.ffa-invite')?.textContent).toBe('ИГРА ДРУГА ПОЛНА' + 'Ты в соседней — зови сюда');
    hud.render(model({ connection: null, idleInS: null, final: null, invite: 'gone' }), 0);
    expect(root.querySelector('.ffa-invite')?.textContent).toBe('ТОЙ ИГРЫ УЖЕ НЕТ' + 'Все разошлись — вот новая');
  });

  it('финал при живых ботах на поле говорит, что первыми выбывают боты; без ботов — без возрождений', () => {
    const { hud, root } = mount(false);
    const finalText = (final: FfaHudModel['final']): string => {
      hud.render(model({ connection: null, idleInS: null, final }), 0);
      const element = root.querySelector('.ffa-final');
      return element instanceof HTMLElement ? shownText(element) : '';
    };
    expect(finalText({ kind: 'soon', secondsLeft: 3, hasBots: true })).toBe(
      'ФИНАЛ ЧЕРЕЗ 3 Потом первыми выбывают боты',
    );
    expect(finalText({ kind: 'soon', secondsLeft: 2, hasBots: false })).toBe('ФИНАЛ ЧЕРЕЗ 2 Потом без возрождений');
    expect(finalText({ kind: 'started', hasBots: true })).toBe('ФИНАЛ! Подбили — вернёшься, пока живы боты');
    expect(finalText({ kind: 'started', hasBots: false })).toBe('ФИНАЛ! Подбили — смотришь до конца');
  });

  it('корень показан, экран — в атрибуте; телефон — класс и раскладка 3 строки ленты, пятёрка итогов', () => {
    const touch = mount(true);
    expect(touch.root.hidden).toBe(false);
    expect(touch.root.classList.contains('is-touch')).toBe(true);
    expect(touch.hud.layout).toEqual({ feedRows: 3, resultsTop: 5 });
    touch.hud.render(
      model({ screen: 'connecting', scoreboard: null, final: null, idleInS: null, connection: 'late' }),
      0,
    );
    expect(touch.root.dataset.screen).toBe('connecting');
    expect(shownText(touch.root)).toBe('Подключаемся… НЕ УСПЕЛИ Место ушло — заходим заново');
    const desktop = mount(false);
    expect(desktop.root.classList.contains('is-touch')).toBe(false);
    expect(desktop.hud.layout).toEqual({ feedRows: 4, resultsTop: 10 });
  });

  it('окончательный экран гасит бой: видна только карточка', () => {
    const { hud, root } = mount(false);
    hud.render(model({ screen: 'update', scoreboard: null, final: null, idleInS: null, connection: null }), 0);
    expect(shownText(root)).toBe('ВЫШЛО ОБНОВЛЕНИЕ Перезагрузи — и в бой. Обновить');
  });
});
