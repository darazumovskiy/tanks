import type { Settings } from './settings.js';
import { stickMagnitude, type StickVector } from './steering.js';

export const TAP_MAX_MS = 200;
// Сдвиг пальца от точки касания, до которого касание ещё считается тапом (порог Android — 8 dp).
export const TAP_SLOP_PX = 10;
// Основание стика отступает от края экрана на эту долю радиуса, чтобы ручку можно было довести до упора в любую сторону.
export const EDGE_GAP_RATIO = 0.12;
// Выход из мёртвой зоны и с кольца огня — ближе к центру, чем вход, чтобы палец на границе не дребезжал.
export const DEAD_ZONE_EXIT_GAP = 0.03;
export const FIRE_RING_EXIT_GAP = 0.04;

export type StickRole = 'move' | 'aim';

// Что стреляло между двумя чтениями ввода: `stick` — стик был у кольца или, без кольца, касался экрана;
// `tap` — короткое касание без сдвига. Тап главнее: он всегда выстрел, стик — только если огонь разрешён.
export type PendingFire = 'none' | 'stick' | 'tap';

// Размеры и пороги фиксируются в момент касания: смена настроек в панели не дёргает уже зажатый стик.
// `fireRing` — доля радиуса, с которой стик башни стреляет; `null` — кольца нет, стреляет само касание.
// `isActive` и `isFiring` считаются с гистерезисом при каждом сдвиге пальца.
export interface StickState extends StickVector {
  role: StickRole;
  baseX: number;
  baseY: number;
  radiusPx: number;
  deadZone: number;
  fireRing: number | null;
  isActive: boolean;
  isFiring: boolean;
}

interface ActiveStick extends StickState {
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
  hasMovedPastTapSlop: boolean;
}

export type StickSettings = Pick<Settings, 'stickRadiusPx' | 'deadZone' | 'hasFireRing' | 'fireRing'>;

function isPastThreshold(magnitude: number, threshold: number, exitGap: number, wasPast: boolean): boolean {
  if (wasPast) {
    return magnitude >= threshold - exitGap;
  }
  return magnitude >= threshold;
}

// Плавающие стики: касание левой половины экрана рождает стик корпуса, правой — стик башни.
// Основание — в точке касания, ручка следует за пальцем в пределах радиуса.
export class TouchSticks {
  private readonly active = new Map<StickRole, ActiveStick>();
  private pendingFire: PendingFire = 'none';

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
    // Приложение ушло в фон или потеряло фокус — касания могут не прийти к завершению, стики сбрасываются.
    const dropAll = (): void => {
      this.active.clear();
      this.pendingFire = 'none';
    };
    window.addEventListener('blur', dropAll);
    window.addEventListener('pagehide', dropAll);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        dropAll();
      }
    });
  }

  stick(role: StickRole): StickState | null {
    return this.active.get(role) ?? null;
  }

  get states(): StickState[] {
    return [...this.active.values()];
  }

  get isFiringByStick(): boolean {
    return this.active.get('aim')?.isFiring === true;
  }

  // Стик стрелял между двумя чтениями ввода (выброс к кольцу, тап) — выстрел не теряется; флаг снимается чтением.
  takePendingFire(): PendingFire {
    const pending = this.pendingFire;
    this.pendingFire = 'none';
    return pending;
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
      fireRing: this.settings.hasFireRing ? this.settings.fireRing : null,
      isActive: false,
      isFiring: false,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: this.now(),
      hasMovedPastTapSlop: false,
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
    const magnitude = stickMagnitude(stick);
    stick.isActive = isPastThreshold(magnitude, stick.deadZone, DEAD_ZONE_EXIT_GAP, stick.isActive);
    stick.isFiring = stick.role === 'aim' && this.isAimFiring(stick, magnitude);
    if (stick.isFiring && this.pendingFire === 'none') {
      this.pendingFire = 'stick';
    }
    if (Math.hypot(clientX - stick.startX, clientY - stick.startY) > TAP_SLOP_PX) {
      stick.hasMovedPastTapSlop = true;
    }
  }

  private isAimFiring(stick: ActiveStick, magnitude: number): boolean {
    if (stick.fireRing === null) {
      return true;
    }
    return isPastThreshold(magnitude, stick.fireRing, FIRE_RING_EXIT_GAP, stick.isFiring);
  }

  private end(event: PointerEvent, isCompleted: boolean): void {
    const stick = this.byPointer(event.pointerId);
    if (stick === null) {
      return;
    }
    this.active.delete(stick.role);
    const isQuick = this.now() - stick.startedAt <= TAP_MAX_MS;
    if (isCompleted && stick.role === 'aim' && isQuick && !stick.hasMovedPastTapSlop) {
      this.pendingFire = 'tap';
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
