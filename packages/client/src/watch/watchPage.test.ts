import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorldView } from '../prediction.js';
import { Effects } from '../render/effects.js';
import type { Overlay } from '../render/renderer.js';
import { StampDecals } from '../render/stampDecals.js';
import type { WatchHudInfo } from '../render/watchRenderer.js';
import { Sfx } from '../sfx.js';
import { installFakeAudio, type FakeAudio } from '../testing/fakeAudio.js';
import { MAX_STEPS_PER_FRAME } from './stepClock.js';
import type { WatchGame } from './watchGame.js';
import { fighterById } from './fighters.js';
import { mountWatch, outcomeText } from './watchPage.js';

const FRAME_MS = 1000 / 60;
const FRAMES_PER_S = 60;
const TICKS_PER_S = 30;
const LONG_GAP_MS = 60_000;
// Раунд Параллакса с Манекеном на ×4 — заведомо меньше этого числа кадров.
const MAX_ROUND_FRAMES = 20_000;
const LEFT_KEY = 'tanks.watch.left';
const RIGHT_KEY = 'tanks.watch.right';

interface Drawn {
  view: WorldView;
  hud: WatchHudInfo;
  overlay: Overlay;
}

function element<T extends HTMLElement>(id: string, kind: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof kind)) {
    throw new Error(`нет элемента #${id}`);
  }
  return found;
}

