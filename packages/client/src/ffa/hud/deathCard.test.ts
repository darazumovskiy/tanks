import { describe, expect, it } from 'vitest';
import { shownText } from '../../testing/hudText.js';
import type { FfaDeathModel } from '../session.js';
import { DeathCardView } from './deathCard.js';

function shown(model: FfaDeathModel): { text: string; card: Element | null } {
  const view = new DeathCardView();
  document.body.replaceChildren(view.element);
  view.update(model);
  return { text: shownText(view.element), card: view.element.querySelector('.ffa-death-card') };
}

describe('карточка «подбит»', () => {
  it.each([
    [
      { kind: 'killed', killerName: 'Вася', isKillerBot: false, isRicochet: true, respawnInS: 3 },
      'ТЕБЯ ПОДБИЛ Вася рикошетом Снова в бою через 3',
      'enemy',
    ],
    [
      { kind: 'killed', killerName: 'Шарик', isKillerBot: true, isRicochet: false, respawnInS: 4 },
      'ТЕБЯ ПОДБИЛ БОТ Шарик Снова в бою через 4',
      'enemy',
    ],
    [
      { kind: 'killed', killerName: null, isKillerBot: false, isRicochet: false, respawnInS: 2 },
      'ТЕБЯ ПОДБИЛИ Снова в бою через 2',
      'enemy',
    ],
    [{ kind: 'self', respawnInS: 4 }, 'САМ СЕБЯ! Рикошет — коварная штука Снова в бою через 4', 'danger'],
    [{ kind: 'zone', respawnInS: 1 }, 'ЗОНА ДОЖАЛА Держись внутри круга Снова в бою через 1', 'zone'],
    [{ kind: 'out' }, 'ТЫ ВЫБЫЛ Финал без возрождений — смотрим, кто кого', 'calm'],
    [{ kind: 'late' }, 'ФИНАЛ УЖЕ ИДЁТ Следующий матч — твой', 'calm'],
  ] as const)('%o — «%s»', (model, text, tone) => {
    const result = shown(model);
    expect(result.text).toBe(text);
    expect(result.card?.classList.contains(`is-${tone}`)).toBe(true);
  });

  it('смена карточки на месте: отметка бота и строка отсчёта уходят', () => {
    const view = new DeathCardView();
    view.update({ kind: 'killed', killerName: 'Шарик', isKillerBot: true, isRicochet: false, respawnInS: 4 });
    view.update({ kind: 'out' });
    expect(shownText(view.element)).toBe('ТЫ ВЫБЫЛ Финал без возрождений — смотрим, кто кого');
    expect(view.element.querySelector('.ffa-bot')).toBeNull();
    view.update(null);
    expect(view.element.classList.contains('is-shown')).toBe(false);
  });
});
