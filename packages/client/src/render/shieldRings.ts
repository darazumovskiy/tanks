import { FFA } from '@tanks/shared/engine';

export interface ShieldTank {
  id: number;
  isAlive: boolean;
  shieldLeft: number;
}

// share — доля остатка неуязвимости: дуга кольца-таймера; alpha — проявление кольца и прозрачности корпуса.
export interface ShieldRing {
  id: number;
  alpha: number;
  share: number;
}

const FADE_MS = 150;
const SHIELDED_BODY_ALPHA = 0.55;

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

// Прозрачность корпуса танка: неуязвимый полупрозрачный, проявляется и гаснет вместе с кольцом.
export function shieldedBodyAlpha(rings: readonly ShieldRing[], id: number): number {
  const ring = rings.find((candidate) => candidate.id === id);
  if (ring === undefined) {
    return 1;
  }
  return 1 - (1 - SHIELDED_BODY_ALPHA) * ring.alpha;
}

// Кольца неуязвимости кадра: у каждого танка — дуга остатка; снятая неуязвимость (выстрел, истекла) гаснет за
// 150 мс по сглаженной кривой с той долей, на которой её сняли.
export class ShieldRings {
  private readonly lit = new Map<number, number>();
  private readonly fading = new Map<number, { share: number; ageMs: number }>();

  update(tanks: readonly ShieldTank[], frameMs: number): ShieldRing[] {
    const rings: ShieldRing[] = [];
    const litNow = new Set<number>();
    for (const tank of tanks) {
      if (!tank.isAlive || tank.shieldLeft <= 0) {
        continue;
      }
      const share = Math.min(1, tank.shieldLeft / FFA.shieldSeconds);
      rings.push({ id: tank.id, alpha: 1, share });
      this.lit.set(tank.id, share);
      this.fading.delete(tank.id);
      litNow.add(tank.id);
    }
    for (const [id, share] of this.lit) {
      if (!litNow.has(id)) {
        this.lit.delete(id);
        this.fading.set(id, { share, ageMs: 0 });
      }
    }
    for (const [id, fade] of this.fading) {
      fade.ageMs += frameMs;
      if (fade.ageMs >= FADE_MS) {
        this.fading.delete(id);
        continue;
      }
      rings.push({ id, alpha: 1 - smoothstep(fade.ageMs / FADE_MS), share: fade.share });
    }
    return rings;
  }
}
