import { buildSelect } from '../labShared.js';
import { type AimLineStyle } from '../render/aimLineStyle.js';
import { worldToScreen } from '../render/camera.js';
import { makeCanvas } from '../render/view.js';
import { renderContactSheet, sheetLayout, type SheetCell } from './contactSheet.js';
import { cropAround, makeTarget, renderFrame, sceneFocus, type Target } from './frame.js';
import { mountParamPanel } from './paramPanel.js';
import { showReview } from './review.js';
import { buildSceneFrame, FX_SCENES, FX_SCREENS, type FxScene, type FxScreen } from './scenes.js';
import { summarizeStyle, withParam } from './styleParams.js';
import { roundById, type StyleRound, type StyleVariant } from './variants.js';

// Лаборатория эффектов (`/?lab=fx`): сцена × вариант стиля × экран × момент времени настоящим рендером, без
// сервера и случайности. `?view=review` — страница просмотра раунда для Димы.

const MAX_TIME_S = 4;
const TIME_STEP_S = 0.05;
const SPRITE_RETRY_MS = 300;
const PNG_NAME = 'contact-sheet.png';
const REVIEW_VIEW = 'review';

interface LabState {
  scene: FxScene;
  variant: StyleVariant;
  screen: FxScreen;
  timeS: number;
}

export function variantLabel(variant: StyleVariant): string {
  return `${variant.title} · ${variant.note}`;
}

export function showFxLab(root: HTMLElement): void {
  const query = new URLSearchParams(location.search);
  const round = roundById(query.get('round'));
  if (query.get('view') === REVIEW_VIEW) {
    showReview(root, round);
    return;
  }
  showLabPage(root, round, query);
}

