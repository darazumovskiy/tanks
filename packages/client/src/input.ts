import type { Action } from '@tanks/shared/engine';
import type { Settings } from './settings.js';
import { aimTurret, steerHull } from './steering.js';
import { TouchSticks, type StickSettings, type StickState } from './touch.js';

// После того как игрок отпустил стик башни, автоведение ждёт: осознанный выстрел в стену на рикошет не должен
// перебиваться доворотом на противника.
export const AUTO_AIM_RESUME_MS = 500;
// Предохранитель задерживает опасный выстрел не дольше этого: башня не ушла — тап отменяется.
export const RICOCHET_GUARD_HOLD_MS = 300;

export type InputSettings = StickSettings &
  Pick<Settings, 'hasAutoAim' | 'hasRicochetGuard' | 'hasQuickReverse' | 'hasZoneFire'>;

export type GuardEvent = 'hold' | 'cancel';

export interface InputHooks {
  now?: () => number;
  onGuard?: (event: GuardEvent) => void;
}

export interface Viewport {
  toWorld(clientX: number, clientY: number): { x: number; y: number };
}

export interface SteeredTank {
  x: number;
  y: number;
  heading: number;
  turret: number;
  stats: { turnRate: number };
}

export interface AimTarget {
  x: number;
  y: number;
}

// Что известно о выстреле с текущего угла башни: цель автоведения, вернётся ли снаряд в свой корпус,
// проходит ли линия через зону противника.
export interface ShotContext {
  target: AimTarget | null;
  isReturning: boolean;
  isInZone: boolean;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

// Клавиатура — корпус, мышь — башня и выстрел; активный стик касания замещает свой источник.
// Авто-огонь — выстрел в каждом тике независимо от остальных источников, пока включён.
// Башня без ручного источника при включённом автоведении держит переданную цель.
// Огонь по цели пропускает выстрелы касания (стик, авто-огонь, выброс стика) только в зоне противника;
// тап, мышь и пробел зоной не ограничены.
// Предохранитель сдерживает выстрел, пока он опасен (признак приходит снаружи), и не дольше задержки.
export class InputReader {
  private readonly keys = new Set<string>();
  private readonly sticks: TouchSticks;
  private readonly now: () => number;
  private readonly onGuard: (event: GuardEvent) => void;
  private mouse: { x: number; y: number } | null = null;
  private isMouseDown = false;
  private isReversing = false;
  private isAutoFireOn = false;
  private isAutoAimingNow = false;
  private lastManualAimAt: number | null = null;
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
    this.sticks = new TouchSticks(target, settings);
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
      if (event.pointerType === 'mouse') {
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

  get isAutoAiming(): boolean {
    return this.isAutoAimingNow;
  }

  get isShotGuarded(): boolean {
    return this.isShotGuardedNow;
  }

  get isZoneFiring(): boolean {
    return this.isZoneFiringNow;
  }

  setAutoFire(isOn: boolean): void {
    this.isAutoFireOn = isOn;
  }

  read(me: SteeredTank, shot: ShotContext): Action {
    const hull = this.readHull(me);
    const turretTurn = this.readTurretTurn(me, shot.target);
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
      if (!stick.isActive) {
        return { throttle: 0, turn: 0 };
      }
      const steering = steerHull(stick, me.heading, me.stats.turnRate, this.isReversing, this.settings.hasQuickReverse);
      this.isReversing = steering.isReversing;
      return steering;
    }
    this.isReversing = false;
    const isForward = this.keys.has('KeyW') || this.keys.has('ArrowUp');
    const isBack = this.keys.has('KeyS') || this.keys.has('ArrowDown');
    const isLeft = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const isRight = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    return { throttle: (isForward ? 1 : 0) - (isBack ? 1 : 0), turn: (isRight ? 1 : 0) - (isLeft ? 1 : 0) };
  }

  // Палец в мёртвой зоне стика башни — не ручное направление, но и не мышь: башню ведёт автоматика.
  private readTurretTurn(me: SteeredTank, target: AimTarget | null): number {
    this.isAutoAimingNow = false;
    const stick = this.sticks.stick('aim');
    if (stick?.isActive === true) {
      this.lastManualAimAt = this.now();
      return aimTurret(Math.atan2(stick.dy, stick.dx), me.turret);
    }
    const mouse = this.mouse;
    const isMouseAiming = stick === null && mouse !== null;
    if (isMouseAiming) {
      return aimTurret(Math.atan2(mouse.y - me.y, mouse.x - me.x), me.turret);
    }
    return this.readAutoAim(me, target);
  }

  private readAutoAim(me: SteeredTank, target: AimTarget | null): number {
    if (!this.settings.hasAutoAim || target === null || this.mouse !== null) {
      return 0;
    }
    const isResting = this.lastManualAimAt !== null && this.now() - this.lastManualAimAt < AUTO_AIM_RESUME_MS;
    if (isResting) {
      return 0;
    }
    this.isAutoAimingNow = true;
    return aimTurret(Math.atan2(target.y - me.y, target.x - me.x), me.turret);
  }
}
