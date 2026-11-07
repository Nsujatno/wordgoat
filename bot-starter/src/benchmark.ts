import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
import { botVersions } from "./versions.js";

type AuctionType = "Vickrey" | "FirstPrice";
type Policy =
  | Strategy
  | "pressure"
  | "starter"
  | "hoarder"
  | "cheap"
  | "value"
  | "aggressive";
interface WordSearch {
  lexicon: Lexicon;
  cashOut: typeof cashOut;
}

interface Strategy extends WordSearch {
  choosePlays: typeof choosePlays;
  decideBid: typeof decideBid;
}

interface Entrant {
  name: string;
  strategy: Strategy;
}

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
const current: Entrant = {
  name: "working tree",
  strategy: { lexicon, cashOut, choosePlays, decideBid },
};
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

function longest(lexicon: Lexicon, player: Player, minimum: number): Play[] {
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

function strategyBid(
  strategy: Strategy,
  player: Player,
  letter: string,
  auctionType: AuctionType,
  bagTotal: number,
  drawn: readonly number[],
): number {
  const start = performance.now();
  const available = BAG_COUNTS.map((count, slot) =>
    Math.max(0, count - drawn[slot] - player.starting[slot]),
  );
  const position = () => ({
    myRack: player.rack,
    myBalance: player.balance,
    lexicon: strategy.lexicon,
    bagTotal,
    auctionType,
    letter,
    market: player.market,
    available,
  });
  for (
    let plays = strategy.choosePlays(position());
    plays.length;
    plays = strategy.choosePlays(position())
  ) {
    playWords(player, plays);
  }
  const bid = strategy.decideBid(position());
  timings.push(performance.now() - start);
  return bid;
}

function runMatch(
  seed: number,
  seats: Policy[],
  auctionType: AuctionType,
  reference: WordSearch,
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
          case "starter":
            if (player.wonLast || player.market.length === 0)
              playWords(player, longest(reference.lexicon, player, 2));
            bid = copies ? face : face + 2;
            break;
          case "hoarder":
            if (bag.length === 0)
              playWords(
                player,
                reference.cashOut(reference.lexicon, rackCounts(player.rack))
                  .plays,
              );
            else
              playWords(
                player,
                longest(reference.lexicon, player, player.balance < 18 ? 3 : 7),
              );
            bid = Math.max(1, 2 * face + (copies ? 0 : 5));
            if (auctionType === "FirstPrice") bid = Math.max(1, bid - 2);
            break;
          case "pressure": {
            // Approximate the much higher bid levels in the public replays.
            if (bag.length === 0) {
              playWords(
                player,
                reference.cashOut(reference.lexicon, rackCounts(player.rack))
                  .plays,
              );
              bid = 0;
              break;
            }
            playWords(
              player,
              longest(reference.lexicon, player, player.balance < 15 ? 3 : 7),
            );
            const jitter = Math.floor(random() * 7) - 3;
            bid = Math.max(
              1,
              Math.round(8 + 2.8 * face + jitter - 2 * copies - (id % 3)),
            );
            if (auctionType === "FirstPrice") bid = Math.floor(bid * 0.75);
            break;
          }
          default: {
            if (typeof player.policy === "object") {
              bid = strategyBid(
                player.policy,
                player,
                letter,
                auctionType,
                bag.length,
                drawn,
              );
            } else {
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
    if (
      winner.policy === "cheap" ||
      winner.policy === "value" ||
      winner.policy === "aggressive"
    )
      playWords(winner, longest(reference.lexicon, winner, 3));
  }

  return players.map((player) => player.score);
}

async function loadStrategy(ref: string): Promise<Strategy> {
  const cwd = fileURLToPath(new URL("../..", import.meta.url));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  const commit = git(
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ).trim();
  const sourcePaths = git(
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    commit,
    "--",
    "bot-starter/src/",
  )
    .split("\0")
    .filter(Boolean);
  const tempRoot = realpathSync(tmpdir());
  const dir = mkdtempSync(join(tempRoot, "wordgoat-bench-"));
  if (dirname(dir) !== tempRoot)
    throw new Error("Unexpected benchmark scratch directory");
  try {
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    const wordlistPath = "spacetimedb/wordlist.txt";
    const dictionary = git("show", `${commit}:${wordlistPath}`);
    for (const path of [...sourcePaths, wordlistPath]) {
      const file = resolve(dir, path);
      const within = relative(dir, file);
      if (isAbsolute(within) || within.startsWith(".."))
        throw new Error(`Invalid snapshot path: ${path}`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        path === wordlistPath ? dictionary : git("show", `${commit}:${path}`),
      );
    }
    const moduleUrl = (file: string) =>
      pathToFileURL(join(dir, "bot-starter/src", file)).href;
    const strategy: typeof import("./strategy.js") = await import(
      moduleUrl("strategy.ts")
    );
    const snapshot: typeof import("./lexicon.js") = await import(
      moduleUrl("lexicon.ts")
    );
    return {
      choosePlays: strategy.choosePlays,
      decideBid: strategy.decideBid,
      lexicon: new snapshot.Lexicon(dictionary.split(/\r?\n/)),
      cashOut: snapshot.cashOut,
    };
  } finally {
    rmSync(dir, { recursive: true });
  }
}

const auctionTypes = ["Vickrey", "FirstPrice"] as const;
const pressureOpponents = Array<Policy>(5).fill("pressure");
const games = 96;

function headToHead(left: Entrant, right: Entrant, reference: WordSearch) {
  const rooms = [
    { name: "Two-bot duel", opponents: [] },
    {
      name: "Six-bot pressure table",
      opponents: pressureOpponents.slice(0, 4),
    },
  ];
  for (const { name, opponents } of rooms) {
    for (const auctionType of auctionTypes) {
      const wins = [0, 0];
      const firsts = [0, 0];
      const points = [0, 0];
      for (let deal = 0; deal < games / 2; deal++) {
        const seed = (deal + 7300) * 7919;
        for (const seat of [0, 1]) {
          const pair =
            seat === 0
              ? [left.strategy, right.strategy]
              : [right.strategy, left.strategy];
          const scores = runMatch(
            seed,
            [...pair, ...opponents],
            auctionType,
            reference,
          );
          for (const [index, playerSeat] of [seat, 1 - seat].entries()) {
            const score = scores[playerSeat];
            wins[index] += Number(score > scores[1 - playerSeat]);
            firsts[index] += Number(
              scores.every((rival, i) => i === playerSeat || score > rival),
            );
            points[index] += score;
          }
        }
      }
      const ties = games - wins[0] - wins[1];
      const tableWins = opponents.length
        ? `. Outright table wins ${firsts[0]}–${firsts[1]}`
        : "";
      console.log(
        `${name}, ${auctionType}. ${left.name} ${wins[0]}–${wins[1]} ${right.name}, ${ties} ties${tableWins}. Average points ${(points[0] / games).toFixed(1)}–${(points[1] / games).toFixed(1)}.`,
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
function benchmarkField(
  entrant: Entrant,
  opponents: Policy[],
  auctionType: AuctionType,
  seedOffset: number,
  reference: WordSearch,
) {
  let wins = 0;
  let ties = 0;
  let points = 0;
  let rivalPoints = 0;
  for (let game = 1; game <= games; game++) {
    const seed = (game + seedOffset) * 7919;
    const seat = seed % (opponents.length + 1);
    const seats = [...opponents];
    seats.splice(seat, 0, entrant.strategy);
    const scores = runMatch(seed, seats, auctionType, reference);
    const score = scores[seat];
    const bestRival = Math.max(...scores.filter((_, i) => i !== seat));
    wins += Number(score > bestRival);
    ties += Number(score === bestRival);
    points += score;
    rivalPoints += bestRival;
  }
  return {
    wins,
    ties,
    average: points / games,
    rivalAverage: rivalPoints / games,
  };
}

async function benchmarkVersions(includeCandidate: boolean) {
  console.log("Registered Wordgoat versions");
  const entrants: Entrant[] = [];
  for (const { id, commit, description, liveMatches } of botVersions) {
    const count = liveMatches.length;
    const wins = liveMatches.filter(
      (match) => match.score > match.bestRivalScore,
    ).length;
    const points = liveMatches.reduce((sum, match) => sum + match.score, 0);
    const live = count
      ? `${wins}/${count} live wins, ${(points / count).toFixed(1)} average points`
      : "No live games recorded";
    console.log(`${id} (${commit.slice(0, 7)}) · ${description} · ${live}`);
    entrants.push({ name: id, strategy: await loadStrategy(commit) });
  }
  if (includeCandidate) entrants.push({ ...current, name: "candidate" });
  // Keep the synthetic opponents fixed as new versions change their lexicons.
  const reference = entrants[0].strategy;

  console.log(
    `\nCommon field against five pressure bots (${games} games per version and format)`,
  );
  for (const auctionType of auctionTypes) {
    const results = entrants.map((entrant) => ({
      name: entrant.name,
      ...benchmarkField(
        entrant,
        pressureOpponents,
        auctionType,
        10300,
        reference,
      ),
    }));
    results.sort((a, b) => b.wins - a.wins || b.average - a.average);
    for (const { name, wins, ties, average } of results) {
      console.log(
        `${auctionType} · ${name} · ${wins}/${games} outright wins, ${ties} ties for first, ${average.toFixed(1)} average points`,
      );
    }
  }

  console.log(
    `\nAll version pairs (${games} games per room and format, swapping seats on each deal)`,
  );
  for (const [index, left] of entrants.entries()) {
    for (const right of entrants.slice(index + 1))
      headToHead(left, right, reference);
  }
}

const args = process.argv.slice(2);
const [flag, ref] = args;
if (flag === "--against" && ref && args.length === 2) {
  const registered = botVersions.find((version) => version.id === ref);
  headToHead(
    current,
    {
      name: ref,
      strategy: await loadStrategy(registered?.commit ?? ref),
    },
    current.strategy,
  );
} else if (
  flag === "--versions" &&
  (args.length === 1 || (args.length === 2 && ref === "--candidate"))
) {
  await benchmarkVersions(ref === "--candidate");
} else if (!flag) {
  for (const [field, opponents] of Object.entries(fields)) {
    for (const auctionType of auctionTypes) {
      const { wins, ties, average, rivalAverage } = benchmarkField(
        current,
        opponents,
        auctionType,
        3000,
        current.strategy,
      );
      console.log(
        `${field}, ${auctionType}. ${wins}/${games} outright wins, ${ties} ties for first. Average points ${average.toFixed(1)} vs. ${rivalAverage.toFixed(1)} for the best rival.`,
      );
    }
  }
} else {
  throw new Error(
    "Usage: npm run benchmark -- [--versions [--candidate] | --against <version-or-commit>]",
  );
}
timings.sort((a, b) => a - b);
console.log(
  `Strategy time per turn: p95 ${timings[Math.floor(timings.length * 0.95)].toFixed(2)} ms, max ${timings.at(-1)?.toFixed(2)} ms`,
);
