import { Share } from '@capacitor/share';

export const COPIED_FEEDBACK_MS = 1500;
const COPY_LABEL = 'Копировать';
const COPIED_LABEL = 'Скопировано';
const SHARE_LABEL = 'Поделиться';
const SHARE_TITLE = 'Танки';
const SHARE_TEXT = 'Заходи на дуэль в танки';
const SHARE_DIALOG_TITLE = 'Отправить ссылку';

export interface InviteActions {
  copy(text: string): Promise<void>;
  canShare(): Promise<boolean>;
  share(url: string): Promise<void>;
}

// В приложении «Поделиться» — системное меню через нативный плагин, в браузере тот же пакет зовёт navigator.share.
export const browserInviteActions: InviteActions = {
  copy: (text) => navigator.clipboard.writeText(text),
  canShare: async () => (await Share.canShare()).value,
  share: async (url) => {
    await Share.share({ title: SHARE_TITLE, text: SHARE_TEXT, url, dialogTitle: SHARE_DIALOG_TITLE });
  },
};

// Подсказка, поле со ссылкой и кнопки «Копировать» / «Поделиться» внутри оверлея ожидания соперника.
export function renderInvite(container: HTMLElement, link: string, actions: InviteActions): void {
  const hint = document.createElement('div');
  hint.className = 'overlay-hint';
  hint.textContent = 'Отправь ссылку второму игроку:';

  const linkBox = document.createElement('input');
  linkBox.className = 'overlay-link';
  linkBox.readOnly = true;
  linkBox.value = link;

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'overlay-button overlay-copy';
  copyButton.textContent = COPY_LABEL;
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  const showCopied = (): void => {
    copyButton.textContent = COPIED_LABEL;
    if (feedbackTimer !== null) {
      clearTimeout(feedbackTimer);
    }
    feedbackTimer = setTimeout(() => {
      copyButton.textContent = COPY_LABEL;
    }, COPIED_FEEDBACK_MS);
  };
  const copyLink = (): void => {
    // Браузер не дал доступ к буферу — надпись не меняется, ссылку можно выделить в поле руками.
    void actions.copy(link).then(showCopied, () => undefined);
  };
  copyButton.addEventListener('click', copyLink);
  linkBox.addEventListener('click', () => {
    linkBox.select();
    copyLink();
  });

  const buttons = document.createElement('div');
  buttons.className = 'overlay-buttons';
  buttons.append(copyButton);

  const shareButton = document.createElement('button');
  shareButton.type = 'button';
  shareButton.className = 'overlay-button overlay-share';
  shareButton.textContent = SHARE_LABEL;
  shareButton.addEventListener('click', () => {
    // Игрок закрыл системное меню, ничего не выбрав — это не ошибка.
    void actions.share(link).catch(() => undefined);
  });
  void actions.canShare().then((isAvailable) => {
    if (isAvailable) {
      buttons.append(shareButton);
    }
  });

  container.append(hint, linkBox, buttons);
}
