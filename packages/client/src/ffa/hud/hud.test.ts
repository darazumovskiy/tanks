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
    final: { kind: 'soon', secondsLeft: 3 },
    idleInS: 7,
    results: null,
    connection: 'lost',
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
  it('под таймером одно место: связь важнее «Ты тут?», «Ты тут?» важнее финала', () => {
    const { hud, root } = mount(false);
    hud.render(model(), 0);
    expect([isShown(root, '.ffa-connection'), isShown(root, '.ffa-idle'), isShown(root, '.ffa-final')]).toEqual([
      true,
      false,
      false,
    ]);
    hud.render(model({ connection: null }), 0);
    expect([isShown(root, '.ffa-connection'), isShown(root, '.ffa-idle'), isShown(root, '.ffa-final')]).toEqual([
      false,
      true,
      false,
    ]);
    hud.render(model({ connection: null, idleInS: null }), 0);
    expect([isShown(root, '.ffa-connection'), isShown(root, '.ffa-idle'), isShown(root, '.ffa-final')]).toEqual([
      false,
      false,
      true,
    ]);
    expect(root.querySelector('.ffa-timer')?.classList.contains('is-final')).toBe(true);
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
