import { replayFfaJournal, type FfaJournalMatch } from '@tanks/shared/protocol';

const HUMAN_JOIN = /^\S+ S gt=\d+ tc=\S+ join id=\d+ nick=(.*) bot=0$/;

export interface FfaMatchSummary {
  index: number;
  ticks: number;
  sums: number;
  mismatches: number;
  firstMismatchTick: number | null;
  isComplete: boolean;
}

export interface FfaGameSummary {
  id: string;
  size: number;
  humans: string[];
  matches: FfaMatchSummary[];
}

function matchSummary(match: FfaJournalMatch): FfaMatchSummary {
  return {
    index: match.index,
    ticks: match.ticks,
    sums: match.sums,
    mismatches: match.mismatches.length,
    firstMismatchTick: match.mismatches[0]?.tick ?? null,
    isComplete: match.isComplete,
  };
}

// Журнал боя толпы прогоняется движком; null — это не журнал боя толпы.
export function analyzeFfaLog(id: string, text: string): FfaGameSummary | null {
  const lines = text.split('\n');
  const replay = replayFfaJournal(lines);
  if (replay.size === null) {
    return null;
  }
  const humans = new Set<string>();
  for (const line of lines) {
    const nick = HUMAN_JOIN.exec(line)?.[1];
    if (nick !== undefined) {
      humans.add(nick);
    }
  }
  return { id, size: replay.size, humans: [...humans], matches: replay.matches.map(matchSummary) };
}