describe('экран боя ботов', () => {
  let stored: Map<string, string>;
  let clock: number;
  let pendingFrame: ((now: number) => void) | null;
  let isHidden: boolean;
  let seeds: number;
  let drawn: Drawn[];
  let game: WatchGame;
  let audio: FakeAudio;

  async function mount(): Promise<void> {
    document.body.innerHTML = `
      <div id="result"></div>
      <div class="watch-pick"><button id="left-toggle"></button><div id="left-list" hidden></div></div>
      <div class="watch-pick"><button id="right-toggle"></button><div id="right-list" hidden></div></div>
      <div id="speeds"></div>
      <button id="pause"></button>
      <button id="restart"></button>
      <button id="sound"></button>`;
    game = await mountWatch(
      {
        left: { toggle: element('left-toggle', HTMLButtonElement), list: element('left-list', HTMLElement) },
        right: { toggle: element('right-toggle', HTMLButtonElement), list: element('right-list', HTMLElement) },
        speeds: element('speeds', HTMLElement),
        pause: element('pause', HTMLButtonElement),
        restart: element('restart', HTMLButtonElement),
        sound: element('sound', HTMLButtonElement),
        result: element('result', HTMLElement),
      },
      {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
      },
      {
        createRenderer: () => ({
          draw: (view, hud, overlay) => {
            drawn.push({ view, hud, overlay });
          },
        }),
        createEffects: (names) =>
          new Effects(
            new StampDecals(),
            () => '#ffffff',
            (id) => names()[id === 0 ? 0 : 1],
          ),
        createSfx: () => new Sfx(() => isHidden),
        now: () => clock,
        requestFrame: (callback) => {
          pendingFrame = callback;
        },
        isHidden: () => isHidden,
        nextSeed: () => ++seeds,
      },
    );
  }

  function frames(count: number, frameMs = FRAME_MS): void {
    for (let frame = 0; frame < count; frame++) {
      const callback = pendingFrame;
      if (callback === null) {
        throw new Error('кадр не запрошен');
      }
      clock += frameMs;
      callback(clock);
    }
  }

  function framesUntil(isDone: () => boolean): void {
    for (let frame = 0; frame < MAX_ROUND_FRAMES; frame++) {
      if (isDone()) {
        return;
      }
      frames(1);
    }
    throw new Error('не дождался');
  }

  function speedButton(speed: number): HTMLButtonElement {
    const button = element('speeds', HTMLElement).querySelector(`[data-speed="${String(speed)}"]`);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`нет кнопки скорости ×${String(speed)}`);
    }
    return button;
  }

  // Новый бой начинается, когда мозг бойца загружен: выбор ждёт, пока бой не сменится.
  async function pick(side: 'left' | 'right', id: string): Promise<void> {
    const index = side === 'left' ? 0 : 1;
    element(`${side}-toggle`, HTMLButtonElement).click();
    element(`${side}-list`, HTMLElement).querySelector<HTMLButtonElement>(`[data-fighter="${id}"]`)?.click();
    await vi.waitFor(() => {
      expect(game.debugState().fighterIds[index]).toBe(id);
    });
  }

  beforeEach(() => {
    stored = new Map();
    clock = 0;
    pendingFrame = null;
    isHidden = false;
    seeds = 0;
    drawn = [];
    audio = installFakeAudio();
  });

  afterEach(() => {
    audio.restore();
  });

  it('без сохранённого выбора: Охотник против Параллакса, ×1, не на паузе', async () => {
    await mount();
    const state = game.debugState();
    expect(state.fighterIds).toEqual(['bot8', 'bot10']);
    expect(state.fighters).toEqual(['Охотник', 'ПАРАЛЛАКС-ASTRA']);
    expect(state.speed).toBe(1);
    expect(state.isPaused).toBe(false);
    expect(speedButton(1).classList.contains('is-selected')).toBe(true);
    expect(element('left-toggle', HTMLButtonElement).textContent).toContain('Охотник');
  });

  it('сохранённый выбор открывается; неизвестный номер — боец по умолчанию', async () => {
    stored.set(LEFT_KEY, 'bot3');
    stored.set(RIGHT_KEY, 'bot99');
    await mount();
    expect(game.debugState().fighterIds).toEqual(['bot3', 'bot10']);
  });

  it('за секунду кадров — 30 тиков на ×1 и 120 на ×4; смена скорости не сбрасывает бой', async () => {
    await mount();
    frames(FRAMES_PER_S);
    expect(game.debugState().totalTicks).toBe(TICKS_PER_S);
    speedButton(4).click();
    expect(speedButton(4).classList.contains('is-selected')).toBe(true);
    expect(speedButton(1).classList.contains('is-selected')).toBe(false);
    frames(FRAMES_PER_S);
    const state = game.debugState();
    expect(state.speed).toBe(4);
    expect(state.totalTicks).toBe(TICKS_PER_S * 5);
    expect(state.seed).toBe(1);
  });

  it('пауза: кадры идут, тики стоят; повторное нажатие продолжает', async () => {
    await mount();
    frames(10);
    const pause = element('pause', HTMLButtonElement);
    pause.click();
    const paused = game.debugState().totalTicks;
    frames(FRAMES_PER_S);
    expect(game.debugState().totalTicks).toBe(paused);
    expect(game.debugState().isPaused).toBe(true);
    expect(pause.getAttribute('aria-label')).toBe('Продолжить');
    expect(pause.classList.contains('is-paused')).toBe(true);
    expect(drawn.at(-1)?.hud.frameMs).toBe(0);
    pause.click();
    frames(FRAMES_PER_S);
    expect(game.debugState().totalTicks).toBe(paused + TICKS_PER_S);
    expect(pause.getAttribute('aria-label')).toBe('Пауза');
  });

  it('скрытая вкладка: бой стоит; вернулась после долгой паузы — без рывка', async () => {
    await mount();
    frames(10);
    isHidden = true;
    const hiddenAt = game.debugState().totalTicks;
    frames(FRAMES_PER_S);
    expect(game.debugState().totalTicks).toBe(hiddenAt);
    expect(game.debugState().isHidden).toBe(true);
    isHidden = false;
    frames(1, LONG_GAP_MS);
    expect(game.debugState().totalTicks).toBe(hiddenAt);
    frames(1);
    expect(game.debugState().totalTicks - hiddenAt).toBeLessThanOrEqual(MAX_STEPS_PER_FRAME);
  });

  it('пауза переживает скрытую вкладку', async () => {
    await mount();
    element('pause', HTMLButtonElement).click();
    isHidden = true;
    frames(10);
    isHidden = false;
    frames(FRAMES_PER_S);
    expect(game.debugState().isPaused).toBe(true);
    expect(game.debugState().totalTicks).toBe(0);
  });

  it('смена бойца посреди боя — новый бой с нуля, выбор запоминается', async () => {
    await mount();
    frames(FRAMES_PER_S);
    await pick('right', 'bot5');
    const state = game.debugState();
    expect(state.fighters).toEqual(['Охотник', 'Ветеран']);
    expect(state.totalTicks).toBe(0);
    expect(state.roundIndex).toBe(0);
    expect(state.score).toEqual([0, 0]);
    expect(state.seed).toBe(2);
    expect(stored.get(RIGHT_KEY)).toBe('bot5');
    expect(element('right-toggle', HTMLButtonElement).textContent).toContain('Ветеран');
  });

  it('двойник — последним в обоих списках: знак «Я», имя и описание', async () => {
    await mount();
    for (const side of ['left', 'right'] as const) {
      const rows = element(`${side}-list`, HTMLElement).querySelectorAll('.level');
      const last = rows[rows.length - 1];
      expect(last?.getAttribute('data-fighter')).toBe('twin');
      expect(last?.querySelector('.level-badge')?.textContent).toBe('Я');
      expect(last?.querySelector('.level-name')?.textContent).toBe('Двойник');
      expect(last?.querySelector('.level-tagline')?.textContent).toBe('Играет как ты. Ну, почти');
    }
  });

  it('выбор двойника — его мозг загружается, бой с ним с нуля; сохранённый двойник — бой с ним с открытия', async () => {
    await mount();
    frames(FRAMES_PER_S);
    await pick('right', 'twin');
    const state = game.debugState();
    expect(state.fighters).toEqual(['Охотник', 'Двойник']);
    expect(state.totalTicks).toBe(0);
    expect(state.score).toEqual([0, 0]);
    expect(stored.get(RIGHT_KEY)).toBe('twin');
    expect(element('right-toggle', HTMLButtonElement).textContent).toContain('Двойник');
    frames(FRAMES_PER_S);
    expect(game.debugState().totalTicks).toBe(TICKS_PER_S);

    stored.set(LEFT_KEY, 'twin');
    await mount();
    expect(game.debugState().fighterIds).toEqual(['twin', 'twin']);
  });

  it('выбран двойник, до конца загрузки — другой боец: бой с последним выбранным', async () => {
    await mount();
    element('right-toggle', HTMLButtonElement).click();
    element('right-list', HTMLElement).querySelector<HTMLButtonElement>('[data-fighter="twin"]')?.click();
    await pick('right', 'bot5');
    await fighterById('twin')?.loadBrain();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(game.debugState().fighterIds).toEqual(['bot8', 'bot5']);
    expect(stored.get(RIGHT_KEY)).toBe('bot5');
  });

  it('одинаковые бойцы в обоих списках — бой идёт', async () => {
    await mount();
    await pick('left', 'bot10');
    frames(FRAMES_PER_S);
    expect(game.debugState().fighterIds).toEqual(['bot10', 'bot10']);
    expect(game.debugState().totalTicks).toBe(TICKS_PER_S);
  });

  it('«заново» — счёт и тики с нуля, новое зерно', async () => {
    await mount();
    frames(FRAMES_PER_S);
    element('restart', HTMLButtonElement).click();
    expect(game.debugState().totalTicks).toBe(0);
    expect(game.debugState().seed).toBe(2);
    expect(game.debugState().fighterIds).toEqual(['bot8', 'bot10']);
  });

  it('конец раунда — итог с именем победителя, со следующим раундом уходит', async () => {
    stored.set(LEFT_KEY, 'bot1');
    await mount();
    speedButton(4).click();
    const result = element('result', HTMLElement);
    expect(result.classList.contains('is-shown')).toBe(false);
    framesUntil(() => game.debugState().phase === 'roundEnd');
    expect(result.classList.contains('is-shown')).toBe(true);
    expect(result.classList.contains('is-right')).toBe(true);
    expect(result.textContent).toContain('ПАРАЛЛАКС-ASTRA побеждает!');
    expect(game.debugState().score).toEqual([0, 1]);
    framesUntil(() => game.debugState().phase === 'countdown');
    expect(result.classList.contains('is-shown')).toBe(false);
    expect(drawn.at(-1)?.overlay?.kind).toBe('countdown');
    expect(drawn.at(-1)?.hud.score).toEqual([0, 1]);
  });

  it('итог раунда: движок стоит — танки и снаряды на картинке стоят кадр в кадр', async () => {
    stored.set(LEFT_KEY, 'bot1');
    await mount();
    speedButton(4).click();
    framesUntil(() => game.debugState().phase === 'roundEnd');
    speedButton(1).click();
    frames(1);
    const shown = drawn.length;
    frames(FRAMES_PER_S);
    expect(game.debugState().phase).toBe('roundEnd');
    const poses = drawn.slice(shown).map(({ view }) =>
      JSON.stringify({
        tanks: view.tanks.map(({ x, y, heading, turret }) => ({ x, y, heading, turret })),
        bullets: view.bullets.map(({ id, x, y }) => ({ id, x, y })),
      }),
    );
    expect(new Set(poses).size).toBe(1);
  });

  it('отсчёт как в дуэли: «3, 2, 1» за три секунды, «БОЙ!» — первые полсекунды боя', async () => {
    await mount();
    frames(1);
    expect(game.debugState().phase).toBe('countdown');
    expect(drawn.at(-1)?.overlay).toMatchObject({ kind: 'countdown', totalS: 3 });
    framesUntil(() => game.debugState().phase === 'fight');
    const go = drawn.at(-1)?.overlay;
    expect(go?.kind).toBe('countdown');
    expect(go !== null && go !== undefined && go.elapsedS >= go.totalS).toBe(true);
    expect(game.debugState().totalTicks).toBe(3 * TICKS_PER_S);
    frames(FRAMES_PER_S / 2);
    expect(drawn.at(-1)?.overlay).toBeNull();
  });

  it('итог раунда словами: победа, победа по времени, ничьи', () => {
    const names = ['Охотник', 'Ветеран'] as const;
    expect(outcomeText({ winner: 0, isByTime: false }, names)).toEqual({ title: 'Охотник побеждает!', note: '' });
    expect(outcomeText({ winner: 1, isByTime: true }, names).note).toBe('Время вышло — у него больше здоровья');
    expect(outcomeText({ winner: null, isByTime: true }, names)).toEqual({
      title: 'Ничья!',
      note: 'Время вышло — сил поровну',
    });
    expect(outcomeText({ winner: null, isByTime: false }, names).note).toBe('Подбили друг друга');
  });

  it('звук: кнопка и M выключают и включают', async () => {
    await mount();
    const sound = element('sound', HTMLButtonElement);
    sound.click();
    expect(game.debugState().isMuted).toBe(true);
    expect(sound.classList.contains('is-muted')).toBe(true);
    expect(sound.getAttribute('aria-label')).toBe('Включить звук');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }));
    expect(game.debugState().isMuted).toBe(false);
    expect(sound.getAttribute('aria-label')).toBe('Выключить звук');
  });
});
