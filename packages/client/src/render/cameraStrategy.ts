import { ARENA } from '@tanks/shared/engine';
import type { Settings } from '../settings.js';
import { frameCamera, type Camera, type Point } from './camera.js';
import { FollowCamera } from './cameraFollow.js';
import { PairCamera } from './cameraPair.js';

// Режимы камеры на телефоне — выбирает игрок; `field` — компьютер, поле целиком.
export type PhoneCameraMode = 'follow' | 'followZoom' | 'pair';
export type CameraMode = PhoneCameraMode | 'field';

export const PHONE_CAMERA_MODES: readonly { mode: PhoneCameraMode; label: string }[] = [
  { mode: 'follow', label: 'За своим' },
  { mode: 'followZoom', label: 'За своим + отдаление' },
  { mode: 'pair', label: 'Оба в кадре' },
];

export interface CameraInput {
  me: Point;
  enemy: Point | null;
  canvasWidth: number;
  canvasHeight: number;
}

export interface CameraStrategy {
  update(input: CameraInput, dtMs: number): Camera;
  // Новый раунд: первый кадр после сброса — установившееся состояние, без проезда через поле.
  reset(): void;
  // Смена стратегии посреди боя: продолжить с окна предыдущей, чтобы камера переехала, а не прыгнула.
  adopt(camera: Camera): void;
}

class FieldCamera implements CameraStrategy {
  update(input: CameraInput): Camera {
    return frameCamera(
      { x: ARENA.width / 2, y: ARENA.height / 2 },
      input.canvasWidth,
      input.canvasHeight,
      ARENA.height,
    );
  }

  // Поле целиком неподвижно: ни сброса, ни продолжения с чужого окна не требуется.
  reset(): void {
    return;
  }

  adopt(): void {
    return;
  }
}

export function createCameraStrategy(mode: CameraMode, settings: Readonly<Settings>): CameraStrategy {
  if (mode === 'follow' || mode === 'followZoom') {
    return new FollowCamera(settings, mode === 'followZoom');
  }
  if (mode === 'pair') {
    return new PairCamera(settings);
  }
  return new FieldCamera();
}
