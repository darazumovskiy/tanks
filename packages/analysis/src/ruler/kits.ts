// Аптечка ближе по пути мне или противнику.
export const KIT_SIDES = ['closer', 'farther'] as const;
export type KitSide = (typeof KIT_SIDES)[number];
