import { describe, expect, it } from 'vitest';
import { shownText } from '../../testing/hudText.js';
import type { FfaFeedRow } from '../session.js';
import { KillFeedView } from './killFeed.js';

function row(key: number, killer: string, victim: string, ageMs = 0): FfaFeedRow {
  return { key, killer, victim, cause: 'bullet', isMyKill: false, isMyDeath: false, ageMs };
}

describe('лента убийств', () => {
  it('строка гаснет последние 200 мс из пяти секунд', () => {
    const view = new KillFeedView();
    view.update([row(1, 'Вася', 'Петя', 4900)]);
    expect(view.element.querySelector<HTMLElement>('.ffa-feed-row')?.style.opacity).toBe('0.5');
    view.update([row(1, 'Вася', 'Петя', 1000)]);
    expect(view.element.querySelector<HTMLElement>('.ffa-feed-row')?.style.opacity).toBe('1');
  });

  it('тот же номер записи из новой сессии — новая строка, а не старый текст', () => {
    const view = new KillFeedView();
    view.update([row(1, 'Вася', 'Петя')]);
    const first = view.element.querySelector('.ffa-feed-row');
    view.update([row(1, 'Оля', 'Гена')]);
    expect([...view.element.querySelectorAll('.ffa-feed-row')].map((node) => shownText(node))).toEqual(['Оля Гена']);
    expect(view.element.querySelector('.ffa-feed-row')).not.toBe(first);
  });

  it('та же запись в следующем кадре — тот же узел: появление не проигрывается заново', () => {
    const view = new KillFeedView();
    view.update([row(1, 'Вася', 'Петя')]);
    const first = view.element.querySelector('.ffa-feed-row');
    view.update([row(2, 'Оля', 'Гена'), row(1, 'Вася', 'Петя', 16)]);
    expect(view.element.children[1]).toBe(first);
  });
});
