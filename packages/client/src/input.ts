import type { Action, Point } from '@tanks/shared/engine';
import type { Settings } from './settings.js';
import { aimTurret, IDLE_HULL, isBehind, steerHull, type HullSteering } from './steering.js';
import { TouchSticks, type StickSettings, type StickState } from './touch.js';

// Предохранитель задерживает опасный выстрел не дольше этого: башня не ушла — тап отменяется.
export const RICOCHET_GUARD_HOLD_MS = 300;

export type InputSettings = StickSettings & Pick<Settings, 'pivotThrottle' | 'hasRicochetGuard' | 'hasZoneFire'>;

export type GuardEvent = 'hold' | 'cancel';

// isMouseScreenAnchored — точка под курсором пересчитывается из места курсора на экране при каждом чтении:
// камера едет — точка под неподвижным курсором меняется. Без него точка поля запоминается в момент сдвига мыши.
export interface InputHooks {
  now?: () => number;
  onGuard?: (event: GuardEvent) => void;
  isMouseScreenAnchored?: boolean;
}

export interface Viewport {
  toWorld(clientX: number, clientY: number): Point;
}

export interface SteeredTank {
  x: number;
  y: number;
  heading: number;
  turret: number;
  stats: { turnRate: number };
}

// Что известно о выстреле с текущего угла башни: вернётся ли снаряд в свой корпус, проходит ли линия через зону
// противника.
export interface ShotContext {
  isReturning: boolean;
  isInZone: boolean;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

// Клавиатура — корпус, мышь — башня и выстрел; активный стик касания замещает свой источник.
// Задний ход со стика — только бросок пальца за корму танка; дальше режим ведёт `steerHull`.
// Авто-огонь — выстрел в каждом тике независимо от остальных источников, пока включён.
// Огонь по цели пропускает выстрелы касания (стик, авто-огонь, выброс стика) только в зоне противника;
// тап, мышь и пробел зоной не ограничены.
// Предохранитель сдерживает выстрел, пока он опасен (признак приходит снаружи), и не дольше задержки.
export class InputReader {
  private readonly keys = new Set<string>();
  private readonly sticks: TouchSticks;
  private readonly now: () => number;
  private readonly onGuard: (event: GuardEvent) => void;
  private readonly isMouseScreenAnchored: boolean;
  private mouse: Point | null = null;
  private mouseClient: Point | null = null;
  private isMouseDown = false;
  private hull: Readonly<HullSteering> = IDLE_HULL;
  private isAutoFireOn = false;
  // Выстрел из защёлки стика, пойманный во время задержки: доживает до безопасного чтения или до таймаута.
  private hasHeldFire = false;
  private guardStartedAt: number | null = null;
  private isShotGuardedNow = false;
  private isZoneFiringNow = false;