function showLabPage(root: HTMLElement, round: StyleRound, query: URLSearchParams): void {
  const firstScene = FX_SCENES[0];
  const firstVariant = round.variants[0];
  const firstScreen = FX_SCREENS[0];
  if (firstScene === undefined || firstVariant === undefined || firstScreen === undefined) {
    return;
  }
  root.hidden = false;
  root.innerHTML = '';
  root.classList.add('fx-lab');

  const sceneSelect = buildSelect(FX_SCENES, (scene) => scene.title);
  const variantSelect = buildSelect(round.variants, variantLabel);
  const screenSelect = buildSelect(
    FX_SCREENS,
    (screen) => `${screen.id} (${String(screen.width)}×${String(screen.height)})`,
  );
  const animate = document.createElement('input');
  animate.type = 'checkbox';
  animate.id = 'fx-animate';
  const animateLabel = document.createElement('label');
  animateLabel.htmlFor = animate.id;
  animateLabel.append(animate, ' идёт время');
  const time = document.createElement('input');
  time.type = 'range';
  time.min = '0';
  time.max = String(MAX_TIME_S);
  time.step = String(TIME_STEP_S);
  time.value = '1';
  const timeLabel = document.createElement('label');
  timeLabel.append('время, с ', time);
  const sheetButton = document.createElement('button');
  sheetButton.type = 'button';
  sheetButton.textContent = 'Контактный лист';
  const reviewLink = document.createElement('a');
  reviewLink.href = `/?lab=fx&view=${REVIEW_VIEW}&round=${round.id}`;
  reviewLink.textContent = `Просмотр · ${round.title}`;
  const controls = document.createElement('div');
  controls.className = 'lab-controls';
  controls.append(sceneSelect, variantSelect, screenSelect, animateLabel, timeLabel, sheetButton, reviewLink);

  const stage = document.createElement('div');
  stage.className = 'fx-stage';
  const info = document.createElement('pre');
  const params = document.createElement('div');
  params.className = 'fx-params';
  const sheetBlock = document.createElement('div');
  sheetBlock.className = 'fx-sheet';
  sheetBlock.hidden = true;
  const download = document.createElement('a');
  download.textContent = 'Скачать PNG';
  download.download = PNG_NAME;
  download.className = 'fx-download';
  const { canvas: sheetCanvas, ctx: sheetCtx } = makeCanvas(1, 1);
  sheetBlock.append(download, sheetCanvas);
  root.append(controls, stage, info, params, sheetBlock);

  const targets = new Map<string, Target>();
  const edits = new Map<string, AimLineStyle>();
  const targetFor = (screen: FxScreen): Target => {
    let target = targets.get(screen.id);
    if (target === undefined) {
      target = makeTarget(screen);
      targets.set(screen.id, target);
    }
    for (const other of targets.values()) {
      other.canvas.hidden = other !== target;
    }
    if (target.canvas.parentElement !== stage) {
      stage.append(target.canvas);
    }
    return target;
  };

  const current = (): LabState => ({
    scene: FX_SCENES.find((scene) => scene.id === sceneSelect.value) ?? firstScene,
    variant: round.variants.find((variant) => variant.id === variantSelect.value) ?? firstVariant,
    screen: FX_SCREENS.find((screen) => screen.id === screenSelect.value) ?? firstScreen,
    timeS: Number(time.value),
  });
  const styleOf = (variant: StyleVariant): AimLineStyle => edits.get(variant.id) ?? variant.style;

  const panel = mountParamPanel(params, styleOf(firstVariant), {
    onChange: (path, value) => {
      const { variant } = current();
      edits.set(variant.id, withParam(styleOf(variant), path, value));
      draw();
    },
    onReset: () => {
      edits.delete(current().variant.id);
      panel.update(styleOf(current().variant));
      draw();
    },
  });

  let lastAimState = 'none';
  let isLastReturning = false;
  const draw = (): void => {
    const state = current();
    const target = targetFor(state.screen);
    const style = styleOf(state.variant);
    renderFrame(target, state.scene, style, state.timeS);
    const frame = buildSceneFrame(state.scene);
    lastAimState = frame.aimLine.state;
    isLastReturning = frame.aimLine.isReturning;
    const camera = target.renderer.currentCamera;
    info.textContent = [
      `${state.scene.id} · ${state.variant.id} · ${state.screen.id} · t=${state.timeS.toFixed(2)}с`,
      `линия: ${frame.aimLine.state}${frame.aimLine.isReturning ? ' · хвост опасный' : ''} · отрезков ${String(frame.aimLine.segments.length)}`,
      `камера: x ${camera.x.toFixed(0)}, y ${camera.y.toFixed(0)}, высота ${camera.height.toFixed(0)}, масштаб ${camera.scale.toFixed(3)}`,
      summarizeStyle(style),
    ].join('\n');
  };

  const buildSheet = (): { width: number; height: number } => {
    const state = current();
    const target = targetFor(state.screen);
    const focus = sceneFocus(state.scene);
    const cells: SheetCell[] = round.variants.map((variant) => {
      const style = styleOf(variant);
      renderFrame(target, state.scene, style, state.timeS);
      return { title: variantLabel(variant), subtitle: summarizeStyle(style), image: cropAround(target, focus) };
    });
    const firstCell = cells[0];
    if (firstCell === undefined) {
      return { width: 0, height: 0 };
    }
    const layout = sheetLayout(cells.length, { width: firstCell.image.width, height: firstCell.image.height });
    sheetCanvas.width = layout.width;
    sheetCanvas.height = layout.height;
    renderContactSheet(sheetCtx, cells, layout);
    sheetBlock.hidden = false;
    sheetCanvas.toBlob((blob) => {
      if (blob !== null) {
        download.href = URL.createObjectURL(blob);
      }
    });
    draw();
    return { width: layout.width, height: layout.height };
  };

  let animationStart = 0;
  const tick = (now: number): void => {
    if (!animate.checked) {
      return;
    }
    time.value = (((now - animationStart) / 1000) % MAX_TIME_S).toFixed(2);
    draw();
    requestAnimationFrame(tick);
  };
  animate.addEventListener('change', () => {
    if (animate.checked) {
      animationStart = performance.now() - Number(time.value) * 1000;
      requestAnimationFrame(tick);
    }
  });
  time.addEventListener('input', draw);
  for (const select of [sceneSelect, screenSelect]) {
    select.addEventListener('change', draw);
  }
  variantSelect.addEventListener('change', () => {
    panel.update(styleOf(current().variant));
    draw();
  });
  sheetButton.addEventListener('click', buildSheet);

  const pick = (select: HTMLSelectElement, key: string): void => {
    const value = query.get(key);
    if (value !== null && Array.from(select.options).some((option) => option.value === value)) {
      select.value = value;
    }
  };
  pick(sceneSelect, 'scene');
  pick(variantSelect, 'variant');
  pick(screenSelect, 'screen');
  const queryTime = Number(query.get('t'));
  if (query.has('t') && Number.isFinite(queryTime)) {
    time.value = String(Math.min(MAX_TIME_S, Math.max(0, queryTime)));
  }
  panel.update(styleOf(current().variant));
  // Спрайты танков — картинки, грузятся асинхронно: первый кадр может быть без них, перерисовываем чуть позже.
  draw();
  window.setTimeout(draw, SPRITE_RETRY_MS);

  Object.assign(window, {
    tanksFxLab: {
      round: round.id,
      scenes: FX_SCENES.map((scene) => scene.id),
      variants: round.variants.map((variant) => variant.id),
      screens: FX_SCREENS.map((screen) => screen.id),
      show: (sceneId: string, variantId?: string, screenId?: string, timeS?: number): void => {
        sceneSelect.value = sceneId;
        if (variantId !== undefined) {
          variantSelect.value = variantId;
        }
        if (screenId !== undefined) {
          screenSelect.value = screenId;
        }
        if (timeS !== undefined) {
          time.value = String(timeS);
        }
        panel.update(styleOf(current().variant));
        draw();
      },
      state: (): Record<string, unknown> => {
        const state = current();
        return {
          round: round.id,
          scene: state.scene.id,
          variant: state.variant.id,
          screen: state.screen.id,
          timeS: state.timeS,
          aimLineState: lastAimState,
          isReturning: isLastReturning,
          style: styleOf(state.variant),
        };
      },
      probe: (worldX: number, worldY: number): number[] => {
        const target = targetFor(current().screen);
        const point = worldToScreen(target.renderer.currentCamera, { x: worldX, y: worldY });
        const pixel = target.ctx.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data;
        return Array.from(pixel);
      },
      sheet: (sceneId?: string, screenId?: string, timeS?: number): { width: number; height: number } => {
        if (sceneId !== undefined) {
          sceneSelect.value = sceneId;
        }
        if (screenId !== undefined) {
          screenSelect.value = screenId;
        }
        if (timeS !== undefined) {
          time.value = String(timeS);
        }
        return buildSheet();
      },
      setParam: (path: string, value: number | string): void => {
        const { variant } = current();
        edits.set(variant.id, withParam(styleOf(variant), path, value));
        panel.update(styleOf(variant));
        draw();
      },
    },
  });
}
