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
import {
  choosePlays,
  decideBid,
  type BidContext,
  type Position,
  type BidObservation,
} from "./strategy.js";
import { botVersions } from "./versions.js";

export type AuctionType = "Vickrey" | "FirstPrice";
export type Policy =
  | Strategy
  | "pressure"
  | "starter"
  | "hoarder"
  | "cheap"
  | "value"
  | "aggressive";
export interface WordSearch {
  lexicon: Lexicon;
  cashOut: typeof cashOut;
}

export interface TournamentPosition {
  phase: "Swiss" | "Bracket" | "Final";
  round: number;
  finalMargin: number;
}

export interface MatchPosition extends Position {
  myScore?: number;
  opponents?: readonly {
    score: number;
    balance: number;
    netTiles: readonly number[];
  }[];
  tournament?: TournamentPosition;
}

export interface Strategy extends WordSearch {
  choosePlays: (ctx: MatchPosition) => Play[];
  decideBid: (ctx: MatchPosition & BidContext) => number;
  rackEventsOnly?: boolean;
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
  netTiles: number[];
  wins: number;
  bids: number;
  spent: number;
  words: number;
  lettersPlayed: number;
}

const lexicon = new Lexicon(
  readFileSync(
    new URL("../../spacetimedb/wordlist.txt", import.meta.url),
    "utf8",
  ).split(/\r?\n/),
);
export const current: Entrant = {
  name: "working tree",
  strategy: { lexicon, cashOut, choosePlays, decideBid },
};
const timings: number[] = [];

export function randomSource(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mix = Math.imul(state ^ (state >>> 15), 1 | state);
    mix ^= mix + Math.imul(mix ^ (mix >>> 7), 61 | mix);
    return ((mix ^ (mix >>> 14)) >>> 0) / 2 ** 32;
  };
}

function awardTile(player: Player, letter: string): void {
  player.rack.set(letter, (player.rack.get(letter) ?? 0) + 1);
}

