import { beforeEach, describe, expect, it } from 'vitest';
import { InputReader, type SteeredTank } from './input.js';

const LEFT_X = 200;
const RIGHT_X = 800;
const Y = 300;

const me: SteeredTank = { x: 0, y: 0, heading: 0, turret: 0, stats: { turnRate: 2 } };

function pointer(kind: string, id: number, x: number, y: number, type: 'touch' | 'mouse' = 'touch'): PointerEvent {
  return new PointerEvent(kind, {
    pointerId: id,
    pointerType: type,
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    cancelable: true,
  });
}

function key(kind: 'keydown' | 'keyup', code: string, isRepeat = false): KeyboardEvent {
  return new KeyboardEvent(kind, { code, repeat: isRepeat, cancelable: true });
}

describe('InputReader', () => {
  let target: HTMLElement;
  let input: InputReader;

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.createElement('div');
    document.body.append(target);
    input = new InputReader(
      target,
      { toWorld: (x, y) => ({ x, y }) },
      { stickRadiusPx: 64, deadZone: 0.15, hasFireRing: true, fireRing: 0.85 },
    );
  });

  it('без ввода — пустое действие', () => {
    expect(input.read(me)).toEqual({ throttle: 0, turn: 0, turretTurn: 0, isFiring: false });
  });

  it('клавиши ведут корпус: W — вперёд, S — назад, A/D — поворот', () => {
    window.dispatchEvent(key('keydown', 'KeyW'));
    window.dispatchEvent(key('keydown', 'KeyD'));
    expect(input.read(me)).toMatchObject({ throttle: 1, turn: 1 });
    window.dispatchEvent(key('keyup', 'KeyW'));
    window.dispatchEvent(key('keydown', 'ArrowDown'));
    window.dispatchEvent(key('keydown', 'ArrowLeft'));
    expect(input.read(me)).toMatchObject({ throttle: -1, turn: 0 });
  });

  it('повтор клавиши и потеря фокуса', () => {
    window.dispatchEvent(key('keydown', 'KeyW', true));
    expect(input.read(me).throttle).toBe(0);
    window.dispatchEvent(key('keydown', 'KeyW'));
    window.dispatchEvent(key('keydown', 'Space'));
    expect(input.read(me)).toMatchObject({ throttle: 1, isFiring: true });
    window.dispatchEvent(new Event('blur'));
    expect(input.read(me)).toMatchObject({ throttle: 0, isFiring: false });
  });

  it('пробел гасит прокрутку страницы', () => {
    const event = key('keydown', 'Space');
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('активный левый стик замещает клавиши корпуса', () => {
    window.dispatchEvent(key('keydown', 'KeyW'));
    target.dispatchEvent(pointer('pointerdown', 1, LEFT_X, Y));
    target.dispatchEvent(pointer('pointermove', 1, LEFT_X, Y + 64));
    const byStick = input.read(me);
    expect(byStick.turn).toBe(1);
    expect(byStick.throttle).toBeCloseTo(0, 6);
    target.dispatchEvent(pointer('pointerup', 1, LEFT_X, Y + 64));
    expect(input.read(me)).toMatchObject({ throttle: 1, turn: 0 });
  });

  it('режим заднего хода живёт между чтениями и сбрасывается без стика', () => {
    target.dispatchEvent(pointer('pointerdown', 1, LEFT_X, Y));
    target.dispatchEvent(pointer('pointermove', 1, LEFT_X - 64, Y));
    expect(input.read(me).throttle).toBeCloseTo(-1, 6);
    // Стик под −80°: на заднем ходу корма доворачивает по часовой, на переднем нос — против.
    target.dispatchEvent(pointer('pointermove', 1, LEFT_X + 11, Y - 63));
    expect(input.read(me).turn).toBe(1);
    target.dispatchEvent(pointer('pointerup', 1, LEFT_X + 11, Y - 63));
    input.read(me);
    target.dispatchEvent(pointer('pointerdown', 1, LEFT_X, Y));
    target.dispatchEvent(pointer('pointermove', 1, LEFT_X + 11, Y - 63));
    expect(input.read(me).turn).toBe(-1);
  });

  it('мышь ведёт башню, активный правый стик её замещает, после отпускания — снова мышь', () => {
    target.dispatchEvent(pointer('pointermove', 5, 0, -100, 'mouse'));
    expect(input.read(me).turretTurn).toBe(-1);
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X + 64, Y));
    expect(input.read(me).turretTurn).toBe(0);
    target.dispatchEvent(pointer('pointerup', 2, RIGHT_X + 64, Y));
    expect(input.read(me).turretTurn).toBe(-1);
  });

  it('правый стик в мёртвой зоне башню не трогает', () => {
    target.dispatchEvent(pointer('pointermove', 5, 0, -100, 'mouse'));
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X + 4, Y));
    expect(input.read(me).turretTurn).toBe(0);
  });

  it('левая кнопка мыши стреляет, касание кнопкой не считается', () => {
    target.dispatchEvent(pointer('pointerdown', 5, 0, 0, 'mouse'));
    expect(input.read(me).isFiring).toBe(true);
    window.dispatchEvent(pointer('pointerup', 5, 0, 0, 'mouse'));
    expect(input.read(me).isFiring).toBe(false);
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    expect(input.read(me).isFiring).toBe(false);
  });

  it('стик у края и пробел вместе — один признак выстрела', () => {
    window.dispatchEvent(key('keydown', 'Space'));
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X + 64, Y));
    expect(input.read(me).isFiring).toBe(true);
  });

  it('тап справа — выстрел на одно чтение, даже если в этот момент зажат пробел', () => {
    window.dispatchEvent(key('keydown', 'Space'));
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointerup', 2, RIGHT_X, Y));
    expect(input.read(me).isFiring).toBe(true);
    window.dispatchEvent(key('keyup', 'Space'));
    expect(input.read(me).isFiring).toBe(false);
  });

  it('авто-огонь стреляет каждое чтение без ввода и не трогает корпус и башню', () => {
    expect(input.isAutoFiring).toBe(false);
    input.setAutoFire(true);
    expect(input.isAutoFiring).toBe(true);
    expect(input.read(me)).toEqual({ throttle: 0, turn: 0, turretTurn: 0, isFiring: true });
    expect(input.read(me).isFiring).toBe(true);
    input.setAutoFire(false);
    expect(input.read(me).isFiring).toBe(false);
  });

  it('при авто-огне правый стик только ведёт башню, после выключения огонь — по стику', () => {
    input.setAutoFire(true);
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X, Y + 20));
    expect(input.read(me)).toMatchObject({ turretTurn: 1, isFiring: true });
    input.setAutoFire(false);
    expect(input.read(me)).toMatchObject({ turretTurn: 1, isFiring: false });
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X, Y + 64));
    expect(input.read(me).isFiring).toBe(true);
  });

  it('состояние стиков доступно для рисования', () => {
    expect(input.stickStates).toHaveLength(0);
    target.dispatchEvent(pointer('pointerdown', 1, LEFT_X, Y));
    expect(input.stickStates).toHaveLength(1);
    expect(input.stickStates[0]?.role).toBe('move');
  });

  it('контекстное меню на холсте подавлено', () => {
    const event = new MouseEvent('contextmenu', { cancelable: true, bubbles: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('клавиши в поле ввода панели настроек не управляют танком', () => {
    const field = document.createElement('input');
    document.body.append(field);
    field.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    expect(input.read(me).throttle).toBe(0);
  });
});
