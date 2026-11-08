import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { Lexicon, type Play } from "./lexicon.js";
import {
  chooseTournamentPlays,
  decideTournamentBid,
  type BidContext,
} from "./strategy.js";

export interface TurnRequest {
  position: Omit<BidContext, "lexicon">;
  playWords: boolean;
}

export interface TurnPlan {
  plays: Play[];
  bid: number;
}

if (!parentPort) throw new Error("Turn search must run in a worker");
const port = parentPort;
const lexicon = new Lexicon(
  readFileSync(
    new URL("../../spacetimedb/wordlist.txt", import.meta.url),
    "utf8",
  ).split(/\r?\n/),
);

port.on("message", ({ position, playWords }: TurnRequest) => {
  const rack = new Map(position.myRack);
  const ctx = { ...position, myRack: rack, lexicon };
  const plays: Play[] = [];
  if (playWords) {
    for (;;) {
      const next = chooseTournamentPlays(ctx);
      if (!next.length) break;
      for (const play of next) {
        for (const letter of play.word)
          rack.set(letter, (rack.get(letter) ?? 0) - 1);
        ctx.myBalance += play.score;
        plays.push(play);
      }
    }
  }
  port.postMessage({ plays, bid: decideTournamentBid(ctx) } satisfies TurnPlan);
});
