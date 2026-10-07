const NEAR_DISTANCE = 300;
export const FAR_DISTANCE = 600;
export const MID_DISTANCE_LABEL = '300–600';
export const DISTANCE_BUCKET_LABELS = ['<300', MID_DISTANCE_LABEL, '>600'] as const;
export type DistanceBucketLabel = (typeof DISTANCE_BUCKET_LABELS)[number];

export interface DistanceBucket {
  low: number;
  high: number;
  label: DistanceBucketLabel;
}

export const DISTANCE_BUCKETS: readonly DistanceBucket[] = [
  { low: 0, high: NEAR_DISTANCE, label: '<300' },
  { low: NEAR_DISTANCE, high: FAR_DISTANCE, label: MID_DISTANCE_LABEL },
  { low: FAR_DISTANCE, high: Infinity, label: '>600' },
];

export function distanceBucketOf(distance: number): DistanceBucketLabel {
  if (distance < NEAR_DISTANCE) {
    return '<300';
  }
  return distance < FAR_DISTANCE ? MID_DISTANCE_LABEL : '>600';
}

// Корзины дистанции для угла хода к линии на противника — по 100 от 200 до 800: угол человека меняется с
// дистанцией круче, чем видно в трёх корзинах огня.
export const COURSE_BAND_LABELS = [
  '<200',
  '200–300',
  '300–400',
  '400–500',
  '500–600',
  '600–700',
  '700–800',
  '>800',
] as const;
export type CourseBandLabel = (typeof COURSE_BAND_LABELS)[number];

export interface CourseBand {
  low: number;
  high: number;
  label: CourseBandLabel;
}

const COURSE_BAND_FIRST_EDGE = 200;
const COURSE_BAND_WIDTH = 100;

export const COURSE_BANDS: readonly CourseBand[] = COURSE_BAND_LABELS.map((label, index) => ({
  low: index === 0 ? 0 : COURSE_BAND_FIRST_EDGE + (index - 1) * COURSE_BAND_WIDTH,
  high: index === COURSE_BAND_LABELS.length - 1 ? Infinity : COURSE_BAND_FIRST_EDGE + index * COURSE_BAND_WIDTH,
  label,
}));

export function courseBandOf(distance: number): CourseBandLabel {
  return COURSE_BANDS.find((band) => distance < band.high)?.label ?? '>800';
}

// Контекст огня — видимость противника и корзина дистанции.
export const FIRE_CONTEXTS = [
  'visible|<300',
  'visible|300–600',
  'visible|>600',
  'hidden|<300',
  'hidden|300–600',
  'hidden|>600',
] as const;
export type FireContext = (typeof FIRE_CONTEXTS)[number];