  constructor(
    target: HTMLElement,
    private readonly viewport: Viewport,
    private readonly settings: Readonly<InputSettings>,
    hooks: InputHooks = {},
  ) {
    this.now = hooks.now ?? ((): number => performance.now());
    this.onGuard = hooks.onGuard ?? ((): void => undefined);
    this.isMouseScreenAnchored = hooks.isMouseScreenAnchored ?? false;
    this.sticks = new TouchSticks(target, settings, this.now);
    window.addEventListener('keydown', (event) => {
      if (event.repeat || isTypingTarget(event.target)) {
        return;
      }
      this.keys.add(event.code);
      if (event.code === 'Space') {
        event.preventDefault();
      }
    });
    window.addEventListener('keyup', (event) => {
      this.keys.delete(event.code);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.isMouseDown = false;
    });
    target.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse') {
        return;
      }
      this.mouseClient = { x: event.clientX, y: event.clientY };
      if (!this.isMouseScreenAnchored) {
        this.mouse = this.viewport.toWorld(event.clientX, event.clientY);
      }
    });
    target.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button === 0) {
        this.isMouseDown = true;
      }
    });
    window.addEventListener('pointerup', (event) => {
      if (event.pointerType === 'mouse' && event.button === 0) {
        this.isMouseDown = false;
      }
    });
    target.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });
  }

  get stickStates(): StickState[] {
    return this.sticks.states;
  }

  get isAutoFiring(): boolean {
    return this.isAutoFireOn;
  }

  get isShotGuarded(): boolean {
    return this.isShotGuardedNow;
  }

  get isZoneFiring(): boolean {
    return this.isZoneFiringNow;
  }

  get isReversing(): boolean {
    return this.hull.isReversing;
  }

  // Башню наводит курсор: мышь над полем была, стика башни нет.
  get isMouseAiming(): boolean {
    return this.sticks.stick('aim') === null && this.mouseClient !== null;
  }

  // Место курсора в координатах окна; null — мышь над полем ещё не двигалась.
  get mouseScreen(): Point | null {
    return this.mouseClient;
  }

  get mouseWorld(): Point | null {
    const client = this.mouseClient;
    if (!this.isMouseScreenAnchored || client === null) {
      return this.mouse;
    }
    return this.viewport.toWorld(client.x, client.y);
  }

  setAutoFire(isOn: boolean): void {
    this.isAutoFireOn = isOn;
  }

  read(me: SteeredTank, shot: ShotContext): Action {
    const hull = this.readHull(me);
    const turretTurn = this.readTurretTurn(me);
    const isFiring = this.readFire(shot);
    return { throttle: hull.throttle, turn: hull.turn, turretTurn, isFiring };
  }

  private readFire(shot: ShotContext): boolean {
    const isZoneOpen = !this.settings.hasZoneFire || shot.isInZone;
    this.isZoneFiringNow = this.settings.hasZoneFire && shot.isInZone;
    const isHoldingByHand = this.isMouseDown || this.keys.has('Space');
    const isHoldingByTouch = (this.sticks.isFiringByStick || this.isAutoFireOn) && isZoneOpen;
    const isHoldingFire = isHoldingByHand || isHoldingByTouch;
    const pending = this.sticks.takePendingFire();
    const isPendingFire = pending === 'tap' || (pending === 'stick' && isZoneOpen);
    // Защёлка нужна только выстрелу, который к чтению уже отпущен; при зажатом огне она ничего не добавляет.
    if (isPendingFire && !isHoldingFire) {
      this.hasHeldFire = true;
    }
    const isWantingFire = isHoldingFire || this.hasHeldFire;
    const isDangerous = this.settings.hasRicochetGuard && shot.isReturning;
    if (!isDangerous || !isWantingFire) {
      this.guardStartedAt = null;
      this.isShotGuardedNow = false;
      this.hasHeldFire = false;
      return isWantingFire;
    }
    const now = this.now();
    if (this.guardStartedAt === null) {
      this.guardStartedAt = now;
      this.onGuard('hold');
    }
    const isExpired = now - this.guardStartedAt >= RICOCHET_GUARD_HOLD_MS;
    if (isExpired && this.hasHeldFire) {
      this.hasHeldFire = false;
      this.onGuard('cancel');
    }
    this.isShotGuardedNow = isHoldingFire || this.hasHeldFire;
    return false;
  }

  private readHull(me: SteeredTank): { throttle: number; turn: number } {
    const stick = this.sticks.stick('move');
    if (stick !== null) {
      const isFlicked = this.sticks.takeReverseFlick();
      if (!stick.isActive) {
        return { throttle: 0, turn: 0 };
      }
      const isEnteringReverse = isFlicked && isBehind(stick, me.heading);
      const previous = isEnteringReverse ? { ...this.hull, isReversing: true } : this.hull;
      this.hull = steerHull(stick, me.heading, me.stats.turnRate, previous, this.settings.pivotThrottle);
      return this.hull;
    }
    this.hull = IDLE_HULL;
    const isForward = this.keys.has('KeyW') || this.keys.has('ArrowUp');
    const isBack = this.keys.has('KeyS') || this.keys.has('ArrowDown');
    const isLeft = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const isRight = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    return { throttle: (isForward ? 1 : 0) - (isBack ? 1 : 0), turn: (isRight ? 1 : 0) - (isLeft ? 1 : 0) };
  }

  // Палец в мёртвой зоне стика башни — не ручное направление, но и не мышь: башня стоит.
  private readTurretTurn(me: SteeredTank): number {
    const stick = this.sticks.stick('aim');
    if (stick?.isActive === true) {
      return aimTurret(Math.atan2(stick.dy, stick.dx), me.turret);
    }
    const mouse = this.mouseWorld;
    const isMouseAiming = stick === null && mouse !== null;
    if (isMouseAiming) {
      return aimTurret(Math.atan2(mouse.y - me.y, mouse.x - me.x), me.turret);
    }
    return 0;
  }
}
