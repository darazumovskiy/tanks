import type { Action } from '@tanks/shared/engine';
import { aimTurret, isStickActive, steerHull } from './steering.js';
import { TouchSticks, type StickState } from './touch.js';

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

// Клавиатура — корпус, мышь — башня и выстрел; активный стик касания замещает свой источник.
export class InputReader {
  private readonly keys = new Set<string>();
  private readonly sticks: TouchSticks;
  private mouse: { x: number; y: number } | null = null;
  private isMouseDown = false;
  private isReversing = false;

  constructor(
    target: HTMLElement,
    private readonly viewport: Viewport,
  ) {
    this.sticks = new TouchSticks(target);
    window.addEventListener('keydown', (event) => {
      if (event.repeat) {
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

  read(me: SteeredTank): Action {
    const hull = this.readHull(me);
    const hasTapFire = this.sticks.takeTapFire();
    const isFiring = this.isMouseDown || this.keys.has('Space') || this.sticks.isFiringByStick || hasTapFire;
    return { throttle: hull.throttle, turn: hull.turn, turretTurn: this.readTurretTurn(me), isFiring };
  }

  private readHull(me: SteeredTank): { throttle: number; turn: number } {
    const stick = this.sticks.stick('move');
    if (stick !== null) {
      const steering = steerHull(stick, me.heading, me.stats.turnRate, this.isReversing);
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

  private readTurretTurn(me: SteeredTank): number {
    const stick = this.sticks.stick('aim');
    if (stick !== null) {
      if (!isStickActive(stick)) {
        return 0;
      }
      return aimTurret(Math.atan2(stick.dy, stick.dx), me.turret);
    }
    if (this.mouse === null) {
      return 0;
    }
    return aimTurret(Math.atan2(this.mouse.y - me.y, this.mouse.x - me.x), me.turret);
  }
}
