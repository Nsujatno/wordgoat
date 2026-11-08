import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  ALPHABET,
  BAG_COUNTS,
  Lexicon,
  cashOut,
  rackCounts,
} from "./lexicon.js";
import { choosePlays, decideBid, type BidObservation } from "./strategy.js";
import { loadStrategy } from "./benchmark.js";
import { botVersions } from "./versions.js";

// Public, finished-match data only. No token or private holding table is used.
interface SqlTable {
  schema: { elements: { name: { some: string } }[] };
  rows: unknown[][];
}
const raw = JSON.parse(
  readFileSync(new URL("../analysis/v3-replays.json", import.meta.url), "utf8"),
);
function rows<T>(name: string): T[] {
  const table: SqlTable = Array.isArray(raw[name]) ? raw[name][0] : raw[name];
  return table.rows.map(
    (row) =>
      Object.fromEntries(
        table.schema.elements.map((column, i) => [column.name.some, row[i]]),
      ) as T,
  );
}
interface Match {
  id: number;
  starting_rack_size: number;
  auction_type: [number, unknown];
}
interface Result {
  auction_id: number;
  match_id: number;
  letter: string;
  winner_bot_id: [number, number?];
  paid: number;
  closed_at: [number];
}
interface Word {
  match_id: number;
  bot_id: number;
  word: string;
  total_reward: number;
  played_at: [number];
}
interface Participant {
  match_id: number;
  bot_id: number;
  score: number;
  balance: number;
}
const bots = rows<{ id: number; name: string }>("bot");
const botId = bots.find((bot) => bot.name.toLowerCase() === "wordgoat")!.id;
const dictionary = readFileSync(
  new URL("../../spacetimedb/wordlist.txt", import.meta.url),
  "utf8",
).split(/\r?\n/);
const lexicon = new Lexicon(dictionary);
const label = (counts: number[]) =>
  counts.map((n, i) => ALPHABET[i].repeat(n)).join("");
