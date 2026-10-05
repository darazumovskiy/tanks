import { Capacitor } from '@capacitor/core';
import { DEFAULT_STATS, FFA_SIZES, STAT_KEYS, STAT_POINTS, type FfaSize, type Stats } from '@tanks/shared/engine';
import { BOT_LEVEL_INFO, BOT_LEVELS, botRoomCode, type BotLevel } from '@tanks/shared/protocol';
import QRCode from 'qrcode';
import { resolveAdminMode } from './admin.js';
import { androidIntentUrl, isAndroidBrowser, showOpenInApp } from './appLink.js';
import { readClientInfo } from './clientInfo.js';
import { mountFfaEntry } from './ffaEntry.js';
import { Game } from './game.js';
import { showFrameStand } from './frameStand/stand.js';
import { showFxLab } from './fxLab/fxLab.js';
import { showCameraLab } from './lab.js';
import { defaultSettings, SettingsStore } from './settings.js';
import { SettingsPanel } from './settingsPanel.js';
import { mountStatsPicker, statsLeft } from './statsPicker.js';
import { Telemetry } from './telemetry.js';

const NICKNAME_KEY = 'tanks.nickname';
const STATS_KEY = 'tanks.stats';
const BOT_LEVEL_KEY = 'tanks.botLevel';
const DEFAULT_BOT_LEVEL: BotLevel = 1;
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const APK_ROUTE = '/app/tanks.apk';
const SETTINGS_KEY_CODE = 'KeyO';
const AUTOFIRE_ACTIVE_CLASS = 'is-active';
const LEVEL_SELECTED_CLASS = 'is-selected';
const LEVEL_INFO_OPEN_CLASS = 'is-open';
const LEVEL_LIST_OPEN_CLASS = 'is-open';
// `/ffa` — игра на 30 мест, куда ведёт кнопка с главной.
const FFA_DEFAULT_SIZE: FfaSize = 30;
const FFA_ROUTE = /^\/ffa(?:\/(\d+))?$/;
const isTouchDevice = (): boolean => matchMedia('(pointer: coarse)').matches;
// Один на страницу: ошибки главной и боя уходят с одинаковым описанием клиента.
const telemetry = new Telemetry(readClientInfo());
telemetry.installErrorHandlers();
// `?admin=1` на любой странице запоминается на устройстве и открывает админские настройки в бою.
const isAdmin = resolveAdminMode(location.search, localStorage);

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

function parseBotLevel(raw: string | null): BotLevel {
  const level = Number(raw);
  const known = BOT_LEVELS.find((candidate) => candidate === level);
  return known ?? DEFAULT_BOT_LEVEL;
}

interface LevelCard {
  level: BotLevel;
  card: HTMLElement;
}

// Номер, имя и короткое описание уровня — одинаково в строке списка и на кнопке выбранного.
function levelContent(level: BotLevel): HTMLElement[] {
  const info = BOT_LEVEL_INFO[level];
  const badge = document.createElement('span');
  badge.className = 'level-badge';
  badge.textContent = String(level);
  const body = document.createElement('span');
  body.className = 'level-body';
  const name = document.createElement('span');
  name.className = 'level-name';
  name.textContent = info.name;
  const tagline = document.createElement('span');
  tagline.className = 'level-tagline';
  tagline.textContent = info.tagline;
  body.append(name, tagline);
  return [badge, body];
}

function buildLevelCard(level: BotLevel): LevelCard {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'level';
  card.dataset.level = String(level);
  card.setAttribute('role', 'option');
  card.append(...levelContent(level));
  return { level, card };
}

interface LevelPickerElements {
  toggle: HTMLButtonElement;
  list: HTMLElement;
  hint: HTMLElement;
  info: HTMLButtonElement;
}

// Выпадающий список уровней своего оформления: кнопка показывает выбранный уровень, панель — все десять.
// Список — из общего с сервером контракта; выбранный уровень запоминается на устройстве.
function mountLevelPicker(elements: LevelPickerElements): { selected: () => BotLevel } {
  const cards = BOT_LEVELS.map(buildLevelCard);
  let selected = parseBotLevel(localStorage.getItem(BOT_LEVEL_KEY));
  const setOpen = (isOpen: boolean): void => {
    elements.list.hidden = !isOpen;
    elements.toggle.setAttribute('aria-expanded', String(isOpen));
    elements.toggle.classList.toggle(LEVEL_LIST_OPEN_CLASS, isOpen);
  };
  const render = (): void => {
    for (const { level, card } of cards) {
      const isSelected = level === selected;
      card.classList.toggle(LEVEL_SELECTED_CLASS, isSelected);
      card.setAttribute('aria-selected', String(isSelected));
    }
    const chevron = document.createElement('span');
    chevron.className = 'dropdown-chevron';
    chevron.textContent = '▾';
    elements.toggle.replaceChildren(...levelContent(selected), chevron);
    elements.hint.textContent = BOT_LEVEL_INFO[selected].summary;
  };
  for (const { level, card } of cards) {
    card.addEventListener('click', () => {
      selected = level;
      localStorage.setItem(BOT_LEVEL_KEY, String(level));
      render();
      setOpen(false);
      elements.toggle.focus();
    });
    elements.list.append(card);
  }
  elements.toggle.addEventListener('click', () => {
    setOpen(elements.list.hidden);
  });
  document.addEventListener('pointerdown', (event) => {
    const isInside = event.target instanceof Node && elements.list.parentElement?.contains(event.target) === true;
    if (!isInside) {
      setOpen(false);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setOpen(false);
    }
  });
  elements.info.addEventListener('click', () => {
    elements.hint.hidden = !elements.hint.hidden;
    elements.info.classList.toggle(LEVEL_INFO_OPEN_CLASS, !elements.hint.hidden);
    elements.info.setAttribute('aria-expanded', String(!elements.hint.hidden));
  });
  render();
  return { selected: () => selected };
}

