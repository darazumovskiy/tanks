// Блокировку ориентации знают не все браузеры и не все описания DOM, поэтому метод необязательный.
export interface OrientationControl {
  readonly type: string;
  lock?: (orientation: 'landscape') => Promise<void>;
}

export interface ImmersivePage {
  events: EventTarget;
  root: { requestFullscreen(options?: FullscreenOptions): Promise<void> };
  orientation: OrientationControl;
  isFullscreen: () => boolean;
  // Касание по плашке «Открыть в приложении» ведёт в приложение, а не разворачивает страницу.
  isOutside: (target: EventTarget | null) => boolean;
}

// Браузер разрешает полный экран и поворот только из жеста игрока, поэтому — по касанию; отказ браузера не мешает игре.
export function bindImmersive(page: ImmersivePage): void {
  page.events.addEventListener('pointerdown', (event) => {
    if (page.isFullscreen() || !page.isOutside(event.target)) {
      return;
    }
    page.root
      .requestFullscreen({ navigationUI: 'hide' })
      .then(() => lockLandscape(page.orientation))
      .catch(() => undefined);
  });
}

async function lockLandscape(orientation: OrientationControl): Promise<void> {
  if (orientation.lock === undefined) {
    return;
  }
  await orientation.lock('landscape');
}