const summaries = [];
const baseline = await loadStrategy(
  botVersions.find((v) => v.id === "v3")!.commit,
);
const archive = new Map(
  rows<{ auction_id: number; top_bid: number }>("auction_top_bid_archive").map(
    (r) => [r.auction_id, r.top_bid],
  ),
);
for (const match of rows<Match>("match_state").sort((a, b) => a.id - b.id)) {
  assert.equal(
    match.auction_type[0],
    1,
    "This recorded batch uses Vickrey auctions",
  );
  const results = rows<Result>("auction_result")
    .filter((r) => r.match_id === match.id)
    .sort((a, b) => a.auction_id - b.auction_id);
  const words = rows<Word>("word_play")
    .filter((w) => w.match_id === match.id && w.bot_id === botId)
    .sort((a, b) => a.played_at[0] - b.played_at[0]);
  const standings = rows<Participant>("match_participant")
    .filter((p) => p.match_id === match.id)
    .sort((a, b) => b.score - a.score);
  const me = standings.find((p) => p.bot_id === botId)!;
  const events = [
    ...results
      .filter((r) => r.winner_bot_id[1] === botId)
      .map((r) => ({ time: r.closed_at[0], tiles: r.letter, delta: 1 })),
    ...words.map((w) => ({ time: w.played_at[0], tiles: w.word, delta: -1 })),
  ].sort((a, b) => a.time - b.time);
  // Maximum prefix deficit is the minimum initial count of each letter.
  // It is exact only when the counts sum to the recorded starting rack size.
  const initial = Array<number>(26).fill(0);
  const running = Array<number>(26).fill(0);
  for (const event of events)
    for (const tile of event.tiles) {
      const i = ALPHABET.indexOf(tile);
      running[i] += event.delta;
      initial[i] = Math.max(initial[i], -running[i]);
    }
  const exact = initial.reduce((a, b) => a + b, 0) === match.starting_rack_size;
  assert.ok(
    exact,
    `Starting rack is ambiguous in ${match.id}; do not invent missing tiles`,
  );
  const rack = new Map(Array.from(ALPHABET, (tile, i) => [tile, initial[i]]));
  const drawn = Array<number>(26).fill(0);
  const market: BidObservation[] = [];
  let balance = 100;
  let wordIndex = 0;
  const turns = [];
  for (const [round, result] of results.entries()) {
    const plays: string[] = [];
    while (
      wordIndex < words.length &&
      words[wordIndex].played_at[0] < result.closed_at[0]
    ) {
      const word = words[wordIndex++];
      for (const tile of word.word) rack.set(tile, rack.get(tile)! - 1);
      balance += word.total_reward;
      plays.push(`${word.word}:${word.total_reward}`);
    }
    const available = BAG_COUNTS.map((n, i) =>
      Math.max(
        0,
        n - initial[i] - drawn[i] - Number(ALPHABET[i] === result.letter),
      ),
    );
    const context = {
      myRack: rack,
      myBalance: balance,
      lexicon,
      bagTotal: results.length - round - 1,
      available,
      market,
      letter: result.letter,
      auctionType: "Vickrey" as const,
    };
    const counts = rackCounts(rack);
    const best = cashOut(lexicon, counts);
    const suggested = choosePlays(context).map((p) => `${p.word}:${p.score}`);
    turns.push({
      round: round + 1,
      rack: label(counts),
      balance,
      best: best.plays.map((p) => p.word).join("+"),
      score: best.score,
      suggested,
      bid: decideBid(context),
      v3Bid: baseline.decideBid({ ...context, lexicon: baseline.lexicon }),
      archivedBid: archive.get(result.auction_id),
      letter: result.letter,
      paid: result.paid,
      won: result.winner_bot_id[1] === botId,
      plays,
    });
    drawn[ALPHABET.indexOf(result.letter)]++;
    if (result.winner_bot_id[1] === botId) {
      rack.set(result.letter, rack.get(result.letter)! + 1);
      balance -= result.paid;
    }
    market.push({
      letter: result.letter,
      paid: result.paid,
      result:
        result.winner_bot_id[1] === botId
          ? "won"
          : result.winner_bot_id[1] === undefined
            ? "unbid"
            : "lost",
    });
  }
  assert.equal(
    balance,
    me.balance,
    `Balance reconstruction failed in ${match.id}`,
  );
  assert.equal(
    words.reduce((sum, w) => sum + w.total_reward, 0),
    me.score,
    `Missing word plays in ${match.id}`,
  );
  const summary = {
    id: match.id,
    score: me.score,
    place: 1 + standings.filter((p) => p.score > me.score).length,
    bestRival: Math.max(
      ...standings.filter((p) => p.bot_id !== botId).map((p) => p.score),
    ),
    initial: label(initial),
    exact,
    endingBalance: me.balance,
    wins: results.filter((r) => r.winner_bot_id[1] === botId).length,
    firstPayout: results.filter((r) => r.closed_at[0] < words[0]?.played_at[0])
      .length,
    firstCandidateDecision: turns.find((t) => t.suggested.length)?.round,
    standings: standings.map((p) => ({
      name: bots.find((b) => b.id === p.bot_id)?.name,
      score: p.score,
    })),
    turns,
  };
  summaries.push(summary);
  console.log(JSON.stringify({ ...summary, turns: undefined }));
  const caps = turns.filter((t) => t.won);
  console.log(
    `  v3 winning caps reproduced: ${caps.filter((t) => t.v3Bid === t.archivedBid).length}/${caps.length}`,
  );
  let last = "";
  for (const t of turns) {
    if (t.plays.length || (t.score >= 25 && t.best !== last))
      console.log(
        `  #${t.round} rack=${t.rack} cash=${t.balance} ready=${t.best}:${t.score} candidate=${t.suggested} played=${t.plays}`,
      );
    last = t.best;
  }
  if (process.argv.includes("--fixed-market")) {
    if (!exact)
      throw new Error(`Cannot replay an ambiguous starting rack: ${match.id}`);
    // Sensitivity check, NOT a prediction: opponents keep their archived
    // bid caps despite changed purchases/cash. No counterfactual win claims.
    const replay = (
      strategy: Pick<typeof baseline, "choosePlays" | "decideBid" | "lexicon">,
      tieWins: boolean,
    ) => {
      const rack = new Map(
        Array.from(ALPHABET, (tile, i) => [tile, initial[i]]),
      );
      const drawn = Array<number>(26).fill(0);
      const market: BidObservation[] = [];
      let balance = 100,
        score = 0;
      for (const [round, result] of results.entries()) {
        drawn[ALPHABET.indexOf(result.letter)]++;
        const position = () => ({
          myRack: rack,
          myBalance: balance,
          lexicon: strategy.lexicon,
          bagTotal: results.length - round - 1,
          market,
          available: BAG_COUNTS.map((n, i) =>
            Math.max(0, n - initial[i] - drawn[i]),
          ),
          letter: result.letter,
          auctionType: "Vickrey" as const,
        });
        for (
          let plays = strategy.choosePlays(position());
          plays.length;
          plays = strategy.choosePlays(position())
        ) {
          for (const play of plays) {
            for (const tile of play.word) rack.set(tile, rack.get(tile)! - 1);
            balance += play.score;
            score += play.score;
          }
        }
        const bid = strategy.decideBid(position());
        const originalWin = result.winner_bot_id[1] === botId;
        const opposingBid = originalWin
          ? result.paid
          : archive.get(result.auction_id)!;
        const won =
          bid > 0 && (bid > opposingBid || (bid === opposingBid && tieWins));
        const paid = won
          ? Math.max(1, opposingBid)
          : Math.max(result.paid, bid);
        if (won) {
          balance -= paid;
          rack.set(result.letter, rack.get(result.letter)! + 1);
        }
        market.push({
          letter: result.letter,
          paid,
          result: won ? "won" : opposingBid ? "lost" : "unbid",
        });
      }
      return score;
    };
    console.log(
      `  Fixed opposing bids (lose/win ties): v3 ${replay(baseline, false)}/${replay(baseline, true)}, candidate ${replay({ lexicon, choosePlays, decideBid }, false)}/${replay({ lexicon, choosePlays, decideBid }, true)}`,
    );
  }
}
writeFileSync(
  new URL("../analysis/v3-decisions.json", import.meta.url),
  JSON.stringify(summaries, null, 2) + "\n",
);
