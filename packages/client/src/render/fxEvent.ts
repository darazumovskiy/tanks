import { EventFlag, type SnapshotEvent } from '@tanks/shared/protocol';
import type { FxAnnouncement, FxEvent, FxEventOptions } from './effects.js';

const DUEL_SHAKE = { shot: 2.5, clash: 6, hit: 9, death: 26 } as const;
const DEATH_SCREEN_FLASH = 0.55;
const QUIET: FxEventOptions = { shake: 0, flash: 0, announcement: null, hasParticles: true };
const DUEL_ANNOUNCEMENT = {
  zoneStart: { kind: 'zoneStart', size: 1, duration: 1 },
  selfHit: { kind: 'selfHit', size: 1, duration: 1 },
  firstBlood: { kind: 'firstBlood', size: 1, duration: 0.5 },
} as const satisfies Readonly<Record<string, FxAnnouncement>>;

function hasFlag(event: SnapshotEvent, flag: number): boolean {
  return (event.flags & flag) !== 0;
}

// Стрелок попадания: противник; свой рикошет — сам танк; урон зоной — никто. Событие смерти дуэли убийцу не несёт.
function shooterOf(event: SnapshotEvent): number | null {
  if (event.kind !== 'hit' || event.side === null) {
    return null;
  }
  if (hasFlag(event, EventFlag.Zone)) {
    return null;
  }
  if (hasFlag(event, EventFlag.Self)) {
    return event.side;
  }
  return event.side === 0 ? 1 : 0;
}

// Событие дуэли → событие эффектов: номер танка — сторона.
export function duelFxEvent(event: SnapshotEvent): FxEvent {
  return {
    kind: event.kind,
    tank: event.side,
    by: shooterOf(event),
    x: event.x,
    y: event.y,
    value: event.value,
    dx: event.dx,
    dy: event.dy,
    flags: event.flags,
  };
}

// Тряска, вспышка экрана и объявления дуэли. Первая кровь — первое попадание раунда не в себя и не зоной.
export class DuelFxPolicy {
  private hasFirstBlood = false;

  reset(): void {
    this.hasFirstBlood = false;
  }

  optionsFor(event: SnapshotEvent): FxEventOptions {
    switch (event.kind) {
      case 'shot':
        return { ...QUIET, shake: DUEL_SHAKE.shot };
      case 'clash':
        return { ...QUIET, shake: DUEL_SHAKE.clash };
      case 'hit':
        return this.hitOptions(event);
      case 'death':
        return { ...QUIET, shake: DUEL_SHAKE.death, flash: DEATH_SCREEN_FLASH };
      case 'zoneStart':
        return { ...QUIET, announcement: DUEL_ANNOUNCEMENT.zoneStart };
      default:
        return QUIET;
    }
  }

  private hitOptions(event: SnapshotEvent): FxEventOptions {
    if (event.side === null || hasFlag(event, EventFlag.Zone)) {
      return QUIET;
    }
    if (hasFlag(event, EventFlag.Self)) {
      return { ...QUIET, shake: DUEL_SHAKE.hit, announcement: DUEL_ANNOUNCEMENT.selfHit };
    }
    if (this.hasFirstBlood) {
      return { ...QUIET, shake: DUEL_SHAKE.hit };
    }
    this.hasFirstBlood = true;
    return { ...QUIET, shake: DUEL_SHAKE.hit, announcement: DUEL_ANNOUNCEMENT.firstBlood };
  }
}
