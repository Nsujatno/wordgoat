import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  current,
  loadStrategy,
  randomSource,
  simulateMatch,
  type AuctionType,
  type DecisionTimes,
  type Policy,
  type Strategy,
} from "./benchmark.js";
import { experiments } from "./experiments.js";
import { chooseTournamentPlays, decideTournamentBid } from "./strategy.js";

type MatchResult = ReturnType<typeof simulateMatch>[number];

export function placement(
  scores: readonly number[],
  seat: number,
  matchSize: number,
) {
  const score = scores[seat];
  const better = scores.filter((other) => other > score).length;
  const worse = scores.filter((other) => other < score).length;
  return {
    place: 1 + better,
    swissPoints: Math.max(0, matchSize - better),
    first: Number(better === 0),
    outrightFirst: Number(worse === scores.length - 1),
    last: Number(worse === 0),
  };
}

interface Entry {
  id: number;
  policy: Policy;
  swiss: number;
  total: number;
  final: number;
  matchScore: number;
}

const standing = (a: Entry, b: Entry) =>
  b.swiss - a.swiss || b.total - a.total || a.id - b.id;
const finalOrder = (a: Entry, b: Entry) =>
  b.final - a.final || b.total - a.total || a.id - b.id;
const bracketOrder = (a: Entry, b: Entry) =>
  a.matchScore - b.matchScore || a.total - b.total || b.id - a.id;

export function tableSizes(entrants: number, matchSize: number): number[] {
  const tables = Math.max(1, Math.floor(entrants / matchSize));
  return Array.from(
    { length: tables },
    (_, i) => Math.floor(entrants / tables) + Number(i < entrants % tables),
  );
}

function runTournament(
  seed: number,
  field: readonly Policy[],
  policy: Policy,
  format: AuctionType,
  times: DecisionTimes,
  matchSize: number,
  rounds: number,
  topCut: number,
  missFinal: number,
) {
  const id = seed % (field.length + 1);
  const lineup = [...field];
  lineup.splice(id, 0, policy);
  const entries = lineup.map(
    (policy, id): Entry => ({
      id,
      policy,
      swiss: 0,
      total: 0,
      final: 0,
      matchScore: 0,
    }),
  );
  const target = entries[id];
  const random = randomSource(seed ^ 0x526d9a13);
  const seedFor = (phase: number, round: number, table: number) =>
    (seed ^ Math.imul(phase * 397 + round * 31 + table, 0x95f61951)) >>> 0;
  const focal: ReturnType<typeof matchMetrics>[] = [];
  let matches = 0;
  function play(
    roster: Entry[],
    phase: "Swiss" | "Bracket" | "Final",
    round: number,
    table: number,
  ) {
    matches++;
    const measuredSeat = roster.indexOf(target);
    const results = simulateMatch(
      seedFor(
        phase === "Swiss" ? 1 : phase === "Bracket" ? 2 : 3,
        round,
        table,
      ),
      roster.map((entry) => entry.policy),
      format,
      current.strategy,
      {
        measuredSeat,
        decisionTimes: times,
        skipFinalTurnForSeat:
          randomSource(
            seedFor(4, round, table) ^
              (phase === "Swiss" ? 101 : phase === "Bracket" ? 102 : 103),
          )() < missFinal
            ? measuredSeat
            : undefined,
        tournament: roster.map((entry, i) => ({
          phase,
          round,
          finalMargin:
            phase === "Final" ? entry.final - roster[1 - i].final : 0,
        })),
      },
    );
    const scores = results.map(({ score }) => score);
    for (const [seat, entry] of roster.entries()) {
      entry.matchScore = scores[seat];
      entry.total += scores[seat];
      if (phase === "Swiss")
        entry.swiss += placement(scores, seat, matchSize).swissPoints;
      if (phase === "Final") entry.final += scores[seat];
    }
    if (measuredSeat >= 0)
      focal.push(matchMetrics(results, measuredSeat, matchSize));
  }
  const pairing = [...entries];
  for (let i = pairing.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pairing[i], pairing[j]] = [pairing[j], pairing[i]];
  }
  for (let round = 1; round <= rounds; round++) {
    if (round > 1) pairing.sort(standing);
    let offset = 0;
    for (const [table, size] of tableSizes(
      entries.length,
      matchSize,
    ).entries()) {
      play(pairing.slice(offset, offset + size), "Swiss", round, table);
      offset += size;
    }
  }
  pairing.sort(standing);
  const alive = pairing.slice(0, topCut).sort((a, b) => a.id - b.id);
  const qualified = Number(alive.includes(target));
  let bracketGames = 0;
  for (let round = 1; alive.length > 2; round++) {
    bracketGames += Number(alive.includes(target));
    play(alive, "Bracket", round, 0);
    const loser = [...alive].sort(bracketOrder)[0];
    alive.splice(alive.indexOf(loser), 1);
  }
  const finalist = Number(alive.includes(target));
  for (let round = 1; round <= 3; round++) play(alive, "Final", round, 0);
  const champion = Number(alive.sort(finalOrder)[0] === target);
  return {
    focal,
    matches,
    sample: {
      champion,
      qualified,
      finalist,
      bracketGames,
      swissTotal: target.swiss,
    },
  };
}

