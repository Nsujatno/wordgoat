import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
type Policy =
  | "bot"
  | "old"
  | "pressure"
  | "starter"
  | "hoarder"
  | "cheap"
  | "value"
  | "aggressive";
type Strategy = {
  choosePlays: typeof choosePlays;
  decideBid: typeof decideBid;
};

interface Player {
  policy: Policy;
  rack: Map<string, number>;
  starting: number[];
  balance: number;
  score: number;
  wonLast: boolean;
  market: BidObservation[];
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
  seats: Policy[],
  auctionType: AuctionType,
  old?: Strategy,
): number[] {
  const drawRandom = randomSource(seed);
  const random = randomSource(seed ^ 0x67f2b2c7);
  const bag = BAG_COUNTS.flatMap((count, index) =>
    Array<string>(count).fill(ALPHABET[index]),
  );
  const draw = () => bag.splice(Math.floor(drawRandom() * bag.length), 1)[0];
  const players = seats.map((policy): Player => ({
    policy,
    rack: new Map(),
    starting: [],
    balance: 100,
    score: 0,
    wonLast: false,
    market: [],
  }));
  for (const player of players) {
    for (let i = 0; i < 5; i++) awardTile(player, draw());
    player.starting = rackCounts(player.rack);
  }
  const drawn = Array<number>(26).fill(0);

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
          case "bot":
          case "old": {
            const strategy =
              player.policy === "old" ? old! : { choosePlays, decideBid };
            const start = performance.now();
            const position = () => ({
              myRack: player.rack,
              myBalance: player.balance,
              lexicon,
              bagTotal: bag.length,
              auctionType,
            });
            for (
              let plays = strategy.choosePlays(position());
              plays.length;
              plays = strategy.choosePlays(position())
            )
              playWords(player, plays);
            const available = BAG_COUNTS.map((count, slot) =>
              Math.max(0, count - drawn[slot] - player.starting[slot]),
            );
            bid = strategy.decideBid({
              ...position(),
              letter,
              auctionType,
              market: player.market,
              available,
            });
            timings.push(performance.now() - start);
            break;
          }
          case "starter":
            if (player.wonLast || player.market.length === 0)
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
          case "pressure": {
            // Approximate the much higher bid levels in the public replays.
            if (bag.length === 0) {
              playWords(
                player,
                cashOut(lexicon, rackCounts(player.rack)).plays,
              );
              bid = 0;
              break;
            }
            playWords(player, longest(player, player.balance < 15 ? 3 : 7));
            const jitter = Math.floor(random() * 7) - 3;
            bid = Math.max(
              1,
              Math.round(8 + 2.8 * face + jitter - 2 * copies - (id % 3)),
            );
            if (auctionType === "FirstPrice") bid = Math.floor(bid * 0.75);
            break;
          }
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
    const paid = !first
      ? 0
      : auctionType === "FirstPrice"
        ? first.amount
        : (second?.amount ?? 1);
    players.forEach((player, id) => {
      player.market.push({
        letter,
        paid,
        result: !first ? "unbid" : first.id === id ? "won" : "lost",
      });
    });
    if (!first) continue;
    const winner = players[first.id];
    winner.balance -= paid;
    awardTile(winner, letter);
    winner.wonLast = true;
    if (["cheap", "value", "aggressive"].includes(winner.policy))
      playWords(winner, longest(winner, 3));
  }

  return players.map((player) => player.score);
}

async function loadStrategy(ref: string): Promise<Strategy> {
  const cwd = fileURLToPath(new URL("../..", import.meta.url));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" });
  const commit = git(
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ).trim();
  const files = new Map([
    ["strategy.ts", git("show", `${commit}:bot-starter/src/strategy.ts`)],
    ["lexicon.ts", git("show", `${commit}:bot-starter/src/lexicon.ts`)],
    ["package.json", '{"type":"module"}'],
  ]);
  const dir = mkdtempSync(join(tmpdir(), "wordgoat-bench-"));
  const written: string[] = [];
  try {
    for (const [name, content] of files) {
      const file = join(dir, name);
      writeFileSync(file, content);
      written.push(file);
    }
    return await import(pathToFileURL(join(dir, "strategy.ts")).href);
  } finally {
    for (const file of written) unlinkSync(file);
    rmdirSync(dir);
  }
}

function headToHead(ref: string, old: Strategy) {
  const pairs = 48;
  for (const { name, others } of [
    { name: "Two-bot duel", others: [] as Policy[] },
    {
      name: "Six-bot pressure table",
      others: ["pressure", "pressure", "pressure", "pressure"] as Policy[],
    },
  ]) {
    for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
      let newer = 0,
        older = 0,
        ties = 0,
        first = 0;
      let newPoints = 0,
        oldPoints = 0;
      for (let game = 0; game < pairs; game++) {
        const seed = (game + 7300) * 7919;
        for (const seat of [0, 1]) {
          const seats: Policy[] =
            seat === 0 ? ["bot", "old", ...others] : ["old", "bot", ...others];
          const scores = runMatch(seed, seats, auctionType, old);
          const newScore = scores[seat],
            oldScore = scores[1 - seat];
          newer += Number(newScore > oldScore);
          older += Number(oldScore > newScore);
          ties += Number(newScore === oldScore);
          first += Number(
            scores.every((score, i) => i === seat || newScore > score),
          );
          newPoints += newScore;
          oldPoints += oldScore;
        }
      }
      const games = 2 * pairs;
      console.log(
        `${name}, ${auctionType} vs ${ref}: new wins ${newer}, old wins ${older}, ties ${ties}. New placed first ${first}/${games}. Average points ${Math.round(newPoints / games)} vs ${Math.round(oldPoints / games)}.`,
      );
    }
  }
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
function benchmarkFields() {
  const games = 96;
  for (const [field, opponents] of Object.entries(fields)) {
    for (const auctionType of ["Vickrey", "FirstPrice"] as const) {
      let wins = 0;
      let ties = 0;
      let points = 0;
      let rivalPoints = 0;
      for (let game = 1; game <= games; game++) {
        const seed = (game + 3000) * 7919;
        const seat = seed % (opponents.length + 1);
        const seats = [...opponents];
        seats.splice(seat, 0, "bot");
        const scores = runMatch(seed, seats, auctionType);
        const score = scores[seat];
        const opponentsScores = scores.filter((_, i) => i !== seat);
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
}

const [flag, ref] = process.argv.slice(2);
if (flag === "--against" && ref) headToHead(ref, await loadStrategy(ref));
else if (flag)
  throw new Error("Usage: npm run benchmark -- [--against <commit>]");
else benchmarkFields();
timings.sort((a, b) => a - b);
console.log(
  `Strategy time per turn: p95 ${timings[Math.floor(timings.length * 0.95)].toFixed(2)} ms, max ${timings.at(-1)?.toFixed(2)} ms`,
);
