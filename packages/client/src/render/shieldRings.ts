import { FFA } from '@tanks/shared/engine';

export interface ShieldTank {
  id: number;
  isAlive: boolean;
  shieldLeft: number;
}

// share — доля остатка у своего танка (дуга), null — полное кольцо чужого.
export interface ShieldRing {
  id: number;
  alpha: number;
  share: number | null;
}

const FADE_MS = 150;

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

// Кольца неуязвимости кадра: у своего — дуга остатка, у чужих — полное кольцо; снятая неуязвимость (выстрел,
// истекла) гаснет за 150 мс по сглаженной кривой.
export class ShieldRings {
  private readonly lit = new Map<number, number | null>();
  private readonly fading = new Map<number, { share: number | null; ageMs: number }>();

  update(tanks: readonly ShieldTank[], myId: number | null, frameMs: number): ShieldRing[] {
    const rings: ShieldRing[] = [];
    const litNow = new Set<number>();
    for (const tank of tanks) {
      if (!tank.isAlive || tank.shieldLeft <= 0) {
        continue;
      }
      const share = tank.id === myId ? Math.min(1, tank.shieldLeft / FFA.shieldSeconds) : null;
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
