import { beforeEach, describe, expect, it } from 'vitest';
import { SOUND_STORAGE_KEY, SoundSetting } from './soundSetting.js';
import { mountSoundToggle } from './soundToggle.js';

const TOUCH = 0;
const RIGHT_MOUSE_BUTTON = 2;

function button(sound: SoundSetting): HTMLButtonElement {
  const created = document.createElement('button');
  created.hidden = true;
  document.body.append(created);
  mountSoundToggle(created, sound);
  return created;
}

function press(target: HTMLButtonElement, mouseButton = TOUCH): PointerEvent {
  const event = new PointerEvent('pointerdown', { button: mouseButton, cancelable: true, bubbles: true });
  target.dispatchEvent(event);
  return event;
}

function shown(target: HTMLButtonElement): { pressed: string | null; label: string | null; isMuted: boolean } {
  return {
    pressed: target.getAttribute('aria-pressed'),
    label: target.getAttribute('aria-label'),
    isMuted: target.classList.contains('is-muted'),
  };
}

const ON = { pressed: 'false', label: 'Выключить звук', isMuted: false };
const OFF = { pressed: 'true', label: 'Включить звук', isMuted: true };

describe('кнопка звука', () => {
  let sound: SoundSetting;

  beforeEach(() => {
    document.body.innerHTML = '';
    sound = new SoundSetting(null);
  });

  it('показана, со значком динамика, волнами и крестиком; состояние — из настройки', () => {
    const toggle = button(sound);
    expect(toggle.hidden).toBe(false);
    expect(toggle.type).toBe('button');
    expect(toggle.querySelectorAll('svg')).toHaveLength(3);
    expect(toggle.querySelector('.sound-icon-waves')).not.toBeNull();
    expect(toggle.querySelector('.sound-icon-cross')).not.toBeNull();
    expect(shown(toggle)).toEqual(ON);
    const muted = new SoundSetting({ getItem: () => 'off', setItem: () => undefined });
    expect(shown(button(muted))).toEqual(OFF);
  });

  it('касание переключает настройку и не забирает фокус; повторное — обратно', () => {
    const toggle = button(sound);
    expect(press(toggle).defaultPrevented).toBe(true);
    expect(sound.isMuted).toBe(true);
    expect(shown(toggle)).toEqual(OFF);
    press(toggle);
    expect(sound.isMuted).toBe(false);
    expect(shown(toggle)).toEqual(ON);
  });

  it('настройку сменили не кнопкой (клавиша M) — кнопки на той же настройке следуют за ней', () => {
    const first = button(sound);
    const second = button(sound);
    sound.toggle();
    expect(shown(first)).toEqual(OFF);
    expect(shown(second)).toEqual(OFF);
    press(second);
    expect(shown(first)).toEqual(ON);
  });

  it('с клавиатуры — переключает; клик после касания и правая кнопка мыши — нет', () => {
    const toggle = button(sound);
    toggle.dispatchEvent(new MouseEvent('click', { detail: 0 }));
    expect(sound.isMuted).toBe(true);
    toggle.dispatchEvent(new MouseEvent('click', { detail: 1 }));
    expect(sound.isMuted).toBe(true);
    press(toggle, RIGHT_MOUSE_BUTTON);
    expect(sound.isMuted).toBe(true);
  });

  it('звук выключен кнопкой — запоминается на устройстве', () => {
    const items = new Map<string, string>();
    const stored = new SoundSetting({
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        items.set(key, value);
      },
    });
    press(button(stored));
    expect(items.get(SOUND_STORAGE_KEY)).toBe('off');
  });
});
