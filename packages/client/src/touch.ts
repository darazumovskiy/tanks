import type { Settings } from './settings.js';
import { isStickActive, stickMagnitude, type StickVector } from './steering.js';

export const TAP_MAX_MS = 200;
// Основание стика отступает от края экрана на эту долю радиуса, чтобы ручку можно было довести до упора в любую сторону.
export const EDGE_GAP_RATIO = 0.12;

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
    const radiusPx = this.settings.stickRadiusPx;
    const inset = radiusPx * (1 + EDGE_GAP_RATIO);
    const stick: ActiveStick = {
      role,
      pointerId: event.pointerId,
      baseX: clampToScreen(event.clientX, inset, window.innerWidth),
      baseY: clampToScreen(event.clientY, inset, window.innerHeight),
      dx: 0,
      dy: 0,
      radiusPx,
      deadZone: this.settings.deadZone,
      fireRing: this.settings.fireRing,
      startedAt: this.now(),
      hasLeftDeadZone: false,
    };
    this.active.set(role, stick);
    this.deflect(stick, event.clientX, event.clientY);
  }

  private move(event: PointerEvent): void {
    const stick = this.byPointer(event.pointerId);
    if (stick === null) {
      return;
    }
    this.deflect(stick, event.clientX, event.clientY);
  }

  private deflect(stick: ActiveStick, clientX: number, clientY: number): void {
    const rawX = (clientX - stick.baseX) / stick.radiusPx;
    const rawY = (clientY - stick.baseY) / stick.radiusPx;
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

function clampToScreen(value: number, inset: number, size: number): number {
  if (size <= inset * 2) {
    return size / 2;
  }
  return Math.min(size - inset, Math.max(inset, value));
}
