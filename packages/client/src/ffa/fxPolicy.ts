import { EventFlag, type FfaSnapshotEvent } from '@tanks/shared/protocol';
import { isInView, type Camera } from '../render/camera.js';
import type { FxAnnouncement, FxEventOptions } from '../render/effects.js';
import type { SoundName } from '../sfx.js';

// Частицы — от событий не дальше этого от окна камеры: дальше их не увидеть, а каждая стоит кадра.
const PARTICLE_MARGIN = 200;
// Панорама по месту на экране: левый край — слева, правый — справа, не до упора.
const PAN_LIMIT = 0.8;
const FULL_VOLUME = 1;
// Урон зоной приходит каждый тик: шипение — на каждом седьмом, примерно как случайные 15 % в дуэли.
const ZONE_TICK_EVERY = 7;
const FFA_ANNOUNCEMENT = {
  zoneStart: { kind: 'zoneStart', size: 1, duration: 1 },
  selfHit: { kind: 'selfHit', size: 1 / 1.5, duration: 0.7 },
} as const satisfies Readonly<Record<string, FxAnnouncement>>;

export interface FfaSound {
  name: SoundName;
  pan: number;
  volume: number;
}

function hasFlag(event: FfaSnapshotEvent, flag: number): boolean {
  return (event.flags & flag) !== 0;
}

function soundNameOf(event: FfaSnapshotEvent, tick: number): SoundName | null {
  switch (event.kind) {
    case 'shot':
    case 'ricochet':
    case 'impact':
    case 'death':
    case 'clash':
    case 'pickup':
      return event.kind;
    case 'hit':
      if (!hasFlag(event, EventFlag.Zone)) {
        return 'hit';
      }
      return tick % ZONE_TICK_EVERY === 0 ? 'zoneTick' : null;
    default:
      return null;
  }
}

// «ЗОНА СУЖАЕТСЯ» — всем; «САМ СЕБЯ!» — своя смерть от своего рикошета.
function announcementFor(event: FfaSnapshotEvent, myId: number | null): FxAnnouncement | null {
  if (event.kind === 'zoneStart') {
    return FFA_ANNOUNCEMENT.zoneStart;
  }
  const isOwnDeath = event.kind === 'death' && myId !== null && event.tank === myId;
  if (isOwnDeath && hasFlag(event, EventFlag.Self)) {
    return FFA_ANNOUNCEMENT.selfHit;
  }
  return null;
}

// Эффекты и звук боя толпы: частицы — у событий возле окна камеры, объявления — свои и общие, свой фраг — над
// убитым, звук — только в окне камеры с панорамой по экрану. Тряски и вспышки экрана нет: в толпе они только мешают.
export class FfaFxPolicy {
  // ownKillCount — номер своего убийства для гибели от своего выстрела, иначе null. Результат null — событию нечего
  // показать: далеко за окном и без объявления.
  optionsFor(
    event: FfaSnapshotEvent,
    myId: number | null,
    camera: Camera,
    ownKillCount: number | null,
  ): FxEventOptions | null {
    const announcement = announcementFor(event, myId);
    const hasParticles = isInView(camera, event, PARTICLE_MARGIN);
    if (!hasParticles && announcement === null) {
      return null;
    }
    return { shake: 0, flash: 0, announcement, hasParticles, ownKillCount };
  }

  soundFor(event: FfaSnapshotEvent, camera: Camera, tick: number): FfaSound | null {
    if (event.kind === 'zoneStart') {
      return { name: 'alarm', pan: 0, volume: FULL_VOLUME };
    }
    if (!isInView(camera, event)) {
      return null;
    }
    const name = soundNameOf(event, tick);
    if (name === null) {
      return null;
    }
    const share = (event.x - camera.x) / camera.width;
    return { name, pan: -PAN_LIMIT + 2 * PAN_LIMIT * share, volume: FULL_VOLUME };
  }
}
