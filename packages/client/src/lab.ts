import { ARENA, createRound, DEFAULT_STATS, type Round } from '@tanks/shared/engine';
import type { WorldView } from './prediction.js';
import {
  CAMERA_SCENARIOS,
  PHONE_SCREENS,
  checkCameraInvariants,
  type CameraScenario,
} from './render/cameraScenarios.js';
import { Effects } from './render/effects.js';
import { Renderer, type HudInfo } from './render/renderer.js';
import { DEFAULT_SETTINGS } from './settings.js';
import type { StickState } from './touch.js';

// Лаборатория камеры (`/?lab=camera`): танки ставятся в позиции сценария без сервера и рисуются настоящим
// рендером на холсте размером с экран телефона; рядом — установившаяся камера и нарушенные инварианты.
// Стики нарисованы там, где обычно лежат большие пальцы, чтобы видеть перекрытие.

const THUMB_LEFT = { fx: 0.12, fy: 0.75 };
const THUMB_RIGHT = { fx: 0.88, fy: 0.75 };
const SETTLE_MS = 100_000;

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

function thumbSticks(width: number, height: number): StickState[] {
  const make = (role: 'move' | 'aim', spot: { fx: number; fy: number }): StickState => ({
    role,
    baseX: width * spot.fx,
    baseY: height * spot.fy,
    dx: 0,
    dy: 0,
    radiusPx: DEFAULT_SETTINGS.stickRadiusPx,
    deadZone: DEFAULT_SETTINGS.deadZone,
    fireRing: DEFAULT_SETTINGS.fireRing,
  });
  return [make('move', THUMB_LEFT), make('aim', THUMB_RIGHT)];
}

export function showCameraLab(root: HTMLElement): void {
  root.hidden = false;
  root.innerHTML = '';
  const screen = PHONE_SCREENS[0];
  if (screen === undefined) {
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.style.width = `${String(screen.width)}px`;
  canvas.style.height = `${String(screen.height)}px`;
  canvas.style.display = 'block';
  canvas.style.border = '1px solid rgba(255,255,255,0.3)';
  const select = document.createElement('select');
  for (const scenario of CAMERA_SCENARIOS) {
    const option = document.createElement('option');
    option.value = scenario.id;
    option.textContent = scenario.title;
    select.append(option);
  }
  const info = document.createElement('pre');
  info.style.whiteSpace = 'pre-wrap';
  root.append(select, canvas, info);

  const effects = new Effects(() => ['Я', 'Противник']);
  const renderer = new Renderer(canvas, effects, DEFAULT_SETTINGS, true, () => ({
    width: screen.width,
    height: screen.height,
    pixelRatio: screen.pixelRatio,
  }));

  const draw = (scenario: CameraScenario): void => {
    renderer.resetCamera();
    const view = viewOf(fakeRound(scenario));
    const hud: HudInfo = {
      names: ['Я', 'Противник'],
      score: [0, 0],
      roundIndex: 0,
      mySide: 0,
      rttMs: 0,
      serverTick: 0,
      pending: 0,
      correctionPx: 0,
      fps: 0,
      worstFrameMs: 0,
      isMuted: true,
      sticks: thumbSticks(screen.width, screen.height),
      frameMs: SETTLE_MS,
      frameTimes: [],
    };
    renderer.draw(view, hud, null);
    const camera = renderer.currentCamera;
    const violations = checkCameraInvariants(camera, scenario, DEFAULT_SETTINGS);
    const lines = [
      `${scenario.id}: я (${String(scenario.me.x)}, ${String(scenario.me.y)}), противник ${scenario.enemy === null ? 'нет' : `(${String(scenario.enemy.x)}, ${String(scenario.enemy.y)})`}`,
      `камера: x ${camera.x.toFixed(0)}, y ${camera.y.toFixed(0)}, высота ${camera.height.toFixed(0)} из ${String(ARENA.height)}`,
      violations.length === 0
        ? 'инварианты: все выполнены'
        : `нарушения: ${violations.map((v) => `${v.invariant} — ${v.detail}`).join('; ')}`,
    ];
    info.textContent = lines.join('\n');
  };

  const first = CAMERA_SCENARIOS[0];
  if (first === undefined) {
    return;
  }
  const current = (): CameraScenario => CAMERA_SCENARIOS.find((s) => s.id === select.value) ?? first;
  select.addEventListener('change', () => {
    draw(current());
  });
  const fromQuery = new URLSearchParams(location.search).get('scenario');
  if (fromQuery !== null && CAMERA_SCENARIOS.some((s) => s.id === fromQuery)) {
    select.value = fromQuery;
  }
  // Спрайты танков — картинки, грузятся асинхронно: первый кадр может быть без них, перерисовываем чуть позже.
  draw(current());
  window.setTimeout(() => {
    draw(current());
  }, 300);
  Object.assign(window, {
    tanksLab: {
      show: (id: string): void => {
        select.value = id;
        draw(current());
      },
      scenarios: CAMERA_SCENARIOS.map((s) => s.id),
    },
  });
}
