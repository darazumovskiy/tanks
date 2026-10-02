import { DEFAULT_STATS, STAT_KEYS, STAT_POINTS, type Stats } from '@tanks/shared/engine';
import { Game } from './game.js';

const NICKNAME_KEY = 'tanks.nickname';
const STATS_KEY = 'tanks.stats';
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length] ?? 'a').join('');
}

function byId<T extends HTMLElement>(id: string, kind: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof kind)) {
    throw new Error(`нет элемента #${id}`);
  }
  return element;
}

function parseStats(raw: string | null): Stats {
  if (raw?.length !== 4) {
    return { ...DEFAULT_STATS };
  }
  const values = Array.from(raw, (char) => Number(char));
  const stats: Stats = { armor: values[0] ?? 0, engine: values[1] ?? 0, gun: values[2] ?? 0, reload: values[3] ?? 0 };
  const total = STAT_KEYS.reduce((sum, key) => sum + stats[key], 0);
  const isValid = STAT_KEYS.every((key) => Number.isInteger(stats[key]) && stats[key] >= 0 && stats[key] <= 5);
  return isValid && total <= STAT_POINTS ? stats : { ...DEFAULT_STATS };
}

function showHome(): void {
  const home = byId('home', HTMLElement);
  const nickname = byId('nickname', HTMLInputElement);
  const statsInput = byId('stats', HTMLInputElement);
  home.hidden = false;
  nickname.value = localStorage.getItem(NICKNAME_KEY) ?? '';
  statsInput.value = localStorage.getItem(STATS_KEY) ?? '3322';
  byId('create', HTMLButtonElement).addEventListener('click', () => {
    localStorage.setItem(NICKNAME_KEY, nickname.value);
    localStorage.setItem(STATS_KEY, statsInput.value);
    location.assign(`/d/${randomCode()}`);
  });
}

// Подсказка «поверни телефон» — только на устройствах с касанием и только в портрете.
function bindRotateHint(hint: HTMLElement): void {
  const portraitTouch = matchMedia('(orientation: portrait) and (pointer: coarse)');
  const apply = (): void => {
    hint.hidden = !portraitTouch.matches;
  };
  portraitTouch.addEventListener('change', apply);
  apply();
}

function startDuel(roomCode: string): void {
  const nickname = localStorage.getItem(NICKNAME_KEY) ?? '';
  const stats = parseStats(localStorage.getItem(STATS_KEY));
  const canvas = byId('stage', HTMLCanvasElement);
  canvas.hidden = false;
  document.body.classList.add('duel');
  const game = new Game({ roomCode, nickname, stats, canvas, overlay: byId('overlay', HTMLElement) });
  bindRotateHint(byId('rotate', HTMLElement));
  // Точка доступа для сквозных тестов и отладки из консоли браузера.
  Object.assign(window, { tanksGame: game });
  window.addEventListener('beforeunload', () => {
    game.close();
  });
}

const duelMatch = /^\/d\/([a-z0-9]{3,16})$/.exec(location.pathname);
if (duelMatch?.[1] !== undefined) {
  startDuel(duelMatch[1]);
} else {
  showHome();
}
