import { Capacitor } from '@capacitor/core';
import { DEFAULT_STATS, STAT_KEYS, STAT_POINTS, type Stats } from '@tanks/shared/engine';
import QRCode from 'qrcode';
import { resolveAdminMode } from './admin.js';
import { androidIntentUrl, isAndroidBrowser, showOpenInApp } from './appLink.js';
import { bindImmersive } from './immersive.js';
import { readClientInfo } from './clientInfo.js';
import { mountDropdown, type DropdownElements } from './dropdown.js';
import { mountFfaEntry } from './ffaEntry.js';
import { ffaRouteOf, type FfaRoute } from './ffaRoute.js';
import { fetchHomeHtml, reloadOnNewBuild } from './freshBuild.js';
import { Game } from './game.js';
import { showFrameStand } from './frameStand/stand.js';
import { showFxLab } from './fxLab/fxLab.js';
import { showCameraLab } from './lab.js';
import { defaultSettings, SettingsStore } from './settings.js';
import { SettingsPanel } from './settingsPanel.js';
import { mountPrivacyNote } from './privacyNote.js';
import { deviceSound } from './soundSetting.js';
import { mountSoundToggle } from './soundToggle.js';
import { RIVALS, rivalBadge, rivalInfo, rivalOf, rivalRoomCode, type Rival } from './rival.js';
import { mountStatsPicker, statsLeft } from './statsPicker.js';
import { Telemetry } from './telemetry.js';
import { startVisit } from './visitor.js';

const NICKNAME_KEY = 'tanks.nickname';
const STATS_KEY = 'tanks.stats';
const BOT_LEVEL_KEY = 'tanks.botLevel';
const DEFAULT_RIVAL: Rival = 1;
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const APK_ROUTE = '/app/tanks.apk';
const WATCH_PATH = '/watch';
const SETTINGS_KEY_CODE = 'KeyO';
const AUTOFIRE_ACTIVE_CLASS = 'is-active';
const LEVEL_INFO_OPEN_CLASS = 'is-open';
const isTouchDevice = (): boolean => matchMedia('(pointer: coarse)').matches;
const clientInfo = readClientInfo();
// Один на страницу: ошибки главной и боя уходят с одинаковым описанием клиента.
const telemetry = new Telemetry(clientInfo);
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

