const HOME_PATH = '/';
const CHECK_INTERVAL_MS = 30_000;
// Vite кладёт файлы сборки в `/assets/` с хешем содержимого в имени: другой набор — другая сборка. Чужие скрипты и
// стили, которые дописывают на живую страницу переводчик браузера и расширения, в сверку не попадают.
const BUILD_FILES = 'script[src^="/assets/"], link[rel="stylesheet"][href^="/assets/"]';

export interface FreshBuildOptions {
  pathname: string;
  // Свежий `index.html` мимо кэша; null — нет связи или ответ не 200.
  loadHome: () => Promise<string | null>;
  reload: () => void;
  now: () => number;
}

export interface FreshBuild {
  // Игрок уходит с главной: идущая сверка не перезагрузит страницу поверх перехода.
  cancelCheck(): void;
}

function buildSignature(page: Document): string {
  return Array.from(page.querySelectorAll(BUILD_FILES), (file) => file.getAttribute('src') ?? file.getAttribute('href'))
    .filter((name) => name !== null)
    .join(' ');
}

export async function fetchHomeHtml(): Promise<string | null> {
  const response = await fetch(HOME_PATH, { cache: 'no-store' }).catch(() => null);
  if (response?.ok !== true) {
    return null;
  }
  return response.text().catch(() => null);
}

// Свёрнутые до выкладки вкладка или приложение-оболочка возвращаются со старой главной из памяти: при возврате на
// экран главная сверяет свою сборку со свежей и перезагружается. Страницы боя не трогаются — бой не рвётся.
export function reloadOnNewBuild(page: Document, options: FreshBuildOptions): FreshBuild {
  let checkNumber = 0;
  const freshBuild: FreshBuild = {
    cancelCheck: () => {
      checkNumber++;
    },
  };
  if (options.pathname !== HOME_PATH) {
    return freshBuild;
  }
  const loaded = buildSignature(page);
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  let isChecking = false;
  const check = async (): Promise<void> => {
    const startedAs = checkNumber;
    const html = await options.loadHome();
    const isCancelled = startedAs !== checkNumber;
    if (html === null || isCancelled) {
      return;
    }
    const fresh = buildSignature(new DOMParser().parseFromString(html, 'text/html'));
    if (fresh !== '' && fresh !== loaded) {
      options.reload();
    }
  };
  page.addEventListener('visibilitychange', () => {
    const isVisible = page.visibilityState === 'visible';
    const isDue = options.now() - lastCheckAt >= CHECK_INTERVAL_MS;
    const shouldCheck = isVisible && isDue && !isChecking;
    if (!shouldCheck) {
      return;
    }
    lastCheckAt = options.now();
    isChecking = true;
    void check().finally(() => {
      isChecking = false;
    });
  });
  return freshBuild;
}
