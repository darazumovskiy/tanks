import type { SoundSetting } from './soundSetting.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_VIEW_BOX = '0 0 24 24';
const MUTED_CLASS = 'is-muted';
const STROKE_CLASS = 'sound-icon-stroke';
const WAVES_CLASS = 'sound-icon-waves';
const CROSS_CLASS = 'sound-icon-cross';
const SPEAKER_PATHS = ['M4 9.5h3.5L12 5.5v13l-4.5-4H4z'];
const WAVES_PATHS = ['M15 9.5a3.5 3.5 0 0 1 0 5', 'M17.5 7a7 7 0 0 1 0 10'];
const CROSS_PATHS = ['m15.5 9.5 5 5', 'm20.5 9.5-5 5'];
const LABEL_TURN_OFF = 'Выключить звук';
const LABEL_TURN_ON = 'Включить звук';
const PRIMARY_BUTTON = 0;
// Клик без нажатия указателя — Enter или пробел на кнопке в фокусе либо экранный диктор.
const KEYBOARD_CLICK_DETAIL = 0;

function icon(classes: readonly string[], paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', ICON_VIEW_BOX);
  svg.setAttribute('aria-hidden', 'true');
  for (const className of classes) {
    svg.classList.add(className);
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function reflect(button: HTMLButtonElement, isMuted: boolean): void {
  button.classList.toggle(MUTED_CLASS, isMuted);
  button.setAttribute('aria-pressed', String(isMuted));
  button.setAttribute('aria-label', isMuted ? LABEL_TURN_ON : LABEL_TURN_OFF);
}

// Кнопка звука любого экрана: значок и состояние — из настройки, касание переключает её. Переключает по самому
// касанию, как шестерёнка: второй палец при зажатом стике не рождает click. Фокус кнопка не забирает — пробел
// остаётся выстрелом.
export function mountSoundToggle(button: HTMLButtonElement, sound: SoundSetting): void {
  button.type = 'button';
  button.replaceChildren(
    icon([], SPEAKER_PATHS),
    icon([STROKE_CLASS, WAVES_CLASS], WAVES_PATHS),
    icon([STROKE_CLASS, CROSS_CLASS], CROSS_PATHS),
  );
  reflect(button, sound.isMuted);
  sound.onChange((isMuted) => {
    reflect(button, isMuted);
  });
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== PRIMARY_BUTTON) {
      return;
    }
    event.preventDefault();
    sound.toggle();
  });
  button.addEventListener('click', (event) => {
    if (event.detail === KEYBOARD_CLICK_DETAIL) {
      sound.toggle();
    }
  });
  button.hidden = false;
}
