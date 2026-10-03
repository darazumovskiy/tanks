import { DEFAULT_STATS, STAT_KEYS, STAT_POINTS, type Stats } from '@tanks/shared/engine';
import QRCode from 'qrcode';
import { Game } from './game.js';
import { showCameraLab } from './lab.js';
import { SettingsStore } from './settings.js';
import { SettingsPanel } from './settingsPanel.js';

const NICKNAME_KEY = 'tanks.nickname';
const STATS_KEY = 'tanks.stats';
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const APK_ROUTE = '/app/tanks.apk';
// Код с этим префиксом сервер понимает как дуэль против манекена.
const BOT_ROOM_PREFIX = 'bot';
const SETTINGS_KEY_CODE = 'KeyO';
const isTouchDevice = (): boolean => matchMedia('(pointer: coarse)').matches;

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
  const startDuelWith = (code: string): void => {
    localStorage.setItem(NICKNAME_KEY, nickname.value);
    localStorage.setItem(STATS_KEY, statsInput.value);
    location.assign(`/d/${code}`);
  };
  byId('create', HTMLButtonElement).addEventListener('click', () => {
    startDuelWith(randomCode());
  });
  byId('create-bot', HTMLButtonElement).addEventListener('click', () => {
    startDuelWith(`${BOT_ROOM_PREFIX}${randomCode()}`);
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
  const store = new SettingsStore(localStorage);
  const game = new Game({
    roomCode,
    nickname,
    stats,
    canvas,
    overlay: byId('overlay', HTMLElement),
    settings: store.value,
    isTouchDevice: isTouchDevice(),
  });
  const settingsToggle = byId('settings-toggle', HTMLButtonElement);
  settingsToggle.hidden = false;
  const panel = new SettingsPanel(byId('settings', HTMLElement), settingsToggle, store);
  window.addEventListener('keydown', (event) => {
    if (event.code === SETTINGS_KEY_CODE && !event.repeat) {
      panel.toggle();
    }
  });
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
} else if (new URLSearchParams(location.search).get('lab') === 'camera') {
  showCameraLab(byId('lab', HTMLElement));
} else {
  showHome();
}