function matchMetrics(
  results: readonly MatchResult[],
  seat: number,
  matchSize: number,
) {
  return {
    ...results[seat],
    ...placement(
      results.map(({ score }) => score),
      seat,
      matchSize,
    ),
  };
}

type Metrics = ReturnType<typeof matchMetrics>;
type Sample = Record<string, number>;
const average = (items: readonly number[]) =>
  items.reduce((sum, item) => sum + item, 0) / items.length;
const variance = (items: readonly number[], mean = average(items)) =>
  items.reduce((sum, item) => sum + (item - mean) ** 2, 0) / (items.length - 1);

export function pairedInterval(
  before: readonly number[],
  after: readonly number[],
) {
  if (before.length !== after.length || before.length < 2)
    throw new Error("Expected paired samples");
  const differences = after.map((item, i) => item - before[i]);
  const delta = average(differences);
  const radius =
    1.96 * Math.sqrt(variance(differences, delta) / differences.length);
  return { delta, lower: delta - radius, upper: delta + radius };
}

export function pairedRateInterval(
  before: readonly number[],
  after: readonly number[],
) {
  if (before.length !== after.length || before.length < 2)
    throw new Error("Expected paired samples");
  const n = before.length;
  const up = average(after.map((value, i) => Number(value > before[i])));
  const down = average(after.map((value, i) => Number(value < before[i])));
  // Bonferroni-adjusted Wilson intervals on the two discordant proportions
  // retain uncertainty even if a sample contains no changes.
  const z = 2.2414;
  const scale = 1 + z ** 2 / n;
  const interval = (p: number) => {
    const center = (p + z ** 2 / (2 * n)) / scale;
    const radius =
      (z / scale) * Math.sqrt((p * (1 - p) + z ** 2 / (4 * n)) / n);
    return { lower: center - radius, upper: center + radius };
  };
  const positive = interval(up);
  const negative = interval(down);
  return {
    delta: up - down,
    lower: positive.lower - negative.upper,
    upper: positive.upper - negative.lower,
  };
}

function percentileTimes(times: number[]) {
  times.sort((a, b) => a - b);
  const p = (pct: number) => times[Math.ceil(pct * times.length) - 1] ?? null;
  return {
    count: times.length,
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    max: p(1),
  };
}

function summarize(rows: readonly Metrics[], times: DecisionTimes) {
  const scores = rows.map(({ score }) => score);
  const mean = (key: keyof Metrics) => average(rows.map((row) => row[key]));
  const ratio = (num: keyof Metrics, denom: keyof Metrics) =>
    mean(denom) > 0 ? mean(num) / mean(denom) : null;
  return {
    focalMatches: rows.length,
    score: mean("score"),
    scoreVariance: variance(scores),
    place: mean("place"),
    first: mean("first"),
    outrightFirst: mean("outrightFirst"),
    last: mean("last"),
    swissPoints: mean("swissPoints"),
    auctionWin: ratio("wins", "auctions"),
    winsPerBid: ratio("wins", "bids"),
    scorePerCredit: ratio("score", "spent"),
    wordLength: ratio("lettersPlayed", "words"),
    remainingCash: mean("balance"),
    latencyMs: {
      bid: percentileTimes(times.bid),
      word: percentileTimes(times.word),
      turn: percentileTimes(times.turn),
    },
  };
}

