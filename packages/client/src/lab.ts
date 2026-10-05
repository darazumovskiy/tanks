import { ARENA, createRound, DEFAULT_STATS, type Round } from '@tanks/shared/engine';
import type { WorldView } from './prediction.js';
import {
  CAMERA_SCENARIOS,
  checkScenarioInvariants,
  PHONE_SCREENS,
  SETTLE_MS,
  type CameraScenario,
  type ScreenGeometry,
} from './render/cameraScenarios.js';
import { buildSelect, LAB_NAMES, labHud, thumbSticks } from './labShared.js';
import { PHONE_CAMERA_MODES, type PhoneCameraMode } from './render/cameraStrategy.js';
import { createDuelEffects, Renderer } from './render/renderer.js';
import { defaultSettings, type Settings } from './settings.js';

// Лаборатория камеры (`/?lab=camera`): танки ставятся в позиции сценария без сервера и рисуются настоящим
// рендером на холсте размером с экран телефона; выбираются стратегия и экран; рядом — установившаяся камера
// и нарушенные инварианты.

const SPRITE_RETRY_MS = 300;

function fakeRound(scenario: CameraScenario): Round {
  const round = createRound(0, [
    { name: 'Я', stats: { ...DEFAULT_STATS } },
    { name: 'Противник', stats: { ...DEFAULT_STATS } },
  ]);
  round.tanks[0].x = scenario.me.x;
  round.tanks[0].y = scenario.me.y;
  if (scenario.enemy === null) {
    round.tanks[1].isAlive = false;
    round.tanks[1].x = -1000;
    round.tanks[1].y = -1000;
  } else {
    round.tanks[1].x = scenario.enemy.x;
    round.tanks[1].y = scenario.enemy.y;
    round.tanks[1].heading = Math.PI;
    round.tanks[1].turret = Math.PI;
  }
  return round;
}

function viewOf(round: Round): WorldView {
  return {
    round,
    tanks: [
      { ...round.tanks[0], maxHp: round.tanks[0].stats.maxHp },
      { ...round.tanks[1], maxHp: round.tanks[1].stats.maxHp },
    ],
    bullets: [],
  };
}

export function showCameraLab(root: HTMLElement): void {
  const firstScenario = CAMERA_SCENARIOS[0];
  const firstScreen = PHONE_SCREENS[0];
  if (firstScenario === undefined || firstScreen === undefined) {
    return;
  }
  root.hidden = false;
  root.innerHTML = '';
  const settings: Settings = defaultSettings();
  const scenarioSelect = buildSelect(CAMERA_SCENARIOS, (s) => s.title);
  const modeSelect = buildSelect(
    PHONE_CAMERA_MODES.map((entry) => ({ id: entry.mode, label: entry.label })),
    (entry) => entry.label,
  );
  const screenSelect = buildSelect(PHONE_SCREENS, (s) => `${s.id} (${String(s.width)}×${String(s.height)})`);
  const controls = document.createElement('div');
  controls.className = 'lab-controls';
  controls.append(scenarioSelect, modeSelect, screenSelect);
  const stage = document.createElement('div');
  const info = document.createElement('pre');
  info.style.whiteSpace = 'pre-wrap';
  root.append(controls, stage, info);

  const effects = createDuelEffects(() => LAB_NAMES);
  let renderer: Renderer | null = null;
  let rendererScreen: ScreenGeometry | null = null;

  const rendererFor = (screen: ScreenGeometry): Renderer => {
    if (renderer !== null && rendererScreen === screen) {
      return renderer;
    }
    stage.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.style.width = `${String(screen.width)}px`;
    canvas.style.height = `${String(screen.height)}px`;
    canvas.style.display = 'block';
    canvas.style.border = '1px solid rgba(255,255,255,0.3)';
    stage.append(canvas);
    renderer = new Renderer(canvas, effects, settings, true, () => ({
      width: screen.width,
      height: screen.height,
      pixelRatio: screen.pixelRatio,
    }));
    rendererScreen = screen;
    return renderer;
  };

  const current = (): { scenario: CameraScenario; mode: PhoneCameraMode; screen: ScreenGeometry } => ({
    scenario: CAMERA_SCENARIOS.find((s) => s.id === scenarioSelect.value) ?? firstScenario,
    mode: PHONE_CAMERA_MODES.find((entry) => entry.mode === modeSelect.value)?.mode ?? 'follow',
    screen: PHONE_SCREENS.find((s) => s.id === screenSelect.value) ?? firstScreen,
  });

  const draw = (): void => {
    const { scenario, mode, screen } = current();
    settings.cameraMode = mode;
    const target = rendererFor(screen);
    target.resetCamera();
    const view = viewOf(fakeRound(scenario));
    const hud = labHud(thumbSticks(screen.width, screen.height, settings), SETTLE_MS, null);
    // Первый кадр после сброса — установившееся состояние; второй нужен, чтобы стратегия сменилась, если её переключили.
    target.draw(view, hud, null);
    target.resetCamera();
    target.draw(view, hud, null);
    const camera = target.currentCamera;
    const violations = checkScenarioInvariants(mode, settings, camera, scenario.me, scenario.enemy);
    const enemyText = scenario.enemy === null ? 'нет' : `(${String(scenario.enemy.x)}, ${String(scenario.enemy.y)})`;
    const lines = [
      `${scenario.id} · ${mode} · ${screen.id}: я (${String(scenario.me.x)}, ${String(scenario.me.y)}), противник ${enemyText}`,
      `камера: x ${camera.x.toFixed(0)}, y ${camera.y.toFixed(0)}, высота ${camera.height.toFixed(0)} из ${String(ARENA.height)}`,
      violations.length === 0
        ? 'инварианты: все выполнены'
        : `нарушения: ${violations.map((v) => `${v.invariant} — ${v.detail}`).join('; ')}`,
    ];
    info.textContent = lines.join('\n');
  };

  for (const select of [scenarioSelect, modeSelect, screenSelect]) {
    select.addEventListener('change', draw);
  }
  const query = new URLSearchParams(location.search);
  const fromQuery = query.get('scenario');
  if (fromQuery !== null && CAMERA_SCENARIOS.some((s) => s.id === fromQuery)) {
    scenarioSelect.value = fromQuery;
  }
  const modeFromQuery = query.get('mode');
  if (modeFromQuery !== null && PHONE_CAMERA_MODES.some((entry) => entry.mode === modeFromQuery)) {
    modeSelect.value = modeFromQuery;
  }
  // Спрайты танков — картинки, грузятся асинхронно: первый кадр может быть без них, перерисовываем чуть позже.
  draw();
  window.setTimeout(draw, SPRITE_RETRY_MS);
  Object.assign(window, {
    tanksLab: {
      show: (scenarioId: string, mode?: string, screenId?: string): void => {
        scenarioSelect.value = scenarioId;
        if (mode !== undefined) {
          modeSelect.value = mode;
        }
        if (screenId !== undefined) {
          screenSelect.value = screenId;
        }
        draw();
      },
      scenarios: CAMERA_SCENARIOS.map((s) => s.id),
      modes: PHONE_CAMERA_MODES.map((entry) => entry.mode),
      screens: PHONE_SCREENS.map((s) => s.id),
    },
  });
}
