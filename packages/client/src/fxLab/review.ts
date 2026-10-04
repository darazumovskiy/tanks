import { makeTarget, renderCrop, type Target } from './frame.js';
import { FX_SCENES, FX_SCREENS, type FxScene, type FxScreen } from './scenes.js';
import { summarizeStyle } from './styleParams.js';
import { AIM_LINE_ROUNDS, type StyleRound, type StyleVariant } from './variants.js';

// Страница просмотра раунда (`/?lab=fx&view=review`): сцены строками, варианты столбцами, кадры вокруг линии.
// Клик по кадру — увеличение ×1 / ×2 / ×4 с прокруткой и переходом к соседним вариантам той же сцены.

const REVIEW_TIME_S = 1;
const ZOOMS = [1, 2, 4] as const;
// Кадр снят с удвоенной плотностью: при ×1 он показывается в физический размер экрана телефона на экране Mac.
const BASE_CSS_SCALE = 0.5;
const SELECTED_CLASS = 'is-selected';
const PICK_CLASS = 'is-pick';
const ANCHOR_CLASS = 'is-anchor';

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

function cellFigure(cell: Cell, round: StyleRound, onOpen: () => void): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'fx-cell';
  figure.dataset.scene = cell.scene.id;
  figure.dataset.variant = cell.variant.id;
  if (cell.variant.anchor !== null) {
    figure.classList.add(ANCHOR_CLASS);
  }
  if (round.pick === cell.variant.id) {
    figure.classList.add(PICK_CLASS);
  }
  cell.image.style.width = `${String(cell.image.width * BASE_CSS_SCALE)}px`;
  cell.image.style.height = `${String(cell.image.height * BASE_CSS_SCALE)}px`;
  const caption = document.createElement('figcaption');
  const title = document.createElement('strong');
  title.textContent = cell.variant.title;
  caption.append(title);
  if (round.pick === cell.variant.id) {
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

export function showReview(root: HTMLElement, round: StyleRound): void {
  const firstScreen = FX_SCREENS[0];
  if (firstScreen === undefined) {
    return;
  }
  root.hidden = false;
  root.innerHTML = '';
  root.classList.add('fx-lab', 'fx-review');

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
  header.append(title, roundLinks, ...screenButtons, labLink);
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
          cellFigure(cell, round, () => {
            lightbox.open(cells, index);
          }),
        );
      });
      grid.append(row);
      requestAnimationFrame(renderRow);
    };
    requestAnimationFrame(renderRow);
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
