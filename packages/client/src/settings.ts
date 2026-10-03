// Настройки ощущения игры на устройстве: читаются вводом и рендером каждый тик, меняются из панели в бою,
// хранятся в localStorage. Умолчания подобраны Димой на Xiaomi 14T Pro (2026-10-03).
export interface Settings {
  stickRadiusPx: number;
  deadZone: number;
  fireRing: number;
  minViewPercent: number;
  cameraLagMs: number;
  zoomLagMs: number;
  showFrameGraph: boolean;
}

export type NumericSettingKey = Exclude<keyof Settings, 'showFrameGraph'>;

export interface NumericSettingField {
  key: NumericSettingKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  stickRadiusPx: 40,
  deadZone: 0.07,
  fireRing: 0.89,
  minViewPercent: 75,
  cameraLagMs: 300,
  zoomLagMs: 600,
  showFrameGraph: false,
};

export const NUMERIC_FIELDS: readonly NumericSettingField[] = [
  { key: 'stickRadiusPx', label: 'Размер стика', hint: 'радиус круга, px', min: 40, max: 110, step: 2 },
  { key: 'deadZone', label: 'Мёртвая зона', hint: 'доля радиуса без реакции', min: 0, max: 0.5, step: 0.01 },
  { key: 'fireRing', label: 'Кольцо огня', hint: 'доля радиуса, с которой стреляет', min: 0.5, max: 1, step: 0.01 },
  {
    key: 'minViewPercent',
    label: 'Максимальное приближение',
    hint: '% высоты поля в кадре при самом близком подъезде камеры; больше — дальше (только телефон)',
    min: 50,
    max: 100,
    step: 5,
  },
  { key: 'cameraLagMs', label: 'Догон камеры', hint: 'мс до середины пути; 0 — мгновенно', min: 0, max: 500, step: 10 },
  {
    key: 'zoomLagMs',
    label: 'Плавность приближения',
    hint: 'мс до середины пути при приближении; отдаление вдвое быстрее',
    min: 0,
    max: 2000,
    step: 50,
  },
];

export const SETTINGS_STORAGE_KEY = 'tanks.settings';

function clampField(field: NumericSettingField, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS[field.key];
  }
  return Math.min(field.max, Math.max(field.min, value));
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
  if (typeof record.showFrameGraph === 'boolean') {
    settings.showFrameGraph = record.showFrameGraph;
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

  setShowFrameGraph(isShown: boolean): void {
    this.value.showFrameGraph = isShown;
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
