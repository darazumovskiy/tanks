import { beforeEach, describe, expect, it } from 'vitest';
import { hideRoundEnd, showRoundEnd, type RoundEndInfo } from './roundEnd.js';

let container: HTMLElement;
const fixedRandom = (): number => 0.5;

function info(overrides: Partial<RoundEndInfo> = {}): RoundEndInfo {
  return { result: 'win', isByTime: false, score: [2, 12], mySide: 1, botLevel: 8, ...overrides };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="round-end" hidden></div>';
  container = document.querySelector<HTMLElement>('#round-end') ?? document.body;
});

describe('попап итога раунда', () => {
  it('победа над Охотником: заголовок, конфетти, фраза про серьёзного противника, счёт и кнопка «В меню»', () => {
    showRoundEnd(container, info(), fixedRandom);
    expect(container.hidden).toBe(false);
    expect(container.classList.contains('is-win')).toBe(true);
    expect(container.querySelector('.round-end-title')?.textContent).toBe('ПОБЕДА!');
    expect(container.querySelectorAll('.confetti-piece').length).toBeGreaterThan(10);
    expect(container.querySelector('.round-end-subtitle')?.textContent).toBe('Серьёзный противник. Серьёзная победа');
    expect(container.querySelector('.round-end-reason')?.textContent).toBe('противник уничтожен');
    expect(container.querySelector('.round-end-score-mine')?.textContent).toBe('12');
    expect(container.querySelector('.round-end-score-theirs')?.textContent).toBe('2');
    expect(container.querySelector<HTMLAnchorElement>('.round-end-menu')?.getAttribute('href')).toBe('/');
  });

  it('кнопка «В бой» убирает попап, не трогая страницу', () => {
    showRoundEnd(container, info(), fixedRandom);
    container.querySelector<HTMLButtonElement>('.round-end-fight')?.click();
    expect(container.hidden).toBe(true);
    expect(container.childElementCount).toBe(0);
  });

  it('поражение и ничья — без конфетти, со своими заголовками и причинами', () => {
    showRoundEnd(container, info({ result: 'loss', isByTime: true }), fixedRandom);
    expect(container.querySelector('.round-end-title')?.textContent).toBe('ПОРАЖЕНИЕ');
    expect(container.querySelectorAll('.confetti-piece').length).toBe(0);
    expect(container.querySelector('.round-end-reason')?.textContent).toBe('по оставшейся броне');

    showRoundEnd(container, info({ result: 'loss' }), fixedRandom);
    expect(container.querySelector('.round-end-reason')?.textContent).toBe('твой танк уничтожен');

    showRoundEnd(container, info({ result: 'draw' }), fixedRandom);
    expect(container.querySelector('.round-end-title')?.textContent).toBe('НИЧЬЯ');
    expect(container.querySelector('.round-end-reason')?.textContent).toBe('оба танка уничтожены');
    expect(container.querySelector('.round-end-subtitle')?.textContent).toBe('Оба хороши');

    showRoundEnd(container, info({ result: 'draw', isByTime: true }), fixedRandom);
    expect(container.querySelector('.round-end-reason')?.textContent).toBe('равная броня по истечении времени');
  });

  it('фраза победы зависит от соперника: человек, разминка, бой, ас, босс', () => {
    const subtitle = (): string | undefined => container.querySelector('.round-end-subtitle')?.textContent ?? undefined;
    showRoundEnd(container, info({ botLevel: null }), fixedRandom);
    expect(subtitle()).toBe('Соперник повержен');
    showRoundEnd(container, info({ botLevel: 2 }), fixedRandom);
    expect(subtitle()).toBe('Разминка засчитана');
    showRoundEnd(container, info({ botLevel: 5 }), fixedRandom);
    expect(subtitle()).toBe('Это уже был бой');
    showRoundEnd(container, info({ botLevel: 9 }), fixedRandom);
    expect(subtitle()).toBe('Ас повержен. Таких побед по пальцам');
    showRoundEnd(container, info({ botLevel: 10 }), fixedRandom);
    expect(subtitle()).toBe('Невозможное случилось. Скриншот — и в рамку');
  });

  it('скрытие прячет контейнер и очищает его', () => {
    showRoundEnd(container, info(), fixedRandom);
    hideRoundEnd(container);
    expect(container.hidden).toBe(true);
    expect(container.childElementCount).toBe(0);
  });
});
