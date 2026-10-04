import { makeTarget, renderCrop, type Target } from './frame.js';
import { hasPick, picksText, readPicks, togglePick, writePicks, type VariantPick } from './picks.js';
import { FX_SCENES, FX_SCREENS, type FxScene, type FxScreen } from './scenes.js';
import { summarizeStyle } from './styleParams.js';
import { AIM_LINE_ROUNDS, type StyleRound, type StyleVariant } from './variants.js';

// Страница просмотра раунда (`/?lab=fx&view=review`): сцены строками, варианты столбцами, кадры вокруг линии.
// Клик по кадру — увеличение ×1 / ×2 / ×4 с прокруткой и переходом к соседним вариантам той же сцены.
// Галочка «нравится» — одна на вариант во всех сценах; «Собрать список» — текст отметок для чата.

const REVIEW_TIME_S = 1;
const ZOOMS = [1, 2, 4] as const;
// Кадр снят с удвоенной плотностью: при ×1 он показывается в физический размер экрана телефона на экране Mac.
const BASE_CSS_SCALE = 0.5;
const SELECTED_CLASS = 'is-selected';
const PICK_CLASS = 'is-pick';
const ANCHOR_CLASS = 'is-anchor';
const LIKED_CLASS = 'is-liked';
const COPIED_MS = 1500;

interface Cell {
  scene: FxScene;
  variant: StyleVariant;
  image: HTMLCanvasElement;
}

function badge(text: string, className: string): HTMLElement {
  const element = document.createElement('span');
  element.className = `fx-badge ${className}`;
  element.textContent = text;
  return element;
}

interface Likes {
  has: (variant: StyleVariant) => boolean;
  toggle: (variant: StyleVariant) => void;
}

function cellFigure(cell: Cell, round: StyleRound, likes: Likes, onOpen: () => void): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'fx-cell';
  figure.dataset.scene = cell.scene.id;
  figure.dataset.variant = cell.variant.id;
  if (cell.variant.anchor !== null) {
    figure.classList.add(ANCHOR_CLASS);
  }
  if (round.picks.includes(cell.variant.id)) {
    figure.classList.add(PICK_CLASS);
  }
  figure.classList.toggle(LIKED_CLASS, likes.has(cell.variant));
  cell.image.style.width = `${String(cell.image.width * BASE_CSS_SCALE)}px`;
  cell.image.style.height = `${String(cell.image.height * BASE_CSS_SCALE)}px`;
  const caption = document.createElement('figcaption');
  const like = document.createElement('label');
  like.className = 'fx-like';
  const likeBox = document.createElement('input');
  likeBox.type = 'checkbox';
  likeBox.checked = likes.has(cell.variant);
  likeBox.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  likeBox.addEventListener('change', () => {
    likes.toggle(cell.variant);
  });
  like.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  like.append(likeBox, ' нравится');
  const title = document.createElement('strong');
  title.textContent = cell.variant.title;
  caption.append(like, title);
  if (round.picks.includes(cell.variant.id)) {
    caption.append(badge('выбор', PICK_CLASS));
  }
  if (cell.variant.anchor !== null) {
    caption.append(badge('якорь', ANCHOR_CLASS));
  }
  const note = document.createElement('span');
  note.className = 'fx-cell-note';
  note.textContent = `${cell.variant.note} · ${summarizeStyle(cell.variant.style)}`;
  caption.append(note);
  figure.append(cell.image, caption);
  figure.addEventListener('click', onOpen);
  return figure;
}

interface Lightbox {
  open: (cells: readonly Cell[], index: number) => void;
}

