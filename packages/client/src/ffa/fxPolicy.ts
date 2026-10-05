import { EventFlag, type FfaScoreRow, type FfaSnapshotEvent } from '@tanks/shared/protocol';
import { isInView, type Camera } from '../render/camera.js';
import type { FxEventOptions } from '../render/effects.js';
import type { SoundName } from '../sfx.js';

// Частицы — от событий не дальше этого от окна камеры: дальше их не увидеть, а каждая стоит кадра.
const PARTICLE_MARGIN = 200;
// Тряска и вспышка своих событий — как в дуэли; чужая гибель в кадре трясёт вдвое слабее и без вспышки.
const OWN_SHAKE = { shot: 2.5, hit: 9, death: 26 } as const;
const OWN_DEATH_FLASH = 0.55;
const OTHER_DEATH_SHAKE_SHARE = 0.5;
// Панорама по месту на экране: левый край — слева, правый — справа, не до упора.
const PAN_LIMIT = 0.8;
const FULL_VOLUME = 1;
// Урон зоной приходит каждый тик: шипение — на каждом седьмом, примерно как случайные 15 % в дуэли.
const ZONE_TICK_EVERY = 7;

export interface FfaSound {
  name: SoundName;
  pan: number;
  volume: number;
}

function hasFlag(event: FfaSnapshotEvent, flag: number): boolean {
  return (event.flags & flag) !== 0;
}

// Убийство засчитано стрелку: смерть от снаряда, не свой рикошет и не зона.
function isKill(event: FfaSnapshotEvent): boolean {
  const isSelfOrZone = hasFlag(event, EventFlag.Self) || hasFlag(event, EventFlag.Zone);
  return event.kind === 'death' && event.by !== null && !isSelfOrZone;
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

// Эффекты и звук боя толпы: частицы — у событий возле окна камеры, тряска и вспышка — от своих, объявления — свои
// и общие, звук — только в окне камеры с панорамой по экрану.
export class FfaFxPolicy {
  private hasFirstBlood = false;

  reset(): void {
    this.hasFirstBlood = false;
  }

  // Счёт с убийствами — первая кровь уже пролита: вошедший в идущий матч её не объявит.
  noteScore(rows: readonly FfaScoreRow[]): void {
    if (rows.some((row) => row.kills > 0)) {
      this.hasFirstBlood = true;
    }
  }

  // null — событию нечего показать: далеко за окном и без объявления.
  optionsFor(event: FfaSnapshotEvent, myId: number | null, camera: Camera): FxEventOptions | null {
    const announcement = this.announcementFor(event, myId);
    const hasParticles = isInView(camera, event, PARTICLE_MARGIN);
    if (!hasParticles && announcement === null) {
      return null;
    }
    const isOwn = myId !== null && event.tank === myId;
    const isOtherDeathInView = event.kind === 'death' && !isOwn && isInView(camera, event);
    let shake = 0;
    let flash = 0;
    if (isOwn && event.kind === 'shot') {
      shake = OWN_SHAKE.shot;
    } else if (isOwn && event.kind === 'hit' && !hasFlag(event, EventFlag.Zone)) {
      shake = OWN_SHAKE.hit;
    } else if (isOwn && event.kind === 'death') {
      shake = OWN_SHAKE.death;
      flash = OWN_DEATH_FLASH;
    } else if (isOtherDeathInView) {
      shake = OWN_SHAKE.death * OTHER_DEATH_SHAKE_SHARE;
    }
    return { shake, flash, announcement, hasParticles };
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

  // «ПЕРВАЯ КРОВЬ» — только когда первое убийство матча сделал свой танк; «САМ СЕБЯ!» — своя смерть от своего
  // рикошета; «ЗОНА СУЖАЕТСЯ» — всем.
  private announcementFor(event: FfaSnapshotEvent, myId: number | null): FxEventOptions['announcement'] {
    if (event.kind === 'zoneStart') {
      return 'zoneStart';
    }
    const isFirstKill = this.noteKill(event);
    if (event.kind !== 'death' || myId === null) {
      return null;
    }
    if (event.tank === myId && hasFlag(event, EventFlag.Self)) {
      return 'selfHit';
    }
    return isFirstKill && event.by === myId ? 'firstBlood' : null;
  }

  // true — это первое убийство матча.
  private noteKill(event: FfaSnapshotEvent): boolean {
    if (!isKill(event) || this.hasFirstBlood) {
      return false;
    }
    this.hasFirstBlood = true;
    return true;
  }
}
