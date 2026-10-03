import type { Settings } from './settings.js';
import { isStickActive, stickMagnitude, type StickVector } from './steering.js';

export const TAP_MAX_MS = 200;

export type StickRole = 'move' | 'aim';

// Размеры и пороги фиксируются в момент касания: смена настроек в панели не дёргает уже зажатый стик.
export interface StickState extends StickVector {
  role: StickRole;
  baseX: number;
  baseY: number;
  radiusPx: number;
  deadZone: number;
  fireRing: number;
}

interface ActiveStick extends StickState {
  pointerId: number;
  startedAt: number;
  hasLeftDeadZone: boolean;
}

export type StickSettings = Pick<Settings, 'stickRadiusPx' | 'deadZone' | 'fireRing'>;

// Плавающие стики: касание левой половины экрана рождает стик корпуса, правой — стик башни.
// Основание — в точке касания, ручка следует за пальцем в пределах радиуса.
export class TouchSticks {
  private readonly active = new Map<StickRole, ActiveStick>();
  private hasPendingTap = false;

  constructor(
    target: HTMLElement,
    private readonly settings: StickSettings,
    private readonly now: () => number = () => performance.now(),
  ) {
    target.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') {
        return;
      }
      event.preventDefault();
      this.begin(event);
    });
    window.addEventListener('pointermove', (event) => {
      this.move(event);
    });
    window.addEventListener('pointerup', (event) => {
      this.end(event, true);
    });
    window.addEventListener('pointercancel', (event) => {
      this.end(event, false);
    });
  }

  stick(role: StickRole): StickState | null {
    return this.active.get(role) ?? null;
  }

  get states(): StickState[] {
    return [...this.active.values()];
  }

  get isFiringByStick(): boolean {
    const aim = this.active.get('aim');
    return aim !== undefined && stickMagnitude(aim) >= aim.fireRing;
  }

  // Тап по правой половине — одиночный выстрел; флаг снимается при чтении.
  takeTapFire(): boolean {
    const hasTap = this.hasPendingTap;
    this.hasPendingTap = false;
    return hasTap;
  }

  private begin(event: PointerEvent): void {
    const role: StickRole = event.clientX < window.innerWidth / 2 ? 'move' : 'aim';
    if (this.active.has(role)) {
      return;
    }
    this.active.set(role, {
      role,
      pointerId: event.pointerId,
      baseX: event.clientX,
      baseY: event.clientY,
      dx: 0,
      dy: 0,
      radiusPx: this.settings.stickRadiusPx,
      deadZone: this.settings.deadZone,
      fireRing: this.settings.fireRing,
      startedAt: this.now(),
      hasLeftDeadZone: false,
    });
  }

  private move(event: PointerEvent): void {
    const stick = this.byPointer(event.pointerId);
    if (stick === null) {
      return;
    }
    const rawX = (event.clientX - stick.baseX) / stick.radiusPx;
    const rawY = (event.clientY - stick.baseY) / stick.radiusPx;
    const length = Math.hypot(rawX, rawY);
    const scale = length > 1 ? 1 / length : 1;
    stick.dx = rawX * scale;
    stick.dy = rawY * scale;
    if (isStickActive(stick, stick.deadZone)) {
      stick.hasLeftDeadZone = true;
    }
  }

  private end(event: PointerEvent, isCompleted: boolean): void {
    const stick = this.byPointer(event.pointerId);
    if (stick === null) {
      return;
    }
    this.active.delete(stick.role);
    const isQuick = this.now() - stick.startedAt <= TAP_MAX_MS;
    if (isCompleted && stick.role === 'aim' && isQuick && !stick.hasLeftDeadZone) {
      this.hasPendingTap = true;
    }
  }

  private byPointer(pointerId: number): ActiveStick | null {
    for (const stick of this.active.values()) {
      if (stick.pointerId === pointerId) {
        return stick;
      }
    }
    return null;
  }
}