function mountLightbox(root: HTMLElement): Lightbox {
  const overlay = document.createElement('div');
  overlay.className = 'fx-lightbox';
  overlay.hidden = true;
  const bar = document.createElement('div');
  bar.className = 'fx-lightbox-bar';
  const caption = document.createElement('span');
  caption.className = 'fx-lightbox-caption';
  const zoomButtons = ZOOMS.map((zoom) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `×${String(zoom)}`;
    button.dataset.zoom = String(zoom);
    return button;
  });
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.textContent = '‹';
  prev.className = 'fx-lightbox-prev';
  const next = document.createElement('button');
  next.type = 'button';
  next.textContent = '›';
  next.className = 'fx-lightbox-next';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '✕';
  close.className = 'fx-lightbox-close';
  bar.append(prev, next, caption, ...zoomButtons, close);
  const viewport = document.createElement('div');
  viewport.className = 'fx-lightbox-viewport';
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-lightbox-canvas';
  viewport.append(canvas);
  overlay.append(bar, viewport);
  root.append(overlay);

  let cells: readonly Cell[] = [];
  let index = 0;
  let zoom: number = ZOOMS[1];

  const render = (): void => {
    const cell = cells[index];
    if (cell === undefined) {
      return;
    }
    canvas.width = cell.image.width;
    canvas.height = cell.image.height;
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(cell.image, 0, 0);
    canvas.style.width = `${String(cell.image.width * BASE_CSS_SCALE * zoom)}px`;
    canvas.style.height = `${String(cell.image.height * BASE_CSS_SCALE * zoom)}px`;
    caption.textContent = `${cell.scene.title} — ${cell.variant.title} · ${cell.variant.note}`;
    for (const button of zoomButtons) {
      button.classList.toggle(SELECTED_CLASS, Number(button.dataset.zoom) === zoom);
    }
  };
  const step = (delta: number): void => {
    index = (index + delta + cells.length) % cells.length;
    render();
  };
  const hide = (): void => {
    overlay.hidden = true;
  };
  for (const button of zoomButtons) {
    button.addEventListener('click', () => {
      zoom = Number(button.dataset.zoom);
      render();
    });
  }
  prev.addEventListener('click', () => {
    step(-1);
  });
  next.addEventListener('click', () => {
    step(1);
  });
  close.addEventListener('click', hide);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target === viewport) {
      hide();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (overlay.hidden) {
      return;
    }
    if (event.key === 'Escape') {
      hide();
    } else if (event.key === 'ArrowLeft') {
      step(-1);
    } else if (event.key === 'ArrowRight') {
      step(1);
    }
  });
  return {
    open: (opened, at) => {
      cells = opened;
      index = at;
      overlay.hidden = false;
      render();
    },
  };
}

interface PicksPopup {
  open: () => void;
}

function mountPicksPopup(root: HTMLElement, text: () => string, onClear: () => void): PicksPopup {
  const overlay = document.createElement('div');
  overlay.className = 'fx-popup';
  overlay.hidden = true;
  const box = document.createElement('div');
  box.className = 'fx-popup-box';
  const heading = document.createElement('h3');
  heading.textContent = 'Список для чата';
  const area = document.createElement('textarea');
  area.className = 'fx-popup-text';
  area.readOnly = true;
  area.rows = 10;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'fx-popup-copy';
  copy.textContent = 'Скопировать';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = 'Очистить отметки';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Закрыть';
  const actions = document.createElement('div');
  actions.className = 'fx-popup-actions';
  actions.append(copy, clear, close);
  box.append(heading, area, actions);
  overlay.append(box);
  root.append(overlay);
  const hide = (): void => {
    overlay.hidden = true;
  };
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(area.value).then(() => {
      copy.textContent = 'Скопировано';
      window.setTimeout(() => {
        copy.textContent = 'Скопировать';
      }, COPIED_MS);
    });
  });
  clear.addEventListener('click', () => {
    onClear();
    area.value = text();
  });
  close.addEventListener('click', hide);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      hide();
    }
  });
  return {
    open: () => {
      area.value = text();
      overlay.hidden = false;
      area.focus();
      area.select();
    },
  };
}

