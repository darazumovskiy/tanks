import { PHONE_CAMERA_MODES, type PhoneCameraMode } from './render/cameraStrategy.js';

// Настройки ощущения игры на устройстве: читаются вводом и рендером каждый тик, меняются из панели в бою,
// хранятся в localStorage. Умолчания стиков подобраны Димой на Xiaomi 14T Pro (2026-10-03).
export interface Settings {
  stickRadiusPx: number;
  deadZone: number;
  hasFireRing: boolean;
  fireRing: number;
  cameraMode: PhoneCameraMode;
  minViewPercent: number;
  followLookAhead: number;
  followLagMs: number;
  pairLagMs: number;
  zoomLagMs: number;
  pairVoidPercent: number;
  showFrameGraph: boolean;
}

export type BooleanSettingKey = 'hasFireRing' | 'showFrameGraph';
export type NumericSettingKey = Exclude<keyof Settings, BooleanSettingKey | 'cameraMode'>;

export interface BooleanSettingField {
  key: BooleanSettingKey;
  label: string;
  hint: string;
}

// Поле с `modes` — настройка камеры: показывается только на устройстве с касанием и только для перечисленных
// стратегий. Поле с `requiresFlag` показывается, пока включён указанный флажок.
export interface NumericSettingField {
  key: NumericSettingKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  modes?: readonly PhoneCameraMode[];
  requiresFlag?: BooleanSettingKey;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  stickRadiusPx: 40,
  deadZone: 0.07,
  hasFireRing: false,
  fireRing: 0.89,
  cameraMode: 'follow',
  minViewPercent: 75,
  followLookAhead: 0.35,
  followLagMs: 120,
  pairLagMs: 300,
  zoomLagMs: 600,
  pairVoidPercent: 25,
  showFrameGraph: false,
};

export const BOOLEAN_FIELDS: readonly BooleanSettingField[] = [
  {
    key: 'hasFireRing',
    label: 'Кольцо огня',
    hint: 'стрелять только у края правого стика; без кольца стреляет любое касание правой половины',
  },
  { key: 'showFrameGraph', label: 'График кадров', hint: 'длительность последних кадров внизу слева' },
];

export const NUMERIC_FIELDS: readonly NumericSettingField[] = [
  { key: 'stickRadiusPx', label: 'Размер стика', hint: 'радиус круга, px', min: 40, max: 110, step: 2 },
  { key: 'deadZone', label: 'Мёртвая зона', hint: 'доля радиуса без реакции', min: 0, max: 0.5, step: 0.01 },
  {
    key: 'fireRing',
    label: 'Радиус кольца огня',
    hint: 'доля радиуса стика, с которой стреляет',
    min: 0.5,
    max: 1,
    step: 0.01,
    requiresFlag: 'hasFireRing',
  },
  {
    key: 'minViewPercent',
    label: 'Обзор',
    hint: '% высоты поля в кадре: «за своим» — постоянно, с отдалением и «оба в кадре» — на ближнем уровне',
    min: 50,
    max: 100,
    step: 5,
    modes: PHONE_CAMERA_MODES.map((entry) => entry.mode),
  },
  {
    key: 'followLookAhead',
    label: 'Упреждение к противнику',
    hint: 'доля расстояния до противника, на которую окно сдвигается к нему; 0 — танк всегда в точке покоя',
    min: 0,
    max: 0.6,
    step: 0.05,
    modes: ['follow', 'followZoom'],
  },
  {
    key: 'followLagMs',
    label: 'Догон камеры',
    hint: 'мс до середины пути; 0 — мгновенно',
    min: 0,
    max: 500,
    step: 10,
    modes: ['follow', 'followZoom'],
  },
  {
    key: 'pairLagMs',
    label: 'Догон камеры',
    hint: 'мс до середины пути; 0 — мгновенно',
    min: 0,
    max: 500,
    step: 10,
    modes: ['pair'],
  },
  {
    key: 'zoomLagMs',
    label: 'Плавность приближения',
    hint: 'мс до середины пути при приближении; отдаление вдвое быстрее',
    min: 0,
    max: 2000,
    step: 50,
    modes: ['followZoom', 'pair'],
  },
  {
    key: 'pairVoidPercent',
    label: 'Пустота за полем',
    hint: '% экрана, на который окно может выйти за поле ради центра пары; дальше — только чтобы оба танка остались в кадре',
    min: 0,
    max: 50,
    step: 5,
    modes: ['pair'],
  },
];

export const SETTINGS_STORAGE_KEY = 'tanks.settings';

function clampField(field: NumericSettingField, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS[field.key];
  }
  return Math.min(field.max, Math.max(field.min, value));
}

function parseCameraMode(value: unknown): PhoneCameraMode {
  const known = PHONE_CAMERA_MODES.find((entry) => entry.mode === value);
  return known === undefined ? DEFAULT_SETTINGS.cameraMode : known.mode;
}

export function parseSettings(raw: string | null): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  if (raw === null) {
    return settings;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return settings;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return settings;
  }
  const record = parsed as Record<string, unknown>;
  for (const field of NUMERIC_FIELDS) {
    settings[field.key] = clampField(field, record[field.key]);
  }
  settings.cameraMode = parseCameraMode(record.cameraMode);
  for (const field of BOOLEAN_FIELDS) {
    const value = record[field.key];
    if (typeof value === 'boolean') {
      settings[field.key] = value;
    }
  }
  return settings;
}

export class SettingsStore {
  readonly value: Settings;

  constructor(private readonly storage: Storage) {
    this.value = parseSettings(storage.getItem(SETTINGS_STORAGE_KEY));
  }

  setNumber(key: NumericSettingKey, value: number): void {
    const field = NUMERIC_FIELDS.find((candidate) => candidate.key === key);
    if (field === undefined) {
      return;
    }
    this.value[key] = clampField(field, value);
    this.save();
  }

  setCameraMode(mode: PhoneCameraMode): void {
    this.value.cameraMode = mode;
    this.save();
  }

  setFlag(key: BooleanSettingKey, isOn: boolean): void {
    this.value[key] = isOn;
    this.save();
  }

  reset(): void {
    Object.assign(this.value, DEFAULT_SETTINGS);
    this.save();
  }

  private save(): void {
    this.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.value));
  }
}
