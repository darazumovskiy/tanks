export const PRIVACY_NOTE_CLOSED_KEY = 'tanks.privacyNoteClosed';
const CLOSED = '1';

function isClosed(storage: Storage): boolean {
  try {
    return storage.getItem(PRIVACY_NOTE_CLOSED_KEY) === CLOSED;
  } catch {
    return false;
  }
}

function rememberClosed(storage: Storage): void {
  try {
    storage.setItem(PRIVACY_NOTE_CLOSED_KEY, CLOSED);
  } catch {
    return;
  }
}

// Плашка о том, что собирает игра: видна, пока игрок не закрыл её крестиком на этом устройстве.
export function mountPrivacyNote(note: HTMLElement, close: HTMLButtonElement, storage: Storage): void {
  if (isClosed(storage)) {
    return;
  }
  note.hidden = false;
  close.addEventListener('click', () => {
    note.hidden = true;
    rememberClosed(storage);
  });
}