function formatStats(stats: Stats): string {
  return STAT_KEYS.map((key) => String(stats[key])).join('');
}

function showHome(): void {
  const home = byId('home', HTMLElement);
  const nickname = byId('nickname', HTMLInputElement);
  const create = byId('create', HTMLButtonElement);
  const createBot = byId('create-bot', HTMLButtonElement);
  home.hidden = false;
  nickname.value = localStorage.getItem(NICKNAME_KEY) ?? '';
  const ffa = mountFfaEntry(
    {
      start: byId('ffa-start', HTMLButtonElement),
      info: byId('ffa-info', HTMLButtonElement),
      hint: byId('ffa-hint', HTMLElement),
    },
    {
      save: () => {
        saveProfile();
      },
      navigate: (path) => {
        location.assign(path);
      },
    },
  );
  // Старт только с полностью розданными очками: иначе бой нечестный к сопернику с полной раскладкой.
  const picker = mountStatsPicker(
    byId('stats-picker', HTMLElement),
    parseStats(localStorage.getItem(STATS_KEY)),
    (stats) => {
      localStorage.setItem(STATS_KEY, formatStats(stats));
      const isComplete = statsLeft(stats) === 0;
      create.disabled = !isComplete;
      createBot.disabled = !isComplete;
      ffa.setReady(isComplete);
    },
  );
  const saveProfile = (): void => {
    localStorage.setItem(NICKNAME_KEY, nickname.value);
    localStorage.setItem(STATS_KEY, formatStats(picker.value()));
  };
  const levels = mountLevelPicker({
    toggle: byId('bot-level-toggle', HTMLButtonElement),
    list: byId('bot-levels', HTMLElement),
    hint: byId('level-hint', HTMLElement),
    info: byId('level-info', HTMLButtonElement),
  });
  const startDuelWith = (code: string): void => {
    saveProfile();
    location.assign(`/d/${code}`);
  };
  create.addEventListener('click', () => {
    startDuelWith(randomCode());
  });
  createBot.addEventListener('click', () => {
    startDuelWith(botRoomCode(levels.selected(), randomCode()));
  });
  void showAndroidDownload();
}

// Блок с QR-кодом появляется, только если сервер действительно раздаёт APK.
async function showAndroidDownload(): Promise<void> {
  const response = await fetch(APK_ROUTE, { method: 'HEAD' }).catch(() => null);
  if (response?.ok !== true) {
    return;
  }
  const url = new URL(APK_ROUTE, location.href).href;
  byId('android-link', HTMLAnchorElement).href = url;
  await QRCode.toCanvas(byId('android-qr', HTMLCanvasElement), url, {
    width: 200,
    margin: 1,
    color: { dark: '#0b0f0d', light: '#f4f1e8' },
  });
  byId('android', HTMLElement).hidden = false;
}

