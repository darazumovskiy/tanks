import { DT, normalizeAngle, TURRET_RATE, type Action } from '@tanks/shared/engine';

export interface Viewport {
  toWorld(clientX: number, clientY: number): { x: number; y: number };
}

// Клавиатура — корпус, мышь — башня и выстрел. Башня получает скорость поворота, которая за один тик
// доведёт её до курсора, но не быстрее предела движка.
export class InputReader {
  private readonly keys = new Set<string>();
  private mouse: { x: number; y: number } | null = null;
  private isMouseDown = false;

  constructor(
    private readonly target: HTMLElement,
    private readonly viewport: Viewport,
  ) {
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
    target.addEventListener('mousemove', (event) => {
      this.mouse = this.viewport.toWorld(event.clientX, event.clientY);
    });
    target.addEventListener('mousedown', (event) => {
      if (event.button === 0) {
        this.isMouseDown = true;
      }
    });
    window.addEventListener('mouseup', (event) => {
      if (event.button === 0) {
        this.isMouseDown = false;
      }
    });
    target.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });
  }

  read(me: { x: number; y: number; turret: number }): Action {
    const isForward = this.keys.has('KeyW') || this.keys.has('ArrowUp');
    const isBack = this.keys.has('KeyS') || this.keys.has('ArrowDown');
    const isLeft = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const isRight = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    const throttle = (isForward ? 1 : 0) - (isBack ? 1 : 0);
    const turn = (isRight ? 1 : 0) - (isLeft ? 1 : 0);
    let turretTurn = 0;
    if (this.mouse !== null) {
      const wanted = Math.atan2(this.mouse.y - me.y, this.mouse.x - me.x);
      const diff = normalizeAngle(wanted - me.turret);
      turretTurn = Math.max(-1, Math.min(1, diff / (TURRET_RATE * DT)));
    }
    return { throttle, turn, turretTurn, isFiring: this.isMouseDown || this.keys.has('Space') };
  }
}