// Номер уровня или знак двойника, имя и короткое описание — одинаково в строке списка и на кнопке выбранного.
function rivalContent(rival: Rival): HTMLElement[] {
  const info = rivalInfo(rival);
  const badge = document.createElement('span');
  badge.className = 'level-badge';
  badge.textContent = rivalBadge(rival);
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

interface LevelPickerElements extends DropdownElements {
  hint: HTMLElement;
  info: HTMLButtonElement;
}

// Список соперников — уровни из общего с сервером контракта и двойник; выбор запоминается на устройстве.
function mountRivalPicker(elements: LevelPickerElements): { selected: () => Rival } {
  const initial = rivalOf(localStorage.getItem(BOT_LEVEL_KEY), DEFAULT_RIVAL);
  const showSummary = (rival: Rival): void => {
    elements.hint.textContent = rivalInfo(rival).summary;
  };
  const picker = mountDropdown(elements, {
    values: RIVALS,
    selected: initial,
    optionClass: 'level',
    dataKey: 'level',
    optionContent: rivalContent,
    toggleContent: rivalContent,
    onSelect: (rival) => {
      localStorage.setItem(BOT_LEVEL_KEY, String(rival));
      showSummary(rival);
    },
  });
  showSummary(initial);
  elements.info.addEventListener('click', () => {
    elements.hint.hidden = !elements.hint.hidden;
    elements.info.classList.toggle(LEVEL_INFO_OPEN_CLASS, !elements.hint.hidden);
    elements.info.setAttribute('aria-expanded', String(!elements.hint.hidden));
  });
  return picker;
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
  startVisit(localStorage, nickname.value, clientInfo);
  mountPrivacyNote(byId('privacy-note', HTMLElement), byId('privacy-note-close', HTMLButtonElement), localStorage);
  mountSoundToggle(byId('home-sound', HTMLButtonElement), deviceSound());
  // Ник на устройстве сразу: главная перезагружается сама, когда выходит новая сборка.
  nickname.addEventListener('input', () => {
    localStorage.setItem(NICKNAME_KEY, nickname.value);
  });
  const freshBuild = reloadOnNewBuild(document, {
    pathname: location.pathname,
    loadHome: fetchHomeHtml,
    reload: () => {
      location.reload();
    },
    now: () => performance.now(),
  });
  const goToFight = (path: string): void => {
    freshBuild.cancelCheck();
    location.assign(path);
  };
  const ffa = mountFfaEntry(
    {
      start: byId('ffa-start', HTMLButtonElement),
      info: byId('ffa-info', HTMLButtonElement),
      hint: byId('ffa-hint', HTMLElement),
      locked: byId('ffa-locked', HTMLElement),
      sizeToggle: byId('ffa-size-toggle', HTMLButtonElement),
      sizeList: byId('ffa-sizes', HTMLElement),
    },
    {
      save: () => {
        saveProfile();
      },
      navigate: goToFight,
    },
    localStorage,
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
  const rivals = mountRivalPicker({
    toggle: byId('bot-level-toggle', HTMLButtonElement),
    list: byId('bot-levels', HTMLElement),
    hint: byId('level-hint', HTMLElement),
    info: byId('level-info', HTMLButtonElement),
  });
  const startDuelWith = (code: string): void => {
    saveProfile();
    goToFight(`/d/${code}`);
  };
  create.addEventListener('click', () => {
    startDuelWith(randomCode());
  });
  createBot.addEventListener('click', () => {
    startDuelWith(rivalRoomCode(rivals.selected(), randomCode()));
  });
  byId('watch-open', HTMLButtonElement).addEventListener('click', () => {
    goToFight(WATCH_PATH);
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

// Бой, открытый в браузере Android: плашка ведёт в приложение, а оставшимся в браузере касание разворачивает игру.
function bindAndroidBrowser(): void {
  if (!isAndroidBrowser(navigator.userAgent, Capacitor.isNativePlatform())) {
    return;
  }
  const banner = byId('open-app', HTMLElement);
  showOpenInApp(
    banner,
    byId('open-app-link', HTMLAnchorElement),
    byId('open-app-close', HTMLButtonElement),
    androidIntentUrl(location.href, new URL(APK_ROUTE, location.href).href),
  );
  bindImmersive({
    events: document,
    root: document.documentElement,
    orientation: screen.orientation,
    isFullscreen: () => document.fullscreenElement !== null,
    isOutside: (target) => !(target instanceof Node && banner.contains(target)),
  });
}

function startDuel(roomCode: string): void {
  const nickname = localStorage.getItem(NICKNAME_KEY) ?? '';
  const stats = parseStats(localStorage.getItem(STATS_KEY));
  const visit = startVisit(localStorage, nickname, clientInfo);
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
    deviceId: visit.dev,
    telemetry,
  });
  const settingsToggle = byId('settings-toggle', HTMLButtonElement);
  settingsToggle.hidden = false;
  byId('menu', HTMLAnchorElement).hidden = false;
  mountSoundToggle(byId('sound-toggle', HTMLButtonElement), deviceSound());
  const panel = new SettingsPanel(byId('settings', HTMLElement), settingsToggle, store, {
    isTouchDevice: hasTouch,
    hasCameraGroup: true,
  });
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
  bindAndroidBrowser();
  // Точка доступа для сквозных тестов и отладки из консоли браузера.
  Object.assign(window, { tanksGame: game });
  window.addEventListener('beforeunload', () => {
    game.close();
  });
}

// Общий бой: та же страница боя, что у дуэли, — холст, кнопки поверх и корень интерфейса толпы.
// Код толпы — отдельный кусок сборки: страница дуэли его не грузит.
async function startFfa(route: FfaRoute): Promise<void> {
  const ffaModule = await import('./ffa/ffaGame.js');
  const canvas = byId('stage', HTMLCanvasElement);
  canvas.hidden = false;
  document.body.classList.add('duel', 'ffa');
  const hasTouch = isTouchDevice();
  const store = new SettingsStore(localStorage, defaultSettings(), { isAdmin });
  const autoFireButton = byId('autofire', HTMLButtonElement);
  const autoFire = bindAutoFire(autoFireButton, hasTouch);
  const nickname = localStorage.getItem(NICKNAME_KEY) ?? '';
  const visit = startVisit(localStorage, nickname, clientInfo);
  const game = new ffaModule.FfaGame({
    size: route.size,
    inviteGameId: route.gameId,
    nickname,
    stats: parseStats(localStorage.getItem(STATS_KEY)),
    canvas,
    hud: byId('ffa-hud', HTMLElement),
    settings: store.value,
    isTouchDevice: hasTouch,
    deviceId: visit.dev,
    telemetry,
    onAutoFireChange: autoFire.reflect,
    onFieldControlsChange: (isVisible) => {
      autoFireButton.hidden = !hasTouch || !isVisible;
    },
  });
  const settingsToggle = byId('settings-toggle', HTMLButtonElement);
  settingsToggle.hidden = false;
  const menu = byId('menu', HTMLAnchorElement);
  menu.hidden = false;
  mountSoundToggle(byId('sound-toggle', HTMLButtonElement), deviceSound());
  menu.addEventListener('click', (event) => {
    event.preventDefault();
    game.leave();
  });
  // Камера толпы одна — стратегий выбирать не из чего.
  const panel = new SettingsPanel(byId('settings', HTMLElement), settingsToggle, store, {
    isTouchDevice: hasTouch,
    hasCameraGroup: false,
  });
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
  bindAndroidBrowser();
  Object.assign(window, { tanksGame: game });
  window.addEventListener('beforeunload', () => {
    game.close();
  });
}

// Бой ботов считается в браузере: холст над панелью управления. Код боя ботов и мозги — отдельный кусок сборки.
async function startWatch(): Promise<void> {
  const watchModule = await import('./watch/watchPage.js');
  const canvas = byId('stage', HTMLCanvasElement);
  document.body.classList.add('duel', 'watch');
  watchModule.applyWatchStyle(document.body);
  canvas.hidden = false;
  byId('watch', HTMLElement).hidden = false;
  const game = await watchModule.mountWatch(
    {
      left: { toggle: byId('watch-left-toggle', HTMLButtonElement), list: byId('watch-left-list', HTMLElement) },
      right: { toggle: byId('watch-right-toggle', HTMLButtonElement), list: byId('watch-right-list', HTMLElement) },
      speeds: byId('watch-speeds', HTMLElement),
      pause: byId('watch-pause', HTMLButtonElement),
      restart: byId('watch-restart', HTMLButtonElement),
      sound: byId('watch-sound', HTMLButtonElement),
      result: byId('watch-result', HTMLElement),
      notice: byId('watch-notice', HTMLElement),
    },
    localStorage,
    watchModule.browserWatchDeps(canvas),
    deviceSound(),
  );
  bindRotateHint(byId('rotate', HTMLElement));
  Object.assign(window, { tanksGame: game });
}

const duelMatch = /^\/d\/([a-z0-9]{3,16})$/.exec(location.pathname);
const ffaRoute = ffaRouteOf(location.pathname);
const query = new URLSearchParams(location.search);
const labKind = query.get('lab');
if (duelMatch?.[1] !== undefined) {
  startDuel(duelMatch[1]);
} else if (ffaRoute !== null) {
  void startFfa(ffaRoute);
} else if (location.pathname === WATCH_PATH) {
  void startWatch();
} else if (labKind === 'camera') {
  showCameraLab(byId('lab', HTMLElement));
} else if (labKind === 'fx') {
  showFxLab(byId('lab', HTMLElement));
} else if (labKind === 'lag') {
  void import('./lagLab/lagLab.js').then(({ showLagLab }) => {
    showLagLab(byId('lab', HTMLElement));
  });
} else if (labKind === 'frames' && query.get('set') === 'ffa') {
  void import('./frameStand/ffaStand.js').then(({ showFfaFrameStand }) => {
    showFfaFrameStand(byId('lab', HTMLElement));
  });
} else if (labKind === 'frames') {
  showFrameStand(byId('lab', HTMLElement));
} else {
  showHome();
}