function playWords(player: Player, plays: readonly Play[]): void {
  for (const play of plays) {
    for (const tile of play.word) {
      const count = player.rack.get(tile) ?? 0;
      if (!count) throw new Error(`Illegal simulated play: ${play.word}`);
      player.rack.set(tile, count - 1);
      player.netTiles[ALPHABET.indexOf(tile)]--;
    }
    player.score += play.score;
    player.balance += play.score;
    player.words++;
    player.lettersPlayed += play.word.length;
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

export interface DecisionTimes {
  bid: number[];
  word: number[];
  turn: number[];
}

function strategyBid(
  strategy: Strategy,
  player: Player,
  letter: string,
  auctionType: AuctionType,
  bagTotal: number,
  drawn: readonly number[],
  opponents: MatchPosition["opponents"],
  tournament: TournamentPosition | undefined,
  decisionTimes: DecisionTimes | undefined,
  recordLegacyTime: boolean,
): number {
  const start = performance.now();
  const available = BAG_COUNTS.map((count, slot) =>
    Math.max(0, count - drawn[slot] - player.starting[slot]),
  );
  const position = () => ({
    myRack: player.rack,
    myBalance: player.balance,
    myScore: player.score,
    lexicon: strategy.lexicon,
    bagTotal,
    auctionType,
    letter,
    market: player.market,
    available,
    opponents,
    tournament,
  });
  const bidNow = () => {
    const before = performance.now();
    const bid = strategy.decideBid(position());
    decisionTimes?.bid.push(performance.now() - before);
    if (!Number.isSafeInteger(bid) || bid < 0 || bid > player.balance)
      throw new Error(
        `Illegal simulated strategy bid: ${bid} of ${player.balance}`,
      );
    return bid;
  };
  const openingBid = strategy.rackEventsOnly ? bidNow() : undefined;
  while (
    !strategy.rackEventsOnly ||
    player.wonLast ||
    player.market.length === 0
  ) {
    const before = performance.now();
    const plays = strategy.choosePlays(position());
    decisionTimes?.word.push(performance.now() - before);
    if (!plays.length) break;
    playWords(player, plays);
    if (strategy.rackEventsOnly) break;
  }
  const bid = openingBid ?? bidNow();
  const end = performance.now();
  decisionTimes?.turn.push(end - start);
  if (recordLegacyTime) timings.push(end - start);
  return bid;
}

export interface MatchOptions {
  startingRackSize?: number;
  measuredSeat?: number;
  decisionTimes?: DecisionTimes;
  tournament?: readonly TournamentPosition[];
  recordLegacyTime?: boolean;
  skipFinalTurnForSeat?: number;
}

export function auctionOutcome(
  bids: readonly { id: number; amount: number; tie: number }[],
  format: AuctionType,
) {
  const [first, second] = bids
    .filter((bid) => bid.amount > 0)
    .sort((a, b) => b.amount - a.amount || a.tie - b.tie);
  return {
    winner: first?.id,
    paid: !first
      ? 0
      : format === "FirstPrice"
        ? first.amount
        : (second?.amount ?? 1),
  };
}

export function simulateMatch(
  seed: number,
  seats: Policy[],
  auctionType: AuctionType,
  reference: WordSearch,
  options: MatchOptions = {},
) {
  const startingRackSize = options.startingRackSize ?? 5;
  if (
    seats.length < 2 ||
    !Number.isInteger(startingRackSize) ||
    startingRackSize < 0 ||
    seats.length * startingRackSize >= BAG_COUNTS.reduce((sum, n) => sum + n, 0)
  )
    throw new Error(
      "A simulated match needs two seats and at least one auction",
    );
  const drawRandom = randomSource(seed);
  const jitterRandom = randomSource(seed ^ 0x67f2b2c7);
  const tieRandom = randomSource(seed ^ 0x2c762d63);
  const bag = BAG_COUNTS.flatMap((count, index) =>
    Array<string>(count).fill(ALPHABET[index]),
  );
  const draw = () => bag.splice(Math.floor(drawRandom() * bag.length), 1)[0];
  const players = seats.map(
    (policy): Player => ({
      policy,
      rack: new Map(),
      starting: [],
      balance: 100,
      score: 0,
      wonLast: false,
      market: [],
      netTiles: Array<number>(26).fill(0),
      wins: 0,
      bids: 0,
      spent: 0,
      words: 0,
      lettersPlayed: 0,
    }),
  );
  for (const player of players) {
    for (let i = 0; i < startingRackSize; i++) awardTile(player, draw());
    player.starting = rackCounts(player.rack);
  }
  const drawn = Array<number>(26).fill(0);

  while (bag.length > 0) {
    const letter = draw();
    const index = ALPHABET.indexOf(letter);
    const face = LETTER_VALUE[letter];
    const vowel = "AEIOU".includes(letter);
    drawn[index]++;
    // Snapshot at open. A policy never sees another seat's simultaneous play
    // or bid, and has no access to opponents' initial deal.
    const visible = players.map(({ score, balance, netTiles }) => ({
      score,
      balance,
      netTiles: [...netTiles],
    }));
    const bids = players.map((player, id) => {
      let bid: number;
      const copies = player.rack.get(letter) ?? 0;
      const jitter = jitterRandom();
      const tie = tieRandom();
      if (bag.length === 0 && options.skipFinalTurnForSeat === id)
        return { id, amount: 0, tie };
      switch (player.policy) {
        case "starter":
          bid = copies ? face : face + 2;
          bid = Math.min(player.balance, bid);
          if (player.wonLast || player.market.length === 0)
            playWords(player, longest(reference.lexicon, player, 2));
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
          bid = Math.max(
            1,
            Math.round(
              8 +
                2.8 * face +
                Math.floor(jitter * 7) -
                3 -
                2 * copies -
                (id % 3),
            ),
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
              visible.filter((_, seat) => seat !== id),
              options.tournament?.[id],
              options.measuredSeat === id ? options.decisionTimes : undefined,
              options.recordLegacyTime ?? false,
            );
          } else {
            const premium =
              player.policy === "aggressive"
                ? vowel
                  ? 4
                  : 2
                : player.policy === "cheap"
                  ? -1
                  : 0;
            bid = Math.max(1, face + premium + Math.floor(jitter * 5) - 2);
          }
        }
      }
      const amount = Math.min(player.balance, bid);
      if (amount > 0) player.bids++;
      return { id, amount, tie };
    });

    for (const player of players) player.wonLast = false;
    const { winner: winnerId, paid } = auctionOutcome(bids, auctionType);
    players.forEach((player, id) => {
      player.market.push({
        letter,
        paid,
        result:
          winnerId === undefined ? "unbid" : winnerId === id ? "won" : "lost",
      });
    });
    if (winnerId === undefined) continue;
    const winner = players[winnerId];
    winner.balance -= paid;
    winner.spent += paid;
    winner.wins++;
    awardTile(winner, letter);
    winner.netTiles[index]++;
    winner.wonLast = true;
    if (
      winner.policy === "cheap" ||
      winner.policy === "value" ||
      winner.policy === "aggressive"
    )
      playWords(winner, longest(reference.lexicon, winner, 3));
  }

  return players.map(
    ({ score, balance, wins, bids, spent, words, lettersPlayed, market }) => ({
      score,
      balance,
      wins,
      bids,
      spent,
      words,
      lettersPlayed,
      auctions: market.length,
    }),
  );
}

