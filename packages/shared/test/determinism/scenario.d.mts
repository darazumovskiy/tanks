export interface ScheduledAction {
  throttle: number;
  turn: number;
  turretTurn: number;
  fire: boolean;
}

export interface Scenario {
  mapIndex: number;
  seed: number;
  fireChance: number;
  stats: [Record<string, number>, Record<string, number>];
}

export const SCENARIOS: Scenario[];
export const MAX_TICKS: number;
export function buildSchedule(seed: number, ticks: number, fireChance: number): [ScheduledAction, ScheduledAction][];
export function digest(snapshot: unknown, eventTypes: string[]): string;
