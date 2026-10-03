import { beforeEach, describe, expect, it } from 'vitest';
import { EDGE_GAP_RATIO, TAP_MAX_MS, TouchSticks, type StickSettings } from './touch.js';

const STICK_RADIUS_PX = 64;

interface PointerSpec {
  id: number;
  x: number;
  y: number;
  type?: 'touch' | 'mouse' | 'pen';
}

const LEFT_X = 200;
const RIGHT_X = 800;
const Y = 300;

function pointerEvent(kind: string, spec: PointerSpec): PointerEvent {
  return new PointerEvent(kind, {
    pointerId: spec.id,
    pointerType: spec.type ?? 'touch',
    clientX: spec.x,
    clientY: spec.y,
    bubbles: true,
    cancelable: true,
  });
}

describe('TouchSticks', () => {
  let target: HTMLElement;
  let sticks: TouchSticks;
  let time = 0;
  let settings: StickSettings;

  const down = (spec: PointerSpec): PointerEvent => {
    const event = pointerEvent('pointerdown', spec);
    target.dispatchEvent(event);
    return event;
  };
  const move = (spec: PointerSpec): void => {
    target.dispatchEvent(pointerEvent('pointermove', spec));
  };
  const up = (spec: PointerSpec): void => {
    target.dispatchEvent(pointerEvent('pointerup', spec));
  };
  const cancel = (spec: PointerSpec): void => {
    target.dispatchEvent(pointerEvent('pointercancel', spec));
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.createElement('div');
    document.body.append(target);
    time = 0;
    settings = { stickRadiusPx: STICK_RADIUS_PX, deadZone: 0.15, hasFireRing: true, fireRing: 0.85 };
    sticks = new TouchSticks(target, settings, () => time);
  });

  it('касание слева рождает стик корпуса в точке касания и ведёт ручку', () => {
    down({ id: 1, x: LEFT_X, y: Y });
    move({ id: 1, x: LEFT_X + 30, y: Y });
    const stick = sticks.stick('move');
    expect(stick).not.toBeNull();
    expect(stick?.baseX).toBe(LEFT_X);
    expect(stick?.baseY).toBe(Y);
    expect(stick?.dx).toBeCloseTo(30 / STICK_RADIUS_PX, 6);
    expect(stick?.dy).toBe(0);
    expect(sticks.stick('aim')).toBeNull();
  });

  it('отклонение дальше радиуса обрезается до единицы', () => {
    down({ id: 1, x: LEFT_X, y: Y });
    move({ id: 1, x: LEFT_X + 100, y: Y + 100 });
    const stick = sticks.stick('move');
    expect(Math.hypot(stick?.dx ?? 0, stick?.dy ?? 0)).toBeCloseTo(1, 6);
    expect(stick?.dx).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('касание справа рождает стик башни; внутри мёртвой зоны огня нет', () => {
    down({ id: 2, x: RIGHT_X, y: Y });
    move({ id: 2, x: RIGHT_X + 8, y: Y });
    const stick = sticks.stick('aim');
    expect(stick?.role).toBe('aim');
    expect(stick?.dx).toBeCloseTo(8 / STICK_RADIUS_PX, 6);
    expect(sticks.isFiringByStick).toBe(false);
  });

  it('два пальца — два независимых стика', () => {
    down({ id: 1, x: LEFT_X, y: Y });
    down({ id: 2, x: RIGHT_X, y: Y });
    move({ id: 1, x: LEFT_X, y: Y + 32 });
    move({ id: 2, x: RIGHT_X - 64, y: Y });
    expect(sticks.stick('move')?.dy).toBeCloseTo(0.5, 6);
    expect(sticks.stick('move')?.dx).toBe(0);
    expect(sticks.stick('aim')?.dx).toBeCloseTo(-1, 6);
    expect(sticks.states).toHaveLength(2);
    up({ id: 1, x: LEFT_X, y: Y + 32 });
    expect(sticks.stick('move')).toBeNull();
    expect(sticks.stick('aim')?.dx).toBeCloseTo(-1, 6);
  });

  it('отпускание убирает стик', () => {
    down({ id: 1, x: LEFT_X, y: Y });
    up({ id: 1, x: LEFT_X, y: Y });
    expect(sticks.stick('move')).toBeNull();
    expect(sticks.states).toHaveLength(0);
  });

  it('отмена касания убирает стик и не считается тапом', () => {
    down({ id: 2, x: RIGHT_X, y: Y });
    time = 50;
    cancel({ id: 2, x: RIGHT_X, y: Y });
    expect(sticks.stick('aim')).toBeNull();
    expect(sticks.takeTapFire()).toBe(false);
  });

  it('второе касание той же половины при живом стике игнорируется', () => {
    down({ id: 1, x: LEFT_X, y: Y });
    down({ id: 3, x: LEFT_X + 100, y: Y + 100 });
    move({ id: 3, x: LEFT_X + 150, y: Y + 100 });
    const stick = sticks.stick('move');
    expect(stick?.baseX).toBe(LEFT_X);
    expect(stick?.dx).toBe(0);
    up({ id: 3, x: LEFT_X + 150, y: Y + 100 });
    expect(sticks.stick('move')).not.toBeNull();
  });

  it('движение чужого указателя не трогает стики', () => {
    down({ id: 1, x: LEFT_X, y: Y });
    move({ id: 9, x: LEFT_X + 50, y: Y });
    up({ id: 9, x: LEFT_X + 50, y: Y });
    expect(sticks.stick('move')?.dx).toBe(0);
  });

  it('быстрый тап справа — один выстрел, флаг снимается чтением', () => {
    down({ id: 2, x: RIGHT_X, y: Y });
    time = 100;
    up({ id: 2, x: RIGHT_X + 3, y: Y });
    expect(sticks.takeTapFire()).toBe(true);
    expect(sticks.takeTapFire()).toBe(false);
  });

  it('тап слева выстрелом не считается', () => {
    down({ id: 1, x: LEFT_X, y: Y });
    time = 100;
    up({ id: 1, x: LEFT_X, y: Y });
    expect(sticks.takeTapFire()).toBe(false);
  });

  it('долгое касание без сдвига — не тап', () => {
    down({ id: 2, x: RIGHT_X, y: Y });
    time = TAP_MAX_MS + 100;
    up({ id: 2, x: RIGHT_X, y: Y });
    expect(sticks.takeTapFire()).toBe(false);
  });

  it('быстрое касание со сдвигом за мёртвую зону — не тап', () => {
    down({ id: 2, x: RIGHT_X, y: Y });
    move({ id: 2, x: RIGHT_X + 40, y: Y });
    move({ id: 2, x: RIGHT_X, y: Y });
    time = 100;
    up({ id: 2, x: RIGHT_X, y: Y });
    expect(sticks.takeTapFire()).toBe(false);
  });

  it('стик башни у края стреляет, пока держится', () => {
    down({ id: 2, x: RIGHT_X, y: Y });
    move({ id: 2, x: RIGHT_X, y: Y - 60 });
    expect(sticks.isFiringByStick).toBe(true);
    move({ id: 2, x: RIGHT_X, y: Y - 32 });
    expect(sticks.isFiringByStick).toBe(false);
    move({ id: 2, x: RIGHT_X, y: Y - 200 });
    expect(sticks.isFiringByStick).toBe(true);
    up({ id: 2, x: RIGHT_X, y: Y - 200 });
    expect(sticks.isFiringByStick).toBe(false);
  });

  it('без кольца огня стреляет само касание правой половины, даже в мёртвой зоне', () => {
    settings.hasFireRing = false;
    down({ id: 2, x: RIGHT_X, y: Y });
    expect(sticks.stick('aim')?.fireRing).toBeNull();
    expect(sticks.isFiringByStick).toBe(true);
    move({ id: 2, x: RIGHT_X + 4, y: Y });
    expect(sticks.isFiringByStick).toBe(true);
    move({ id: 2, x: RIGHT_X + 200, y: Y });
    expect(sticks.isFiringByStick).toBe(true);
    up({ id: 2, x: RIGHT_X + 200, y: Y });
    expect(sticks.isFiringByStick).toBe(false);
  });

  it('без кольца огня касание левой половины не стреляет', () => {
    settings.hasFireRing = false;
    down({ id: 1, x: LEFT_X, y: Y });
    move({ id: 1, x: LEFT_X + 200, y: Y });
    expect(sticks.isFiringByStick).toBe(false);
  });

  it('кольцо выключили при зажатом стике — зажатый стреляет по кольцу, новый — касанием', () => {
    down({ id: 2, x: RIGHT_X, y: Y });
    settings.hasFireRing = false;
    expect(sticks.isFiringByStick).toBe(false);
    up({ id: 2, x: RIGHT_X, y: Y });
    down({ id: 2, x: RIGHT_X, y: Y });
    expect(sticks.isFiringByStick).toBe(true);
  });

  it('мышь стиками не обрабатывается', () => {
    const event = down({ id: 5, x: LEFT_X, y: Y, type: 'mouse' });
    expect(sticks.states).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('стилус работает как палец', () => {
    down({ id: 6, x: RIGHT_X, y: Y, type: 'pen' });
    expect(sticks.stick('aim')).not.toBeNull();
  });

  it('касание гасит действие по умолчанию, чтобы браузер не рисовал мышь', () => {
    const event = down({ id: 1, x: LEFT_X, y: Y });
    expect(event.defaultPrevented).toBe(true);
  });

  it('новый стик берёт текущие настройки, зажатый — не меняется', () => {
    down({ id: 1, x: LEFT_X, y: Y });
    settings.stickRadiusPx = 32;
    settings.fireRing = 0.5;
    move({ id: 1, x: LEFT_X + 32, y: Y });
    expect(sticks.stick('move')?.dx).toBeCloseTo(0.5, 6);
    down({ id: 2, x: RIGHT_X, y: Y });
    move({ id: 2, x: RIGHT_X + 20, y: Y });
    expect(sticks.stick('aim')?.radiusPx).toBe(32);
    expect(sticks.stick('aim')?.dx).toBeCloseTo(20 / 32, 6);
    expect(sticks.isFiringByStick).toBe(true);
  });

  it('касание у края экрана — основание отступает от края, отклонение считается от основания', () => {
    down({ id: 1, x: 5, y: Y });
    const stick = sticks.stick('move');
    const inset = STICK_RADIUS_PX * (1 + EDGE_GAP_RATIO);
    expect(stick?.baseX).toBeCloseTo(inset, 6);
    expect(stick?.baseY).toBe(Y);
    expect(stick?.dx).toBeCloseTo(-Math.min(1, (inset - 5) / STICK_RADIUS_PX), 6);
    move({ id: 1, x: inset, y: Y });
    expect(stick?.dx).toBeCloseTo(0, 6);
  });

  it('касание в нижнем правом углу — отступ и по горизонтали, и по вертикали', () => {
    down({ id: 2, x: window.innerWidth - 2, y: window.innerHeight - 2 });
    const stick = sticks.stick('aim');
    const inset = STICK_RADIUS_PX * (1 + EDGE_GAP_RATIO);
    expect(stick?.baseX).toBeCloseTo(window.innerWidth - inset, 6);
    expect(stick?.baseY).toBeCloseTo(window.innerHeight - inset, 6);
  });

  it('касание вдали от края — основание в точке касания', () => {
    down({ id: 1, x: LEFT_X, y: Y });
    expect(sticks.stick('move')?.baseX).toBe(LEFT_X);
    expect(sticks.stick('move')?.dx).toBe(0);
  });

  it('уход в фон или потеря фокуса сбрасывает зажатые стики и тап', () => {
    down({ id: 1, x: LEFT_X, y: Y });
    down({ id: 2, x: RIGHT_X, y: Y });
    window.dispatchEvent(new Event('blur'));
    expect(sticks.states).toHaveLength(0);
    down({ id: 2, x: RIGHT_X, y: Y });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sticks.states).toHaveLength(0);
    expect(sticks.takeTapFire()).toBe(false);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
});