const matchFields: Record<string, Policy[]> = {
  pressure: ["pressure", "pressure", "pressure", "pressure", "pressure"],
  mixed: ["pressure", "pressure", "hoarder", "starter", "aggressive"],
  builtins: ["cheap", "value", "value", "aggressive", "aggressive"],
  starters: ["starter", "starter", "starter", "starter", "starter"],
  bonus: ["hoarder", "hoarder", "hoarder", "starter", "aggressive"],
  duel: ["pressure"],
};

function seedAt(offset: number, sample: number): number {
  return Math.imul(offset + sample, 7919) >>> 0;
}

async function main() {
  const [mode, count, seedOffset, baseline, ...candidates] =
    process.argv.slice(2);
  const games = Number(count);
  const offset = Number(seedOffset);
  if (
    (mode !== "matches" && mode !== "tournaments") ||
    !Number.isSafeInteger(games) ||
    games < 2 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !baseline ||
    !candidates.length
  )
    throw new Error(
      "Usage: npm run evaluate -- <matches|tournaments> <samples> <seed offset> <baseline> <candidate...>",
    );
  const lexiconMemory = process.memoryUsage();
  const v4 = await loadStrategy("44212af");
  const v5 = await loadStrategy("aeae8b9");
  const v3 =
    baseline === "v3" || candidates.includes("v3")
      ? await loadStrategy("0f58d7d")
      : undefined;
  const policies: Readonly<Record<string, Policy>> = {
    ...(v3 ? { v3 } : {}),
    v4,
    v5,
    starter: "starter",
    safeClose: { ...current.strategy, choosePlays: chooseTournamentPlays },
    working: {
      ...current.strategy,
      choosePlays: chooseTournamentPlays,
      decideBid: decideTournamentBid,
    },
    ...experiments,
  };
  const labels = [...new Set([baseline, ...candidates])];
  for (const label of labels) {
    if (!Object.hasOwn(policies, label))
      throw new Error(`Unknown policy: ${label}`);
  }
  const fieldMap: Record<string, Policy[]> =
    mode === "matches"
      ? {
          ...matchFields,
          competitive: [v4, "pressure", "pressure", "hoarder", "aggressive"],
          peerDuel: [v5],
        }
      : {
          mixed: [
            v4,
            "pressure",
            "pressure",
            "pressure",
            "hoarder",
            "hoarder",
            "starter",
            "starter",
            "aggressive",
            "value",
            "pressure",
          ],
          competitive: [
            v4,
            v5,
            "pressure",
            "pressure",
            "pressure",
            "pressure",
            "pressure",
            "hoarder",
            "hoarder",
            "hoarder",
            "aggressive",
          ],
        };
  const fields = (process.env.EVAL_FIELDS ?? "competitive,mixed").split(",");
  const formats = (process.env.EVAL_FORMATS ?? "Vickrey,FirstPrice").split(",");
  const missFinal = Number(process.env.EVAL_MISS_FINAL ?? 0);
  const matchSize = Number(process.env.EVAL_MATCH_SIZE ?? 6);
  const rounds = Number(process.env.EVAL_SWISS_ROUNDS ?? 3);
  const topCut = Number(process.env.EVAL_TOP_CUT ?? 4);
  if (!(missFinal >= 0 && missFinal <= 1))
    throw new Error("EVAL_MISS_FINAL must be a probability from 0 to 1");
  if (
    !Number.isInteger(matchSize) ||
    matchSize < 2 ||
    !Number.isInteger(rounds) ||
    rounds < 1 ||
    !Number.isInteger(topCut) ||
    topCut < 2
  )
    throw new Error("Invalid tournament configuration");
  if (fields.some((field) => !Object.hasOwn(fieldMap, field)))
    throw new Error("Unknown field");
  if (formats.some((format) => format !== "Vickrey" && format !== "FirstPrice"))
    throw new Error("Unknown auction format");
  const rows = [];
  const started = performance.now();
  const cpu = process.cpuUsage();
  const time = () => ({ bid: [], word: [], turn: [] }) as DecisionTimes;
  for (const field of fields) {
    const opponents = fieldMap[field];
    for (const format of formats as AuctionType[]) {
      const results = [];
      let control: Sample[] = [];
      for (const label of labels) {
        const samples: Sample[] = [];
        const focal: Metrics[] = [];
        const times = time();
        let matches = 0;
        const policy = policies[label];
        for (let sample = 0; sample < games; sample++) {
          const seed = seedAt(offset, sample);
          if (mode === "tournaments") {
            const result = runTournament(
              seed,
              opponents,
              policy,
              format,
              times,
              matchSize,
              rounds,
              topCut,
              missFinal,
            );
            samples.push(result.sample);
            focal.push(...result.focal);
            matches += result.matches;
          } else {
            const seats = [...opponents];
            const seat = seed % (seats.length + 1);
            seats.splice(seat, 0, policy);
            const result = simulateMatch(
              seed,
              seats,
              format,
              current.strategy,
              {
                measuredSeat: seat,
                decisionTimes: times,
                skipFinalTurnForSeat:
                  randomSource(seed ^ 0x762bd671)() < missFinal
                    ? seat
                    : undefined,
              },
            );
            const row = matchMetrics(result, seat, seats.length);
            focal.push(row);
            samples.push({
              score: row.score,
              place: row.place,
              first: row.first,
              last: row.last,
              swissPoints: row.swissPoints,
            });
            matches++;
          }
        }
        if (label === baseline) control = samples;
        const means: Sample = {};
        const paired: Record<string, ReturnType<typeof pairedInterval>> = {};
        for (const key of Object.keys(samples[0])) {
          const after = samples.map((sample) => sample[key]);
          means[key] = average(after);
          if (label !== baseline) {
            const rate = [
              "first",
              "last",
              "champion",
              "qualified",
              "finalist",
            ].includes(key);
            paired[key] = (rate ? pairedRateInterval : pairedInterval)(
              control.map((sample) => sample[key]),
              after,
            );
          }
        }
        const metrics = summarize(focal, times);
        results.push({ label, matches, means, metrics, paired, samples });
        const display =
          mode === "tournaments"
            ? `champ ${Math.round(means.champion * games)}/${games}, cut ${Math.round(means.qualified * games)}/${games}, finalists ${Math.round(means.finalist * games)}/${games}`
            : `score ${means.score.toFixed(2)}, first ${Math.round(means.first * games)}/${games}, last ${Math.round(means.last * games)}/${games}`;
        const primary = mode === "tournaments" ? paired.champion : paired.score;
        const interval = primary
          ? `, paired 95% CI [${primary.lower.toFixed(3)}, ${primary.upper.toFixed(3)}]`
          : "";
        console.log(
          `${field} ${format} ${label}: ${display}, bid p99 ${metrics.latencyMs.bid.p99?.toFixed(2) ?? "n/a"} ms${interval}`,
        );
      }
      rows.push({ field, format, results });
    }
  }
  const report = {
    mode,
    games,
    offset,
    baseline,
    formats,
    missFinal,
    matchSize,
    rounds,
    topCut,
    rows,
    wallMs: performance.now() - started,
    cpu: process.cpuUsage(cpu),
    memory: {
      beforeRun: lexiconMemory,
      afterRun: process.memoryUsage(),
      peakRssKiB: process.resourceUsage().maxRSS,
    },
  };
  if (process.env.EVAL_REPORT)
    writeFileSync(
      process.env.EVAL_REPORT,
      JSON.stringify(report, null, 2) + "\n",
    );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await main();
