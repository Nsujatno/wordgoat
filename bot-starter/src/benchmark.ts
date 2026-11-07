import { readFileSync } from "node:fs";
import {
  ALPHABET,
  BAG_COUNTS,
  LETTER_VALUE,
  Lexicon,
  cashOut,
  rackCounts,
  type Play,
} from "./lexicon.js";
import { choosePlays, decideBid, type BidObservation } from "./strategy.js";

type AuctionType = "Vickrey" | "FirstPrice";
type Policy = "bot" | "starter" | "hoarder" | "cheap" | "value" | "aggressive";

interface Player {
  policy: Policy;
  rack: Map<string, number>;
  starting: number[];
  balance: number;
  score: number;
  wonLast: boolean;
}

const lexicon = new Lexicon(
  readFileSync(
    new URL("../../spacetimedb/wordlist.txt", import.meta.url),
    "utf8",
  ).split(/\r?\n/),
);
const timings: number[] = [];

function randomSource(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function awardTile(player: Player, letter: string): void {
  player.rack.set(letter, (player.rack.get(letter) ?? 0) + 1);
}

function playWords(player: Player, plays: readonly Play[]): void {
  for (const play of plays) {
    for (const tile of play.word)
      player.rack.set(tile, player.rack.get(tile)! - 1);
    player.score += play.score;
    player.balance += play.score;
  }
}

function longest(player: Player, minimum: number): Play[] {
  let best: Play | undefined;
  lexicon.visit(rackCounts(player.rack), (play) => {
    if (play.letters.length < minimum) return;
    if (
      !best ||
      play.letters.length > best.letters.length ||
      (play.letters.length === best.letters.length && play.word < best.word)
    )
      best = play;
  });
  return best ? [best] : [];
}

function runMatch(
  seed: number,
  opponents: Policy[],
  auctionType: AuctionType,
): number[] {
  const random = randomSource(seed);
  const bag = BAG_COUNTS.flatMap((count, index) =>
    Array<string>(count).fill(ALPHABET[index]),
  );
  const draw = () => bag.splice(Math.floor(random() * bag.length), 1)[0];
  const seat = seed % (opponents.length + 1);
  const policies = [...opponents];
  policies.splice(seat, 0, "bot");
  const players = policies.map((policy): Player => ({
    policy,
    rack: new Map(),
    starting: [],
    balance: 100,
    score: 0,
    wonLast: false,
  }));
  for (const player of players) {
    for (let i = 0; i < 5; i++) awardTile(player, draw());
    player.starting = rackCounts(player.rack);
  }
  const drawn = Array<number>(26).fill(0);
  const market: BidObservation[] = [];

  while (bag.length > 0) {
    const letter = draw();
    const index = ALPHABET.indexOf(letter);
    const face = LETTER_VALUE[letter];
    const vowel = "AEIOU".includes(letter);
    drawn[index]++;
    const bids = players
      .map((player, id) => {
        let bid: number;
        const copies = player.rack.get(letter) ?? 0;
        switch (player.policy) {
          case "bot": {
            const start = performance.now();
            const position = () => ({
              myRack: player.rack,
              myBalance: player.balance,
              lexicon,
              bagTotal: bag.length,
            });
            for (
              let plays = choosePlays(position());
              plays.length;
              plays = choosePlays(position())
            )
              playWords(player, plays);
            const available = BAG_COUNTS.map((count, slot) =>
              Math.max(0, count - drawn[slot] - player.starting[slot]),
            );
            bid = decideBid({
              ...position(),
              letter,
              auctionType,
              market,
              available,
            });
            timings.push(performance.now() - start);
            break;
          }
          case "starter":
            if (player.wonLast || market.length === 0)
              playWords(player, longest(player, 2));
            bid = copies ? face : face + 2;
            break;
          case "hoarder":
            if (bag.length === 0)
              playWords(
                player,
                cashOut(lexicon, rackCounts(player.rack)).plays,
              );
            else
              playWords(player, longest(player, player.balance < 18 ? 3 : 7));
            bid = Math.max(1, 2 * face + (copies ? 0 : 5));
            if (auctionType === "FirstPrice") bid = Math.max(1, bid - 2);
            break;
          default: {
            const jitter = Math.floor(random() * 5) - 2;
            const premium =
              player.policy === "aggressive"
                ? vowel
                  ? 4
                  : 2
                : player.policy === "cheap"
                  ? -1
                  : 0;
            bid = Math.max(1, face + premium + jitter);
          }
        }
        return { id, amount: Math.min(player.balance, bid), tie: random() };
      })
      .filter((bid) => bid.amount > 0)
      .sort((a, b) => b.amount - a.amount || a.tie - b.tie);

    for (const player of players) player.wonLast = false;
    const [first, second] = bids;
    if (!first) {
      market.push({ letter, paid: 0, result: "unbid" });
      continue;
    }
    const paid =
      auctionType === "FirstPrice" ? first.amount : (second?.amount ?? 1);
    market.push({ letter, paid, result: first.id === seat ? "won" : "lost" });
    const winner = players[first.id];
    winner.balance -= paid;
    awardTile(winner, letter);
    winner.wonLast = true;
    if (["cheap", "value", "aggressive"].includes(winner.policy))
      playWords(winner, longest(winner, 3));
  }

  return [
    players[seat].score,
    ...players.filter((_, id) => id !== seat).map((player) => player.score),
  ];
}

const fields: Record<string, Policy[]> = {
  "Built-in opponents": ["cheap", "value", "value", "aggressive", "aggressive"],
  "Five stock starters": [
    "starter",
    "starter",
    "starter",
    "starter",
    "starter",
  ],
  "Bonus-seeking opponents": [
    "hoarder",
    "hoarder",
    "hoarder",
    "starter",
    "aggressive",
  ],
};
const games = 96;
for (const [field, opponents] of Object.entries(fields)) {
  for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
    let wins = 0;
    let ties = 0;
    let points = 0;
    let rivalPoints = 0;
    for (let game = 1; game <= games; game++) {
      const [score, ...opponentsScores] = runMatch(
        (game + 3000) * 7919,
        opponents,
        auctionType,
      );
      const bestRival = Math.max(...opponentsScores);
      wins += Number(score > bestRival);
      ties += Number(score === bestRival);
      points += score;
      rivalPoints += bestRival;
    }
    console.log(
      `${field}, ${auctionType}: ${wins}/${games} outright wins, ${ties} tied; average ${Math.round(points / games)} vs. ${Math.round(rivalPoints / games)} best rival`,
    );
  }
}
timings.sort((a, b) => a - b);
console.log(
  `Strategy time per turn: p95 ${timings[Math.floor(timings.length * 0.95)].toFixed(2)} ms, max ${timings.at(-1)?.toFixed(2)} ms`,
);
