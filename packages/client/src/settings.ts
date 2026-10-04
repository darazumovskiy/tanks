import { DEFAULT_AIM_LINE_STYLE_ID, isAimLineStyleId, type AimLineStyleId } from './render/aimLineStyles.js';
import { PHONE_CAMERA_MODES, type PhoneCameraMode } from './render/cameraStrategy.js';

// Настройки ощущения игры на устройстве: читаются вводом и рендером каждый тик, меняются из панели в бою,
// хранятся в localStorage. Умолчания стиков подобраны Димой на Xiaomi 14T Pro (2026-10-03).
export interface Settings {
  stickRadiusPx: number;
  deadZone: number;
  pivotThrottle: number;
  hasFireRing: boolean;
  fireRing: number;
  hasRicochetGuard: boolean;
  hasAimLine: boolean;
  aimLineStyle: AimLineStyleId;
  hasLeadHint: boolean;
  hasZoneFire: boolean;
  cameraMode: PhoneCameraMode;
  minViewPercent: number;
  followLookAhead: number;
  followLagMs: number;
  pairLagMs: number;
  zoomLagMs: number;
  pairVoidPercent: number;
  showFrameGraph: boolean;
}

export type BooleanSettingKey =
  'hasFireRing' | 'hasRicochetGuard' | 'hasAimLine' | 'hasLeadHint' | 'hasZoneFire' | 'showFrameGraph';
export type NumericSettingKey = Exclude<keyof Settings, BooleanSettingKey | 'cameraMode' | 'aimLineStyle'>;

// Флажок с `isTouchOnly` показывается только на устройстве с касанием: настройка касается стиков.
// Флажок с `isAdminOnly` — только в админ-режиме; без права его значение читается как выключенное.
export interface BooleanSettingField {
  key: BooleanSettingKey;
  label: string;
  hint: string;
  isTouchOnly?: boolean;
  isAdminOnly?: boolean;
}

export interface SettingsAccess {
  isAdmin: boolean;
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

// Умолчания — настройки Димы из боевых игр 2026-10-04 (журнал 4SFJ): стик 54 px, разворот 0,6, предохранитель включён,
// прицел «Точки», обзор 85 %, упреждение камеры 0,4, догон 410 мс. Одинаковы для телефона и компьютера.
export function defaultSettings(): Settings {
  return {
    stickRadiusPx: 54,
    deadZone: 0.07,
    pivotThrottle: 0.6,
    hasFireRing: false,
    fireRing: 0.89,
    hasRicochetGuard: true,
    hasAimLine: true,
    aimLineStyle: DEFAULT_AIM_LINE_STYLE_ID,
    hasLeadHint: false,
    hasZoneFire: false,
    cameraMode: 'follow',
    minViewPercent: 85,
    followLookAhead: 0.4,
    followLagMs: 410,
    pairLagMs: 300,
    zoomLagMs: 600,
    pairVoidPercent: 25,
    showFrameGraph: false,
  };
}

export const BOOLEAN_FIELDS: readonly BooleanSettingField[] = [
  {
    key: 'hasFireRing',
    label: 'Кольцо огня',
    hint: 'стрелять только у края правого стика; без кольца стреляет любое касание правой половины',
  },
  {
    key: 'hasRicochetGuard',
    label: 'Предохранитель',
    hint: 'не стреляет, если снаряд отскочит в тебя же; доверни башню — выстрелит',
  },
  {
    key: 'hasAimLine',
    label: 'Линия выстрела',
    hint: 'куда полетит снаряд и куда отскочит; ловит противника — подсвечивается',
  },
  { key: 'showFrameGraph', label: 'График кадров', hint: 'длительность последних кадров внизу слева' },
  {
    key: 'hasLeadHint',
    label: 'Подсказка упреждения',
    hint: 'линия подсвечивается и там, где противник окажется к прилёту снаряда',
    isAdminOnly: true,
  },
  {
    key: 'hasZoneFire',
    label: 'Огонь по цели',
    hint: 'стреляет, только когда линия проходит через противника или туда, куда он едет; короткий тап — всегда',
    isTouchOnly: true,
    isAdminOnly: true,
  },
];

export const NUMERIC_FIELDS: readonly NumericSettingField[] = [
  { key: 'stickRadiusPx', label: 'Размер стика', hint: 'радиус круга, px', min: 40, max: 110, step: 2 },
  { key: 'deadZone', label: 'Мёртвая зона', hint: 'доля радиуса без реакции', min: 0, max: 0.5, step: 0.01 },
  {
    key: 'pivotThrottle',
    label: 'Разворот',
    hint: 'сколько хода танк держит в повороте: 0 — крутится на месте, 1 — не сбавляет и идёт широкой дугой',
    min: 0,
    max: 1,
    step: 0.05,
  },
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

function clampField(field: NumericSettingField, value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(field.max, Math.max(field.min, value));
}

function parseCameraMode(value: unknown, fallback: PhoneCameraMode): PhoneCameraMode {
  const known = PHONE_CAMERA_MODES.find((entry) => entry.mode === value);
  return known === undefined ? fallback : known.mode;
}

// Без права админские флаги читаются выключенными: запись в хранилище без админ-режима не включает фичу.
export function parseSettings(raw: string | null, defaults: Readonly<Settings>, access: SettingsAccess): Settings {
  const settings = parseStored(raw, defaults);
  if (access.isAdmin) {
    return settings;
  }
  for (const field of BOOLEAN_FIELDS) {
    if (field.isAdminOnly === true) {
      settings[field.key] = false;
    }
  }
  return settings;
}

function parseStored(raw: string | null, defaults: Readonly<Settings>): Settings {
  const settings: Settings = { ...defaults };
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
    settings[field.key] = clampField(field, record[field.key], defaults[field.key]);
  }
  settings.cameraMode = parseCameraMode(record.cameraMode, defaults.cameraMode);
  settings.aimLineStyle = isAimLineStyleId(record.aimLineStyle) ? record.aimLineStyle : defaults.aimLineStyle;
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
  readonly isAdmin: boolean;

  constructor(
    private readonly storage: Storage,
    private readonly defaults: Readonly<Settings>,
    access: SettingsAccess,
  ) {
    this.isAdmin = access.isAdmin;
    this.value = parseSettings(storage.getItem(SETTINGS_STORAGE_KEY), defaults, access);
  }

  setNumber(key: NumericSettingKey, value: number): void {
    const field = NUMERIC_FIELDS.find((candidate) => candidate.key === key);
    if (field === undefined) {
      return;
    }
    this.value[key] = clampField(field, value, this.defaults[key]);
    this.save();
  }

  setCameraMode(mode: PhoneCameraMode): void {
    this.value.cameraMode = mode;
    this.save();
  }

  setAimLineStyle(id: AimLineStyleId): void {
    this.value.aimLineStyle = id;
    this.save();
  }

  setFlag(key: BooleanSettingKey, isOn: boolean): void {
    this.value[key] = isOn;
    this.save();
  }

  reset(): void {
    Object.assign(this.value, this.defaults);
    this.save();
  }

  private save(): void {
    this.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.value));
  }
}
