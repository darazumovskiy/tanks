import { beforeEach, describe, expect, it } from 'vitest';
import { InputReader, RICOCHET_GUARD_HOLD_MS, type GuardEvent, type InputSettings, type SteeredTank } from './input.js';

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
  let settings: InputSettings;
  let time = 0;
  let guardEvents: GuardEvent[] = [];

  const read = (isReturning = false, isInZone = false): ReturnType<InputReader['read']> =>
    input.read(me, { isReturning, isInZone });

  beforeEach(() => {
    document.body.innerHTML = '';
    target = document.createElement('div');
    document.body.append(target);
    time = 0;
    guardEvents = [];
    settings = {
      stickRadiusPx: 64,
      deadZone: 0.15,
      pivotThrottle: 0,
      hasFireRing: true,
      fireRing: 0.85,
      hasRicochetGuard: false,
      hasZoneFire: false,
    };
    input = new InputReader(target, { toWorld: (x, y) => ({ x, y }) }, settings, {
      now: () => time,
      onGuard: (event) => {
        guardEvents.push(event);
      },
    });
  });

  it('без ввода — пустое действие', () => {
    expect(read()).toEqual({ throttle: 0, turn: 0, turretTurn: 0, isFiring: false });
  });

  it('клавиши ведут корпус: W — вперёд, S — назад, A/D — поворот', () => {
    window.dispatchEvent(key('keydown', 'KeyW'));
    window.dispatchEvent(key('keydown', 'KeyD'));
    expect(read()).toMatchObject({ throttle: 1, turn: 1 });
    window.dispatchEvent(key('keyup', 'KeyW'));
    window.dispatchEvent(key('keydown', 'ArrowDown'));
    window.dispatchEvent(key('keydown', 'ArrowLeft'));
    expect(read()).toMatchObject({ throttle: -1, turn: 0 });
  });

  it('повтор клавиши и потеря фокуса', () => {
    window.dispatchEvent(key('keydown', 'KeyW', true));
    expect(read().throttle).toBe(0);
    window.dispatchEvent(key('keydown', 'KeyW'));
    window.dispatchEvent(key('keydown', 'Space'));
    expect(read()).toMatchObject({ throttle: 1, isFiring: true });
    window.dispatchEvent(new Event('blur'));
    expect(read()).toMatchObject({ throttle: 0, isFiring: false });
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
    const byStick = read();
    expect(byStick.turn).toBe(1);
    expect(byStick.throttle).toBeCloseTo(0, 6);
    target.dispatchEvent(pointer('pointerup', 1, LEFT_X, Y + 64));
    expect(read()).toMatchObject({ throttle: 1, turn: 0 });
  });

  // Бросок левого стика: палец на одной стороне основания, через центр, на другую — за 100 мс.
  const flickLeftStick = (from: { dx: number; dy: number }, to: { dx: number; dy: number }): void => {
    target.dispatchEvent(pointer('pointermove', 1, LEFT_X + from.dx, Y + from.dy));
    time += 100;
    target.dispatchEvent(pointer('pointermove', 1, LEFT_X, Y));
    time += 100;
    target.dispatchEvent(pointer('pointermove', 1, LEFT_X + to.dx, Y + to.dy));
  };

  it('стик против курса без броска — разворот на месте, не задний ход', () => {
    target.dispatchEvent(pointer('pointerdown', 1, LEFT_X, Y));
    target.dispatchEvent(pointer('pointermove', 1, LEFT_X - 64, Y));
    const action = read();
    expect(action.throttle).toBeCloseTo(0, 6);
    expect(Math.abs(action.turn)).toBe(1);
    expect(input.isReversing).toBe(false);
  });

  it('бросок с носа за корму — задний ход, держится до 70° от кормы, дальше — передний', () => {
    target.dispatchEvent(pointer('pointerdown', 1, LEFT_X, Y));
    flickLeftStick({ dx: 64, dy: 0 }, { dx: -64, dy: 0 });
    expect(read().throttle).toBeCloseTo(-1, 6);
    expect(input.isReversing).toBe(true);
    // 50° от кормы (стик под 130°): всё ещё задний ход, корма доворачивает.
    target.dispatchEvent(pointer('pointermove', 1, LEFT_X - 41, Y + 49));
    const holding = read();
    expect(holding.throttle).toBeLessThan(0);
    expect(input.isReversing).toBe(true);
    // 80° от кормы (стик под 100°): передний ход.
    target.dispatchEvent(pointer('pointermove', 1, LEFT_X - 11, Y + 63));
    const forward = read();
    expect(forward.throttle).toBeCloseTo(0, 6);
    expect(forward.turn).toBe(1);
    expect(input.isReversing).toBe(false);
  });

  it('бросок, после которого палец не позади танка, — просто поворот', () => {
    target.dispatchEvent(pointer('pointerdown', 1, LEFT_X, Y));
    flickLeftStick({ dx: 0, dy: -64 }, { dx: 0, dy: 64 });
    const action = read();
    expect(action.throttle).toBeCloseTo(0, 6);
    expect(action.turn).toBe(1);
    expect(input.isReversing).toBe(false);
  });

  it('бросок обратно на сторону носа во время заднего хода — передний ход', () => {
    target.dispatchEvent(pointer('pointerdown', 1, LEFT_X, Y));
    flickLeftStick({ dx: 64, dy: 0 }, { dx: -64, dy: 0 });
    expect(read().throttle).toBeCloseTo(-1, 6);
    flickLeftStick({ dx: -64, dy: 0 }, { dx: 64, dy: 0 });
    expect(read()).toMatchObject({ throttle: 1, turn: 0 });
    expect(input.isReversing).toBe(false);
  });

  it('отпускание на заднем ходу сбрасывает режим; новое касание к корме — передний ход', () => {
    target.dispatchEvent(pointer('pointerdown', 1, LEFT_X, Y));
    flickLeftStick({ dx: 64, dy: 0 }, { dx: -64, dy: 0 });
    expect(read().throttle).toBeCloseTo(-1, 6);
    target.dispatchEvent(pointer('pointerup', 1, LEFT_X - 64, Y));
    read();
    expect(input.isReversing).toBe(false);
    target.dispatchEvent(pointer('pointerdown', 1, LEFT_X, Y));
    target.dispatchEvent(pointer('pointermove', 1, LEFT_X - 64, Y));
    expect(read().throttle).toBeCloseTo(0, 6);
    expect(input.isReversing).toBe(false);
  });

  it('мышь ведёт башню, активный правый стик её замещает, после отпускания — снова мышь', () => {
    target.dispatchEvent(pointer('pointermove', 5, 0, -100, 'mouse'));
    expect(read().turretTurn).toBe(-1);
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X + 64, Y));
    expect(read().turretTurn).toBe(0);
    target.dispatchEvent(pointer('pointerup', 2, RIGHT_X + 64, Y));
    expect(read().turretTurn).toBe(-1);
  });

  it('левый стик в мёртвой зоне — нулевое действие, режим заднего хода сохраняется', () => {
    target.dispatchEvent(pointer('pointerdown', 1, LEFT_X, Y));
    flickLeftStick({ dx: 64, dy: 0 }, { dx: -64, dy: 0 });
    expect(read().throttle).toBeCloseTo(-1, 6);
    target.dispatchEvent(pointer('pointermove', 1, LEFT_X - 4, Y));
    expect(read()).toMatchObject({ throttle: 0, turn: 0 });
    expect(input.isReversing).toBe(true);
    // Стик под 140° с сохранённым задним ходом: корма доворачивает против часовой.
    target.dispatchEvent(pointer('pointermove', 1, LEFT_X - 49, Y + 41));
    const action = read();
    expect(action.turn).toBe(-1);
    expect(action.throttle).toBeLessThan(0);
  });

  it('выброс правого стика к кольцу и отпускание между чтениями — выстрел на следующем чтении', () => {
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X + 64, Y));
    target.dispatchEvent(pointer('pointerup', 2, RIGHT_X + 64, Y));
    expect(read().isFiring).toBe(true);
    expect(read().isFiring).toBe(false);
  });

  it('правый стик в мёртвой зоне башню не трогает', () => {
    target.dispatchEvent(pointer('pointermove', 5, 0, -100, 'mouse'));
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X + 4, Y));
    expect(read().turretTurn).toBe(0);
  });

  it('левая кнопка мыши стреляет, касание кнопкой не считается', () => {
    target.dispatchEvent(pointer('pointerdown', 5, 0, 0, 'mouse'));
    expect(read().isFiring).toBe(true);
    window.dispatchEvent(pointer('pointerup', 5, 0, 0, 'mouse'));
    expect(read().isFiring).toBe(false);
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    expect(read().isFiring).toBe(false);
  });

  it('стик у края и пробел вместе — один признак выстрела', () => {
    window.dispatchEvent(key('keydown', 'Space'));
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X + 64, Y));
    expect(read().isFiring).toBe(true);
  });

  it('тап справа — выстрел на одно чтение, даже если в этот момент зажат пробел', () => {
    window.dispatchEvent(key('keydown', 'Space'));
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointerup', 2, RIGHT_X, Y));
    expect(read().isFiring).toBe(true);
    window.dispatchEvent(key('keyup', 'Space'));
    expect(read().isFiring).toBe(false);
  });

  it('авто-огонь стреляет каждое чтение без ввода и не трогает корпус и башню', () => {
    expect(input.isAutoFiring).toBe(false);
    input.setAutoFire(true);
    expect(input.isAutoFiring).toBe(true);
    expect(read()).toEqual({ throttle: 0, turn: 0, turretTurn: 0, isFiring: true });
    expect(read().isFiring).toBe(true);
    input.setAutoFire(false);
    expect(read().isFiring).toBe(false);
  });

  it('при авто-огне правый стик только ведёт башню, после выключения огонь — по стику', () => {
    input.setAutoFire(true);
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X, Y + 20));
    expect(read()).toMatchObject({ turretTurn: 1, isFiring: true });
    input.setAutoFire(false);
    expect(read()).toMatchObject({ turretTurn: 1, isFiring: false });
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X, Y + 64));
    expect(read().isFiring).toBe(true);
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
    expect(read().throttle).toBe(0);
  });

  it('палец в мёртвой зоне правой половины без кольца стреляет, башня стоит', () => {
    settings.hasFireRing = false;
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X + 4, Y));
    expect(read()).toMatchObject({ turretTurn: 0, isFiring: true });
  });

  it('палец в мёртвой зоне при известной позиции мыши — башня стоит, мышь не перехватывает', () => {
    target.dispatchEvent(pointer('pointermove', 5, 0, -100, 'mouse'));
    expect(read().turretTurn).toBe(-1);
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X + 4, Y));
    expect(read().turretTurn).toBe(0);
  });

  describe('предохранитель от своего рикошета', () => {
    const isReturning = true;
    const isSafe = false;

    beforeEach(() => {
      settings.hasRicochetGuard = true;
    });

    it('без внедрённых часов задержка отсчитывается по времени браузера', () => {
      const clocked = new InputReader(target, { toWorld: (x, y) => ({ x, y }) }, settings);
      window.dispatchEvent(key('keydown', 'Space'));
      expect(clocked.read(me, { isReturning, isInZone: false }).isFiring).toBe(false);
      expect(clocked.isShotGuarded).toBe(true);
      expect(clocked.read(me, { isReturning: isSafe, isInZone: false }).isFiring).toBe(true);
    });

    it('выключенный флаг — опасный выстрел уходит как раньше', () => {
      settings.hasRicochetGuard = false;
      window.dispatchEvent(key('keydown', 'Space'));
      expect(read(isReturning).isFiring).toBe(true);
      expect(input.isShotGuarded).toBe(false);
      expect(guardEvents).toEqual([]);
    });

    it('зажатый пробел при опасности сдерживается', () => {
      window.dispatchEvent(key('keydown', 'Space'));
      expect(read(isReturning).isFiring).toBe(false);
      expect(input.isShotGuarded).toBe(true);
      expect(guardEvents).toEqual(['hold']);
    });

    it('тап при опасности ждёт; башня ушла до таймаута — выстрел уходит один раз', () => {
      target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
      target.dispatchEvent(pointer('pointerup', 2, RIGHT_X, Y));
      expect(read(isReturning).isFiring).toBe(false);
      expect(input.isShotGuarded).toBe(true);
      time = 200;
      expect(read(isReturning).isFiring).toBe(false);
      expect(read(isSafe).isFiring).toBe(true);
      expect(input.isShotGuarded).toBe(false);
      expect(read(isSafe).isFiring).toBe(false);
      expect(guardEvents).toEqual(['hold']);
    });

    it('тап при опасности дольше таймаута отменяется', () => {
      target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
      target.dispatchEvent(pointer('pointerup', 2, RIGHT_X, Y));
      expect(read(isReturning).isFiring).toBe(false);
      time = RICOCHET_GUARD_HOLD_MS - 1;
      expect(read(isReturning).isFiring).toBe(false);
      expect(input.isShotGuarded).toBe(true);
      time = RICOCHET_GUARD_HOLD_MS;
      expect(read(isReturning).isFiring).toBe(false);
      expect(input.isShotGuarded).toBe(false);
      expect(guardEvents).toEqual(['hold', 'cancel']);
      expect(read(isSafe).isFiring).toBe(false);
    });

    it('зажатая мышь при опасности не стреляет и после таймаута, стреляет сразу после ухода опасности', () => {
      target.dispatchEvent(pointer('pointerdown', 5, 0, 0, 'mouse'));
      expect(read(isReturning).isFiring).toBe(false);
      time = RICOCHET_GUARD_HOLD_MS + 500;
      expect(read(isReturning).isFiring).toBe(false);
      expect(input.isShotGuarded).toBe(true);
      expect(read(isSafe).isFiring).toBe(true);
      expect(input.isShotGuarded).toBe(false);
      expect(guardEvents).toEqual(['hold']);
    });

    it('опасность пропала и вернулась — счётчик стартует заново', () => {
      target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
      target.dispatchEvent(pointer('pointerup', 2, RIGHT_X, Y));
      expect(read(isReturning).isFiring).toBe(false);
      time = 200;
      expect(read(isSafe).isFiring).toBe(true);
      target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
      target.dispatchEvent(pointer('pointerup', 2, RIGHT_X, Y));
      time = 250;
      expect(read(isReturning).isFiring).toBe(false);
      time = 250 + RICOCHET_GUARD_HOLD_MS - 1;
      expect(read(isReturning).isFiring).toBe(false);
      expect(input.isShotGuarded).toBe(true);
      expect(guardEvents).toEqual(['hold', 'hold']);
      time = 250 + RICOCHET_GUARD_HOLD_MS;
      expect(read(isReturning).isFiring).toBe(false);
      expect(input.isShotGuarded).toBe(false);
      expect(guardEvents).toEqual(['hold', 'hold', 'cancel']);
    });

    it('палец на правой половине при опасности: сдерживается без отмены защёлки, после отпускания выстрела нет', () => {
      settings.hasFireRing = false;
      target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
      target.dispatchEvent(pointer('pointermove', 2, RIGHT_X + 40, Y));
      expect(read(isReturning).isFiring).toBe(false);
      time = RICOCHET_GUARD_HOLD_MS + 100;
      target.dispatchEvent(pointer('pointermove', 2, RIGHT_X + 41, Y));
      expect(read(isReturning).isFiring).toBe(false);
      expect(input.isShotGuarded).toBe(true);
      expect(guardEvents).toEqual(['hold']);
      target.dispatchEvent(pointer('pointerup', 2, RIGHT_X + 41, Y));
      expect(read(isSafe).isFiring).toBe(false);
      expect(input.isShotGuarded).toBe(false);
    });

    it('авто-огонь под предохранителем', () => {
      input.setAutoFire(true);
      expect(read(isReturning).isFiring).toBe(false);
      expect(input.isShotGuarded).toBe(true);
      expect(read(isSafe).isFiring).toBe(true);
      expect(input.isShotGuarded).toBe(false);
    });

    it('опасно, но стрелять никто не хочет — ничего не сдерживается', () => {
      expect(read(isReturning).isFiring).toBe(false);
      expect(input.isShotGuarded).toBe(false);
      expect(guardEvents).toEqual([]);
    });
  });

  describe('огонь по цели', () => {
    const isInZone = true;
    const isOutOfZone = false;
    const isSafe = false;

    const touchRightHalf = (): void => {
      target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
      target.dispatchEvent(pointer('pointermove', 2, RIGHT_X + 40, Y));
    };

    beforeEach(() => {
      settings.hasFireRing = false;
      settings.hasZoneFire = true;
    });

    it('выключенный флаг — касание стреляет вне зоны, как раньше', () => {
      settings.hasZoneFire = false;
      touchRightHalf();
      expect(read(isSafe, isOutOfZone).isFiring).toBe(true);
      expect(input.isZoneFiring).toBe(false);
    });

    it('палец на правой половине: вне зоны молчит, в зоне стреляет', () => {
      touchRightHalf();
      expect(read(isSafe, isOutOfZone).isFiring).toBe(false);
      expect(input.isZoneFiring).toBe(false);
      expect(read(isSafe, isInZone).isFiring).toBe(true);
      expect(input.isZoneFiring).toBe(true);
      expect(read(isSafe, isOutOfZone).isFiring).toBe(false);
    });

    it('тап стреляет вне зоны один раз', () => {
      target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
      target.dispatchEvent(pointer('pointerup', 2, RIGHT_X, Y));
      expect(read(isSafe, isOutOfZone).isFiring).toBe(true);
      expect(read(isSafe, isOutOfZone).isFiring).toBe(false);
    });

    it('выброс стика, отпущенный между чтениями, вне зоны гасится, в зоне стреляет один раз', () => {
      touchRightHalf();
      time = 300;
      target.dispatchEvent(pointer('pointerup', 2, RIGHT_X + 40, Y));
      expect(read(isSafe, isOutOfZone).isFiring).toBe(false);
      touchRightHalf();
      target.dispatchEvent(pointer('pointerup', 2, RIGHT_X + 40, Y));
      expect(read(isSafe, isInZone).isFiring).toBe(true);
      expect(read(isSafe, isInZone).isFiring).toBe(false);
    });

    it('авто-огонь подчиняется зоне', () => {
      input.setAutoFire(true);
      expect(read(isSafe, isOutOfZone).isFiring).toBe(false);
      expect(read(isSafe, isInZone).isFiring).toBe(true);
    });

    it('мышь и пробел зоной не ограничены', () => {
      target.dispatchEvent(pointer('pointerdown', 5, 0, 0, 'mouse'));
      expect(read(isSafe, isOutOfZone).isFiring).toBe(true);
      window.dispatchEvent(pointer('pointerup', 5, 0, 0, 'mouse'));
      window.dispatchEvent(key('keydown', 'Space'));
      expect(read(isSafe, isOutOfZone).isFiring).toBe(true);
    });

    it('предохранитель действует поверх зоны', () => {
      settings.hasRicochetGuard = true;
      touchRightHalf();
      expect(read(true, isInZone).isFiring).toBe(false);
      expect(input.isShotGuarded).toBe(true);
      expect(input.isZoneFiring).toBe(true);
      expect(read(isSafe, isInZone).isFiring).toBe(true);
      expect(input.isShotGuarded).toBe(false);
    });
  });

  it('порог газа на повороте читается из настроек каждый тик', () => {
    target.dispatchEvent(pointer('pointerdown', 1, LEFT_X, Y));
    target.dispatchEvent(pointer('pointermove', 1, LEFT_X - 64, Y));
    expect(read().throttle).toBeCloseTo(0, 6);
    settings.pivotThrottle = 0.5;
    expect(read().throttle).toBeCloseTo(0.5, 6);
    expect(input.isReversing).toBe(false);
  });

  it('клавиша S — задний ход с клавиатуры не меняется', () => {
    window.dispatchEvent(key('keydown', 'KeyS'));
    expect(read().throttle).toBe(-1);
    expect(input.isReversing).toBe(false);
  });
});
