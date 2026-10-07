import type { Side } from '@tanks/shared/engine';
import { mountDropdown, type Dropdown, type DropdownElements } from '../dropdown.js';
import { createDuelEffects } from '../render/renderer.js';
import { SIDE_COLORS } from '../render/view.js';
import { WatchRenderer } from '../render/watchRenderer.js';
import { WATCH_STYLE } from '../render/watchStyle.js';
import { Sfx } from '../sfx.js';
import type { RoundOutcome } from './botMatch.js';
import { FIGHTERS, fighterById, readyFighter, type Fighter, type ReadyFighter } from './fighters.js';
import { WATCH_SPEEDS, type WatchSpeed } from './stepClock.js';
import { WatchGame, type WatchGameDeps } from './watchGame.js';

export interface WatchPageElements {
  left: DropdownElements;
  right: DropdownElements;
  speeds: HTMLElement;
  pause: HTMLButtonElement;
  restart: HTMLButtonElement;
  sound: HTMLButtonElement;
  result: HTMLElement;
  notice: HTMLElement;
}

export interface WatchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LEFT_KEY = 'tanks.watch.left';
const RIGHT_KEY = 'tanks.watch.right';
const DEFAULT_LEFT_ID = 'bot8';
const DEFAULT_RIGHT_ID = 'bot10';
const DEFAULT_SPEED: WatchSpeed = 1;
const SELECTED_CLASS = 'is-selected';
const PAUSED_CLASS = 'is-paused';
const MUTED_CLASS = 'is-muted';
const SHOWN_CLASS = 'is-shown';
const OUTCOME_SIDE_CLASSES = ['is-left', 'is-right'] as const;
const DRAW_CLASS = 'is-draw';
const SOUND_KEY_CODE = 'KeyM';
const SEED_PARAM = 'seed';
const SIDES: readonly Side[] = [0, 1];

function requireFighter(id: string): Fighter {
  const fighter = fighterById(id);
  if (fighter === null) {
    throw new Error(`нет бойца ${id}`);
  }
  return fighter;
}

// Боец по сохранённому номеру; номер, которого больше нет в списке, — боец по умолчанию.
function storedFighter(storage: WatchStorage, key: string, fallbackId: string): Fighter {
  return fighterById(storage.getItem(key)) ?? requireFighter(fallbackId);
}

function badgeOf(fighter: Fighter): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'level-badge';
  badge.textContent = fighter.badge;
  return badge;
}

function nameOf(fighter: Fighter): HTMLElement {
  const name = document.createElement('span');
  name.className = 'level-name';
  name.textContent = fighter.name;
  return name;
}

// Строка списка: номер, имя и короткое описание, как список уровней на главной.
function optionContent(fighter: Fighter): HTMLElement[] {
  const body = document.createElement('span');
  body.className = 'level-body';
  const tagline = document.createElement('span');
  tagline.className = 'level-tagline';
  tagline.textContent = fighter.tagline;
  body.append(nameOf(fighter), tagline);
  return [badgeOf(fighter), body];
}

// Кнопка выбранного — номер и имя: панель внизу экрана узкая.
function toggleContent(fighter: Fighter): HTMLElement[] {
  return [badgeOf(fighter), nameOf(fighter)];
}

// Итог раунда для игрока: кто победил и почему, если не нокаутом.
export function outcomeText(outcome: RoundOutcome, names: readonly [string, string]): { title: string; note: string } {
  if (outcome.winner === null) {
    return { title: 'Ничья!', note: outcome.isByTime ? 'Время вышло — сил поровну' : 'Подбили друг друга' };
  }
  const title = `${names[outcome.winner]} побеждает!`;
  return { title, note: outcome.isByTime ? 'Время вышло — у него больше здоровья' : '' };
}

function showOutcome(element: HTMLElement, outcome: RoundOutcome | null, names: readonly [string, string]): void {
  if (outcome === null) {
    element.classList.remove(SHOWN_CLASS);
    return;
  }
  const { title, note } = outcomeText(outcome, names);
  const titleElement = document.createElement('span');
  titleElement.className = 'watch-result-title';
  titleElement.textContent = title;
  const noteElement = document.createElement('span');
  noteElement.className = 'watch-result-note';
  noteElement.textContent = note;
  noteElement.hidden = note === '';
  element.replaceChildren(titleElement, noteElement);
  element.classList.toggle(DRAW_CLASS, outcome.winner === null);
  OUTCOME_SIDE_CLASSES.forEach((className, side) => {
    element.classList.toggle(className, outcome.winner === side);
  });
  element.classList.add(SHOWN_CLASS);
}