// Кнопка авто-огня — только на устройстве с касанием; реагирует на само касание, как шестерёнка, чтобы работать
// вторым пальцем при зажатом стике. Подсветку кнопка берёт из игры: та же сбрасывает авто-огонь на старте раунда.
function bindAutoFire(button: HTMLButtonElement, hasTouch: boolean): { reflect: (isOn: boolean) => void } {
  button.hidden = !hasTouch;
  return {
    reflect: (isOn) => {
      button.classList.toggle(AUTOFIRE_ACTIVE_CLASS, isOn);
      button.setAttribute('aria-pressed', String(isOn));
    },
  };
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
  const hasTouch = isTouchDevice();
  const store = new SettingsStore(localStorage, defaultSettings(), { isAdmin });
  const autoFireButton = byId('autofire', HTMLButtonElement);
  const autoFire = bindAutoFire(autoFireButton, hasTouch);
  const game = new Game({
    roomCode,
    nickname,
    stats,
    canvas,
    overlay: byId('overlay', HTMLElement),
    roundEnd: byId('round-end', HTMLElement),
    onAutoFireChange: autoFire.reflect,
    settings: store.value,
    isTouchDevice: hasTouch,
    telemetry,
  });
  const settingsToggle = byId('settings-toggle', HTMLButtonElement);
  settingsToggle.hidden = false;
  byId('menu', HTMLAnchorElement).hidden = false;
  const panel = new SettingsPanel(byId('settings', HTMLElement), settingsToggle, store, hasTouch);
  window.addEventListener('keydown', (event) => {
    if (event.code === SETTINGS_KEY_CODE && !event.repeat) {
      panel.toggle();
    }
  });
  autoFireButton.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    game.toggleAutoFire();
  });
  bindRotateHint(byId('rotate', HTMLElement));
  if (isAndroidBrowser(navigator.userAgent, Capacitor.isNativePlatform())) {
    const apkUrl = new URL(APK_ROUTE, location.href).href;
    showOpenInApp(
      byId('open-app', HTMLElement),
      byId('open-app-link', HTMLAnchorElement),
      byId('open-app-close', HTMLButtonElement),
      androidIntentUrl(location.href, apkUrl),
    );
  }
  // Точка доступа для сквозных тестов и отладки из консоли браузера.
  Object.assign(window, { tanksGame: game });
  window.addEventListener('beforeunload', () => {
    game.close();
  });
}

// Общий бой: та же страница боя, что у дуэли, — холст, кнопки поверх и корень интерфейса толпы. Ссылки `/ffa`
// приложение-оболочка не перехватывает, поэтому баннера «Открыть в приложении» здесь нет.
// Код толпы — отдельный кусок сборки: страница дуэли его не грузит.
async function startFfa(size: FfaSize): Promise<void> {
  const ffaModule = await import('./ffa/ffaGame.js');
  const canvas = byId('stage', HTMLCanvasElement);
  canvas.hidden = false;
  document.body.classList.add('duel');
  const hasTouch = isTouchDevice();
  const store = new SettingsStore(localStorage, defaultSettings(), { isAdmin });
  const autoFireButton = byId('autofire', HTMLButtonElement);
  const autoFire = bindAutoFire(autoFireButton, hasTouch);
  const game = new ffaModule.FfaGame({
    size,
    nickname: localStorage.getItem(NICKNAME_KEY) ?? '',
    stats: parseStats(localStorage.getItem(STATS_KEY)),
    canvas,
    hud: byId('ffa-hud', HTMLElement),
    settings: store.value,
    isTouchDevice: hasTouch,
    isAdmin,
    telemetry,
    onAutoFireChange: autoFire.reflect,
    onFieldControlsChange: (isVisible) => {
      autoFireButton.hidden = !hasTouch || !isVisible;
    },
  });
  const settingsToggle = byId('settings-toggle', HTMLButtonElement);
  settingsToggle.hidden = false;
  byId('menu', HTMLAnchorElement).hidden = false;
  const panel = new SettingsPanel(byId('settings', HTMLElement), settingsToggle, store, hasTouch);
  window.addEventListener('keydown', (event) => {
    if (event.code === SETTINGS_KEY_CODE && !event.repeat) {
      panel.toggle();
    }
  });
  autoFireButton.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    game.toggleAutoFire();
  });
  bindRotateHint(byId('rotate', HTMLElement));
  Object.assign(window, { tanksGame: game });
  window.addEventListener('beforeunload', () => {
    game.close();
  });
}

// null — адрес не общего боя или размер не из списка игр.
function ffaSizeOfPath(pathname: string): FfaSize | null {
  const match = FFA_ROUTE.exec(pathname);
  if (match === null) {
    return null;
  }
  const digits = match[1];
  if (digits === undefined) {
    return FFA_DEFAULT_SIZE;
  }
  return FFA_SIZES.find((size) => String(size) === digits) ?? null;
}

const duelMatch = /^\/d\/([a-z0-9]{3,16})$/.exec(location.pathname);
const ffaSize = ffaSizeOfPath(location.pathname);
const query = new URLSearchParams(location.search);
const labKind = query.get('lab');
if (duelMatch?.[1] !== undefined) {
  startDuel(duelMatch[1]);
} else if (ffaSize !== null) {
  void startFfa(ffaSize);
} else if (labKind === 'camera') {
  showCameraLab(byId('lab', HTMLElement));
} else if (labKind === 'fx') {
  showFxLab(byId('lab', HTMLElement));
} else if (labKind === 'frames' && query.get('set') === 'ffa') {
  void import('./frameStand/ffaStand.js').then(({ showFfaFrameStand }) => {
    showFfaFrameStand(byId('lab', HTMLElement));
  });
} else if (labKind === 'frames') {
  showFrameStand(byId('lab', HTMLElement));
} else {
  showHome();
}