function runMatch(
  seed: number,
  seats: Policy[],
  format: AuctionType,
  reference: WordSearch,
) {
  return simulateMatch(seed, seats, format, reference, {
    recordLegacyTime: true,
  }).map(({ score }) => score);
}

export async function loadStrategy(ref: string): Promise<Strategy> {
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
const games = Number(process.env.BENCH_GAMES ?? 96);
const seedShift = Number(process.env.BENCH_SEED_OFFSET ?? 0);
if (
  !Number.isSafeInteger(games) ||
  games < 2 ||
  games % 2 ||
  !Number.isSafeInteger(seedShift)
)
  throw new Error(
    "BENCH_GAMES must be a positive even integer; BENCH_SEED_OFFSET must be an integer",
  );

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
        const seed = (deal + 7300 + seedShift) * 7919;
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
  const scoresByGame: number[] = [];
  for (let game = 1; game <= games; game++) {
    const seed = (game + seedOffset + seedShift) * 7919;
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
    scoresByGame.push(score);
  }
  const sorted = [...scoresByGame].sort((a, b) => a - b);
  const tailSize = Math.max(1, Math.ceil(games / 10));
  return {
    wins,
    ties,
    average: points / games,
    rivalAverage: rivalPoints / games,
    bottomDecile:
      sorted.slice(0, tailSize).reduce((a, b) => a + b, 0) / tailSize,
    below60: sorted.filter((score) => score < 60).length,
    scoresByGame,
  };
}

async function benchmarkRobustness(ref: string) {
  const registered = botVersions.find((version) => version.id === ref);
  const baseline = {
    name: ref,
    strategy: await loadStrategy(registered?.commit ?? ref),
  };
  const rooms: Record<string, Policy[]> = {
    ...fields,
    "Five pressure bots": pressureOpponents,
    "Mixed pressure": [
      "pressure",
      "pressure",
      "hoarder",
      "starter",
      "aggressive",
    ],
    "Pressure duel": ["pressure"],
  };
  const report = [];
  for (const [field, opponents] of Object.entries(rooms)) {
    if (
      process.env.BENCH_FIELDS &&
      !process.env.BENCH_FIELDS.toLowerCase()
        .split(",")
        .some((filter) => field.toLowerCase().includes(filter.trim()))
    )
      continue;
    for (const auctionType of auctionTypes) {
      const before = benchmarkField(
        baseline,
        opponents,
        auctionType,
        10300,
        baseline.strategy,
      );
      const after = benchmarkField(
        current,
        opponents,
        auctionType,
        10300,
        baseline.strategy,
      );
      const differences = after.scoresByGame.map(
        (score, i) => score - before.scoresByGame[i],
      );
      const mean = after.average - before.average;
      const se = Math.sqrt(
        differences.reduce((s, d) => s + (d - mean) ** 2, 0) /
          (games - 1) /
          games,
      );
      console.log(
        `${field}, ${auctionType}: average ${before.average.toFixed(1)} -> ${after.average.toFixed(1)}; bottom 10% ${before.bottomDecile.toFixed(1)} -> ${after.bottomDecile.toFixed(1)}; wins ${before.wins} -> ${after.wins}/${games}; below 60 ${before.below60} -> ${after.below60}; paired gain ${mean.toFixed(1)} ± ${(1.96 * se).toFixed(1)}`,
      );
      report.push({
        field,
        auctionType,
        games,
        seedShift,
        before,
        after,
        pairedGain: mean,
        paired95HalfWidth: 1.96 * se,
      });
    }
  }
  if (process.env.BENCH_REPORT)
    writeFileSync(
      process.env.BENCH_REPORT,
      JSON.stringify(report, null, 2) + "\n",
    );
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

async function main() {
  const args = process.argv.slice(2);
  const [flag, ref] = args;
  if (flag === "--robust" && args.length <= 2) {
    await benchmarkRobustness(ref ?? "v3");
  } else if (flag === "--against" && ref && args.length === 2) {
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
      "Usage: npm run benchmark -- [--versions [--candidate] | --against <version-or-commit> | --robust [version-or-commit]]",
    );
  }
  timings.sort((a, b) => a - b);
  console.log(
    `Strategy time per turn: p95 ${timings[Math.floor(timings.length * 0.95)].toFixed(2)} ms, max ${timings.at(-1)?.toFixed(2)} ms`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await main();
