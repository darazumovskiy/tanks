import type { DamageCause, FfaEvent } from '../engine/index.js';
import { EventFlag, type FfaSnapshotEvent } from './messages.js';

function plain(
  kind: FfaSnapshotEvent['kind'],
  tank: number | null,
  by: number | null,
  x = 0,
  y = 0,
  value = 0,
  dx = 0,
  dy = 0,
  flags = 0,
): FfaSnapshotEvent {
  return { kind, tank, by, x, y, value, dx, dy, flags };
}

function causeFlags(cause: DamageCause, isRicochet: boolean): number {
  let flags = 0;
  if (cause === 'self') {
    flags |= EventFlag.Self;
  }
  if (cause === 'zone') {
    flags |= EventFlag.Zone;
  }
  if (isRicochet) {
    flags |= EventFlag.Ricochet;
  }
  return flags;
}

// Событие матча → событие снимка: эффекты, звук, лента убийств.
export function toFfaSnapshotEvent(event: FfaEvent): FfaSnapshotEvent {
  switch (event.type) {
    case 'shot':
      return plain(
        'shot',
        event.tank,
        null,
        event.x,
        event.y,
        event.angle,
        Math.cos(event.angle),
        Math.sin(event.angle),
      );
    case 'impact':
    case 'fizzle':
      return plain(event.type, event.owner, null, event.x, event.y);
    case 'ricochet':
      return plain('ricochet', event.owner, null, event.x, event.y, 0, event.nx, event.ny);
    case 'clash':
    case 'kitSpawn':
      return plain(event.type, null, null, event.x, event.y);
    case 'hit':
      return plain(
        'hit',
        event.tank,
        event.by ?? null,
        event.bulletX ?? event.x,
        event.bulletY ?? event.y,
        event.damage,
        event.dirX ?? 0,
        event.dirY ?? 0,
        causeFlags(event.cause, event.isRicochet === true),
      );
    case 'shield':
      return plain('shield', event.tank, event.owner, event.x, event.y);
    case 'death':
      return plain('death', event.tank, event.by, event.x, event.y, 0, 0, 0, causeFlags(event.cause, event.isRicochet));
    case 'bump':
    case 'spawn':
      return plain(event.type, event.tank, null, event.x, event.y);
    case 'pickup':
      return plain('pickup', event.tank, null, event.x, event.y, event.healed);
    case 'zoneStart':
    case 'suddenDeath':
    case 'matchOver':
      return plain(event.type, null, null);
  }
}