// Токен вида — в CSS-переменные страницы: панель, переходы и цвета сторон берутся оттуда.
export function applyWatchStyle(root: HTMLElement): void {
  root.style.setProperty('--watch-bar-height', `${String(WATCH_STYLE.barHeightPx)}px`);
  root.style.setProperty('--watch-bar-wide-height', `${String(WATCH_STYLE.barWideHeightPx)}px`);
  root.style.setProperty('--watch-transition', `${String(WATCH_STYLE.transitionMs)}ms`);
  root.style.setProperty('--watch-result', `${String(WATCH_STYLE.resultMs)}ms`);
  root.style.setProperty('--watch-left', SIDE_COLORS[0]);
  root.style.setProperty('--watch-right', SIDE_COLORS[1]);
}

// Зерно всех боёв страницы — из `?seed=`, иначе новое случайное на каждый бой.
function seedSource(search: string): () => number {
  const fixed = new URLSearchParams(search).get(SEED_PARAM);
  if (fixed !== null && Number.isInteger(Number(fixed))) {
    return () => Number(fixed);
  }
  return () => {
    const [seed = 0] = crypto.getRandomValues(new Uint32Array(1));
    return seed;
  };
}

export function browserWatchDeps(canvas: HTMLCanvasElement): WatchGameDeps {
  return {
    createRenderer: (effects) => new WatchRenderer(canvas, effects, WATCH_STYLE),
    createEffects: createDuelEffects,
    createSfx: () => new Sfx(),
    now: () => performance.now(),
    requestFrame: (callback) => {
      requestAnimationFrame(callback);
    },
    isHidden: () => document.visibilityState === 'hidden',
    nextSeed: seedSource(location.search),
  };
}

function reflectPause(button: HTMLButtonElement, isPaused: boolean): void {
  button.classList.toggle(PAUSED_CLASS, isPaused);
  button.setAttribute('aria-pressed', String(isPaused));
  button.setAttribute('aria-label', isPaused ? 'Продолжить' : 'Пауза');
}

function reflectSound(button: HTMLButtonElement, isMuted: boolean): void {
  button.classList.toggle(MUTED_CLASS, isMuted);
  button.setAttribute('aria-pressed', String(isMuted));
  button.setAttribute('aria-label', isMuted ? 'Включить звук' : 'Выключить звук');
}

// Значение списка — номер бойца: он же попадает в data-атрибут строки.
function mountPicker(
  elements: DropdownElements,
  selected: Fighter,
  onSelect: (fighter: Fighter) => void,
): Dropdown<string> {
  return mountDropdown(elements, {
    values: FIGHTERS.map((fighter) => fighter.id),
    selected: selected.id,
    optionClass: 'level',
    dataKey: 'fighter',
    optionContent: (id) => optionContent(requireFighter(id)),
    toggleContent: (id) => toggleContent(requireFighter(id)),
    onSelect: (id) => {
      onSelect(requireFighter(id));
    },
  });
}

function mountSpeeds(container: HTMLElement, game: WatchGame): void {
  const buttons = WATCH_SPEEDS.map((speed) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'watch-speed';
    button.dataset.speed = String(speed);
    button.textContent = `×${String(speed)}`;
    button.setAttribute('aria-label', `Скорость ×${String(speed)}`);
    return { speed, button };
  });
  const select = (chosen: WatchSpeed): void => {
    game.setSpeed(chosen);
    for (const { speed, button } of buttons) {
      button.classList.toggle(SELECTED_CLASS, speed === chosen);
      button.setAttribute('aria-pressed', String(speed === chosen));
    }
  };
  for (const { speed, button } of buttons) {
    button.addEventListener('click', () => {
      select(speed);
    });
    container.append(button);
  }
  select(DEFAULT_SPEED);
}

// null — мозг бойца не загрузился: кусок сборки не приехал по сети.
async function readyOrNull(fighter: Fighter): Promise<ReadyFighter | null> {
  try {
    return await readyFighter(fighter);
  } catch {
    return null;
  }
}

