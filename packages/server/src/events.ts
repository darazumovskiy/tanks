import type { RoundEvent } from '@tanks/shared/engine';
import { EventFlag, type SnapshotEvent } from '@tanks/shared/protocol';

function plain(
  kind: SnapshotEvent['kind'],
  side: SnapshotEvent['side'],
  x: number,
  y: number,
  value = 0,
  dx = 0,
  dy = 0,
  flags = 0,
): SnapshotEvent {
  return { kind, side, x, y, value, dx, dy, flags };
}

// Событие движка → компактное событие снимка для эффектов и звука на клиенте.
export function toSnapshotEvent(event: RoundEvent): SnapshotEvent {
  switch (event.type) {
    case 'shot':
      return plain('shot', event.side, event.x, event.y, event.angle, Math.cos(event.angle), Math.sin(event.angle));
    case 'impact':
    case 'fizzle':
      return plain(event.type, event.owner, event.x, event.y);
    case 'ricochet':
      return plain('ricochet', event.owner, event.x, event.y, 0, event.nx, event.ny);
    case 'clash':
      return plain('clash', null, event.x, event.y);
    case 'hit': {
      let flags = 0;
      if (event.cause === 'self') {
        flags |= EventFlag.Self;
      }
      if (event.cause === 'zone') {
        flags |= EventFlag.Zone;
      }
      if (event.isRicochet === true) {
        flags |= EventFlag.Ricochet;
      }
      const x = event.bulletX ?? event.x;
      const y = event.bulletY ?? event.y;
      return plain('hit', event.side, x, y, event.damage, event.dirX ?? 0, event.dirY ?? 0, flags);
    }
    case 'death':
    case 'bump':
      return plain(event.type, event.side, event.x, event.y);
    case 'kitSpawn':
      return plain('kitSpawn', null, event.x, event.y);
    case 'pickup':
      return plain('pickup', event.side, event.x, event.y, event.healed);
    case 'zoneStart':
      return plain('zoneStart', null, 0, 0);
    case 'roundOver':
      return plain('roundOver', event.winner, 0, 0, 0, 0, 0, event.reason === 'time' ? EventFlag.ByTime : 0);
  }
}
