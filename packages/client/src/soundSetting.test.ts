import { describe, expect, it } from 'vitest';
import { SOUND_STORAGE_KEY, SoundSetting, type SoundStorage } from './soundSetting.js';

function memoryStorage(entries: Record<string, string> = {}): SoundStorage & { items: Map<string, string> } {
  const items = new Map(Object.entries(entries));
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

const unreadable: SoundStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => undefined,
};

const unwritable: SoundStorage = {
  getItem: () => null,
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('звук на устройстве', () => {
  it('в хранилище пусто — звук включён; там «off» — выключен', () => {
    expect(new SoundSetting(memoryStorage()).isMuted).toBe(false);
    expect(new SoundSetting(memoryStorage({ [SOUND_STORAGE_KEY]: 'off' })).isMuted).toBe(true);
    expect(new SoundSetting(memoryStorage({ [SOUND_STORAGE_KEY]: 'on' })).isMuted).toBe(false);
  });

  it('переключение записывается в хранилище и доходит до всех подписчиков', () => {
    const storage = memoryStorage();
    const sound = new SoundSetting(storage);
    const heard: boolean[][] = [[], []];
    sound.onChange((isMuted) => heard[0]?.push(isMuted));
    sound.onChange((isMuted) => heard[1]?.push(isMuted));
    sound.toggle();
    expect(sound.isMuted).toBe(true);
    expect(storage.items.get(SOUND_STORAGE_KEY)).toBe('off');
    expect(new SoundSetting(storage).isMuted).toBe(true);
    sound.toggle();
    expect(storage.items.get(SOUND_STORAGE_KEY)).toBe('on');
    expect(heard).toEqual([
      [true, false],
      [true, false],
    ]);
  });

  it('хранилище не читается — звук включён; не пишет или его нет — переключается в памяти', () => {
    expect(new SoundSetting(unreadable).isMuted).toBe(false);
    for (const storage of [unwritable, null]) {
      const sound = new SoundSetting(storage);
      sound.toggle();
      expect(sound.isMuted).toBe(true);
      sound.toggle();
      expect(sound.isMuted).toBe(false);
    }
  });
});
