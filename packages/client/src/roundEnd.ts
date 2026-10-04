import type { Side } from '@tanks/shared/engine';
import type { BotLevel } from '@tanks/shared/protocol';

export type RoundResult = 'win' | 'loss' | 'draw';

export interface RoundEndInfo {
  result: RoundResult;
  // Причина со стороны движка: уничтожение или по времени.
  isByTime: boolean;
  score: [number, number];
  mySide: Side;
  // Уровень бота-соперника из кода комнаты; null — соперник человек.
  botLevel: BotLevel | null;
}

const CONFETTI_ROUNDS = 7;
const CONFETTI_COLORS = ['#e8825a', '#4fc3c9', '#f4f1e8', '#ffd166', '#c084fc'];
const HOME_PATH = '/';

const TITLES: Readonly<Record<RoundResult, string>> = { win: 'ПОБЕДА!', loss: 'ПОРАЖЕНИЕ', draw: 'НИЧЬЯ' };

function reasonText(info: RoundEndInfo): string {
  if (info.result === 'draw') {
    return info.isByTime ? 'равная броня по истечении времени' : 'оба танка уничтожены';
  }
  if (info.isByTime) {
    return 'по оставшейся броне';
  }
  return info.result === 'win' ? 'противник уничтожен' : 'твой танк уничтожен';
}

// Фраза под заголовком победы — по силе соперника: человек или уровень бота.
function praiseText(botLevel: BotLevel | null): string {
  if (botLevel === null) {
    return 'Соперник повержен';
  }
  if (botLevel <= 3) {
    return 'Разминка засчитана';
  }
  if (botLevel <= 6) {
    return 'Это уже был бой';
  }
  if (botLevel <= 8) {
    return 'Серьёзный противник. Серьёзная победа';
  }
  if (botLevel === 9) {
    return 'Ас повержен. Таких побед по пальцам';
  }
  return 'Невозможное случилось. Скриншот — и в рамку';
}

function subtitleText(info: RoundEndInfo): string {
  if (info.result === 'win') {
    return praiseText(info.botLevel);
  }
  if (info.result === 'loss') {
    return 'Следующий раунд через мгновение';
  }
  return 'Оба хороши';
}

function confetti(random: () => number): HTMLElement {
  const layer = document.createElement('div');
  layer.className = 'confetti';
  for (let round = 0; round < CONFETTI_ROUNDS; round++) {
    for (const color of CONFETTI_COLORS) {
      const piece = document.createElement('span');
      piece.className = 'confetti-piece';
      piece.style.left = `${String(random() * 100)}%`;
      piece.style.background = color;
      piece.style.animationDelay = `${String(random() * 0.8)}s`;
      piece.style.animationDuration = `${String(1.8 + random() * 1.2)}s`;
      piece.style.transform = `rotate(${String(random() * 360)}deg)`;
      layer.append(piece);
    }
  }
  return layer;
}

function scoreLine(score: [number, number], mySide: Side): HTMLElement {
  const line = document.createElement('div');
  line.className = 'round-end-score';
  for (const side of [0, 1] as const) {
    const value = document.createElement('span');
    value.className = side === mySide ? 'round-end-score-mine' : 'round-end-score-theirs';
    value.textContent = String(score[side]);
    line.append(value);
    if (side === 0) {
      const colon = document.createElement('span');
      colon.className = 'round-end-score-colon';
      colon.textContent = ':';
      line.append(colon);
    }
  }
  return line;
}

export function showRoundEnd(container: HTMLElement, info: RoundEndInfo, random: () => number = Math.random): void {
  container.replaceChildren();
  container.className = `round-end is-${info.result}`;
  if (info.result === 'win') {
    container.append(confetti(random));
  }
  const card = document.createElement('div');
  card.className = 'round-end-card';
  const title = document.createElement('h2');
  title.className = 'round-end-title';
  title.textContent = TITLES[info.result];
  const subtitle = document.createElement('p');
  subtitle.className = 'round-end-subtitle';
  subtitle.textContent = subtitleText(info);
  const reason = document.createElement('p');
  reason.className = 'round-end-reason';
  reason.textContent = reasonText(info);
  const buttons = document.createElement('div');
  buttons.className = 'round-end-buttons';
  const fight = document.createElement('button');
  fight.type = 'button';
  fight.className = 'round-end-fight';
  fight.textContent = 'В бой';
  // Следующий раунд сервер начнёт сам; кнопка лишь убирает попап с глаз.
  fight.addEventListener('click', () => {
    hideRoundEnd(container);
  });
  const menu = document.createElement('a');
  menu.className = 'round-end-menu';
  menu.href = HOME_PATH;
  menu.textContent = 'Меню';
  buttons.append(fight, menu);
  card.append(title, subtitle, scoreLine(info.score, info.mySide), reason, buttons);
  container.append(card);
  container.hidden = false;
}

export function hideRoundEnd(container: HTMLElement): void {
  container.hidden = true;
  container.replaceChildren();
}
