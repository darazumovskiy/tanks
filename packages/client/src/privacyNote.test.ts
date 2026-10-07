import { describe, expect, it } from 'vitest';
import { mountPrivacyNote, PRIVACY_NOTE_CLOSED_KEY } from './privacyNote.js';

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

class BrokenStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new Error('SecurityError');
  }

  override setItem(): void {
    throw new Error('QuotaExceededError');
  }
}

function mount(storage: Storage): { note: HTMLElement; close: HTMLButtonElement } {
  const note = document.createElement('div');
  note.hidden = true;
  const close = document.createElement('button');
  note.append(close);
  mountPrivacyNote(note, close, storage);
  return { note, close };
}

describe('плашка о сборе данных', () => {
  it('видна, пока не закрыта; крестик прячет её и запоминает на устройстве', () => {
    const storage = new MemoryStorage();
    const first = mount(storage);
    expect(first.note.hidden).toBe(false);
    first.close.click();
    expect(first.note.hidden).toBe(true);
    expect(storage.getItem(PRIVACY_NOTE_CLOSED_KEY)).toBe('1');
    expect(mount(storage).note.hidden).toBe(true);
  });

  it('хранилище бросает — плашка видна и закрывается без исключений', () => {
    const { note, close } = mount(new BrokenStorage());
    expect(note.hidden).toBe(false);
    close.click();
    expect(note.hidden).toBe(true);
  });
});