export function showReview(root: HTMLElement, round: StyleRound): void {
  const firstScreen = FX_SCREENS[0];
  if (firstScreen === undefined) {
    return;
  }
  root.hidden = false;
  root.innerHTML = '';
  root.classList.add('fx-lab', 'fx-review');

  let picks: VariantPick[] = readPicks(localStorage);
  const pickOf = (variant: StyleVariant): VariantPick => ({ round: round.id, variant: variant.id });
  const counter = document.createElement('span');
  counter.className = 'fx-picks-count';
  const refreshPicks = (): void => {
    counter.textContent = `выбрано ${String(picks.length)}`;
    for (const figure of root.querySelectorAll<HTMLElement>('.fx-cell')) {
      const variantId = figure.dataset.variant ?? '';
      const isLiked = hasPick(picks, { round: round.id, variant: variantId });
      figure.classList.toggle(LIKED_CLASS, isLiked);
      const box = figure.querySelector<HTMLInputElement>('.fx-like input');
      if (box !== null) {
        box.checked = isLiked;
      }
    }
  };
  const likes: Likes = {
    has: (variant) => hasPick(picks, pickOf(variant)),
    toggle: (variant) => {
      picks = togglePick(picks, pickOf(variant));
      writePicks(localStorage, picks);
      refreshPicks();
    },
  };
  const popup = mountPicksPopup(
    root,
    () => picksText(picks, AIM_LINE_ROUNDS),
    () => {
      picks = [];
      writePicks(localStorage, picks);
      refreshPicks();
    },
  );
  const collect = document.createElement('button');
  collect.type = 'button';
  collect.className = 'fx-collect';
  collect.textContent = 'Собрать список';
  collect.addEventListener('click', popup.open);

  const header = document.createElement('div');
  header.className = 'lab-controls';
  const title = document.createElement('h2');
  title.textContent = round.title;
  const roundLinks = document.createElement('nav');
  roundLinks.className = 'fx-round-links';
  for (const other of AIM_LINE_ROUNDS) {
    const link = document.createElement('a');
    link.href = `/?lab=fx&view=review&round=${other.id}`;
    link.textContent = other.title;
    link.classList.toggle(SELECTED_CLASS, other.id === round.id);
    roundLinks.append(link);
  }
  const screenButtons = FX_SCREENS.map((screen) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = screen.id === 'phone' ? 'телефон' : 'компьютер';
    button.dataset.screen = screen.id;
    return button;
  });
  const labLink = document.createElement('a');
  labLink.href = `/?lab=fx&round=${round.id}`;
  labLink.textContent = 'ползунки';
  header.append(title, roundLinks, ...screenButtons, labLink, counter, collect);
  const grid = document.createElement('div');
  grid.className = 'fx-review-grid';
  root.append(header, grid);
  const lightbox = mountLightbox(root);

  const targets = new Map<string, Target>();
  const targetFor = (screen: FxScreen): Target => {
    let target = targets.get(screen.id);
    if (target === undefined) {
      target = makeTarget(screen);
      targets.set(screen.id, target);
    }
    return target;
  };

  let generation = 0;
  const build = (screen: FxScreen): void => {
    generation += 1;
    const myGeneration = generation;
    grid.innerHTML = '';
    for (const button of screenButtons) {
      button.classList.toggle(SELECTED_CLASS, button.dataset.screen === screen.id);
    }
    const target = targetFor(screen);
    // Строки рисуются по одной между кадрами браузера, чтобы страница не замирала на всю сетку.
    const rows = [...FX_SCENES];
    const renderRow = (): void => {
      const scene = rows.shift();
      if (scene === undefined || myGeneration !== generation) {
        return;
      }
      const row = document.createElement('section');
      row.className = 'fx-review-row';
      const heading = document.createElement('h3');
      heading.textContent = scene.title;
      row.append(heading);
      const cells: Cell[] = round.variants.map((variant) => ({
        scene,
        variant,
        image: renderCrop(target, scene, variant.style, REVIEW_TIME_S),
      }));
      cells.forEach((cell, index) => {
        row.append(
          cellFigure(cell, round, likes, () => {
            lightbox.open(cells, index);
          }),
        );
      });
      grid.append(row);
      requestAnimationFrame(renderRow);
    };
    requestAnimationFrame(renderRow);
    refreshPicks();
  };
  for (const button of screenButtons) {
    button.addEventListener('click', () => {
      const screen = FX_SCREENS.find((candidate) => candidate.id === button.dataset.screen) ?? firstScreen;
      build(screen);
    });
  }
  // Спрайты танков грузятся асинхронно: первая сетка может быть без них — перестраиваем чуть позже.
  const spriteWait = window.setTimeout(() => {
    build(firstScreen);
  }, 400);
  build(firstScreen);
  Object.assign(window, {
    tanksFxReview: {
      round: round.id,
      rebuild: (screenId: string): void => {
        window.clearTimeout(spriteWait);
        build(FX_SCREENS.find((candidate) => candidate.id === screenId) ?? firstScreen);
      },
    },
  });
}
