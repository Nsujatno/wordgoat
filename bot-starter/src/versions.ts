export interface LiveMatch {
  id: number;
  place: number;
  score: number;
  bestRivalScore: number;
}

export interface BotVersion {
  id: string;
  commit: string;
  description: string;
  liveMatches: readonly LiveMatch[];
}

// Each version points to the exact committed strategy and lexicon that ran.
// Match-to-version assignments come from the operator's reported test groups.
export const botVersions: readonly BotVersion[] = [
  {
    id: "v1",
    commit: "082789082a446c41d0cff8c7bdff8f48d4998e11",
    description:
      "Rack-equity bidding, seven-letter bonuses, and final cash-out",
    liveMatches: [
      { id: 42798, place: 3, score: 69, bestRivalScore: 126 },
      { id: 42801, place: 3, score: 108, bestRivalScore: 150 },
      { id: 42804, place: 2, score: 73, bestRivalScore: 111 },
      { id: 42807, place: 3, score: 87, bestRivalScore: 118 },
      { id: 42810, place: 2, score: 92, bestRivalScore: 114 },
    ],
  },
  {
    id: "v2",
    commit: "96462d6d53565c8dbd846de4187ac1bd1a20810a",
    description:
      "More selective Vickrey bidding and larger payouts before refilling the rack",
    liveMatches: [
      { id: 42871, place: 1, score: 118, bestRivalScore: 109 },
      { id: 42874, place: 2, score: 86, bestRivalScore: 100 },
      { id: 42877, place: 1, score: 146, bestRivalScore: 93 },
      { id: 42880, place: 3, score: 85, bestRivalScore: 93 },
      { id: 42884, place: 1, score: 94, bestRivalScore: 91 },
      { id: 42887, place: 3, score: 77, bestRivalScore: 142 },
    ],
  },
];