// Сообщение поверх боя о бойце, который не загрузился; само уходит через noticeShownMs.
function noticeShower(element: HTMLElement): (fighter: Fighter) => void {
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  return (fighter) => {
    const title = document.createElement('span');
    title.className = 'watch-notice-title';
    title.textContent = `${fighter.name} не приехал`;
    const note = document.createElement('span');
    note.className = 'watch-notice-note';
    note.textContent = 'Обнови страницу — и в бой';
    element.replaceChildren(title, note);
    element.classList.add(SHOWN_CLASS);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      element.classList.remove(SHOWN_CLASS);
    }, WATCH_STYLE.noticeShownMs);
  };
}

// Боец, сохранённый для стороны; не загрузился — боец стороны по умолчанию, его мозг готов сразу.
async function readyStored(
  storage: WatchStorage,
  key: string,
  fallbackId: string,
  showNotice: (fighter: Fighter) => void,
): Promise<ReadyFighter> {
  const fighter = storedFighter(storage, key, fallbackId);
  const ready = await readyOrNull(fighter);
  if (ready !== null) {
    return ready;
  }
  showNotice(fighter);
  return readyFighter(requireFighter(fallbackId));
}

// Экран боя ботов: выбор двух бойцов, скорость, пауза, «заново», звук, итог раунда. Выбор бойцов запоминается.
// Бой с новым бойцом начинается, когда его мозг загружен; пока грузится, идёт прежний бой, а выбор, сделанный за это
// время позже, побеждает. Боец, чей мозг не загрузился, в выборе не остаётся и не запоминается.
export async function mountWatch(
  elements: WatchPageElements,
  storage: WatchStorage,
  deps: WatchGameDeps,
): Promise<WatchGame> {
  const showNotice = noticeShower(elements.notice);
  let playing: [ReadyFighter, ReadyFighter] = await Promise.all([
    readyStored(storage, LEFT_KEY, DEFAULT_LEFT_ID, showNotice),
    readyStored(storage, RIGHT_KEY, DEFAULT_RIGHT_ID, showNotice),
  ]);
  const chosen: [Fighter, Fighter] = [requireFighter(playing[0].id), requireFighter(playing[1].id)];
  const game = new WatchGame(
    {
      fighters: playing,
      speed: DEFAULT_SPEED,
      onOutcome: (outcome, names) => {
        showOutcome(elements.result, outcome, names);
      },
    },
    deps,
  );
  let choice = 0;
  const startChosen = async (): Promise<void> => {
    choice++;
    const current = choice;
    const loaded = await Promise.all([readyOrNull(chosen[0]), readyOrNull(chosen[1])]);
    if (current !== choice) {
      return;
    }
    const next: [ReadyFighter, ReadyFighter] = [...playing];
    let hasFailed = false;
    for (const side of SIDES) {
      const ready = loaded[side];
      if (ready === null) {
        hasFailed = true;
        showNotice(chosen[side]);
        chosen[side] = requireFighter(playing[side].id);
        pickers[side].setSelected(chosen[side].id);
        continue;
      }
      next[side] = ready;
    }
    const isSamePair = next[0].id === playing[0].id && next[1].id === playing[1].id;
    if (hasFailed && isSamePair) {
      return;
    }
    playing = next;
    storage.setItem(LEFT_KEY, playing[0].id);
    storage.setItem(RIGHT_KEY, playing[1].id);
    game.setFighters(playing);
  };
  const choose = (side: Side, fighter: Fighter): void => {
    chosen[side] = fighter;
    void startChosen();
  };
  const pickers = [
    mountPicker(elements.left, chosen[0], (fighter) => {
      choose(0, fighter);
    }),
    mountPicker(elements.right, chosen[1], (fighter) => {
      choose(1, fighter);
    }),
  ] as const;
  mountSpeeds(elements.speeds, game);
  reflectPause(elements.pause, game.isPaused);
  elements.pause.addEventListener('click', () => {
    reflectPause(elements.pause, game.togglePause());
  });
  elements.restart.addEventListener('click', () => {
    game.restart();
  });
  reflectSound(elements.sound, game.isMuted);
  elements.sound.addEventListener('click', () => {
    reflectSound(elements.sound, game.toggleSound());
  });
  window.addEventListener('keydown', (event) => {
    if (event.code === SOUND_KEY_CODE && !event.repeat) {
      reflectSound(elements.sound, game.toggleSound());
    }
  });
  // Звук браузер разрешает только после действия игрока на странице.
  for (const type of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(type, () => {
      game.unlockSound();
    });
  }
  return game;
}
