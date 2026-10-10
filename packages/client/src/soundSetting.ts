export const SOUND_STORAGE_KEY = 'tanks.sound';
const SOUND_OFF = 'off';
const SOUND_ON = 'on';

export interface SoundStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SoundListener = (isMuted: boolean) => void;

function readMuted(storage: SoundStorage | null): boolean {
  if (storage === null) {
    return false;
  }
  try {
    return storage.getItem(SOUND_STORAGE_KEY) === SOUND_OFF;
  } catch {
    return false;
  }
}

function writeMuted(storage: SoundStorage | null, isMuted: boolean): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(SOUND_STORAGE_KEY, isMuted ? SOUND_OFF : SOUND_ON);
  } catch {
    return;
  }
}

// Звук на устройстве — включён или выключен. Хранилище недоступно или не принимает запись — живёт в памяти страницы.
export class SoundSetting {
  private isMutedNow: boolean;
  private readonly listeners: SoundListener[] = [];

  constructor(private readonly storage: SoundStorage | null) {
    this.isMutedNow = readMuted(storage);
  }

  get isMuted(): boolean {
    return this.isMutedNow;
  }

  toggle(): void {
    this.isMutedNow = !this.isMutedNow;
    writeMuted(this.storage, this.isMutedNow);
    for (const listener of this.listeners) {
      listener(this.isMutedNow);
    }
  }

  onChange(listener: SoundListener): void {
    this.listeners.push(listener);
  }
}

function browserStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

let device: SoundSetting | null = null;

// Одна настройка на страницу: звуки и кнопки всех экранов читают и меняют её.
export function deviceSound(): SoundSetting {
  device ??= new SoundSetting(browserStorage());
  return device;
}
